/**
 * Sooz Books — bank reconciliation.
 *
 * A reconciliation proves that the ledger's bank account agrees with the bank's own
 * statement. The figure that has to tie is the **cleared balance, computed from the
 * general ledger**: the posted lines on the bank's GL account that earlier completed
 * reconciliations cleared, plus the ones this reconciliation clears. The bank rows are
 * only the way a person finds those lines — they are never summed themselves, because a
 * bank row that never posted is not in the books, whatever the statement says.
 *
 * The opening-balance entry of a bank account (source `opening_balance`) is the
 * balance per bank on the day the books start, so it counts as cleared from the outset.
 *
 * Relay prints a running balance on every row, so `proposeStatement` can read a month's
 * opening and closing balance straight off the imported rows. Starting a reconciliation
 * with that proposal and `autoClear` leaves only the exceptions for a human.
 *
 * Locks, from the outside in: a completed reconciliation stamps `reconciliation_id` and
 * `reconciled_at` on its bank rows (a trigger then refuses to change them), its items
 * cannot change (0019), and an entry it cleared cannot be reversed (0019). Only an owner
 * can undo one, and only the latest for its account.
 */

import { and, desc, eq, sql as sqlTag } from 'drizzle-orm';

import { type Tx } from '@/db/client';
import { appUsers, bankAccounts, reconciliations } from '@/db/schema';
import { type CalendarDate, isCalendarDate, monthEnd } from '@/lib/dates';
import type { LedgerDb } from '@/lib/ledger/post';

import { type BankingCtx, BankingError, inBankingTx } from './post';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ReconciliationSummary {
  id: string;
  bankAccountId: string;
  bankAccountName: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  statementStartDate: CalendarDate;
  statementDate: CalendarDate;
  /** The statement's beginning balance, as entered or proposed. */
  openingBalanceCents: number;
  /** The statement's ending balance. */
  closingBalanceCents: number;
  /** GL lines cleared before this reconciliation, plus the opening-balance entry. */
  previouslyClearedCents: number;
  /** GL lines this reconciliation clears. */
  clearedThisPeriodCents: number;
  clearedCount: number;
  /** `previouslyClearedCents + clearedThisPeriodCents`. */
  clearedBalanceCents: number;
  /** `closingBalanceCents − clearedBalanceCents`. Must be exactly 0 to complete. */
  differenceCents: number;
  /**
   * `openingBalanceCents − previouslyClearedCents`: non-zero means the statement starts
   * somewhere the books' reconciled history does not, usually a missing earlier month.
   */
  openingDifferenceCents: number;
  completedAt: string | null;
  completedBy: string | null;
}

export interface StartReconciliationInput {
  bankAccountId: string;
  statementStartDate: CalendarDate;
  statementDate: CalendarDate;
  closingBalanceCents: number;
  /** Defaults to the last completed reconciliation's closing balance, or the opening entry. */
  openingBalanceCents?: number;
  /** Clear every posted bank row dated inside the statement, and self-cancelling pairs. */
  autoClear?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertId(value: string, what: string): void {
  if (!UUID.test(value)) throw new BankingError('reconciliation_invalid', `${what} ${JSON.stringify(value)} is not an id.`);
}

function assertCents(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new BankingError('reconciliation_invalid', `${what} must be a whole number of cents; received ${value}.`);
  }
}

function cents(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Expected whole cents from the database, got ${String(value)}`);
  return n;
}

function money(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${Math.trunc(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

type Exec = LedgerDb | Tx;

async function rows<T>(exec: Exec, query: ReturnType<typeof sqlTag>): Promise<T[]> {
  return (await exec.execute(query)) as unknown as T[];
}

interface ReconRow {
  id: string;
  bank_account_id: string;
  bank_account_name: string;
  gl_account_id: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  statement_start_date: string;
  statement_date: string;
  opening_balance_cents: string;
  closing_balance_cents: string;
  completed_at: string | null;
  completed_by: string | null;
}

async function loadRecon(exec: Exec, id: string, lock: boolean): Promise<ReconRow> {
  assertId(id, 'Reconciliation');
  const [row] = await rows<ReconRow>(
    exec,
    sqlTag`
      select r.id, r.bank_account_id, ba.name as bank_account_name, ba.account_id as gl_account_id,
             r.status::text as status, r.statement_start_date::text, r.statement_date::text,
             r.opening_balance_cents::text, r.closing_balance_cents::text,
             r.completed_at::text, r.completed_by
        from reconciliations r
        join bank_accounts ba on ba.id = r.bank_account_id
       where r.id = ${id}::uuid
       ${lock ? sqlTag`for update of r` : sqlTag``}`,
  );
  if (row === undefined) throw new BankingError('reconciliation_not_found', `Reconciliation ${id} does not exist.`);
  return row;
}

/**
 * Posted lines on the bank's GL account that count as cleared before `reconId`: those a
 * completed reconciliation cleared, and the account's opening-balance entry (with its
 * reversal, if it was ever reversed) up to `asOf`.
 */
function baselineSql(bankAccountId: string, glAccountId: string, excludeReconId: string | null, asOf: CalendarDate) {
  return sqlTag`
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::text as cents
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
     where jl.account_id = ${glAccountId}::uuid
       and (
         exists (select 1
                   from reconciliation_items ri
                   join reconciliations r on r.id = ri.reconciliation_id
                  where ri.journal_line_id = jl.id
                    and ri.cleared
                    and r.status = 'completed'
                    and (${excludeReconId}::uuid is null or r.id <> ${excludeReconId}::uuid))
         or (je.entry_date <= ${asOf}::date
             and (   (je.source_type = 'opening_balance' and je.source_id = ${bankAccountId}::uuid)
                  or (je.source_type = 'reversal' and exists (
                        select 1 from journal_entries o
                         where o.id = je.reverses_id
                           and o.source_type = 'opening_balance'
                           and o.source_id = ${bankAccountId}::uuid))))
       )`;
}

async function summarise(exec: Exec, recon: ReconRow): Promise<ReconciliationSummary> {
  const [baseline] = await rows<{ cents: string }>(
    exec,
    baselineSql(recon.bank_account_id, recon.gl_account_id, recon.id, recon.statement_date),
  );
  const [items] = await rows<{ cents: string; n: number }>(
    exec,
    sqlTag`
      select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::text as cents, count(*)::int as n
        from reconciliation_items ri
        join journal_lines jl on jl.id = ri.journal_line_id
       where ri.reconciliation_id = ${recon.id}::uuid
         and ri.cleared`,
  );
  const previously = cents(baseline.cents);
  const thisPeriod = cents(items.cents);
  const opening = cents(recon.opening_balance_cents);
  const closing = cents(recon.closing_balance_cents);
  const cleared = previously + thisPeriod;
  return {
    id: recon.id,
    bankAccountId: recon.bank_account_id,
    bankAccountName: recon.bank_account_name,
    status: recon.status,
    statementStartDate: recon.statement_start_date,
    statementDate: recon.statement_date,
    openingBalanceCents: opening,
    closingBalanceCents: closing,
    previouslyClearedCents: previously,
    clearedThisPeriodCents: thisPeriod,
    clearedCount: items.n,
    clearedBalanceCents: cleared,
    differenceCents: closing - cleared,
    openingDifferenceCents: opening - previously,
    completedAt: recon.completed_at,
    completedBy: recon.completed_by,
  };
}

/** Recomputes the cleared balance and stores it on the row, for lists that read it. */
async function refresh(tx: Tx, recon: ReconRow): Promise<ReconciliationSummary> {
  const summary = await summarise(tx, recon);
  if (recon.status === 'in_progress') {
    await tx
      .update(reconciliations)
      .set({ clearedBalanceCents: summary.clearedBalanceCents, differenceCents: summary.differenceCents })
      .where(eq(reconciliations.id, recon.id));
  }
  return summary;
}

function assertInProgress(recon: ReconRow): void {
  if (recon.status !== 'in_progress') {
    throw new BankingError(
      'reconciliation_state',
      `This reconciliation is ${recon.status === 'completed' ? 'completed and locked' : 'abandoned'}; ` +
        `only one in progress can be changed.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The live summary of one reconciliation, cleared balance computed from the GL. */
export async function clearedBalance(reconciliationId: string, exec?: LedgerDb): Promise<ReconciliationSummary> {
  const runner = exec ?? (await import('@/db/client')).db;
  return summarise(runner, await loadRecon(runner, reconciliationId, false));
}

export interface ReconciliationLine {
  journalLineId: string;
  entryId: string;
  entryNo: number;
  /** The bank's date for the row when there is one, the entry's date otherwise. */
  date: CalendarDate;
  /** Signed from the bank's point of view: positive is money in. */
  amountCents: number;
  memo: string | null;
  bankTransactionId: string | null;
  payee: string | null;
  sourceType: string;
  cleared: boolean;
}

/**
 * Every GL line on the bank account a reconciliation can clear, through the statement
 * date, that no completed reconciliation has cleared — with whether this one clears it.
 * One query.
 */
export async function reconciliationLines(
  reconciliationId: string,
  exec?: LedgerDb,
): Promise<ReconciliationLine[]> {
  const runner = exec ?? (await import('@/db/client')).db;
  const recon = await loadRecon(runner, reconciliationId, false);
  const result = await rows<{
    journal_line_id: string;
    entry_id: string;
    entry_no: string;
    date: string;
    amount_cents: string;
    memo: string | null;
    bank_transaction_id: string | null;
    payee: string | null;
    source_type: string;
    cleared: boolean;
  }>(
    runner,
    sqlTag`
      select jl.id as journal_line_id, je.id as entry_id, je.entry_no::text,
             coalesce(bt.txn_date, je.entry_date)::text as date,
             (jl.debit_cents - jl.credit_cents)::text as amount_cents,
             coalesce(jl.memo, je.memo) as memo,
             bt.id as bank_transaction_id,
             coalesce(bt.counterparty, bt.description) as payee,
             je.source_type,
             exists (select 1 from reconciliation_items mine
                      where mine.reconciliation_id = ${recon.id}::uuid
                        and mine.journal_line_id = jl.id
                        and mine.cleared) as cleared
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
        left join bank_transactions bt
               on bt.journal_entry_id = je.id and bt.bank_account_id = ${recon.bank_account_id}::uuid
       where jl.account_id = ${recon.gl_account_id}::uuid
         and coalesce(bt.txn_date, je.entry_date) <= ${recon.statement_date}::date
         and not exists (select 1
                           from reconciliation_items ri
                           join reconciliations r on r.id = ri.reconciliation_id
                          where ri.journal_line_id = jl.id
                            and r.status = 'completed'
                            and r.id <> ${recon.id}::uuid)
         and not (je.source_type = 'opening_balance' and je.source_id = ${recon.bank_account_id}::uuid)
       order by coalesce(bt.txn_date, je.entry_date), je.entry_no, jl.line_no`,
  );
  return result.map((row) => ({
    journalLineId: row.journal_line_id,
    entryId: row.entry_id,
    entryNo: cents(row.entry_no),
    date: row.date,
    amountCents: cents(row.amount_cents),
    memo: row.memo,
    bankTransactionId: row.bank_transaction_id,
    payee: row.payee,
    sourceType: row.source_type,
    cleared: row.cleared,
  }));
}

// ---------------------------------------------------------------------------
// Proposing a statement from Relay's running balance
// ---------------------------------------------------------------------------

export interface StatementProposal {
  bankAccountId: string;
  month: string;
  statementStartDate: CalendarDate;
  statementDate: CalendarDate;
  /** Balance per bank before the month's first row; null when there is no data yet. */
  openingBalanceCents: number | null;
  /** Balance per bank after the month's last row. */
  closingBalanceCents: number | null;
  transactionCount: number;
  netChangeCents: number;
  /** Where the figures came from. `carried_forward` is a month with no rows. */
  basis: 'balance_chain' | 'carried_forward' | 'no_data';
  /** True when every day through the month's end ties to the printed balance. */
  chainOk: boolean;
  breaks: { date: CalendarDate; expectedCents: number; actualCents: number }[];
  /** The GL balance of the bank account at the statement date, for comparison. */
  ledgerBalanceCents: number;
}

interface ChainRow {
  id: string;
  date: CalendarDate;
  amount: number;
  balance: number | null;
}

/**
 * The balance a day ended on. Rows of one day are unordered in the database — Relay's
 * file order is gone — so the day's last row is found by the chain: the row whose
 * balance no other row of the day starts from.
 */
function terminalBalance(day: readonly ChainRow[]): number | null {
  const withBalance = day.filter((row): row is ChainRow & { balance: number } => row.balance !== null);
  if (withBalance.length === 0) return null;
  const terminal = withBalance.find(
    (row) => !withBalance.some((other) => other !== row && other.balance - other.amount === row.balance),
  );
  return (terminal ?? withBalance[withBalance.length - 1]).balance;
}

/** The balance a day started from: the start no other row of the day ends on. */
function initialBalance(day: readonly ChainRow[]): number | null {
  const withBalance = day.filter((row): row is ChainRow & { balance: number } => row.balance !== null);
  if (withBalance.length === 0) return null;
  const first = withBalance.find(
    (row) => !withBalance.some((other) => other !== row && other.balance === row.balance - row.amount),
  );
  const pick = first ?? withBalance[0];
  const before = pick.balance - pick.amount;
  // Rows of the day without a printed balance still moved the account.
  return before;
}

/**
 * Proposes a calendar month's statement from the imported rows' running balance.
 * Every row counts, whatever its review status: the balance column is the bank's view,
 * and an excluded returned ACH still appeared on the statement.
 *
 * @param month `YYYY-MM`
 */
export async function proposeStatement(
  bankAccountId: string,
  month: string,
  exec?: LedgerDb,
): Promise<StatementProposal> {
  assertId(bankAccountId, 'Bank account');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new BankingError('reconciliation_invalid', `${JSON.stringify(month)} is not a month in YYYY-MM form.`);
  }
  const start = `${month}-01`;
  const end = monthEnd(start);
  const runner = exec ?? (await import('@/db/client')).db;

  const data = await rows<{ id: string; date: string; amount: string; balance: string | null }>(
    runner,
    sqlTag`
      select id, txn_date::text as date, amount_cents::text as amount, balance_cents::text as balance
        from bank_transactions
       where bank_account_id = ${bankAccountId}::uuid
         and txn_date <= ${end}::date
       order by txn_date, created_at, id`,
  );
  const [ledger] = await rows<{ cents: string }>(
    runner,
    sqlTag`
      select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::text as cents
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
        join bank_accounts ba on ba.account_id = jl.account_id
       where ba.id = ${bankAccountId}::uuid
         and je.entry_date <= ${end}::date`,
  );

  const byDay = new Map<CalendarDate, ChainRow[]>();
  for (const row of data) {
    const entry: ChainRow = {
      id: row.id,
      date: row.date,
      amount: cents(row.amount),
      balance: row.balance === null ? null : cents(row.balance),
    };
    const bucket = byDay.get(entry.date);
    if (bucket === undefined) byDay.set(entry.date, [entry]);
    else bucket.push(entry);
  }

  let running: number | null = null;
  let opening: number | null = null;
  let openingSet = false;
  const breaks: StatementProposal['breaks'] = [];
  let count = 0;
  let net = 0;

  for (const [date, day] of byDay) {
    const inMonth = date >= start;
    const sum = day.reduce((acc, row) => acc + row.amount, 0);
    const startOfDay: number | null = running ?? initialBalance(day);
    if (inMonth && !openingSet) {
      opening = startOfDay;
      openingSet = true;
    }
    if (inMonth) {
      count += day.length;
      net += sum;
    }
    if (startOfDay === null) {
      running = null;
      continue;
    }
    const expected: number = startOfDay + sum;
    const printed = terminalBalance(day);
    if (printed !== null && !day.some((row) => row.balance === expected)) {
      breaks.push({ date, expectedCents: expected, actualCents: printed });
      running = printed;
    } else {
      running = expected;
    }
  }

  const hasData = data.length > 0;
  if (!openingSet) opening = running;

  return {
    bankAccountId,
    month,
    statementStartDate: start,
    statementDate: end,
    openingBalanceCents: hasData ? opening : null,
    closingBalanceCents: hasData ? running : null,
    transactionCount: count,
    netChangeCents: net,
    basis: !hasData ? 'no_data' : count === 0 ? 'carried_forward' : 'balance_chain',
    chainOk: breaks.length === 0,
    breaks,
    ledgerBalanceCents: cents(ledger.cents),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Clears every posted bank row of the account dated inside the statement, and every
 * uncleared entry-and-reversal pair dated through it (they net to zero and would
 * otherwise sit in the list for ever).
 */
async function autoClear(tx: Tx, recon: ReconRow): Promise<void> {
  await tx.execute(sqlTag`
    insert into reconciliation_items (reconciliation_id, bank_transaction_id, journal_line_id, amount_cents, cleared)
    select ${recon.id}::uuid, bt.id, jl.id, jl.debit_cents - jl.credit_cents, true
      from bank_transactions bt
      join journal_lines jl on jl.entry_id = bt.journal_entry_id and jl.account_id = ${recon.gl_account_id}::uuid
      join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
     where bt.bank_account_id = ${recon.bank_account_id}::uuid
       and bt.txn_date between ${recon.statement_start_date}::date and ${recon.statement_date}::date
       and bt.reconciled_at is null
       and not exists (select 1 from reconciliation_items ri where ri.journal_line_id = jl.id)
    on conflict do nothing`);

  await tx.execute(sqlTag`
    insert into reconciliation_items (reconciliation_id, journal_line_id, amount_cents, cleared)
    select ${recon.id}::uuid, jl.id, jl.debit_cents - jl.credit_cents, true
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
      join journal_entries partner
        on (partner.reverses_id = je.id or je.reverses_id = partner.id) and partner.status = 'posted'
     where jl.account_id = ${recon.gl_account_id}::uuid
       and je.entry_date <= ${recon.statement_date}::date
       and partner.entry_date <= ${recon.statement_date}::date
       and not (je.source_type = 'opening_balance' or partner.source_type = 'opening_balance')
       and not exists (select 1 from reconciliation_items ri where ri.journal_line_id = jl.id)
       and not exists (select 1 from reconciliation_items ri
                         join journal_lines pl on pl.id = ri.journal_line_id
                        where pl.entry_id = partner.id)
    on conflict do nothing`);
}

/**
 * Opens a reconciliation for one statement.
 *
 * @throws {BankingError} another reconciliation is in progress, the statement overlaps a
 *   completed one, or the dates and amounts are malformed
 */
export async function startReconciliation(
  input: StartReconciliationInput,
  ctx: BankingCtx,
): Promise<ReconciliationSummary> {
  assertId(input.bankAccountId, 'Bank account');
  if (!isCalendarDate(input.statementStartDate) || !isCalendarDate(input.statementDate)) {
    throw new BankingError('reconciliation_invalid', 'Statement dates must be calendar dates in YYYY-MM-DD form.');
  }
  if (input.statementStartDate > input.statementDate) {
    throw new BankingError('reconciliation_invalid', 'The statement cannot end before it starts.');
  }
  assertCents(input.closingBalanceCents, 'The closing balance');
  if (input.openingBalanceCents !== undefined) assertCents(input.openingBalanceCents, 'The opening balance');

  return inBankingTx(ctx, async (tx) => {
    const [account] = await tx
      .select({ id: bankAccounts.id, glAccountId: bankAccounts.accountId })
      .from(bankAccounts)
      .where(eq(bankAccounts.id, input.bankAccountId))
      .for('update');
    if (account === undefined) {
      throw new BankingError('reconciliation_invalid', `Bank account ${input.bankAccountId} does not exist.`);
    }

    const [open] = await tx
      .select({ id: reconciliations.id, statementDate: reconciliations.statementDate })
      .from(reconciliations)
      .where(and(eq(reconciliations.bankAccountId, account.id), eq(reconciliations.status, 'in_progress')));
    if (open !== undefined) {
      throw new BankingError(
        'reconciliation_state',
        `The reconciliation to ${open.statementDate} is still in progress. Finish or abandon it first.`,
      );
    }

    const [last] = await tx
      .select({ statementDate: reconciliations.statementDate, closing: reconciliations.closingBalanceCents })
      .from(reconciliations)
      .where(and(eq(reconciliations.bankAccountId, account.id), eq(reconciliations.status, 'completed')))
      .orderBy(desc(reconciliations.statementDate))
      .limit(1);
    if (last !== undefined && input.statementStartDate <= last.statementDate) {
      throw new BankingError(
        'reconciliation_invalid',
        `This account is reconciled through ${last.statementDate}; the next statement must start after it.`,
      );
    }

    let opening = input.openingBalanceCents;
    if (opening === undefined) {
      if (last !== undefined) {
        opening = last.closing;
      } else {
        const [baseline] = await rows<{ cents: string }>(
          tx,
          baselineSql(account.id, account.glAccountId, null, input.statementDate),
        );
        opening = cents(baseline.cents);
      }
    }

    const [created] = await tx
      .insert(reconciliations)
      .values({
        bankAccountId: account.id,
        statementStartDate: input.statementStartDate,
        statementDate: input.statementDate,
        openingBalanceCents: opening,
        closingBalanceCents: input.closingBalanceCents,
        createdBy: ctx.userId,
      })
      .returning({ id: reconciliations.id });

    const recon = await loadRecon(tx, created.id, true);
    if (input.autoClear === true) await autoClear(tx, recon);
    return refresh(tx, recon);
  });
}

export interface ToggleClearedInput {
  reconciliationId: string;
  /** A posted bank row of this account; its line on the bank's GL account is cleared. */
  bankTransactionId?: string;
  /** A GL line on the bank account with no bank row (a manual entry, a bill payment). */
  journalLineId?: string;
  cleared: boolean;
}

/** Marks one item cleared or not, and returns the recomputed summary. */
export async function toggleCleared(
  input: ToggleClearedInput,
  ctx: BankingCtx,
): Promise<ReconciliationSummary> {
  if ((input.bankTransactionId === undefined) === (input.journalLineId === undefined)) {
    throw new BankingError('reconciliation_invalid', 'Name exactly one of a bank transaction or a journal line.');
  }
  return inBankingTx(ctx, async (tx) => {
    const recon = await loadRecon(tx, input.reconciliationId, true);
    assertInProgress(recon);

    let lineId: string;
    let bankTxnId: string | null = null;
    if (input.bankTransactionId !== undefined) {
      assertId(input.bankTransactionId, 'Bank transaction');
      const [bank] = await rows<{
        id: string;
        bank_account_id: string;
        txn_date: string;
        status: string;
        journal_entry_id: string | null;
        line_ids: string[] | null;
      }>(
        tx,
        sqlTag`
          select bt.id, bt.bank_account_id, bt.txn_date::text, bt.status::text, bt.journal_entry_id,
                 (select array_agg(jl.id::text order by jl.line_no)
                    from journal_lines jl
                   where jl.entry_id = bt.journal_entry_id
                     and jl.account_id = ${recon.gl_account_id}::uuid) as line_ids
            from bank_transactions bt
           where bt.id = ${input.bankTransactionId}::uuid`,
      );
      if (bank === undefined || bank.bank_account_id !== recon.bank_account_id) {
        throw new BankingError('reconciliation_invalid', 'That transaction is not on this bank account.');
      }
      if (bank.journal_entry_id === null) {
        throw new BankingError(
          'reconciliation_invalid',
          bank.status === 'excluded'
            ? 'An excluded transaction never reached the books, so there is nothing to clear.'
            : 'Post this transaction before clearing it: only the ledger can be reconciled.',
        );
      }
      if (bank.txn_date > recon.statement_date) {
        throw new BankingError('reconciliation_invalid', `This transaction is dated after the statement (${recon.statement_date}).`);
      }
      const lineIds = bank.line_ids ?? [];
      if (lineIds.length !== 1) {
        throw new BankingError('reconciliation_invalid', 'This transaction does not have exactly one line on the bank account.');
      }
      lineId = lineIds[0];
      bankTxnId = bank.id;
    } else {
      lineId = input.journalLineId as string;
      assertId(lineId, 'Journal line');
      const [line] = await rows<{ account_id: string; entry_date: string; status: string; bank_txn_id: string | null }>(
        tx,
        sqlTag`
          select jl.account_id, je.entry_date::text, je.status::text,
                 (select bt.id from bank_transactions bt
                   where bt.journal_entry_id = je.id and bt.bank_account_id = ${recon.bank_account_id}::uuid
                   limit 1) as bank_txn_id
            from journal_lines jl
            join journal_entries je on je.id = jl.entry_id
           where jl.id = ${lineId}::uuid`,
      );
      if (line === undefined || line.account_id !== recon.gl_account_id || line.status !== 'posted') {
        throw new BankingError('reconciliation_invalid', "That line is not a posted line on this bank account's GL account.");
      }
      if (line.entry_date > recon.statement_date && line.bank_txn_id === null) {
        throw new BankingError('reconciliation_invalid', `This line is dated after the statement (${recon.statement_date}).`);
      }
      bankTxnId = line.bank_txn_id;
    }

    const [elsewhere] = await rows<{ status: string; statement_date: string }>(
      tx,
      sqlTag`
        select r.status::text, r.statement_date::text
          from reconciliation_items ri
          join reconciliations r on r.id = ri.reconciliation_id
         where ri.journal_line_id = ${lineId}::uuid
           and r.id <> ${recon.id}::uuid`,
    );
    if (elsewhere !== undefined) {
      throw new BankingError(
        'reconciliation_invalid',
        `That item is already cleared in the reconciliation to ${elsewhere.statement_date}.`,
      );
    }

    if (input.cleared) {
      await tx.execute(sqlTag`
        insert into reconciliation_items (reconciliation_id, bank_transaction_id, journal_line_id, amount_cents, cleared)
        select ${recon.id}::uuid, ${bankTxnId}::uuid, jl.id, jl.debit_cents - jl.credit_cents, true
          from journal_lines jl
         where jl.id = ${lineId}::uuid
        on conflict do nothing`);
    } else {
      await tx.execute(sqlTag`
        delete from reconciliation_items
         where reconciliation_id = ${recon.id}::uuid
           and journal_line_id = ${lineId}::uuid`);
    }
    return refresh(tx, recon);
  });
}

/**
 * Completes a reconciliation. Refuses unless the cleared balance, computed from the GL,
 * equals the statement's closing balance to the cent — and the database refuses a
 * completed row with a non-zero difference regardless. Locks every cleared bank row.
 */
export async function completeReconciliation(
  reconciliationId: string,
  ctx: BankingCtx,
): Promise<ReconciliationSummary> {
  return inBankingTx(ctx, async (tx) => {
    const recon = await loadRecon(tx, reconciliationId, true);
    assertInProgress(recon);
    const summary = await summarise(tx, recon);
    if (summary.differenceCents !== 0) {
      throw new BankingError(
        'reconciliation_not_tied',
        `The cleared balance is ${money(summary.clearedBalanceCents)} but the statement ends at ` +
          `${money(summary.closingBalanceCents)}: ${money(Math.abs(summary.differenceCents))} ` +
          `${summary.differenceCents > 0 ? 'still to clear' : 'cleared too much'}. It can only be completed at exactly zero.`,
      );
    }

    await tx
      .update(reconciliations)
      .set({
        status: 'completed',
        clearedBalanceCents: summary.clearedBalanceCents,
        differenceCents: 0,
        completedAt: new Date(),
        completedBy: ctx.userId,
      })
      .where(eq(reconciliations.id, recon.id));

    await tx.execute(sqlTag`
      update bank_transactions bt
         set reconciliation_id = ${recon.id}::uuid,
             reconciled_at = now()
        from reconciliation_items ri
        join journal_lines jl on jl.id = ri.journal_line_id
       where ri.reconciliation_id = ${recon.id}::uuid
         and ri.cleared
         and bt.journal_entry_id = jl.entry_id
         and bt.bank_account_id = ${recon.bank_account_id}::uuid`);

    return summarise(tx, await loadRecon(tx, recon.id, false));
  });
}

/**
 * Reopens the latest completed reconciliation of an account. Owner only: it unlocks
 * figures that may already have been reported.
 */
export async function undoReconciliation(
  reconciliationId: string,
  ctx: BankingCtx,
): Promise<ReconciliationSummary> {
  return inBankingTx(ctx, async (tx) => {
    const role =
      ctx.userId === null
        ? null
        : ((
            await tx
              .select({ role: appUsers.role, active: appUsers.active })
              .from(appUsers)
              .where(eq(appUsers.id, ctx.userId))
          )[0] ?? null);
    if (role === null || !role.active || role.role !== 'owner') {
      throw new BankingError('not_permitted', 'Only an owner can undo a completed reconciliation.');
    }

    const recon = await loadRecon(tx, reconciliationId, true);
    if (recon.status !== 'completed') {
      throw new BankingError('reconciliation_state', 'Only a completed reconciliation can be undone.');
    }
    const [later] = await tx
      .select({ statementDate: reconciliations.statementDate, status: reconciliations.status })
      .from(reconciliations)
      .where(
        and(
          eq(reconciliations.bankAccountId, recon.bank_account_id),
          sqlTag`${reconciliations.status} in ('completed', 'in_progress')`,
          sqlTag`${reconciliations.id} <> ${recon.id}::uuid`,
          sqlTag`(${reconciliations.status} = 'in_progress' or ${reconciliations.statementDate} > ${recon.statement_date}::date)`,
        ),
      )
      .limit(1);
    if (later !== undefined) {
      throw new BankingError(
        'reconciliation_state',
        later.status === 'in_progress'
          ? `The reconciliation to ${later.statementDate} is in progress; abandon it before undoing an earlier one.`
          : `The reconciliation to ${later.statementDate} comes after this one; undo it first.`,
      );
    }

    await tx
      .update(reconciliations)
      .set({ status: 'in_progress', completedAt: null, completedBy: null })
      .where(eq(reconciliations.id, recon.id));
    await tx.execute(sqlTag`
      update bank_transactions
         set reconciliation_id = null, reconciled_at = null
       where reconciliation_id = ${recon.id}::uuid`);

    return refresh(tx, await loadRecon(tx, recon.id, false));
  });
}

/** Throws away an in-progress reconciliation and everything it had cleared. */
export async function abandonReconciliation(reconciliationId: string, ctx: BankingCtx): Promise<void> {
  await inBankingTx(ctx, async (tx) => {
    const recon = await loadRecon(tx, reconciliationId, true);
    assertInProgress(recon);
    await tx.execute(sqlTag`delete from reconciliation_items where reconciliation_id = ${recon.id}::uuid`);
    await tx
      .update(reconciliations)
      .set({ status: 'abandoned', clearedBalanceCents: 0, differenceCents: 0 })
      .where(eq(reconciliations.id, recon.id));
  });
}

/**
 * The automatic checks of the month-end close.
 *
 * Each check reads the books as of the month's last day and returns what it
 * compared, so the checklist can show why a task passed or failed without
 * running it again. A check never changes anything; fixing what it finds is a
 * person's job. Every figure is whole cents.
 */

import { sql } from 'drizzle-orm';

import type { CloseTaskResult } from '@/db/schema';
import { arAging, apAging } from '@/lib/arap/aging';
import type { CalendarDate } from '@/lib/dates';
import { isInventoryError } from '@/lib/inventory/errors';
import { computeTieout } from '@/lib/inventory/tieout';
import { trialBalance, trialBalanceTotals } from '@/lib/ledger/balances';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';
import { formatMoney } from '@/lib/money';
import { overdueRecurringEntries } from '@/lib/planning/recurring';

export const AUTO_CHECKS = [
  'no_draft_entries',
  'bank_unreviewed_zero',
  'bank_recs_complete',
  'clearing_zero',
  'ar_ties',
  'ap_ties',
  'recurring_raised',
  'cogs_posted',
  'inventory_tieout',
  'trial_balance_balances',
] as const;

export type AutoCheck = (typeof AUTO_CHECKS)[number];

export function isAutoCheck(value: string): value is AutoCheck {
  return (AUTO_CHECKS as readonly string[]).includes(value);
}

export interface CheckOptions {
  /** How far the inventory count may sit from the ledger and still tie. Default $25.00. */
  inventoryToleranceCents?: number;
}

export const DEFAULT_INVENTORY_TOLERANCE_CENTS = 2_500;

export interface CheckContext {
  year: number;
  month: number;
  start: CalendarDate;
  end: CalendarDate;
  exec: LedgerDb;
  options: CheckOptions;
}

type Outcome = Omit<CloseTaskResult, 'checkedAt'>;

function pass(message: string, values?: CloseTaskResult['values']): Outcome {
  return { ok: true, message, values };
}

function fail(message: string, values?: CloseTaskResult['values']): Outcome {
  return { ok: false, message, values };
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(n)) throw new Error(`Expected a whole number, received ${String(value)}.`);
  return n;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A short list for a message: the first few, then how many more. */
function listing(items: readonly string[], max = 5): string {
  if (items.length <= max) return items.join('; ');
  return `${items.slice(0, max).join('; ')}; and ${items.length - max} more`;
}

/* -------------------------------------------------------------------- checks */

async function noDraftEntries({ exec, start, end }: CheckContext): Promise<Outcome> {
  const rows = await exec.execute<{ entry_no: string | number; memo: string | null }>(sql`
    select entry_no, memo from journal_entries
     where status = 'draft' and entry_date between ${start} and ${end}
     order by entry_no
  `);
  if (rows.length === 0) return pass('No draft entries are dated in the month.', { count: 0 });
  const refs = [...rows].map((r) => `#${num(r.entry_no)}${r.memo ? ` ${r.memo}` : ''}`);
  return fail(`${plural(rows.length, 'draft entry is', 'draft entries are')} dated in the month: ${listing(refs)}. Post or delete them.`, {
    count: rows.length,
  });
}

async function bankUnreviewedZero({ exec, start, end }: CheckContext): Promise<Outcome> {
  const [row] = await exec.execute<{ n: string | number; total: string | number }>(sql`
    select count(*) as n, coalesce(sum(amount_cents), 0) as total
      from bank_transactions
     where status = 'unreviewed' and txn_date between ${start} and ${end}
  `);
  const count = num(row?.n);
  if (count === 0) return pass('Every bank transaction dated in the month has been reviewed.', { count: 0 });
  return fail(
    `${plural(count, 'bank transaction is', 'bank transactions are')} still unreviewed (${formatMoney(num(row?.total))} net).`,
    { count, netCents: num(row?.total) },
  );
}

interface RecRow extends Record<string, unknown> {
  name: string;
  mask: string | null;
  has_activity: boolean;
  reconciled: boolean;
}

async function bankRecsComplete({ exec, end }: CheckContext): Promise<Outcome> {
  const rows = await exec.execute<RecRow>(sql`
    select b.name, b.mask,
           (exists (select 1 from bank_transactions t where t.bank_account_id = b.id and t.txn_date <= ${end})
            or exists (select 1 from journal_lines l join journal_entries e on e.id = l.entry_id
                        where l.account_id = b.account_id and e.status = 'posted' and e.entry_date <= ${end})
            or (b.opening_balance_cents <> 0 and b.opening_date <= ${end})) as has_activity,
           exists (select 1 from reconciliations r
                    where r.bank_account_id = b.id and r.status = 'completed'
                      and r.statement_start_date <= ${end} and r.statement_date >= ${end}) as reconciled
      from bank_accounts b
     where b.active
     order by b.name
  `);
  const needed = [...rows].filter((r) => r.has_activity);
  const missing = needed.filter((r) => !r.reconciled).map((r) => (r.mask ? `${r.name} ••${r.mask}` : r.name));
  const idle = rows.length - needed.length;
  const idleNote = idle > 0 ? ` ${plural(idle, 'account has', 'accounts have')} no activity yet and need none.` : '';
  if (missing.length === 0) {
    return pass(`Every active bank account with activity is reconciled through ${end}.${idleNote}`, {
      reconciled: needed.length,
      idle,
    });
  }
  return fail(`Not reconciled through ${end}: ${listing(missing)}.${idleNote}`, {
    missing: missing.length,
    reconciled: needed.length - missing.length,
  });
}

interface BalanceRow extends Record<string, unknown> {
  code: string;
  name: string;
  balance: string | number;
}

async function clearingZero({ exec, end }: CheckContext): Promise<Outcome> {
  const rows = await exec.execute<BalanceRow>(sql`
    select a.code, a.name, coalesce(sum(l.debit_cents - l.credit_cents), 0) as balance
      from accounts a
      join journal_lines l on l.account_id = a.id
      join journal_entries e on e.id = l.entry_id and e.status = 'posted' and e.entry_date <= ${end}
     where a.subtype = 'clearing'
        or a.parent_id = (select id from accounts where code = ${ACCOUNTS.CLEARING})
     group by a.code, a.name
    having coalesce(sum(l.debit_cents - l.credit_cents), 0) <> 0
     order by a.code
  `);
  if (rows.length === 0) return pass(`Every clearing account is at zero on ${end}.`, { exceptions: 0 });
  const exceptions = [...rows].map((r) => `${r.code} ${r.name} ${formatMoney(num(r.balance))}`);
  const values: Record<string, number> = { exceptions: rows.length };
  for (const r of rows) values[r.code] = num(r.balance);
  return fail(
    `Clearing accounts not at zero on ${end}: ${listing(exceptions)}. A payout in transit over month end is ` +
      'legitimate; skip this task with that reason if so.',
    values,
  );
}

async function subledgerTies(side: 'ar' | 'ap', { exec, end }: CheckContext): Promise<Outcome> {
  const aging = side === 'ar' ? await arAging(end, exec) : await apAging(end, exec);
  const name = side === 'ar' ? 'receivables aging' : 'payables aging';
  const control = side === 'ar' ? `${ACCOUNTS.AR} Accounts Receivable` : `${ACCOUNTS.AP} Accounts Payable`;
  const values = {
    agingCents: aging.totals.total,
    controlCents: aging.controlBalanceCents,
    differenceCents: aging.differenceCents,
  };
  if (aging.differenceCents === 0) {
    return pass(`The ${name} (${formatMoney(aging.totals.total)}) ties to ${control}.`, values);
  }
  return fail(
    `The ${name} totals ${formatMoney(aging.totals.total)} but ${control} is ${formatMoney(aging.controlBalanceCents)}: ` +
      `${formatMoney(aging.differenceCents)} apart.`,
    values,
  );
}

async function recurringRaised({ exec, end }: CheckContext): Promise<Outcome> {
  const overdue = await overdueRecurringEntries(end, exec);
  if (overdue.length === 0) return pass('Every recurring entry due in the month has been raised.', { overdue: 0 });
  return fail(
    `${plural(overdue.length, 'recurring entry is', 'recurring entries are')} due and not raised: ` +
      `${listing(overdue.map((r) => `${r.name} (${r.nextDate})`))}.`,
    { overdue: overdue.length },
  );
}

async function cogsPosted({ exec, year, month }: CheckContext): Promise<Outcome> {
  const [row] = await exec.execute<{ shipped: string | number; posted: boolean }>(sql`
    select (select count(*) from shipment_units
             where period_year = ${year} and period_month = ${month} and units <> 0) as shipped,
           exists (select 1 from cogs_batches
                    where period_year = ${year} and period_month = ${month} and status = 'posted') as posted
  `);
  const shipped = num(row?.shipped);
  if (shipped === 0) return pass('No shipments are recorded for the month, so there is no COGS to post.', { shipmentLines: 0 });
  if (row?.posted === true) return pass('The COGS batch for the month is posted.', { shipmentLines: shipped });
  return fail(`${plural(shipped, 'shipment line is', 'shipment lines are')} recorded for the month but its COGS batch is not posted.`, {
    shipmentLines: shipped,
  });
}

async function inventoryTieout({ exec, start, end, options }: CheckContext): Promise<Outcome> {
  const tolerance = options.inventoryToleranceCents ?? DEFAULT_INVENTORY_TOLERANCE_CENTS;
  const [ledgerRow] = await exec.execute<{ balance: string | number }>(sql`
    select coalesce(sum(l.debit_cents - l.credit_cents), 0) as balance
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted' and e.entry_date <= ${end}
      join accounts a on a.id = l.account_id
     where a.subtype = 'inventory'
  `);
  const ledgerCents = num(ledgerRow?.balance);

  let tieout: Awaited<ReturnType<typeof computeTieout>> | null = null;
  try {
    tieout = await computeTieout(end, exec);
  } catch (error) {
    if (!isInventoryError(error) || error.code !== 'not_found') throw error;
  }

  if (tieout === null || tieout.snapshotDate < start) {
    if (Math.abs(ledgerCents) <= tolerance) {
      return pass(`The ledger carries ${formatMoney(ledgerCents)} of inventory, within tolerance of nothing to count.`, {
        ledgerCents,
        toleranceCents: tolerance,
      });
    }
    return fail(
      `The ledger carries ${formatMoney(ledgerCents)} of inventory but there is no count dated in the month to tie it to. ` +
        'Import a Peasy snapshot for the month end.',
      { ledgerCents, toleranceCents: tolerance },
    );
  }

  const values = {
    snapshotDate: tieout.snapshotDate,
    snapshotCents: tieout.snapshotValueCents,
    ledgerCents: tieout.ledgerValueCents,
    varianceCents: tieout.varianceCents,
    toleranceCents: tolerance,
  };
  if (Math.abs(tieout.varianceCents) <= tolerance) {
    return pass(
      `The ${tieout.snapshotDate} count (${formatMoney(tieout.snapshotValueCents)}) is within ${formatMoney(tolerance)} of the ledger.`,
      values,
    );
  }
  return fail(
    `The ${tieout.snapshotDate} count is ${formatMoney(tieout.snapshotValueCents)} against ${formatMoney(tieout.ledgerValueCents)} ` +
      `in the ledger: ${formatMoney(tieout.varianceCents)} apart, more than the ${formatMoney(tolerance)} tolerance.`,
    values,
  );
}

async function trialBalanceBalances({ exec, end }: CheckContext): Promise<Outcome> {
  const totals = trialBalanceTotals(await trialBalance({ asOf: end }, exec));
  const values = { debitCents: totals.debitCents, creditCents: totals.creditCents };
  if (totals.debitCents === totals.creditCents) {
    return pass(`The trial balance on ${end} balances at ${formatMoney(totals.debitCents)}.`, values);
  }
  return fail(
    `The trial balance on ${end} does not balance: debits ${formatMoney(totals.debitCents)}, credits ${formatMoney(totals.creditCents)}.`,
    values,
  );
}

const RUNNERS: Readonly<Record<AutoCheck, (ctx: CheckContext) => Promise<Outcome>>> = {
  no_draft_entries: noDraftEntries,
  bank_unreviewed_zero: bankUnreviewedZero,
  bank_recs_complete: bankRecsComplete,
  clearing_zero: clearingZero,
  ar_ties: (ctx) => subledgerTies('ar', ctx),
  ap_ties: (ctx) => subledgerTies('ap', ctx),
  recurring_raised: recurringRaised,
  cogs_posted: cogsPosted,
  inventory_tieout: inventoryTieout,
  trial_balance_balances: trialBalanceBalances,
};

/**
 * Runs one check inside its own savepoint, so a check that fails in the database
 * does not abort the caller's transaction. A check that throws is reported as
 * failed, with the reason, rather than lost.
 */
export async function runCheck(check: AutoCheck, ctx: CheckContext): Promise<CloseTaskResult> {
  const checkedAt = new Date().toISOString();
  try {
    const outcome = await ctx.exec.transaction((tx) => RUNNERS[check]({ ...ctx, exec: tx }));
    return { ...outcome, checkedAt };
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      message: `The check could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

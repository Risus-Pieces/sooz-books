/**
 * Puts Sooz's books in their starting state using only what the owner has already
 * authorised, then proves the result.
 *
 *   npx tsx scripts/post-authorized.ts            # post, then verify
 *   npx tsx scripts/post-authorized.ts --check    # verify only; post nothing
 *
 * It posts exactly two things, and nothing else:
 *
 *   1. `postOpeningBalances` for the Relay operating account (••9726): the $1,000.00 it
 *      held on 2026-01-14, credited to 3015 Member Contributions.
 *   2. `postAutoPostMatches` for the Relay accounts: the rows a rule the owner marked
 *      `auto_post` categorized — Relay banking fees, Square payouts to 1150, and the
 *      founder's ACH pulls from Chase College and BofA SafeBalance to 3015.
 *
 * Every other bank row — the review queue, the $50 transfer pair, the excluded RETURNED
 * ACH — is the owner's to review. The script snapshots those rows before posting and
 * fails if a single column of them changed.
 *
 * Both calls are idempotent. The script calls each a second time and fails if the
 * second call posts anything. It exits 1 on any failed check.
 */
import 'dotenv/config';
import { config } from 'dotenv';

config({ path: '.env.local', override: true });
// The session pooler is shared by everything on this project; this script needs two.
process.env.DB_POOL_MAX ??= '2';

const ARGS = new Set(process.argv.slice(2));
for (const arg of ARGS) {
  if (arg !== '--check') {
    process.stdout.write(`Unknown option "${arg}". Valid options: --check.\n`);
    process.exit(2);
  }
}
const CHECK_ONLY = ARGS.has('--check');

/** The owner's figures, from the Relay statements. */
const EXPECTED = {
  openingCents: 100_000,
  memberContributionsCents: 667_346,
  founderPulls: 12,
  founderPullsCents: 567_346,
  squareClearingCreditCents: 27_200,
  squareDeposits: 7,
  bankFeesCents: 900,
  autoPostRows: 21,
  statementBalance9726Cents: 52_967,
} as const;

interface HeldRow {
  id: string;
  status: string;
  journal_entry_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  suggested_account_id: string | null;
  rule_id: string | null;
  transfer_pair_id: string | null;
}

const problems: string[] = [];

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function check(ok: boolean, label: string, detail: string): void {
  line(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} ${detail}`);
  if (!ok) problems.push(`${label}: ${detail}`);
}

async function main(): Promise<void> {
  const { sql } = await import('@/db/client');
  const { postOpeningBalances } = await import('@/lib/ledger/opening-balances');
  const { postAutoPostMatches } = await import('@/lib/banking/post');
  const { trialBalance, trialBalanceTotals } = await import('@/lib/ledger/balances');
  const { balanceSheetReport } = await import('@/lib/reports/balance-sheet');
  const { profitAndLossReport } = await import('@/lib/reports/pnl');
  const { ACCOUNTS } = await import('@/lib/ledger/coa');
  const { formatMoney } = await import('@/lib/money');
  const { today } = await import('@/lib/dates');

  const money = (cents: number): string => formatMoney(cents);

  try {
    // -----------------------------------------------------------------------
    // Who, and which accounts
    // -----------------------------------------------------------------------
    const relay = await sql<{ id: string; mask: string; gl_code: string; opening_balance_cents: string }[]>`
      select ba.id, ba.mask, a.code as gl_code, ba.opening_balance_cents
        from bank_accounts ba
        join accounts a on a.id = ba.account_id
       where ba.institution = 'Relay' and ba.active
       order by ba.mask`;
    const operating = relay.find((row) => row.mask === '9726');
    if (operating === undefined) throw new Error('The active Relay ••9726 account is missing.');

    const [actorRow] = await sql<{ id: string; email: string }[]>`
      select u.id, u.email
        from app_users u
        join app_settings s on lower(s.owner_email) = lower(u.email)
       where u.active`;
    const userId = actorRow?.id ?? null;

    line('Sooz Books — posting what the owner has authorised');
    line(`  actor: ${actorRow === undefined ? 'system (the owner has not signed in yet; audit actor is null)' : actorRow.email}`);
    line(`  mode:  ${CHECK_ONLY ? 'check only — nothing will be posted' : 'post, then verify'}`);
    line();

    // -----------------------------------------------------------------------
    // Preflight: the auto-post candidates must be exactly the owner's rules'
    // matches on Relay, and nothing else.
    // -----------------------------------------------------------------------
    const relayIds = relay.map((row) => row.id);
    const candidates = await sql<{ id: string; bank_account_id: string; rule: string; amount_cents: string }[]>`
      select bt.id, bt.bank_account_id, r.name as rule, bt.amount_cents
        from bank_transactions bt
        join categorization_rules r on r.id = bt.rule_id
       where bt.status = 'categorized'
         and bt.journal_entry_id is null
         and bt.transfer_pair_id is null
         and bt.refund_of_txn_id is null
         and r.auto_post and r.active
         and bt.bank_account_id = any(${relayIds}::uuid[])`;
    line(`Auto-post candidates awaiting posting on Relay: ${candidates.length}`);
    for (const [rule, rows] of groupBy(candidates, (row) => row.rule)) {
      line(`  ${rule.padEnd(42)} ${String(rows.length).padStart(3)}  ${money(sumOf(rows))}`);
    }
    line();

    const held = await heldRows(sql, relayIds);

    // -----------------------------------------------------------------------
    // Post
    // -----------------------------------------------------------------------
    if (!CHECK_ONLY) {
      line('1. Opening balance');
      const opening = await postOpeningBalances({ userId }, { bankAccountIds: [operating.id] });
      for (const result of opening) line(`  ${result.name}: ${describeOpening(result)}`);

      line('2. Auto-post matches');
      let postedCount = 0;
      for (const account of relay) {
        const report = await postAutoPostMatches({ userId }, { bankAccountId: account.id });
        postedCount += report.posted.length;
        if (report.posted.length > 0) line(`  ••${account.mask}: posted ${report.posted.length}`);
        for (const failed of report.failed) {
          line(`  ••${account.mask}: FAILED ${failed.txnId} — ${failed.error}`);
          problems.push(`auto-post ${failed.txnId}: ${failed.error}`);
        }
      }
      line(`  total posted this run: ${postedCount}`);
      line();
    }

    // -----------------------------------------------------------------------
    // Idempotence: a second call posts nothing.
    // -----------------------------------------------------------------------
    line('Verification');
    if (!CHECK_ONLY) {
      const again = await postOpeningBalances({ userId }, { bankAccountIds: [operating.id] });
      const reposted = again.filter((result) => result.status === 'posted').length;
      check(reposted === 0, 'second postOpeningBalances posts nothing', `${reposted} posted; ${again.map((r) => r.status).join(', ')}`);
      let repostedRows = 0;
      for (const account of relay) {
        const report = await postAutoPostMatches({ userId }, { bankAccountId: account.id });
        repostedRows += report.posted.length + report.failed.length;
      }
      check(repostedRows === 0, 'second postAutoPostMatches posts nothing', `${repostedRows} rows touched`);
    }

    // The owner's rows are exactly as they were.
    const heldAfter = await heldRows(sql, relayIds);
    const changed = diffHeld(held, heldAfter);
    check(changed.length === 0, 'review queue, transfer pair, excluded untouched', `${held.size} rows compared, ${changed.length} changed`);

    // What is in the ledger, by source.
    const entries = await sql<{ source_type: string; rule: string | null; n: string; cents: string }[]>`
      select e.source_type, r.name as rule, count(*) as n,
             sum((select sum(l.debit_cents) from journal_lines l where l.entry_id = e.id)) as cents
        from journal_entries e
        left join bank_transactions bt on e.source_type = 'bank' and bt.id = e.source_id
        left join categorization_rules r on r.id = bt.rule_id
       where e.status = 'posted'
       group by 1, 2 order by 1, 2`;
    const openingEntries = entries.filter((row) => row.source_type === 'opening_balance');
    const bankEntries = entries.filter((row) => row.source_type === 'bank');
    const otherEntries = entries.filter((row) => row.source_type !== 'bank' && row.source_type !== 'opening_balance');
    check(sumN(openingEntries) === 1, 'one opening-balance entry', `${sumN(openingEntries)}`);
    check(sumN(bankEntries) === EXPECTED.autoPostRows, `${EXPECTED.autoPostRows} bank entries, all auto-post rules`, bankEntries.map((r) => `${r.rule ?? 'no rule'}=${r.n}`).join('; '));
    check(otherEntries.length === 0, 'no entries from any other source', otherEntries.map((r) => `${r.source_type}=${r.n}`).join('; ') || 'none');

    const unreviewedPosted = await sql<{ n: string }[]>`
      select count(*) as n from bank_transactions bt
       where bt.bank_account_id = any(${relayIds}::uuid[])
         and bt.journal_entry_id is not null
         and (bt.status <> 'categorized' or bt.rule_id is null
              or not exists (select 1 from categorization_rules r where r.id = bt.rule_id and r.auto_post))`;
    check(Number(unreviewedPosted[0].n) === 0, 'no row outside auto-post rules is posted', `${unreviewedPosted[0].n}`);

    // Trial balance.
    const asOf = today();
    const tb = await trialBalance({ asOf });
    const totals = trialBalanceTotals(tb);
    check(
      totals.debitCents === totals.creditCents,
      'trial balance ties',
      `debits ${money(totals.debitCents)} = credits ${money(totals.creditCents)}`,
    );
    const byCode = new Map(tb.map((row) => [row.code, row]));
    const balanceOf = (code: string): number => byCode.get(code)?.balanceCents ?? 0;

    // Balance sheet.
    const bs = await balanceSheetReport({ from: '2026-01-01', to: asOf, columns: 'total', basis: 'accrual', includeZeroRows: false });
    const outOfBalance = bs.totals.outOfBalance[0] ?? 0;
    check(
      outOfBalance === 0,
      'balance sheet balances',
      `assets ${money(bs.totals.assets[0] ?? 0)} = liabilities ${money(bs.totals.liabilities[0] ?? 0)} + equity ${money(bs.totals.equity[0] ?? 0)}`,
    );

    // Account figures.
    const pulls = await sql<{ n: string; cents: string }[]>`
      select count(*) as n, coalesce(sum(bt.amount_cents), 0) as cents
        from bank_transactions bt
        join categorization_rules r on r.id = bt.rule_id
        join accounts a on a.id = r.account_id
       where bt.journal_entry_id is not null and a.code = ${ACCOUNTS.MEMBER_CONTRIBUTIONS}`;
    check(
      balanceOf(ACCOUNTS.MEMBER_CONTRIBUTIONS) === EXPECTED.memberContributionsCents,
      '3015 Member Contributions',
      `${money(balanceOf(ACCOUNTS.MEMBER_CONTRIBUTIONS))} (expected ${money(EXPECTED.memberContributionsCents)})`,
    );
    check(
      Number(pulls[0].n) === EXPECTED.founderPulls && Number(pulls[0].cents) === EXPECTED.founderPullsCents,
      '  of which founder ACH pulls',
      `${pulls[0].n} pulls, ${money(Number(pulls[0].cents))} + opening ${money(EXPECTED.openingCents)}`,
    );

    const square = await sql<{ n: string }[]>`
      select count(*) as n
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.status = 'posted'
        join accounts a on a.id = l.account_id
       where a.code = ${ACCOUNTS.CLEARING_SQUARE} and l.credit_cents > 0`;
    const squareBalance = balanceOf(ACCOUNTS.CLEARING_SQUARE);
    check(
      squareBalance === -EXPECTED.squareClearingCreditCents && Number(square[0].n) === EXPECTED.squareDeposits,
      '1150 Square Clearing (credit balance)',
      `${money(-squareBalance)} credit across ${square[0].n} deposits`,
    );
    check(
      balanceOf(ACCOUNTS.BANK_FEES) === EXPECTED.bankFeesCents,
      '6710 Bank & Merchant Fees',
      money(balanceOf(ACCOUNTS.BANK_FEES)),
    );

    // P&L: the fees are the only income-statement activity.
    const pnl = await profitAndLossReport({ from: '2026-01-01', to: asOf, columns: 'total', basis: 'accrual', includeZeroRows: false });
    const netIncome = pnl.totals.netIncome[0] ?? 0;
    check(netIncome === -EXPECTED.bankFeesCents, 'P&L net income', `${money(netIncome)} (the bank fees)`);

    // -----------------------------------------------------------------------
    // ••9726: book vs bank, reconciled to the cent.
    // -----------------------------------------------------------------------
    const book = balanceOf(operating.gl_code);
    const [statement] = await sql<{ rows_net: string; last_balance: string | null }[]>`
      select coalesce(sum(amount_cents), 0) as rows_net,
             (select balance_cents from bank_transactions
               where bank_account_id = ${operating.id} and balance_cents is not null
               order by txn_date desc, created_at desc limit 1) as last_balance
        from bank_transactions where bank_account_id = ${operating.id}`;
    const bank = Number(operating.opening_balance_cents) + Number(statement.rows_net);
    check(bank === EXPECTED.statementBalance9726Cents, '••9726 bank balance', `${money(bank)} (statement ${money(EXPECTED.statementBalance9726Cents)}; last row ${statement.last_balance === null ? 'n/a' : money(Number(statement.last_balance))})`);

    const pending = await sql<{ status: string; n: string; cents: string }[]>`
      select status, count(*) as n, coalesce(sum(amount_cents), 0) as cents
        from bank_transactions
       where bank_account_id = ${operating.id} and journal_entry_id is null and status <> 'excluded'
       group by status order by status`;
    const pendingNet = pending.reduce((acc, row) => acc + Number(row.cents), 0);
    line();
    line(`  ••9726 (${operating.gl_code}) book balance   ${money(book).padStart(14)}`);
    line(`  ••9726 bank balance            ${money(bank).padStart(14)}`);
    line(`  book − bank                    ${money(book - bank).padStart(14)}`);
    for (const row of pending) {
      line(`    unposted ${row.status.padEnd(12)} ${row.n.padStart(3)} rows ${money(Number(row.cents)).padStart(14)}`);
    }
    line(`    net awaiting the owner          ${money(pendingNet).padStart(14)}`);
    check(book - bank === -pendingNet, '••9726 difference = unposted rows, to the cent', `${money(book - bank)} = −(${money(pendingNet)})`);
  } finally {
    await sql.end({ timeout: 5 });
  }

  line();
  if (problems.length === 0) {
    line('All checks passed.');
  } else {
    line(`${problems.length} check(s) failed:`);
    for (const problem of problems) line(`  - ${problem}`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

type Sql = typeof import('@/db/client')['sql'];

/** Every Relay row the owner has yet to decide on: not posted, not an auto-post candidate. */
async function heldRows(sql: Sql, relayIds: string[]): Promise<Map<string, HeldRow>> {
  const rows = await sql<HeldRow[]>`
    select bt.id, bt.status::text as status, bt.journal_entry_id, bt.reviewed_by,
           bt.reviewed_at::text as reviewed_at, bt.suggested_account_id, bt.rule_id, bt.transfer_pair_id
      from bank_transactions bt
      left join categorization_rules r on r.id = bt.rule_id
     where bt.bank_account_id = any(${relayIds}::uuid[])
       and not (bt.status = 'categorized' and coalesce(r.auto_post, false))`;
  return new Map(rows.map((row) => [row.id, row]));
}

function diffHeld(before: Map<string, HeldRow>, after: Map<string, HeldRow>): string[] {
  const changed: string[] = [];
  for (const [id, row] of before) {
    const now = after.get(id);
    if (now === undefined || JSON.stringify(now) !== JSON.stringify(row)) changed.push(id);
  }
  for (const id of after.keys()) if (!before.has(id)) changed.push(id);
  return changed;
}

function describeOpening(result: import('@/lib/ledger/opening-balances').OpeningBalanceResult): string {
  switch (result.status) {
    case 'posted':
      return `posted entry #${result.entryNo} to ${result.equityAccountCode}`;
    case 'already_posted':
      return 'already posted';
    case 'skipped':
      return `skipped (${result.reason})`;
    case 'failed':
      problems.push(`opening balance ${result.name}: ${result.error}`);
      return `FAILED — ${result.error}`;
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k) ?? [];
    list.push(row);
    out.set(k, list);
  }
  return out;
}

function sumOf(rows: readonly { amount_cents: string }[]): number {
  return rows.reduce((acc, row) => acc + Number(row.amount_cents), 0);
}

function sumN(rows: readonly { n: string }[]): number {
  return rows.reduce((acc, row) => acc + Number(row.n), 0);
}

main().catch((error: unknown) => {
  process.stdout.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});

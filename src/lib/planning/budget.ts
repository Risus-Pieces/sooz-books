/**
 * Budgets: versions, monthly lines, CSV import and a copy of last year's actuals.
 *
 * A version belongs to a fiscal year (Sooz's fiscal year is the calendar year)
 * and moves draft → active → archived. At most one version is active per year —
 * the database enforces it with a partial unique index, and activating a version
 * archives the one it replaces in the same transaction — and the active version
 * is what budget-vs-actual compares against unless the reader picks another.
 *
 * A line is one cell: account × month, optionally × channel. Amounts are held in
 * the sign the statement prints them in, so a budget reads the way the P&L
 * does: revenue positive, a contra-revenue deduction (a slotting fee, a
 * marketplace commission) positive, an expense positive. Only profit-and-loss
 * accounts that can be posted to take a budget; a rollup is a heading.
 */

import Papa from 'papaparse';
import { and, asc, eq, sql } from 'drizzle-orm';

import { type BudgetLine, type BudgetVersion, accounts, budgetLines, budgetVersions, channels } from '@/db/schema';
import { parseMoney } from '@/lib/money';
import type { LedgerDb } from '@/lib/ledger/post';
import { formatBasisPoints } from '@/lib/reports/types';

import { PlanningError, type PlanningCtx, cents, inTx, reader } from './context';
import { roundDiv } from './forecast-math';

/* ------------------------------------------------------------------ versions */

export interface NewBudgetVersionInput {
  name: string;
  fiscalYear: number;
  notes?: string | null;
}

function assertYear(year: number): void {
  if (!Number.isInteger(year) || year < 2000 || year > 2999) {
    throw new PlanningError('invalid_input', `${year} is not a usable fiscal year.`);
  }
}

export async function createBudgetVersion(input: NewBudgetVersionInput, ctx: PlanningCtx): Promise<BudgetVersion> {
  const name = input.name.trim();
  if (name === '') throw new PlanningError('invalid_input', 'A budget version needs a name.');
  assertYear(input.fiscalYear);
  return inTx(ctx, async (tx) => {
    const [clash] = await tx
      .select({ id: budgetVersions.id })
      .from(budgetVersions)
      .where(and(eq(budgetVersions.name, name), eq(budgetVersions.fiscalYear, input.fiscalYear)));
    if (clash !== undefined) {
      throw new PlanningError('duplicate', `A ${input.fiscalYear} budget named "${name}" already exists.`);
    }
    const [created] = await tx
      .insert(budgetVersions)
      .values({ name, fiscalYear: input.fiscalYear, notes: input.notes ?? null, createdBy: ctx.userId })
      .returning();
    return created;
  });
}

async function lockVersion(tx: LedgerDb, versionId: string): Promise<BudgetVersion> {
  const [version] = await tx.select().from(budgetVersions).where(eq(budgetVersions.id, versionId)).for('update');
  if (version === undefined) throw new PlanningError('not_found', 'That budget version does not exist.');
  return version;
}

/** Makes a version the year's active budget, archiving whichever was active before. */
export async function activateBudgetVersion(versionId: string, ctx: PlanningCtx): Promise<BudgetVersion> {
  return inTx(ctx, async (tx) => {
    const version = await lockVersion(tx, versionId);
    if (version.status === 'active') return version;
    await tx
      .update(budgetVersions)
      .set({ status: 'archived' })
      .where(and(eq(budgetVersions.fiscalYear, version.fiscalYear), eq(budgetVersions.status, 'active')));
    const [updated] = await tx
      .update(budgetVersions)
      .set({ status: 'active' })
      .where(eq(budgetVersions.id, versionId))
      .returning();
    return updated;
  });
}

export async function archiveBudgetVersion(versionId: string, ctx: PlanningCtx): Promise<BudgetVersion> {
  return inTx(ctx, async (tx) => {
    await lockVersion(tx, versionId);
    const [updated] = await tx
      .update(budgetVersions)
      .set({ status: 'archived' })
      .where(eq(budgetVersions.id, versionId))
      .returning();
    return updated;
  });
}

export async function listBudgetVersions(exec?: LedgerDb): Promise<BudgetVersion[]> {
  return reader(exec)
    .select()
    .from(budgetVersions)
    .orderBy(asc(budgetVersions.fiscalYear), asc(budgetVersions.name));
}

export async function activeBudgetVersion(fiscalYear: number, exec?: LedgerDb): Promise<BudgetVersion | null> {
  const [row] = await reader(exec)
    .select()
    .from(budgetVersions)
    .where(and(eq(budgetVersions.fiscalYear, fiscalYear), eq(budgetVersions.status, 'active')));
  return row ?? null;
}

/* --------------------------------------------------------------------- lines */

export interface BudgetLineInput {
  accountCode: string;
  /** Channel code (DTC, AMAZON, …). Omit for a budget that is not by channel. */
  channelCode?: string | null;
  month: number;
  /** In the statement's sign: positive revenue, positive deduction, positive expense. */
  amountCents: number;
  notes?: string | null;
}

interface AccountRef {
  id: string;
  code: string;
  type: string;
  subtype: string | null;
  active: boolean;
  isRollup: boolean;
}

async function budgetableAccounts(exec: LedgerDb): Promise<Map<string, AccountRef>> {
  const rows = await exec.execute<{
    id: string;
    code: string;
    type: string;
    subtype: string | null;
    active: boolean;
    is_rollup: boolean;
  }>(sql`
    select a.id, a.code, a.type::text as type, a.subtype, a.active,
           exists (select 1 from accounts c where c.parent_id = a.id) as is_rollup
      from accounts a
  `);
  return new Map(
    [...rows].map((r) => [
      r.code,
      { id: r.id, code: r.code, type: r.type, subtype: r.subtype, active: r.active, isRollup: r.is_rollup },
    ]),
  );
}

async function channelIdsByCode(exec: LedgerDb): Promise<Map<string, string>> {
  const rows = await exec.select({ id: channels.id, code: channels.code }).from(channels);
  return new Map(rows.map((r) => [r.code.toUpperCase(), r.id]));
}

interface ResolvedLine {
  accountId: string;
  channelId: string | null;
  month: number;
  amountCents: number;
  notes: string | null;
}

function resolveLine(
  line: BudgetLineInput,
  accountsByCode: ReadonlyMap<string, AccountRef>,
  channelByCode: ReadonlyMap<string, string>,
): ResolvedLine {
  const account = accountsByCode.get(line.accountCode.trim());
  if (account === undefined) throw new PlanningError('invalid_input', `Account ${line.accountCode} is not in the chart.`);
  if (account.type !== 'revenue' && account.type !== 'expense') {
    throw new PlanningError('invalid_input', `Account ${account.code} is a ${account.type} account; budgets cover income and expense.`);
  }
  if (account.isRollup) {
    throw new PlanningError('invalid_input', `Account ${account.code} is a heading; budget one of the accounts under it.`);
  }
  if (!Number.isInteger(line.month) || line.month < 1 || line.month > 12) {
    throw new PlanningError('invalid_input', `${line.month} is not a month between 1 and 12.`);
  }
  if (!Number.isSafeInteger(line.amountCents)) {
    throw new PlanningError('invalid_input', `The amount for ${account.code} is not a whole number of cents.`);
  }
  let channelId: string | null = null;
  const code = line.channelCode?.trim() ?? '';
  if (code !== '') {
    const found = channelByCode.get(code.toUpperCase());
    if (found === undefined) throw new PlanningError('invalid_input', `Channel ${code} does not exist.`);
    channelId = found;
  }
  return { accountId: account.id, channelId, month: line.month, amountCents: line.amountCents, notes: line.notes ?? null };
}

async function upsertLines(tx: LedgerDb, version: BudgetVersion, lines: readonly ResolvedLine[]): Promise<number> {
  if (lines.length === 0) return 0;
  // One cell appears once: the last value given for a cell wins, as in a spreadsheet.
  const byCell = new Map<string, ResolvedLine>();
  for (const line of lines) byCell.set(`${line.accountId}|${line.channelId ?? ''}|${line.month}`, line);
  const values = [...byCell.values()].map((line) => ({
    versionId: version.id,
    accountId: line.accountId,
    channelId: line.channelId,
    year: version.fiscalYear,
    month: line.month,
    amountCents: line.amountCents,
    notes: line.notes,
  }));
  for (let i = 0; i < values.length; i += 500) {
    await tx
      .insert(budgetLines)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [budgetLines.versionId, budgetLines.accountId, budgetLines.channelId, budgetLines.year, budgetLines.month],
        set: { amountCents: sql`excluded.amount_cents`, notes: sql`excluded.notes` },
      });
  }
  return values.length;
}

function assertEditable(version: BudgetVersion): void {
  if (version.status === 'archived') {
    throw new PlanningError('invalid_state', `"${version.name}" is archived. Copy it into a new version to change it.`);
  }
}

/** Sets budget cells, replacing any value already in each cell. Returns the cells written. */
export async function setBudgetLines(
  versionId: string,
  lines: readonly BudgetLineInput[],
  ctx: PlanningCtx,
): Promise<number> {
  return inTx(ctx, async (tx) => {
    const version = await lockVersion(tx, versionId);
    assertEditable(version);
    const accountsByCode = await budgetableAccounts(tx);
    const channelByCode = await channelIdsByCode(tx);
    const resolved = lines.map((line) => resolveLine(line, accountsByCode, channelByCode));
    return upsertLines(tx, version, resolved);
  });
}

export async function listBudgetLines(versionId: string, exec?: LedgerDb): Promise<BudgetLine[]> {
  return reader(exec)
    .select()
    .from(budgetLines)
    .where(eq(budgetLines.versionId, versionId))
    .orderBy(asc(budgetLines.accountId), asc(budgetLines.month));
}

/* ----------------------------------------------------------------------- CSV */

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * Reads a month column header: `Jan`, `January`, `Jan 2027`, `2027-01`, `01/2027`
 * or a bare `1`–`12`. A header naming a different year than the version is
 * refused rather than silently moved into the version's year.
 */
export function monthOfHeader(header: string, fiscalYear: number): number | null {
  const text = header.trim().toLowerCase();
  if (text === '') return null;
  let month: number | null = null;
  let year: number | null = null;

  const isoLike = /^(\d{4})[-/](\d{1,2})$/.exec(text);
  const usLike = /^(\d{1,2})[-/](\d{4})$/.exec(text);
  const named = /^([a-z]{3,9})\.?(?:[\s-]+(\d{2}|\d{4}))?$/.exec(text);
  if (isoLike) {
    year = Number(isoLike[1]);
    month = Number(isoLike[2]);
  } else if (usLike) {
    month = Number(usLike[1]);
    year = Number(usLike[2]);
  } else if (/^\d{1,2}$/.test(text)) {
    month = Number(text);
  } else if (named) {
    const word = named[1];
    const index = MONTH_NAMES.findIndex((name) => word.length >= 3 && name.startsWith(word));
    if (index === -1) return null;
    month = index + 1;
    if (named[2] !== undefined) year = named[2].length === 2 ? 2000 + Number(named[2]) : Number(named[2]);
  }
  if (month === null || month < 1 || month > 12) return null;
  if (year !== null && year !== fiscalYear) {
    throw new PlanningError(
      'import_refused',
      `Column "${header}" is for ${year}, but this budget is for ${fiscalYear}.`,
    );
  }
  return month;
}

export interface BudgetCsvResult {
  cellsWritten: number;
  rowsRead: number;
  /** When `replace` was set, the cells removed before the import. */
  cellsRemoved: number;
}

/**
 * Imports a budget grid:
 *
 *     Account, Channel, Jan, Feb, …, Dec
 *     6510,           , 1500.00, 1500.00, …
 *     4015 Direct & Market Sales (Square), , 250, 300, …
 *
 * The account column takes a code, or a code followed by the name as exported
 * from a chart. The channel column is optional. Blank cells are left alone;
 * amounts are dollars in any form `parseMoney` reads. Every row is checked
 * before anything is written, and a file with any bad row is refused whole, with
 * every problem listed — a half-imported budget is worse than none.
 */
export async function importBudgetCsv(
  versionId: string,
  csvText: string,
  ctx: PlanningCtx,
  options: { replace?: boolean } = {},
): Promise<BudgetCsvResult> {
  return inTx(ctx, async (tx) => {
    const version = await lockVersion(tx, versionId);
    assertEditable(version);

    const parsed = Papa.parse<string[]>(csvText.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
    const grid = parsed.data;
    if (grid.length < 2) throw new PlanningError('import_refused', 'The file has no budget rows under its header.');

    const header = grid[0].map((cell) => cell.trim());
    const accountCol = header.findIndex((h) => /^(account|account code|code|gl account)$/i.test(h));
    if (accountCol === -1) {
      throw new PlanningError('import_refused', 'The header needs an "Account" column holding account codes.');
    }
    const channelCol = header.findIndex((h) => /^channel( code)?$/i.test(h));
    const monthCols: Array<{ col: number; month: number }> = [];
    header.forEach((h, col) => {
      if (col === accountCol || col === channelCol) return;
      const month = monthOfHeader(h, version.fiscalYear);
      if (month !== null) monthCols.push({ col, month });
    });
    if (monthCols.length === 0) {
      throw new PlanningError('import_refused', 'No month columns found. Name them Jan–Dec or YYYY-MM.');
    }
    const seenMonths = new Set<number>();
    for (const { month } of monthCols) {
      if (seenMonths.has(month)) throw new PlanningError('import_refused', `Month ${month} appears in two columns.`);
      seenMonths.add(month);
    }

    const accountsByCode = await budgetableAccounts(tx);
    const channelByCode = await channelIdsByCode(tx);
    const problems: string[] = [];
    const resolved: ResolvedLine[] = [];

    grid.slice(1).forEach((cells, index) => {
      const rowNo = index + 2;
      const accountCell = (cells[accountCol] ?? '').trim();
      if (accountCell === '') {
        if (cells.some((c) => c.trim() !== '')) problems.push(`Row ${rowNo}: no account.`);
        return;
      }
      const code = /^[0-9A-Za-z.-]+/.exec(accountCell)?.[0] ?? accountCell;
      const channelCode = channelCol === -1 ? null : (cells[channelCol] ?? '').trim() || null;
      for (const { col, month } of monthCols) {
        const raw = (cells[col] ?? '').trim();
        if (raw === '') continue;
        try {
          const amountCents = parseMoney(raw);
          resolved.push(resolveLine({ accountCode: code, channelCode, month, amountCents }, accountsByCode, channelByCode));
        } catch (error) {
          problems.push(`Row ${rowNo}, ${header[col]}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });

    if (problems.length > 0) {
      throw new PlanningError(
        'import_refused',
        `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} in the file; nothing was imported.`,
        problems,
      );
    }

    let cellsRemoved = 0;
    if (options.replace === true) {
      const removed = await tx.delete(budgetLines).where(eq(budgetLines.versionId, version.id)).returning({ id: budgetLines.id });
      cellsRemoved = removed.length;
    }
    const cellsWritten = await upsertLines(tx, version, resolved);
    return { cellsWritten, rowsRead: grid.length - 1, cellsRemoved };
  });
}

/* ------------------------------------------------------ copy from actuals */

export interface CopyFromActualsInput {
  versionId: string;
  /** The year whose posted actuals seed the budget. */
  sourceYear: number;
  /**
   * Growth in basis points applied to every cell: 1000 is +10%, −500 is −5%.
   * Each cell rounds half away from zero on its own.
   */
  growthBps: number;
  /** Keep the channel on each cell; otherwise every channel folds into one cell. */
  byChannel?: boolean;
  /** Clear the version's existing lines first. */
  replace?: boolean;
}

export interface CopyFromActualsResult {
  cellsWritten: number;
  /** Sum of the source actuals copied, in statement sign, before growth. */
  sourceTotalCents: number;
}

interface ActualCellRow extends Record<string, unknown> {
  account_id: string;
  channel_id: string | null;
  month: number;
  amount_cents: string | number;
}

/** Seeds a budget from a year of posted actuals, grown by a factor. */
export async function copyBudgetFromActuals(
  input: CopyFromActualsInput,
  ctx: PlanningCtx,
): Promise<CopyFromActualsResult> {
  assertYear(input.sourceYear);
  if (!Number.isInteger(input.growthBps) || input.growthBps <= -10_000) {
    throw new PlanningError('invalid_input', 'Growth must be a whole number of basis points above −10,000 (−100%).');
  }
  return inTx(ctx, async (tx) => {
    const version = await lockVersion(tx, input.versionId);
    assertEditable(version);
    const byChannel = input.byChannel === true;

    // Statement sign: account_sign turns every account positive in its normal
    // direction; contra revenue is then flipped so a deduction reads positive.
    const rows = await tx.execute<ActualCellRow>(sql`
      select l.account_id,
             ${byChannel ? sql`l.channel_id` : sql`null::uuid`} as channel_id,
             extract(month from e.entry_date)::int as month,
             sum(account_sign(a.type) * (l.debit_cents - l.credit_cents)
                 * case when a.subtype = 'contra_revenue' then -1 else 1 end) as amount_cents
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id
       where e.status = 'posted'
         and e.entry_date between ${`${input.sourceYear}-01-01`} and ${`${input.sourceYear}-12-31`}
         and a.type in ('revenue', 'expense')
         and not exists (select 1 from accounts c where c.parent_id = a.id)
       group by 1, 2, 3
    `);

    let sourceTotalCents = 0;
    const resolved: ResolvedLine[] = [];
    for (const r of rows) {
      const actual = cents(r.amount_cents);
      if (actual === 0) continue;
      sourceTotalCents += actual;
      const grown = Number(roundDiv(BigInt(actual) * BigInt(10_000 + input.growthBps), BigInt(10_000)));
      resolved.push({
        accountId: r.account_id,
        channelId: r.channel_id,
        month: Number(r.month),
        amountCents: grown,
        notes: `${input.sourceYear} actual ${formatBasisPoints(input.growthBps, { sign: true })}`,
      });
    }

    if (input.replace === true) await tx.delete(budgetLines).where(eq(budgetLines.versionId, version.id));
    const cellsWritten = await upsertLines(tx, version, resolved);
    return { cellsWritten, sourceTotalCents };
  });
}

/** Accounts a budget can be entered against, for a picker. */
export async function budgetAccountOptions(
  exec?: LedgerDb,
): Promise<Array<{ id: string; code: string; name: string; type: string }>> {
  return reader(exec)
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
    .from(accounts)
    .where(
      and(
        eq(accounts.active, true),
        sql`${accounts.type} in ('revenue', 'expense')`,
        // Spelled out: drizzle renders a lone table's column unqualified, which the
        // subquery would read as its own.
        sql`not exists (select 1 from accounts c where c.parent_id = accounts.id)`,
      ),
    )
    .orderBy(asc(accounts.code));
}

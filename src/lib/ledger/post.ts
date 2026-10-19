/**
 * The posting engine. This module is the only code in the product that writes
 * `journal_lines`; every other module — bank import, invoices, bills, payouts,
 * deductions, COGS, the QuickBooks migration — hands a draft entry to
 * `postJournalEntry` and lets it deal with the ledger.
 *
 * The database enforces the accounting invariants itself: a posted entry must
 * balance and have at least two lines (a constraint trigger deferred to COMMIT),
 * a posted entry and its lines are immutable and undeletable, and nothing posts
 * into a closed period. That makes exactly one posting sequence legal, and it is
 * the one below: insert the entry as a draft, insert its lines, flip it to
 * posted, all inside a single transaction.
 *
 * Everything this module can check without the database — shape, amounts,
 * balance — it checks first, so a bad entry never reaches a trigger. The checks
 * that do need the database (does the account exist, is the period open) run
 * inside the same transaction that writes, and they exist so the UI gets a
 * readable, typed error instead of a trigger's exception text.
 */

import { type ExtractTablesWithRelations, and, eq, inArray, or, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';

import { withActor } from '@/db/client';
import { accounts, journalEntries, journalLines, periods } from '@/db/schema';
import { type CalendarDate, isCalendarDate, periodOf } from '@/lib/dates';
import { constraintOf, postgresErrorOf } from '@/lib/db-errors';
import { sumCents } from '@/lib/money';

import {
  ClosedPeriodError,
  ControlAccountError,
  ImmutableEntryError,
  InvalidAmountError,
  InvalidDateError,
  InvalidReferenceError,
  LedgerError,
  OwnedEntryError,
  RollupAccountError,
  UnbalancedEntryError,
  UnknownAccountError,
} from './errors';

type Schema = typeof import('@/db/schema');

/**
 * Anything that can run a statement: the pooled database, or a transaction a
 * caller opened to post several entries alongside its own sub-ledger rows.
 */
export type LedgerDb = PgDatabase<PostgresJsQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/**
 * The document a journal entry came from. Free text in the database so new
 * modules need no migration, but narrowed here: a typo in a source type would
 * silently break the provenance links every drill-down and reconciliation uses.
 */
export const SOURCE_TYPES = [
  'manual',
  'bank',
  'invoice',
  'receipt',
  'credit_memo',
  'bill',
  'bill_payment',
  'vendor_credit',
  'purchase_receipt',
  'payout',
  'deduction',
  'cogs',
  'inventory',
  'landed_cost',
  'accrual',
  'depreciation',
  'payroll',
  'sales_tax',
  'recurring',
  'reversal',
  'opening_balance',
  'qbo_migration',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Sources allowed to move a control account. AR and AP are owned by the invoice
 * and bill sub-ledgers; only the documents those sub-ledgers raise may touch
 * them, so the aging reports and the general ledger cannot drift apart.
 */
export const SUB_LEDGER_SOURCE_TYPES = [
  'invoice',
  'receipt',
  'bill',
  'bill_payment',
  'credit_memo',
  'vendor_credit',
  'deduction',
  'qbo_migration',
] as const;

export type SubLedgerSourceType = (typeof SUB_LEDGER_SOURCE_TYPES)[number];

const SOURCE_TYPE_SET: ReadonlySet<string> = new Set(SOURCE_TYPES);
const SUB_LEDGER_SET: ReadonlySet<string> = new Set(SUB_LEDGER_SOURCE_TYPES);

export function isSourceType(value: string): value is SourceType {
  return SOURCE_TYPE_SET.has(value);
}

export function isSubLedgerSource(value: string): value is SubLedgerSourceType {
  return SUB_LEDGER_SET.has(value);
}

export interface DraftLine {
  /** Semantic account code from `ACCOUNTS` in `./coa`. Either this or `accountId`. */
  accountCode?: string;
  accountId?: string;
  debitCents?: number;
  creditCents?: number;
  memo?: string;
  channelId?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  productId?: string | null;
}

export interface DraftEntry {
  date: CalendarDate;
  memo?: string;
  sourceType: SourceType;
  sourceId?: string | null;
  /** Set only by `reverseEntry`; a posted entry's `reverses_id` is immutable. */
  reversesId?: string | null;
  lines: readonly DraftLine[];
}

export interface PostContext {
  userId: string | null;
  /**
   * An open transaction to post inside. Callers use it to write their own
   * sub-ledger rows and the entries that back them atomically. It must already
   * have `app.user_id` set — `withActor` does that — or the audit trail will
   * record a null actor.
   */
  tx?: LedgerDb;
}

export interface PostedEntry {
  entryId: string;
  entryNo: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PreparedLine {
  lineNo: number;
  accountCode: string | null;
  accountId: string | null;
  debitCents: number;
  creditCents: number;
  memo: string | null;
  channelId: string | null;
  customerId: string | null;
  vendorId: string | null;
  productId: string | null;
}

interface PreparedEntry {
  date: CalendarDate;
  memo: string | null;
  sourceType: SourceType;
  sourceId: string | null;
  reversesId: string | null;
  lines: PreparedLine[];
}

interface ResolvedAccount {
  id: string;
  code: string;
  name: string;
  active: boolean;
  isControl: boolean;
  /** Some other account names this one as its parent: a report header, not postable. */
  isRollup: boolean;
}

function dimension(field: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!UUID.test(value)) throw new InvalidReferenceError(field, value, `${field} is not a uuid.`);
  return value;
}

function optionalText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Everything that can be decided without the database. Runs before a connection
 * is taken, so a malformed entry costs nothing and the caller gets the precise
 * line that is wrong.
 */
function prepare(input: DraftEntry): PreparedEntry {
  if (!isCalendarDate(input.date)) throw new InvalidDateError(String(input.date));
  if (!isSourceType(input.sourceType)) {
    throw new InvalidReferenceError(
      'sourceType',
      String(input.sourceType),
      `${JSON.stringify(input.sourceType)} is not a known journal entry source.`,
    );
  }
  if (input.lines.length < 2) throw UnbalancedEntryError.tooFewLines(input.lines.length);

  const lines = input.lines.map((line, index): PreparedLine => {
    const lineNo = index + 1;
    const debitCents = line.debitCents ?? 0;
    const creditCents = line.creditCents ?? 0;

    for (const [side, amount] of [
      ['debit', debitCents],
      ['credit', creditCents],
    ] as const) {
      if (!Number.isSafeInteger(amount)) {
        throw new InvalidAmountError(
          lineNo,
          `${side} must be a whole number of cents, received ${amount}`,
          debitCents,
          creditCents,
        );
      }
      if (amount < 0) {
        throw new InvalidAmountError(
          lineNo,
          `${side} cannot be negative (${amount}); put the amount on the other side instead`,
          debitCents,
          creditCents,
        );
      }
    }

    if (debitCents > 0 && creditCents > 0) {
      throw new InvalidAmountError(
        lineNo,
        'carries both a debit and a credit; a line takes one side only',
        debitCents,
        creditCents,
      );
    }
    if (debitCents === 0 && creditCents === 0) {
      throw new InvalidAmountError(lineNo, 'has no amount', debitCents, creditCents);
    }

    const accountCode = optionalText(line.accountCode);
    const accountId = line.accountId === undefined ? null : dimension('accountId', line.accountId);
    if (accountCode === null && accountId === null) {
      throw new UnknownAccountError({}, 'missing', lineNo);
    }

    return {
      lineNo,
      accountCode,
      accountId,
      debitCents,
      creditCents,
      memo: optionalText(line.memo),
      channelId: dimension('channelId', line.channelId),
      customerId: dimension('customerId', line.customerId),
      vendorId: dimension('vendorId', line.vendorId),
      productId: dimension('productId', line.productId),
    };
  });

  const debits = sumCents(lines.map((l) => l.debitCents));
  const credits = sumCents(lines.map((l) => l.creditCents));
  if (debits !== credits) throw new UnbalancedEntryError(debits, credits, lines.length);
  if (debits === 0) {
    throw new UnbalancedEntryError(0, 0, lines.length, 'Entry has no amounts to post.');
  }

  return {
    date: input.date,
    memo: optionalText(input.memo),
    sourceType: input.sourceType,
    sourceId: dimension('sourceId', input.sourceId),
    reversesId: dimension('reversesId', input.reversesId),
    lines,
  };
}

/** One query for every account any of these entries names, by code or by id. */
async function resolveAccounts(
  exec: LedgerDb,
  entries: readonly PreparedEntry[],
): Promise<{ byCode: Map<string, ResolvedAccount>; byId: Map<string, ResolvedAccount> }> {
  const codes = new Set<string>();
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.accountCode !== null) codes.add(line.accountCode);
      if (line.accountId !== null) ids.add(line.accountId);
    }
  }

  const byCode = new Map<string, ResolvedAccount>();
  const byId = new Map<string, ResolvedAccount>();
  if (codes.size === 0 && ids.size === 0) return { byCode, byId };

  const rows = await exec
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      active: accounts.active,
      isControl: accounts.isControl,
      // Spelled out rather than interpolated: drizzle renders a column of the only
      // table in a select unqualified, which the subquery would read as its own.
      isRollup: sql<boolean>`exists (select 1 from accounts child where child.parent_id = accounts.id)`,
    })
    .from(accounts)
    .where(
      or(
        codes.size > 0 ? inArray(accounts.code, [...codes]) : undefined,
        ids.size > 0 ? inArray(accounts.id, [...ids]) : undefined,
      ),
    );

  for (const row of rows) {
    byCode.set(row.code, row);
    byId.set(row.id, row);
  }
  return { byCode, byId };
}

/**
 * A reversal mirrors an entry that was already accepted, so it is held to the
 * ledger's rules as they were then: it may move a control account the original
 * moved, and may post to an account deactivated since. Only `reverseEntry` sets
 * `reverses_id`, and it copies the original's lines, so nothing new can reach a
 * control account this way.
 */
function isMirror(entry: PreparedEntry): boolean {
  return entry.sourceType === 'reversal' && entry.reversesId !== null;
}

function accountFor(
  line: PreparedLine,
  entry: PreparedEntry,
  lookup: { byCode: Map<string, ResolvedAccount>; byId: Map<string, ResolvedAccount> },
): ResolvedAccount {
  const { sourceType } = entry;
  const reference = {
    ...(line.accountCode === null ? {} : { accountCode: line.accountCode }),
    ...(line.accountId === null ? {} : { accountId: line.accountId }),
  };

  const byId = line.accountId === null ? undefined : lookup.byId.get(line.accountId);
  const byCode = line.accountCode === null ? undefined : lookup.byCode.get(line.accountCode);

  if (line.accountId !== null && byId === undefined) {
    throw new UnknownAccountError(reference, 'missing', line.lineNo);
  }
  if (line.accountCode !== null && byCode === undefined) {
    throw new UnknownAccountError(reference, 'missing', line.lineNo);
  }
  if (byId !== undefined && byCode !== undefined && byId.id !== byCode.id) {
    throw new UnknownAccountError(reference, 'ambiguous', line.lineNo);
  }

  const account = byId ?? byCode;
  if (account === undefined) throw new UnknownAccountError(reference, 'missing', line.lineNo);

  const mirror = isMirror(entry);
  if (!account.active && !mirror) {
    throw new UnknownAccountError(reference, 'inactive', line.lineNo);
  }
  // A reversal may still reach an account that gained children after the
  // original posted; refusing it would leave that entry impossible to correct.
  if (account.isRollup && !mirror) {
    throw new RollupAccountError(account.code, account.name, line.lineNo);
  }
  if (account.isControl && !isSubLedgerSource(sourceType) && !mirror) {
    throw new ControlAccountError(account.code, account.name, sourceType, line.lineNo);
  }
  return account;
}

/**
 * Rejects a closed period up front. The database would refuse the posting too,
 * but only at the flip to 'posted' and with a message written for a DBA.
 */
async function assertPeriodsOpen(exec: LedgerDb, entries: readonly PreparedEntry[]): Promise<void> {
  const wanted = new Map<string, { year: number; month: number; date: CalendarDate }>();
  for (const entry of entries) {
    const { year, month } = periodOf(entry.date);
    const key = `${year}-${month}`;
    if (!wanted.has(key)) wanted.set(key, { year, month, date: entry.date });
  }

  const months = [...wanted.values()];
  const rows = await exec
    .select({ year: periods.year, month: periods.month, status: periods.status })
    .from(periods)
    .where(
      or(
        ...months.map((m) => and(eq(periods.year, m.year), eq(periods.month, m.month))),
      ),
    );

  const closed = new Set(rows.filter((r) => r.status === 'closed').map((r) => `${r.year}-${r.month}`));
  for (const [key, month] of wanted) {
    if (closed.has(key)) throw new ClosedPeriodError(month.year, month.month, month.date);
  }
}

async function insertPosted(
  exec: LedgerDb,
  entry: PreparedEntry,
  lookup: { byCode: Map<string, ResolvedAccount>; byId: Map<string, ResolvedAccount> },
  userId: string | null,
): Promise<PostedEntry> {
  // Resolve before writing anything so a bad account fails on its own error
  // rather than a foreign key violation halfway through the entry.
  const accountIds = entry.lines.map((line) => accountFor(line, entry, lookup).id);

  const [created] = await exec
    .insert(journalEntries)
    .values({
      entryDate: entry.date,
      memo: entry.memo,
      status: 'draft',
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      reversesId: entry.reversesId,
      createdBy: userId,
    })
    .returning({ id: journalEntries.id, entryNo: journalEntries.entryNo });

  await exec.insert(journalLines).values(
    entry.lines.map((line, index) => ({
      entryId: created.id,
      lineNo: line.lineNo,
      accountId: accountIds[index],
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      memo: line.memo,
      channelId: line.channelId,
      customerId: line.customerId,
      vendorId: line.vendorId,
      productId: line.productId,
    })),
  );

  // The balance trigger is deferred to COMMIT, so this flip is accepted here and
  // judged once at the end of the transaction, with the lines already in place.
  await exec
    .update(journalEntries)
    .set({ status: 'posted', postedBy: userId })
    .where(eq(journalEntries.id, created.id));

  return { entryId: created.id, entryNo: created.entryNo };
}

const FK_FIELDS: Readonly<Record<string, string>> = {
  journal_lines_channel_id_fkey: 'channelId',
  journal_lines_product_id_fkey: 'productId',
  journal_lines_customer_fk: 'customerId',
  journal_lines_vendor_fk: 'vendorId',
  journal_entries_created_by_fkey: 'userId',
  journal_entries_posted_by_fkey: 'userId',
  journal_entries_reverses_id_fkey: 'reversesId',
};

/**
 * Turns the ledger triggers' exceptions into the same typed errors the checks
 * above raise. They should be unreachable — every one of them is checked first —
 * but a concurrent period close or a caller reaching past this module would
 * otherwise surface raw Postgres text in the UI. Deferred constraint failures
 * arrive at COMMIT, outside any statement, which is why this wraps the whole
 * transaction and not a single query. A statement's failure arrives wrapped in
 * drizzle's `DrizzleQueryError`, so the Postgres error is dug out of the cause
 * chain rather than read off the top.
 */
function translateDbError(error: unknown, entries: readonly PreparedEntry[]): unknown {
  if (error instanceof LedgerError) return error;
  const pg = postgresErrorOf(error);
  if (pg === null) return error;
  const message = typeof pg.message === 'string' ? pg.message : '';
  const constraint = constraintOf(pg);

  if (pg.code === '23514') {
    const closed = /period (\d+)-(\d+) is closed/.exec(message);
    if (closed) {
      const year = Number(closed[1]);
      const month = Number(closed[2]);
      const entry = entries.find((e) => {
        const p = periodOf(e.date);
        return p.year === year && p.month === month;
      });
      return new ClosedPeriodError(
        year,
        month,
        entry?.date ?? `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`,
      );
    }
    const unbalanced = /out of balance: debits (\d+) <> credits (\d+)/.exec(message);
    if (unbalanced) {
      return new UnbalancedEntryError(Number(unbalanced[1]), Number(unbalanced[2]), 0);
    }
    if (/must have at least two lines/.test(message)) return UnbalancedEntryError.tooFewLines(1);
    if (/has no amounts/.test(message)) {
      return new UnbalancedEntryError(0, 0, 0, 'Entry has no amounts to post.');
    }
    const owned = /journal entry #(\d+) is a (\S+) entry; reverse it through the module that owns it/.exec(message);
    if (owned) return new OwnedEntryError(null, Number(owned[1]), owned[2]);
    const rollup = /account (\S+) (.+) is a rollup/.exec(message);
    if (rollup) return new RollupAccountError(rollup[1], rollup[2]);
    if (
      /immutable|cannot be deleted|lines of a posted journal entry|moved to another entry|linked to/.test(
        message,
      )
    ) {
      return new ImmutableEntryError(message);
    }
  }

  if (pg.code === '23503' && constraint !== undefined) {
    if (constraint === 'journal_lines_account_id_fkey') {
      return new UnknownAccountError({}, 'missing');
    }
    const field = FK_FIELDS[constraint];
    if (field !== undefined) return new InvalidReferenceError(field, null, `${field} does not exist.`);
  }

  return error;
}

/**
 * The typed ledger error behind a database failure, for callers that ran their
 * own transaction around the posting engine — whose COMMIT, and so whose
 * deferred balance check, happens outside `postJournalEntry`. Returns `error`
 * unchanged when it is not one the ledger recognises.
 */
export function translateLedgerDbError(error: unknown): unknown {
  return translateDbError(error, []);
}

async function run<T>(
  ctx: PostContext,
  entries: readonly PreparedEntry[],
  fn: (tx: LedgerDb) => Promise<T>,
): Promise<T> {
  const guarded = async (tx: LedgerDb): Promise<T> => {
    try {
      return await fn(tx);
    } catch (error) {
      throw translateDbError(error, entries);
    }
  };

  // A caller's transaction commits on its own terms, so the deferred triggers
  // fire under its watch rather than here.
  if (ctx.tx) return guarded(ctx.tx);

  try {
    return await withActor(ctx.userId, guarded);
  } catch (error) {
    throw translateDbError(error, entries);
  }
}

/**
 * Posts one journal entry and returns its id and human-facing number.
 *
 * @throws {UnbalancedEntryError} debits and credits disagree, or fewer than two lines
 * @throws {InvalidAmountError} a line amount is negative, fractional or on both sides
 * @throws {InvalidDateError} the entry date is not a YYYY-MM-DD calendar date
 * @throws {UnknownAccountError} an account code or id does not resolve to an active account
 * @throws {RollupAccountError} a line names a rollup (an account with children)
 * @throws {ControlAccountError} a non sub-ledger entry tried to move AR or AP
 * @throws {ClosedPeriodError} the entry date falls in a closed period
 */
export async function postJournalEntry(input: DraftEntry, ctx: PostContext): Promise<PostedEntry> {
  const [posted] = await postPrepared([prepare(input)], ctx);
  return posted;
}

export interface EntryPreviewLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
}

export interface EntryPreview {
  date: CalendarDate;
  memo: string | null;
  lines: EntryPreviewLine[];
  totalCents: number;
}

/**
 * Runs every check `postJournalEntry` runs before it writes — shape, balance, accounts that exist
 * and are postable, an open period — and returns the entry with its accounts named. Writes nothing,
 * so a caller can show a person exactly what would post and be sure it would not be refused for
 * those reasons.
 */
export async function previewJournalEntry(input: DraftEntry, exec: LedgerDb): Promise<EntryPreview> {
  const entry = prepare(input);
  const lookup = await resolveAccounts(exec, [entry]);
  const resolved = entry.lines.map((line) => accountFor(line, entry, lookup));
  await assertPeriodsOpen(exec, [entry]);
  return {
    date: entry.date,
    memo: entry.memo,
    totalCents: sumCents(entry.lines.map((line) => line.debitCents)),
    lines: entry.lines.map((line, index) => ({
      accountId: resolved[index].id,
      accountCode: resolved[index].code,
      accountName: resolved[index].name,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      memo: line.memo,
    })),
  };
}

/**
 * Posts several entries as one unit: they all land or none of them do. Used by
 * imports and by any module that raises a document and its ledger effect
 * together.
 */
export async function postJournalEntries(
  inputs: readonly DraftEntry[],
  ctx: PostContext,
): Promise<PostedEntry[]> {
  if (inputs.length === 0) return [];
  return postPrepared(
    inputs.map((input) => prepare(input)),
    ctx,
  );
}

async function postPrepared(
  entries: readonly PreparedEntry[],
  ctx: PostContext,
): Promise<PostedEntry[]> {
  return run(ctx, entries, async (tx) => {
    const lookup = await resolveAccounts(tx, entries);
    await assertPeriodsOpen(tx, entries);

    const posted: PostedEntry[] = [];
    for (const entry of entries) {
      posted.push(await insertPosted(tx, entry, lookup, ctx.userId));
    }
    return posted;
  });
}

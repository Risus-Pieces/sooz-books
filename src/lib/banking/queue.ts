/**
 * Sooz Books — the read model behind the bank review screens.
 *
 * Three reads, each one SQL statement however many rows it returns:
 *
 *   - `listQueue`  — bank rows with everything the review UI shows beside them: the
 *     suggested account, vendor, rule, confidence and reasoning; the transfer partner;
 *     the charge a refund reverses; what the row actually posted to; why it is flagged.
 *   - `queueCounts` — the tab badges: rows by status, by stage and by suggestion source.
 *   - `bankRegister` — the bank account as the ledger sees it, with a running balance.
 *
 * A row's **stage** is what a person has to do with it:
 *   `review`   unreviewed, or an unposted transfer pair — a human decides;
 *   `ready`    categorized by an auto-post rule (or matched) but not yet posted;
 *   `posted`   in the ledger (`journal_entry_id` is set);
 *   `excluded` never moved money.
 *
 * Nothing here writes. Components reach these through server code only.
 */

import { type SQL, sql as sqlTag } from 'drizzle-orm';

import type { BankTxnStatus } from '@/db/schema';
import { type CalendarDate, isCalendarDate } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';

import { HAS_BOOKED_CANDIDATE } from './booked';
import type { LedgerDb } from '@/lib/ledger/post';
import { parseMoney } from '@/lib/money';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type QueueStage = 'review' | 'ready' | 'posted' | 'excluded';

/** A raw status, or one of the two posting states that cut across statuses. */
export type QueueStatusFilter = BankTxnStatus | 'posted' | 'awaiting_post';

export type QueueSource = 'rule' | 'history' | 'ai' | 'match' | 'none';

/**
 * Why a row wants a closer look.
 *   `mixed_use`       the suggested vendor is on the owner's always-review list
 *   `low_confidence`  the suggestion scored below the floor
 *   `no_suggestion`   nothing proposed an account
 *   `ask_accountant`  the suggestion is the 7900 suspense account
 *   `already_booked`  an entry already in the ledger records this money on this bank
 *                     account (a receipt or bill payment entered by hand); link, don't post
 *   `open_document`   an open invoice (money in) or bill (money out) is owed exactly this
 */
export type QueueFlag =
  | 'mixed_use'
  | 'low_confidence'
  | 'no_suggestion'
  | 'ask_accountant'
  | 'already_booked'
  | 'open_document';

/** Matches ai-suggest's DEFAULT_CONFIDENCE_FLOOR: below this a suggestion is flagged. */
export const QUEUE_CONFIDENCE_FLOOR = 0.6;

export interface AccountRef {
  id: string;
  code: string;
  name: string;
}

export interface QueueRow {
  id: string;
  bankAccountId: string;
  bankAccountName: string;
  bankAccountMask: string | null;
  txnDate: CalendarDate;
  description: string;
  payee: string | null;
  reference: string | null;
  /** Signed: positive is money in. */
  amountCents: number;
  /** The bank's printed running balance after this row, where the file had one. */
  balanceCents: number | null;
  status: BankTxnStatus;
  stage: QueueStage;
  journalEntryId: string | null;
  entryNo: number | null;
  /**
   * How a `matched` row got its entry: `receipt` / `bill_payment` (bank matching recorded
   * the document — void it to undo), `entry` (linked to an entry already in the ledger).
   * `payout` marks a deposit that clears a channel settlement.
   */
  matchedType: string | null;
  matchedId: string | null;
  reconciled: boolean;
  notes: string | null;
  suggestion: {
    account: AccountRef | null;
    vendor: { id: string; name: string } | null;
    customerId: string | null;
    channelId: string | null;
    memo: string | null;
    source: Exclude<QueueSource, 'none'> | null;
    /** 0–1. A score, not money. */
    confidence: number | null;
    reasoning: string | null;
    rule: { id: string; name: string; autoPost: boolean } | null;
  };
  /** The largest non-bank line of the posted entry; `postedLineCount` > 1 means a split. */
  postedAccount: AccountRef | null;
  postedLineCount: number;
  transferPartner: {
    id: string;
    bankAccountId: string;
    bankAccountName: string;
    txnDate: CalendarDate;
    amountCents: number;
    status: BankTxnStatus;
  } | null;
  refundOriginal: {
    id: string;
    txnDate: CalendarDate;
    amountCents: number;
    payee: string | null;
    /** What the charge was coded to; approving the refund defaults to it. */
    account: AccountRef | null;
  } | null;
  flags: QueueFlag[];
}

export interface ListQueueOptions {
  status?: QueueStatusFilter;
  stage?: QueueStage;
  bankAccountId?: string;
  source?: QueueSource;
  flaggedOnly?: boolean;
  /** Payee, description, reference or notes; an amount like `12.34` also matches ±$12.34. */
  search?: string;
  dateFrom?: CalendarDate;
  dateTo?: CalendarDate;
  /** Opaque, from a previous page's `nextCursor`. */
  cursor?: string | null;
  /** 1–500, default 100. */
  limit?: number;
}

export interface QueuePage {
  rows: QueueRow[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Shared SQL
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) throw new Error(`${what} ${JSON.stringify(value)} is not an id.`);
}

function assertDate(value: string, what: string): void {
  if (!isCalendarDate(value)) throw new Error(`${what} ${JSON.stringify(value)} is not a YYYY-MM-DD date.`);
}

function cents(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Expected whole cents from the database, got ${String(value)}`);
  return n;
}

function centsOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : cents(value);
}

async function run<T>(exec: LedgerDb | undefined, query: SQL): Promise<T[]> {
  const runner = exec ?? (await import('@/db/client')).db;
  return (await runner.execute(query)) as unknown as T[];
}

/** `stage` of the row aliased `bt`. */
const STAGE = sqlTag`
  case
    when bt.journal_entry_id is not null then 'posted'
    when bt.status = 'excluded' then 'excluded'
    when bt.status in ('categorized', 'matched') then 'ready'
    else 'review'
  end`;

/** Only unposted, live rows carry flags: a posted row has been decided. */
const FLAGGABLE = sqlTag`(bt.journal_entry_id is null and bt.status <> 'excluded')`;
const MIXED_USE = sqlTag`(${FLAGGABLE} and coalesce(sv.notes, '') ~* 'always[[:space:]]+review')`;
const LOW_CONFIDENCE = sqlTag`(${FLAGGABLE} and bt.suggestion_confidence < ${QUEUE_CONFIDENCE_FLOOR})`;
// A linked refund has an answer even without a suggestion: its charge's account.
const NO_SUGGESTION = sqlTag`(${FLAGGABLE} and bt.status = 'unreviewed' and bt.suggested_account_id is null
                               and bt.refund_of_txn_id is null)`;
const ASK_ACCOUNTANT = sqlTag`(${FLAGGABLE} and sa.code = ${ACCOUNTS.ASK_MY_ACCOUNTANT})`;
// Needs `ba`, the row's bank account, in scope.
const ALREADY_BOOKED = sqlTag`(${FLAGGABLE} and ${HAS_BOOKED_CANDIDATE})`;
const OPEN_DOCUMENT = sqlTag`(${FLAGGABLE} and bt.status <> 'transfer' and case
    when bt.amount_cents > 0 then exists (
      select 1 from invoices i
       where i.status in ('open', 'partial')
         and i.invoice_date <= bt.txn_date
         and (i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents) = bt.amount_cents)
    else exists (
      select 1 from bills b
       where b.status in ('open', 'partial')
         and b.bill_date <= bt.txn_date
         and (b.total_cents - b.paid_cents - b.credited_cents) = -bt.amount_cents)
  end)`;
const ANY_FLAG = sqlTag`(${MIXED_USE} or ${LOW_CONFIDENCE} or ${NO_SUGGESTION} or ${ASK_ACCOUNTANT}
                        or ${ALREADY_BOOKED} or ${OPEN_DOCUMENT})`;

function statusCondition(status: QueueStatusFilter): SQL {
  switch (status) {
    case 'posted':
      return sqlTag`bt.journal_entry_id is not null`;
    case 'awaiting_post':
      return sqlTag`(bt.journal_entry_id is null and bt.status in ('categorized', 'matched'))`;
    default:
      return sqlTag`bt.status = ${status}::bank_txn_status`;
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function searchCondition(search: string): SQL | null {
  const text = search.trim();
  if (text === '') return null;
  const pattern = `%${escapeLike(text)}%`;
  const textMatch = sqlTag`(bt.description ilike ${pattern} or bt.counterparty ilike ${pattern}
                          or bt.reference ilike ${pattern} or bt.notes ilike ${pattern})`;
  let amount: number | null = null;
  if (/^[-+($]*[\d,]+(\.\d{1,2})?\)?$/.test(text)) {
    try {
      amount = Math.abs(parseMoney(text));
    } catch {
      amount = null;
    }
  }
  if (amount === null || amount === 0) return textMatch;
  return sqlTag`(${textMatch} or abs(bt.amount_cents) = ${amount})`;
}

interface Cursor {
  date: CalendarDate;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.date}|${cursor.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  const [date, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (date === undefined || id === undefined || !isCalendarDate(date) || !UUID.test(id)) {
    throw new Error('The page cursor is not valid.');
  }
  return { date, id };
}

// ---------------------------------------------------------------------------
// listQueue
// ---------------------------------------------------------------------------

interface QueueSqlRow {
  id: string;
  bank_account_id: string;
  bank_account_name: string;
  bank_account_mask: string | null;
  txn_date: string;
  description: string;
  counterparty: string | null;
  reference: string | null;
  amount_cents: string;
  balance_cents: string | null;
  status: BankTxnStatus;
  stage: QueueStage;
  journal_entry_id: string | null;
  entry_no: string | null;
  matched_type: string | null;
  matched_id: string | null;
  reconciled: boolean;
  notes: string | null;
  sa_id: string | null;
  sa_code: string | null;
  sa_name: string | null;
  sv_id: string | null;
  sv_name: string | null;
  suggested_customer_id: string | null;
  suggested_channel_id: string | null;
  suggested_memo: string | null;
  suggestion_source: Exclude<QueueSource, 'none'> | null;
  suggestion_confidence: string | null;
  suggestion_reasoning: string | null;
  rule_id: string | null;
  rule_name: string | null;
  rule_auto_post: boolean | null;
  pa_id: string | null;
  pa_code: string | null;
  pa_name: string | null;
  posted_line_count: number;
  tp_id: string | null;
  tp_bank_account_id: string | null;
  tp_bank_account_name: string | null;
  tp_txn_date: string | null;
  tp_amount_cents: string | null;
  tp_status: BankTxnStatus | null;
  ro_id: string | null;
  ro_txn_date: string | null;
  ro_amount_cents: string | null;
  ro_payee: string | null;
  ro_account_id: string | null;
  ro_account_code: string | null;
  ro_account_name: string | null;
  flag_mixed_use: boolean;
  flag_low_confidence: boolean;
  flag_no_suggestion: boolean;
  flag_ask_accountant: boolean;
  flag_already_booked: boolean;
  flag_open_document: boolean;
}

function account(id: string | null, code: string | null, name: string | null): AccountRef | null {
  return id === null || code === null || name === null ? null : { id, code, name };
}

function toQueueRow(row: QueueSqlRow): QueueRow {
  const flags: QueueFlag[] = [];
  if (row.flag_mixed_use) flags.push('mixed_use');
  if (row.flag_low_confidence) flags.push('low_confidence');
  if (row.flag_no_suggestion) flags.push('no_suggestion');
  if (row.flag_ask_accountant) flags.push('ask_accountant');
  if (row.flag_already_booked) flags.push('already_booked');
  if (row.flag_open_document) flags.push('open_document');

  return {
    id: row.id,
    bankAccountId: row.bank_account_id,
    bankAccountName: row.bank_account_name,
    bankAccountMask: row.bank_account_mask,
    txnDate: row.txn_date,
    description: row.description,
    payee: row.counterparty,
    reference: row.reference,
    amountCents: cents(row.amount_cents),
    balanceCents: centsOrNull(row.balance_cents),
    status: row.status,
    stage: row.stage,
    journalEntryId: row.journal_entry_id,
    entryNo: centsOrNull(row.entry_no),
    matchedType: row.matched_type,
    matchedId: row.matched_id,
    reconciled: row.reconciled,
    notes: row.notes,
    suggestion: {
      account: account(row.sa_id, row.sa_code, row.sa_name),
      vendor: row.sv_id === null || row.sv_name === null ? null : { id: row.sv_id, name: row.sv_name },
      customerId: row.suggested_customer_id,
      channelId: row.suggested_channel_id,
      memo: row.suggested_memo,
      source: row.suggestion_source,
      confidence: row.suggestion_confidence === null ? null : Number(row.suggestion_confidence),
      reasoning: row.suggestion_reasoning,
      rule:
        row.rule_id === null || row.rule_name === null
          ? null
          : { id: row.rule_id, name: row.rule_name, autoPost: row.rule_auto_post === true },
    },
    postedAccount: account(row.pa_id, row.pa_code, row.pa_name),
    postedLineCount: row.posted_line_count,
    transferPartner:
      row.tp_id === null || row.tp_bank_account_id === null || row.tp_txn_date === null || row.tp_status === null
        ? null
        : {
            id: row.tp_id,
            bankAccountId: row.tp_bank_account_id,
            bankAccountName: row.tp_bank_account_name ?? '',
            txnDate: row.tp_txn_date,
            amountCents: cents(row.tp_amount_cents),
            status: row.tp_status,
          },
    refundOriginal:
      row.ro_id === null || row.ro_txn_date === null
        ? null
        : {
            id: row.ro_id,
            txnDate: row.ro_txn_date,
            amountCents: cents(row.ro_amount_cents),
            payee: row.ro_payee,
            account: account(row.ro_account_id, row.ro_account_code, row.ro_account_name),
          },
    flags,
  };
}

/** The review queue, newest first, keyset-paginated. One statement per page. */
export async function listQueue(options: ListQueueOptions = {}, exec?: LedgerDb): Promise<QueuePage> {
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 100)));
  const where: SQL[] = [];

  if (options.status !== undefined) where.push(statusCondition(options.status));
  if (options.stage !== undefined) where.push(sqlTag`(${STAGE}) = ${options.stage}`);
  if (options.bankAccountId !== undefined) {
    assertUuid(options.bankAccountId, 'Bank account');
    where.push(sqlTag`bt.bank_account_id = ${options.bankAccountId}::uuid`);
  }
  if (options.source !== undefined) {
    where.push(
      options.source === 'none'
        ? sqlTag`bt.suggestion_source is null`
        : sqlTag`bt.suggestion_source = ${options.source}::suggestion_source`,
    );
  }
  if (options.flaggedOnly === true) where.push(ANY_FLAG);
  if (options.search !== undefined) {
    const condition = searchCondition(options.search);
    if (condition !== null) where.push(condition);
  }
  if (options.dateFrom !== undefined) {
    assertDate(options.dateFrom, 'dateFrom');
    where.push(sqlTag`bt.txn_date >= ${options.dateFrom}::date`);
  }
  if (options.dateTo !== undefined) {
    assertDate(options.dateTo, 'dateTo');
    where.push(sqlTag`bt.txn_date <= ${options.dateTo}::date`);
  }
  if (options.cursor !== undefined && options.cursor !== null) {
    const cursor = decodeCursor(options.cursor);
    where.push(sqlTag`(bt.txn_date, bt.id) < (${cursor.date}::date, ${cursor.id}::uuid)`);
  }

  const whereSql = where.length === 0 ? sqlTag`true` : sqlTag.join(where, sqlTag` and `);

  const result = await run<QueueSqlRow>(
    exec,
    sqlTag`
      select bt.id, bt.bank_account_id, ba.name as bank_account_name, ba.mask as bank_account_mask,
             bt.txn_date::text, bt.description, bt.counterparty, bt.reference,
             bt.amount_cents::text, bt.balance_cents::text,
             bt.status::text as status, ${STAGE} as stage,
             bt.journal_entry_id, je.entry_no::text, bt.matched_type, bt.matched_id,
             (bt.reconciliation_id is not null and bt.reconciled_at is not null) as reconciled,
             bt.notes,
             sa.id as sa_id, sa.code as sa_code, sa.name as sa_name,
             sv.id as sv_id, coalesce(sv.display_name, sv.name) as sv_name,
             bt.suggested_customer_id, bt.suggested_channel_id, bt.suggested_memo,
             bt.suggestion_source::text as suggestion_source,
             bt.suggestion_confidence::text, bt.suggestion_reasoning,
             r.id as rule_id, r.name as rule_name, r.auto_post as rule_auto_post,
             pa.id as pa_id, pa.code as pa_code, pa.name as pa_name,
             coalesce(posted.n, 0)::int as posted_line_count,
             tp.id as tp_id, tp.bank_account_id as tp_bank_account_id, tpa.name as tp_bank_account_name,
             tp.txn_date::text as tp_txn_date, tp.amount_cents::text as tp_amount_cents,
             tp.status::text as tp_status,
             ro.id as ro_id, ro.txn_date::text as ro_txn_date, ro.amount_cents::text as ro_amount_cents,
             coalesce(ro.counterparty, ro.description) as ro_payee,
             roa.id as ro_account_id, roa.code as ro_account_code, roa.name as ro_account_name,
             ${MIXED_USE} as flag_mixed_use,
             coalesce(${LOW_CONFIDENCE}, false) as flag_low_confidence,
             ${NO_SUGGESTION} as flag_no_suggestion,
             coalesce(${ASK_ACCOUNTANT}, false) as flag_ask_accountant,
             ${ALREADY_BOOKED} as flag_already_booked,
             coalesce(${OPEN_DOCUMENT}, false) as flag_open_document
        from bank_transactions bt
        join bank_accounts ba on ba.id = bt.bank_account_id
        left join journal_entries je on je.id = bt.journal_entry_id
        left join accounts sa on sa.id = bt.suggested_account_id
        left join vendors sv on sv.id = bt.suggested_vendor_id
        left join categorization_rules r on r.id = bt.rule_id
        left join lateral (
          select count(*) as n,
                 (array_agg(jl.account_id order by (jl.debit_cents + jl.credit_cents) desc, jl.line_no))[1] as top
            from journal_lines jl
           where jl.entry_id = bt.journal_entry_id
             and jl.account_id <> ba.account_id
        ) posted on bt.journal_entry_id is not null
        left join accounts pa on pa.id = posted.top
        left join bank_transactions tp on tp.id = bt.transfer_pair_id
        left join bank_accounts tpa on tpa.id = tp.bank_account_id
        left join bank_transactions ro on ro.id = bt.refund_of_txn_id
        left join bank_accounts roba on roba.id = ro.bank_account_id
        left join lateral (
          select coalesce(
                   (select jl.account_id
                      from journal_lines jl
                     where jl.entry_id = ro.journal_entry_id
                       and jl.account_id <> roba.account_id
                     order by (jl.debit_cents + jl.credit_cents) desc, jl.line_no
                     limit 1),
                   ro.suggested_account_id) as account_id
        ) ro_coded on ro.id is not null
        left join accounts roa on roa.id = ro_coded.account_id
       where ${whereSql}
       order by bt.txn_date desc, bt.id desc
       limit ${limit + 1}`,
  );

  const page = result.slice(0, limit).map(toQueueRow);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: result.length > limit && last !== undefined ? encodeCursor({ date: last.txnDate, id: last.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// queueCounts
// ---------------------------------------------------------------------------

export interface QueueCounts {
  total: number;
  byStatus: Record<BankTxnStatus, number>;
  byStage: Record<QueueStage, number>;
  /** Suggestion source of the rows still in review. */
  bySource: Record<QueueSource, number>;
  /** Unposted rows carrying at least one flag. */
  flagged: number;
}

/** Badge counts for the queue tabs, optionally for one bank account. One statement. */
export async function queueCounts(
  options: { bankAccountId?: string } = {},
  exec?: LedgerDb,
): Promise<QueueCounts> {
  if (options.bankAccountId !== undefined) assertUuid(options.bankAccountId, 'Bank account');
  const scope =
    options.bankAccountId === undefined ? sqlTag`true` : sqlTag`bt.bank_account_id = ${options.bankAccountId}::uuid`;
  const review = sqlTag`(${STAGE}) = 'review'`;

  const [row] = await run<Record<string, number>>(
    exec,
    sqlTag`
      select count(*)::int as total,
             count(*) filter (where bt.status = 'unreviewed')::int  as s_unreviewed,
             count(*) filter (where bt.status = 'categorized')::int as s_categorized,
             count(*) filter (where bt.status = 'matched')::int     as s_matched,
             count(*) filter (where bt.status = 'transfer')::int    as s_transfer,
             count(*) filter (where bt.status = 'excluded')::int    as s_excluded,
             count(*) filter (where (${STAGE}) = 'review')::int     as g_review,
             count(*) filter (where (${STAGE}) = 'ready')::int      as g_ready,
             count(*) filter (where (${STAGE}) = 'posted')::int     as g_posted,
             count(*) filter (where (${STAGE}) = 'excluded')::int   as g_excluded,
             count(*) filter (where ${review} and bt.suggestion_source = 'rule')::int    as o_rule,
             count(*) filter (where ${review} and bt.suggestion_source = 'history')::int as o_history,
             count(*) filter (where ${review} and bt.suggestion_source = 'ai')::int      as o_ai,
             count(*) filter (where ${review} and bt.suggestion_source = 'match')::int   as o_match,
             count(*) filter (where ${review} and bt.suggestion_source is null)::int     as o_none,
             count(*) filter (where ${ANY_FLAG})::int as flagged
        from bank_transactions bt
        join bank_accounts ba on ba.id = bt.bank_account_id
        left join accounts sa on sa.id = bt.suggested_account_id
        left join vendors sv on sv.id = bt.suggested_vendor_id
       where ${scope}`,
  );

  return {
    total: row.total,
    byStatus: {
      unreviewed: row.s_unreviewed,
      categorized: row.s_categorized,
      matched: row.s_matched,
      transfer: row.s_transfer,
      excluded: row.s_excluded,
    },
    byStage: { review: row.g_review, ready: row.g_ready, posted: row.g_posted, excluded: row.g_excluded },
    bySource: { rule: row.o_rule, history: row.o_history, ai: row.o_ai, match: row.o_match, none: row.o_none },
    flagged: row.flagged,
  };
}

// ---------------------------------------------------------------------------
// bankRegister
// ---------------------------------------------------------------------------

export type ClearedState = 'reconciled' | 'cleared' | 'uncleared';

export interface RegisterRow {
  journalLineId: string;
  entryId: string;
  entryNo: number;
  date: CalendarDate;
  sourceType: string;
  memo: string | null;
  /** Signed from the bank's side: positive is money in. */
  amountCents: number;
  /** Ledger balance after this line. */
  runningBalanceCents: number;
  bankTransactionId: string | null;
  payee: string | null;
  reference: string | null;
  /** What the bank printed after the matching statement row, for comparison. */
  statementBalanceCents: number | null;
  /** The other side: the largest counter line, and how many there are. */
  counterAccount: AccountRef | null;
  counterLineCount: number;
  cleared: ClearedState;
}

export interface BankRegister {
  bankAccountId: string;
  bankAccountName: string;
  glAccount: AccountRef;
  from: CalendarDate;
  to: CalendarDate;
  openingBalanceCents: number;
  closingBalanceCents: number;
  rows: RegisterRow[];
}

interface RegisterSqlRow {
  bank_account_name: string;
  gl_id: string;
  gl_code: string;
  gl_name: string;
  opening: string;
  journal_line_id: string | null;
  entry_id: string | null;
  entry_no: string | null;
  date: string | null;
  source_type: string | null;
  memo: string | null;
  amount_cents: string | null;
  running: string | null;
  bank_transaction_id: string | null;
  payee: string | null;
  reference: string | null;
  statement_balance: string | null;
  ca_id: string | null;
  ca_code: string | null;
  ca_name: string | null;
  counter_count: number | null;
  cleared: ClearedState | null;
}

/**
 * The bank account's ledger between two dates — posted lines only, oldest first — with
 * the balance brought forward and a running balance. One statement.
 */
export async function bankRegister(
  input: { bankAccountId: string; from: CalendarDate; to: CalendarDate },
  exec?: LedgerDb,
): Promise<BankRegister> {
  assertUuid(input.bankAccountId, 'Bank account');
  assertDate(input.from, 'from');
  assertDate(input.to, 'to');

  const result = await run<RegisterSqlRow>(
    exec,
    sqlTag`
      with bank as (
        select ba.id, ba.name, ba.account_id, a.code, a.name as gl_name
          from bank_accounts ba
          join accounts a on a.id = ba.account_id
         where ba.id = ${input.bankAccountId}::uuid
      ),
      opening as (
        select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) as cents
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
         where jl.account_id = (select account_id from bank)
           and je.entry_date < ${input.from}::date
      ),
      lines as (
        select jl.id as journal_line_id, je.id as entry_id, je.entry_no, je.entry_date, jl.line_no,
               je.source_type, coalesce(jl.memo, je.memo) as memo,
               jl.debit_cents - jl.credit_cents as amount
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
         where jl.account_id = (select account_id from bank)
           and je.entry_date between ${input.from}::date and ${input.to}::date
      ),
      ran as (
        select l.*,
               (select cents from opening)
                 + sum(l.amount) over (order by l.entry_date, l.entry_no, l.line_no
                                       rows between unbounded preceding and current row) as running
          from lines l
      )
      select bank.name as bank_account_name, bank.account_id as gl_id, bank.code as gl_code,
             bank.gl_name, (select cents from opening)::text as opening,
             ran.journal_line_id, ran.entry_id, ran.entry_no::text, ran.entry_date::text as date,
             ran.source_type, ran.memo, ran.amount::text as amount_cents, ran.running::text as running,
             bt.id as bank_transaction_id, coalesce(bt.counterparty, bt.description) as payee,
             bt.reference, bt.balance_cents::text as statement_balance,
             ca.id as ca_id, ca.code as ca_code, ca.name as ca_name,
             counter.n::int as counter_count,
             case
               when exists (select 1 from reconciliation_items ri
                              join reconciliations r on r.id = ri.reconciliation_id
                             where ri.journal_line_id = ran.journal_line_id and r.status = 'completed')
                    or (ran.source_type = 'opening_balance') then 'reconciled'
               when exists (select 1 from reconciliation_items ri
                              join reconciliations r on r.id = ri.reconciliation_id
                             where ri.journal_line_id = ran.journal_line_id and r.status = 'in_progress')
                    then 'cleared'
               when ran.journal_line_id is null then null
               else 'uncleared'
             end as cleared
        from bank
        left join ran on true
        left join bank_transactions bt
               on bt.journal_entry_id = ran.entry_id and bt.bank_account_id = bank.id
        left join lateral (
          select count(*) as n,
                 (array_agg(jl.account_id order by (jl.debit_cents + jl.credit_cents) desc, jl.line_no))[1] as top
            from journal_lines jl
           where jl.entry_id = ran.entry_id
             and jl.id <> ran.journal_line_id
        ) counter on ran.entry_id is not null
        left join accounts ca on ca.id = counter.top
       order by ran.entry_date, ran.entry_no, ran.line_no`,
  );

  const head = result[0];
  if (head === undefined) throw new Error(`Bank account ${input.bankAccountId} does not exist.`);
  const opening = cents(head.opening);
  const rows: RegisterRow[] = result
    .filter((row) => row.journal_line_id !== null)
    .map((row) => ({
      journalLineId: row.journal_line_id as string,
      entryId: row.entry_id as string,
      entryNo: cents(row.entry_no),
      date: row.date as string,
      sourceType: row.source_type as string,
      memo: row.memo,
      amountCents: cents(row.amount_cents),
      runningBalanceCents: cents(row.running),
      bankTransactionId: row.bank_transaction_id,
      payee: row.payee,
      reference: row.reference,
      statementBalanceCents: centsOrNull(row.statement_balance),
      counterAccount: account(row.ca_id, row.ca_code, row.ca_name),
      counterLineCount: row.counter_count ?? 0,
      cleared: row.cleared ?? 'uncleared',
    }));

  return {
    bankAccountId: input.bankAccountId,
    bankAccountName: head.bank_account_name,
    glAccount: { id: head.gl_id, code: head.gl_code, name: head.gl_name },
    from: input.from,
    to: input.to,
    openingBalanceCents: opening,
    closingBalanceCents: rows.length === 0 ? opening : rows[rows.length - 1].runningBalanceCents,
    rows,
  };
}

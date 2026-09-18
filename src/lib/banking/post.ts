/**
 * Sooz Books — turning reviewed bank transactions into journal entries.
 *
 * This is the only module that moves a bank row from "a line on a statement" to "an
 * entry in the ledger". Every path through it follows the same shape:
 *
 *   1. lock the bank row (and its partner, for a transfer) inside one transaction;
 *   2. refuse anything that must not post — an excluded, already-posted or reconciled
 *      row, a closed period, a bank / control / rollup account on the other side;
 *   3. hand the entry to `postJournalEntry`, the only writer of `journal_lines`;
 *   4. stamp the row with the entry, status and reviewer — in the same transaction, so a
 *      row and its entry can never disagree.
 *
 * "Posted" is not a status of its own: a row is posted exactly when `journal_entry_id`
 * is set. Its status says what kind of posting it is — `categorized` for a row coded to
 * an account, `transfer` for one leg of an internal transfer. The suggestion columns are
 * never overwritten by an approval, so unposting returns the row to review with the
 * suggestion it arrived with; what was actually chosen lives on the entry.
 *
 * Nothing here decides on the owner's behalf. `approve*` and `markPersonal` are called
 * for a human's decision; `postAutoPostMatches` posts only rows a rule the owner marked
 * `auto_post` categorized, and records no reviewer because nobody reviewed them.
 */

import { and, eq, inArray, isNull, sql as sqlTag } from 'drizzle-orm';

import { type Tx, withActor } from '@/db/client';
import { accounts, bankAccounts, bankTransactions, categorizationRules } from '@/db/schema';
import type { BankTxnStatus } from '@/db/schema';
import type { CalendarDate } from '@/lib/dates';
import { postgresErrorOf } from '@/lib/db-errors';
import { ACCOUNTS } from '@/lib/ledger/coa';
import {
  ClosedPeriodError,
  ControlAccountError,
  RollupAccountError,
  UnknownAccountError,
  isLedgerError,
} from '@/lib/ledger/errors';
import { isPeriodOpen } from '@/lib/ledger/periods';
import { type DraftLine, type LedgerDb, postJournalEntry, translateLedgerDbError } from '@/lib/ledger/post';
import { ENTRY_MATCH_TYPE, reverseEntry } from '@/lib/ledger/reverse';
import { periodOf } from '@/lib/dates';
import { sumCents } from '@/lib/money';

import { type BookedCandidate, bookedCandidates } from './booked';
import { cleanPayee, normalizeDescription } from './normalize';
import {
  RULE_DIRECTIONS,
  type RuleCondition,
  type RuleDirection,
  inspectRegexSource,
  parseRuleConditions,
} from './rules';
import { learnAlias } from './vendors';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BankingErrorCode =
  | 'txn_not_found'
  | 'excluded'
  | 'already_posted'
  | 'not_posted'
  | 'reconciled'
  | 'wrong_status'
  | 'bank_account_as_category'
  | 'no_account'
  | 'invalid_split'
  | 'split_mismatch'
  | 'transfer_unpaired'
  | 'transfer_invalid'
  | 'refund_invalid'
  | 'rule_invalid'
  | 'reconciliation_not_found'
  | 'reconciliation_state'
  | 'reconciliation_invalid'
  | 'reconciliation_not_tied'
  | 'already_booked'
  | 'not_linkable'
  | 'not_permitted';

/**
 * An expected refusal from the banking engine. Server actions hand `message` to the UI
 * as-is; `code` is for code that needs to branch on the reason.
 */
export class BankingError extends Error {
  constructor(
    readonly code: BankingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BankingError';
  }
}

export function isBankingError(error: unknown): error is BankingError {
  return error instanceof BankingError;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Who is acting, and optionally the transaction to act inside. A caller-supplied `tx`
 * must already carry `app.user_id` (`withActor` sets it); each operation then runs in a
 * savepoint of it, so one refused operation never poisons the caller's transaction.
 */
export interface BankingCtx {
  userId: string | null;
  tx?: LedgerDb;
}

const RECONCILED_MESSAGE = /is reconciled and cannot be changed|cleared by a completed bank reconciliation|reconciliation .* is completed/;

/** The trigger and ledger exceptions behind a failure, as the typed errors the UI reads. */
function translate(error: unknown): unknown {
  if (error instanceof BankingError || isLedgerError(error)) return error;
  const pg = postgresErrorOf(error);
  if (pg !== null && pg.code === '23514' && RECONCILED_MESSAGE.test(pg.message)) {
    return new BankingError(
      'reconciled',
      'This transaction has been reconciled and is locked. Undo the reconciliation before changing it.',
    );
  }
  return translateLedgerDbError(error);
}

/** Runs one unit of work atomically: its own transaction, or a savepoint of the caller's. */
export async function inBankingTx<T>(ctx: BankingCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    if (ctx.tx !== undefined) return await ctx.tx.transaction(fn);
    return await withActor(ctx.userId, fn);
  } catch (error) {
    throw translate(error);
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface LockedTxn {
  id: string;
  bankAccountId: string;
  bankName: string;
  bankGlAccountId: string;
  txnDate: CalendarDate;
  amountCents: number;
  status: BankTxnStatus;
  journalEntryId: string | null;
  reconciliationId: string | null;
  reconciledAt: Date | null;
  transferPairId: string | null;
  refundOfTxnId: string | null;
  counterparty: string | null;
  description: string;
  reference: string | null;
  suggestedAccountId: string | null;
  suggestedVendorId: string | null;
  suggestedCustomerId: string | null;
  suggestedChannelId: string | null;
  suggestedMemo: string | null;
  ruleId: string | null;
  matchedType: (typeof bankTransactions.$inferSelect)['matchedType'];
  matchedId: string | null;
}

const LOCKED_TXN_FIELDS = {
  id: bankTransactions.id,
  bankAccountId: bankTransactions.bankAccountId,
  bankName: bankAccounts.name,
  bankGlAccountId: bankAccounts.accountId,
  txnDate: bankTransactions.txnDate,
  amountCents: bankTransactions.amountCents,
  status: bankTransactions.status,
  journalEntryId: bankTransactions.journalEntryId,
  reconciliationId: bankTransactions.reconciliationId,
  reconciledAt: bankTransactions.reconciledAt,
  transferPairId: bankTransactions.transferPairId,
  refundOfTxnId: bankTransactions.refundOfTxnId,
  counterparty: bankTransactions.counterparty,
  description: bankTransactions.description,
  reference: bankTransactions.reference,
  suggestedAccountId: bankTransactions.suggestedAccountId,
  suggestedVendorId: bankTransactions.suggestedVendorId,
  suggestedCustomerId: bankTransactions.suggestedCustomerId,
  suggestedChannelId: bankTransactions.suggestedChannelId,
  suggestedMemo: bankTransactions.suggestedMemo,
  ruleId: bankTransactions.ruleId,
  matchedType: bankTransactions.matchedType,
  matchedId: bankTransactions.matchedId,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) throw new BankingError('txn_not_found', `${what} ${JSON.stringify(value)} is not an id.`);
}

/** Locks rows in id order, so two operations touching the same pair cannot deadlock. */
async function lockTxns(tx: Tx, ids: readonly string[]): Promise<Map<string, LockedTxn>> {
  for (const id of ids) assertUuid(id, 'Bank transaction');
  const rows = await tx
    .select(LOCKED_TXN_FIELDS)
    .from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
    .where(inArray(bankTransactions.id, [...new Set(ids)].sort()))
    .orderBy(bankTransactions.id)
    .for('update', { of: bankTransactions });
  return new Map(rows.map((row) => [row.id, row]));
}

async function lockTxn(tx: Tx, id: string): Promise<LockedTxn> {
  const row = (await lockTxns(tx, [id])).get(id);
  if (row === undefined) throw new BankingError('txn_not_found', `Bank transaction ${id} does not exist.`);
  return row;
}

function describeTxn(txn: LockedTxn): string {
  const who = (txn.counterparty ?? '').trim() || txn.description.trim() || 'transaction';
  return `the ${txn.txnDate} ${who} transaction`;
}

function isReconciled(txn: LockedTxn): boolean {
  return txn.reconciliationId !== null && txn.reconciledAt !== null;
}

/** The checks every posting path shares. */
function assertPostable(txn: LockedTxn): void {
  if (isReconciled(txn)) {
    throw new BankingError(
      'reconciled',
      `${capitalise(describeTxn(txn))} is reconciled and locked. Undo the reconciliation first.`,
    );
  }
  if (txn.journalEntryId !== null) {
    throw new BankingError('already_posted', `${capitalise(describeTxn(txn))} is already posted.`);
  }
  if (txn.status === 'excluded') {
    throw new BankingError(
      'excluded',
      `${capitalise(describeTxn(txn))} is excluded — the money never moved — so it cannot post.`,
    );
  }
}

function describeBooked(candidate: BookedCandidate): string {
  const what =
    candidate.documentNo !== null
      ? `${candidate.sourceType === 'receipt' ? 'receipt' : 'payment'} ${candidate.documentNo}`
      : candidate.memo ?? candidate.sourceType.replace('_', ' ');
  return `entry #${candidate.entryNo} (${what}, ${candidate.entryDate})`;
}

/**
 * Refuses to post a row whose money an existing entry already records on the same bank
 * GL account — a receipt or bill payment entered by hand, a manual entry — unless the
 * reviewer has confirmed it is a different transaction. See `booked.ts`.
 */
async function assertNotAlreadyBooked(tx: Tx, txn: LockedTxn, confirmedNew: boolean): Promise<void> {
  if (confirmedNew) return;
  const [candidate, ...rest] = await bookedCandidates(
    { glAccountId: txn.bankGlAccountId, amountCents: txn.amountCents, txnDate: txn.txnDate },
    tx,
    { limit: 3 },
  );
  if (candidate === undefined) return;
  const more = rest.length === 0 ? '' : ` (and ${rest.length} other${rest.length === 1 ? '' : 's'})`;
  throw new BankingError(
    'already_booked',
    `${capitalise(describeTxn(txn))} looks already booked: ${describeBooked(candidate)}${more} records the same ` +
      `${formatCents(Math.abs(txn.amountCents))} on ${txn.bankName}. Match the bank line to that entry instead of ` +
      `posting the money twice — or, if it is a different transaction, confirm that and post it.`,
  );
}

async function assertPeriodOpen(tx: Tx, date: CalendarDate): Promise<void> {
  if (await isPeriodOpen(date, tx)) return;
  const { year, month } = periodOf(date);
  throw new ClosedPeriodError(year, month, date);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Counter-accounts
// ---------------------------------------------------------------------------

interface CounterAccount {
  id: string;
  code: string;
  name: string;
}

/**
 * The accounts a bank row may be coded to. A bank account on the other side is a
 * transfer and goes through `approveTransfer`; AR and AP belong to their sub-ledgers; a
 * rollup is a report header. Each gets the typed error that says so.
 */
async function resolveCounterAccounts(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, CounterAccount>> {
  for (const id of ids) {
    if (!UUID.test(id)) throw new UnknownAccountError({ accountId: id }, 'missing');
  }
  const unique = [...new Set(ids)];
  const rows = await tx
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      active: accounts.active,
      isBank: accounts.isBank,
      isControl: accounts.isControl,
      isRollup: sqlTag<boolean>`exists (select 1 from accounts child where child.parent_id = accounts.id)`,
      isBankFeed: sqlTag<boolean>`exists (select 1 from bank_accounts ba where ba.account_id = accounts.id)`,
    })
    .from(accounts)
    .where(inArray(accounts.id, unique));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const out = new Map<string, CounterAccount>();
  for (const id of unique) {
    const row = byId.get(id);
    if (row === undefined) throw new UnknownAccountError({ accountId: id }, 'missing');
    if (!row.active) throw new UnknownAccountError({ accountCode: row.code }, 'inactive');
    if (row.isRollup) throw new RollupAccountError(row.code, row.name);
    if (row.isControl) throw new ControlAccountError(row.code, row.name, 'bank');
    if (row.isBank || row.isBankFeed) {
      throw new BankingError(
        'bank_account_as_category',
        `${row.code} ${row.name} is a bank account. Money moving between two of the company's own ` +
          `accounts is a transfer: pair the two legs and approve them as a transfer instead.`,
      );
    }
    out.set(id, { id: row.id, code: row.code, name: row.name });
  }
  return out;
}

async function accountIdByCode(tx: Tx, code: string): Promise<string> {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
  if (row === undefined) throw new UnknownAccountError({ accountCode: code }, 'missing');
  return row.id;
}

/**
 * The account a charge was coded to: the largest non-bank line of its entry once
 * posted, its suggestion before that.
 */
async function codedAccountOf(tx: Tx, txnId: string): Promise<string | null> {
  const rows = (await tx.execute(sqlTag`
    select coalesce(line.account_id, bt.suggested_account_id) as account_id
      from bank_transactions bt
      join bank_accounts ba on ba.id = bt.bank_account_id
      left join lateral (
        select jl.account_id
          from journal_lines jl
         where jl.entry_id = bt.journal_entry_id
           and jl.account_id <> ba.account_id
         order by (jl.debit_cents + jl.credit_cents) desc, jl.line_no
         limit 1
      ) line on true
     where bt.id = ${txnId}::uuid`)) as unknown as { account_id: string | null }[];
  return rows[0]?.account_id ?? null;
}

// ---------------------------------------------------------------------------
// Approving one row
// ---------------------------------------------------------------------------

export interface ApprovalSplit {
  accountId: string;
  /** Positive cents. The splits of a row sum exactly to its absolute amount. */
  amountCents: number;
  memo?: string;
  channelId?: string | null;
  productId?: string | null;
}

export interface ApproveInput {
  txnId: string;
  /**
   * The account the whole amount posts to. May be left out when the row carries a
   * suggestion, or is a card refund linked to its charge — the charge's account is then
   * the default, so the pair nets to zero. Ignored when `splits` is given.
   */
  accountId?: string;
  /** Explicit `null` clears the suggested vendor; `undefined` keeps it. */
  vendorId?: string | null;
  customerId?: string | null;
  channelId?: string | null;
  productId?: string | null;
  memo?: string;
  splits?: readonly ApprovalSplit[];
  /**
   * The reviewer has seen that an existing entry records the same amount on this bank
   * account and says this row is a different transaction. Without it, such a row is
   * refused with `already_booked`.
   */
  confirmedNew?: boolean;
}

export interface ApprovalResult {
  txnId: string;
  entryId: string;
  entryNo: number;
  /** The counter-accounts the entry posted to, in line order. */
  accountIds: string[];
}

interface Choice {
  lines: { accountId: string; amountCents: number; memo: string | null; channelId: string | null; productId: string | null }[];
  vendorId: string | null;
  customerId: string | null;
  memo: string;
}

function payeeOf(txn: LockedTxn): string {
  const cleaned = cleanPayee(txn.counterparty).name.trim();
  return cleaned || txn.description.trim() || 'Bank transaction';
}

function optionalText(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

async function decide(tx: Tx, txn: LockedTxn, input: Omit<ApproveInput, 'txnId'>): Promise<Choice> {
  const magnitude = Math.abs(txn.amountCents);
  const memo = optionalText(input.memo) ?? optionalText(txn.suggestedMemo) ?? payeeOf(txn);
  const channelId = input.channelId !== undefined ? input.channelId : txn.suggestedChannelId;
  const productId = input.productId ?? null;

  let lines: Choice['lines'];
  if (input.splits !== undefined && input.splits.length > 0) {
    input.splits.forEach((split, index) => {
      if (!Number.isSafeInteger(split.amountCents) || split.amountCents <= 0) {
        throw new BankingError(
          'invalid_split',
          `Split ${index + 1} must be a positive whole number of cents; received ${split.amountCents}.`,
        );
      }
    });
    const total = sumCents(input.splits.map((split) => split.amountCents));
    if (total !== magnitude) {
      const difference = magnitude - total;
      throw new BankingError(
        'split_mismatch',
        `The splits total ${formatCents(total)} but the transaction is ${formatCents(magnitude)}: ` +
          `${difference > 0 ? `${formatCents(difference)} still to allocate` : `${formatCents(-difference)} over`}.`,
      );
    }
    lines = input.splits.map((split) => ({
      accountId: split.accountId,
      amountCents: split.amountCents,
      memo: optionalText(split.memo),
      channelId: split.channelId !== undefined ? split.channelId : channelId,
      productId: split.productId !== undefined ? split.productId : productId,
    }));
  } else {
    let accountId = input.accountId ?? null;
    if (accountId === null && txn.refundOfTxnId !== null) {
      accountId = await codedAccountOf(tx, txn.refundOfTxnId);
    }
    accountId ??= txn.suggestedAccountId;
    if (accountId === null) {
      throw new BankingError('no_account', `Choose an account for ${describeTxn(txn)}; it has no suggestion.`);
    }
    lines = [{ accountId, amountCents: magnitude, memo: null, channelId, productId }];
  }

  await resolveCounterAccounts(
    tx,
    lines.map((line) => line.accountId),
  );

  return {
    lines,
    vendorId: input.vendorId !== undefined ? input.vendorId : txn.suggestedVendorId,
    customerId: input.customerId !== undefined ? input.customerId : txn.suggestedCustomerId,
    memo,
  };
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * The entry for one bank row. Money out debits the chosen accounts and credits the
 * bank; money in is the mirror. Dimensions ride on the non-bank lines only: the bank
 * line is cash, and a vendor or channel on it would double every dimension report.
 */
function entryLines(txn: LockedTxn, choice: Choice): DraftLine[] {
  const outflow = txn.amountCents < 0;
  const magnitude = Math.abs(txn.amountCents);
  const counter: DraftLine[] = choice.lines.map((line) => ({
    accountId: line.accountId,
    ...(outflow ? { debitCents: line.amountCents } : { creditCents: line.amountCents }),
    memo: line.memo ?? choice.memo,
    vendorId: choice.vendorId,
    customerId: choice.customerId,
    channelId: line.channelId,
    productId: line.productId,
  }));
  const bank: DraftLine = {
    accountId: txn.bankGlAccountId,
    ...(outflow ? { creditCents: magnitude } : { debitCents: magnitude }),
    memo: payeeOf(txn),
  };
  return [...counter, bank];
}

async function postRow(
  tx: Tx,
  txn: LockedTxn,
  choice: Choice,
  userId: string | null,
  reviewed: boolean,
): Promise<ApprovalResult> {
  await assertPeriodOpen(tx, txn.txnDate);

  const posted = await postJournalEntry(
    {
      date: txn.txnDate,
      memo: choice.memo,
      sourceType: 'bank',
      sourceId: txn.id,
      lines: entryLines(txn, choice),
    },
    { userId, tx },
  );

  const updated = await tx
    .update(bankTransactions)
    .set({
      status: 'categorized',
      journalEntryId: posted.entryId,
      reviewedBy: reviewed ? userId : null,
      reviewedAt: reviewed ? new Date() : null,
    })
    .where(and(eq(bankTransactions.id, txn.id), isNull(bankTransactions.journalEntryId)))
    .returning({ id: bankTransactions.id });
  if (updated.length !== 1) {
    throw new BankingError('already_posted', `${capitalise(describeTxn(txn))} was posted by someone else.`);
  }

  return {
    txnId: txn.id,
    entryId: posted.entryId,
    entryNo: posted.entryNo,
    accountIds: choice.lines.map((line) => line.accountId),
  };
}

/** Remembers the bank's spelling of a vendor. Never fails the approval it rides on. */
async function learnVendor(tx: Tx, txn: LockedTxn, vendorId: string | null, userId: string | null): Promise<void> {
  const payee = (txn.counterparty ?? '').trim();
  if (vendorId === null || payee === '' || normalizeDescription(payee) === '') return;
  try {
    await tx.transaction((sp) => learnAlias(vendorId, payee, { userId, tx: sp }).then(() => undefined));
  } catch {
    // An alias is a convenience for the next import; the posting is the record.
  }
}

/**
 * Posts one reviewed bank transaction.
 *
 * @throws {BankingError} excluded, already posted, reconciled, a transfer leg, a bank
 *   account as the category, splits that do not add up, no account to post to
 * @throws {ClosedPeriodError} the transaction's date is in a closed period
 * @throws {RollupAccountError | ControlAccountError | UnknownAccountError} the chosen account
 */
export async function approveBankTransaction(
  input: ApproveInput,
  ctx: BankingCtx,
): Promise<ApprovalResult> {
  return inBankingTx(ctx, async (tx) => {
    const txn = await lockTxn(tx, input.txnId);
    assertPostable(txn);
    if (txn.status === 'transfer') {
      throw new BankingError(
        'wrong_status',
        `${capitalise(describeTxn(txn))} is one leg of an internal transfer. Approve the pair as a ` +
          `transfer, or unlink it first if it is not one.`,
      );
    }
    if (txn.status === 'matched') {
      throw new BankingError(
        'wrong_status',
        `${capitalise(describeTxn(txn))} is matched to an invoice or bill, which posts it.`,
      );
    }
    await assertNotAlreadyBooked(tx, txn, input.confirmedNew === true);
    const choice = await decide(tx, txn, input);
    const result = await postRow(tx, txn, choice, ctx.userId, true);
    await learnVendor(tx, txn, choice.vendorId, ctx.userId);
    return result;
  });
}

/**
 * The owner's one-click answer for a personal purchase on a mixed-use payee: post it
 * to Owner Draws. Carries no vendor, so personal spend never shows in vendor reports.
 */
export async function markPersonal(
  txnId: string,
  ctx: BankingCtx,
  options: { memo?: string; confirmedNew?: boolean } = {},
): Promise<ApprovalResult> {
  const ownerDraws = await inBankingTx(ctx, (tx) => accountIdByCode(tx, ACCOUNTS.OWNER_DRAWS));
  return approveBankTransaction(
    {
      txnId,
      accountId: ownerDraws,
      vendorId: null,
      customerId: null,
      channelId: null,
      memo: options.memo ?? 'Personal purchase — owner draw',
      confirmedNew: options.confirmedNew,
    },
    ctx,
  );
}

export type BulkResult =
  | ({ ok: true } & ApprovalResult)
  | { ok: false; txnId: string; error: string; code: string };

function failure(txnId: string, error: unknown): BulkResult {
  if (error instanceof BankingError || isLedgerError(error)) {
    return { ok: false, txnId, error: error.message, code: error.code };
  }
  return {
    ok: false,
    txnId,
    error: 'This transaction could not be posted because of an unexpected error.',
    code: 'unexpected',
  };
}

/** Approves each item in its own transaction; one refusal never undoes the others. */
export async function approveMany(
  items: readonly ApproveInput[],
  ctx: BankingCtx,
): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  for (const item of items) {
    try {
      results.push({ ok: true, ...(await approveBankTransaction(item, ctx)) });
    } catch (error) {
      results.push(failure(item.txnId, error));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Auto-post
// ---------------------------------------------------------------------------

export interface AutoPostReport {
  posted: ApprovalResult[];
  failed: { txnId: string; error: string; code: string }[];
}

/**
 * Posts every `categorized`, unposted row whose rule is (still) an active `auto_post`
 * rule, to the rule's suggestion. Idempotent: a posted row is no longer a candidate, and
 * each row is re-checked under its lock, so a second or concurrent call posts nothing
 * twice. Transfers and card refunds are never candidates. `bankAccountId` narrows it to
 * one account.
 */
export async function postAutoPostMatches(
  ctx: BankingCtx,
  options: { bankAccountId?: string } = {},
): Promise<AutoPostReport> {
  if (options.bankAccountId !== undefined) assertUuid(options.bankAccountId, 'Bank account');
  const exec = ctx.tx ?? (await import('@/db/client')).db;
  const candidates = await exec
    .select({ id: bankTransactions.id })
    .from(bankTransactions)
    .innerJoin(categorizationRules, eq(categorizationRules.id, bankTransactions.ruleId))
    .where(
      and(
        eq(bankTransactions.status, 'categorized'),
        isNull(bankTransactions.journalEntryId),
        isNull(bankTransactions.transferPairId),
        isNull(bankTransactions.refundOfTxnId),
        eq(categorizationRules.autoPost, true),
        eq(categorizationRules.active, true),
        options.bankAccountId === undefined ? undefined : eq(bankTransactions.bankAccountId, options.bankAccountId),
      ),
    )
    .orderBy(bankTransactions.txnDate, bankTransactions.id);

  const report: AutoPostReport = { posted: [], failed: [] };
  for (const { id } of candidates) {
    try {
      const result = await inBankingTx(ctx, async (tx) => {
        const txn = await lockTxn(tx, id);
        // Re-read under the lock: another caller may have posted it since the scan.
        if (txn.journalEntryId !== null || txn.status !== 'categorized') return null;
        assertPostable(txn);
        // An auto-post rule never decides that money already in the ledger is new.
        await assertNotAlreadyBooked(tx, txn, false);
        const choice = await decide(tx, txn, {});
        return postRow(tx, txn, choice, ctx.userId, false);
      });
      if (result !== null) report.posted.push(result);
    } catch (error) {
      const failed = failure(id, error);
      if (!failed.ok) report.failed.push({ txnId: id, error: failed.error, code: failed.code });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export interface TransferResult {
  entryId: string;
  entryNo: number;
  sendingTxnId: string;
  receivingTxnId: string;
}

function assertTransferPair(a: LockedTxn, b: LockedTxn | undefined): asserts b is LockedTxn {
  if (b === undefined) {
    throw new BankingError(
      'transfer_unpaired',
      `${capitalise(describeTxn(a))} has no other leg. Pair it with the matching transaction on the other account first.`,
    );
  }
  if (b.transferPairId !== a.id || a.transferPairId !== b.id) {
    throw new BankingError('transfer_invalid', 'The two legs of this transfer do not point at each other.');
  }
  if (a.bankAccountId === b.bankAccountId) {
    throw new BankingError('transfer_invalid', 'Both legs are on the same bank account; that is not a transfer.');
  }
  if (Math.sign(a.amountCents) === Math.sign(b.amountCents) || Math.abs(a.amountCents) !== Math.abs(b.amountCents)) {
    throw new BankingError(
      'transfer_invalid',
      `A transfer's legs must be equal and opposite; these are ${formatCents(a.amountCents)} and ${formatCents(b.amountCents)}.`,
    );
  }
}

/**
 * Posts an internal transfer as ONE entry — debit the receiving bank, credit the
 * sending bank — and links both legs to it. Dated on the day the money left.
 *
 * @param txnId either leg
 */
export async function approveTransfer(
  txnId: string,
  ctx: BankingCtx,
  options: { confirmedNew?: boolean } = {},
): Promise<TransferResult> {
  return inBankingTx(ctx, async (tx) => {
    const first = await lockTxn(tx, txnId);
    if (first.transferPairId === null) assertTransferPair(first, undefined);
    const locked = await lockTxns(tx, [first.id, first.transferPairId as string]);
    const a = locked.get(first.id) as LockedTxn;
    const b = locked.get(first.transferPairId as string);
    assertTransferPair(a, b);
    for (const leg of [a, b]) {
      assertPostable(leg);
      if (leg.status !== 'transfer' && leg.status !== 'unreviewed') {
        throw new BankingError('wrong_status', `${capitalise(describeTxn(leg))} is ${leg.status}, not a transfer leg.`);
      }
    }

    for (const leg of [a, b]) await assertNotAlreadyBooked(tx, leg, options.confirmedNew === true);

    const sending = a.amountCents < 0 ? a : b;
    const receiving = sending === a ? b : a;
    await assertPeriodOpen(tx, sending.txnDate);
    const amount = receiving.amountCents;
    const memo = `Transfer ${sending.bankName} → ${receiving.bankName}`;

    const posted = await postJournalEntry(
      {
        date: sending.txnDate,
        memo,
        sourceType: 'bank',
        sourceId: sending.id,
        lines: [
          { accountId: receiving.bankGlAccountId, debitCents: amount, memo },
          { accountId: sending.bankGlAccountId, creditCents: amount, memo },
        ],
      },
      { userId: ctx.userId, tx },
    );

    const updated = await tx
      .update(bankTransactions)
      .set({ status: 'transfer', journalEntryId: posted.entryId, reviewedBy: ctx.userId, reviewedAt: new Date() })
      .where(and(inArray(bankTransactions.id, [a.id, b.id]), isNull(bankTransactions.journalEntryId)))
      .returning({ id: bankTransactions.id });
    if (updated.length !== 2) throw new BankingError('already_posted', 'One leg of this transfer was posted by someone else.');

    return { entryId: posted.entryId, entryNo: posted.entryNo, sendingTxnId: sending.id, receivingTxnId: receiving.id };
  });
}

/** Pairs two unposted rows as the legs of one internal transfer. */
export async function linkTransfer(txnIdA: string, txnIdB: string, ctx: BankingCtx): Promise<void> {
  await inBankingTx(ctx, async (tx) => {
    const locked = await lockTxns(tx, [txnIdA, txnIdB]);
    const a = locked.get(txnIdA);
    const b = locked.get(txnIdB);
    if (a === undefined || b === undefined) throw new BankingError('txn_not_found', 'One of these bank transactions does not exist.');
    for (const leg of [a, b]) {
      assertPostable(leg);
      const other = leg === a ? b : a;
      if (leg.transferPairId !== null && leg.transferPairId !== other.id) {
        throw new BankingError('transfer_invalid', `${capitalise(describeTxn(leg))} is already paired with another transaction.`);
      }
    }
    assertTransferPair({ ...a, transferPairId: b.id }, { ...b, transferPairId: a.id });
    await tx.update(bankTransactions).set({ transferPairId: b.id, status: 'transfer' }).where(eq(bankTransactions.id, a.id));
    await tx.update(bankTransactions).set({ transferPairId: a.id, status: 'transfer' }).where(eq(bankTransactions.id, b.id));
  });
}

/** Breaks an unposted transfer pair; both legs go back to review with their suggestions. */
export async function unlinkTransfer(txnId: string, ctx: BankingCtx): Promise<void> {
  await inBankingTx(ctx, async (tx) => {
    const first = await lockTxn(tx, txnId);
    if (first.status !== 'transfer' || first.transferPairId === null) {
      throw new BankingError('transfer_unpaired', `${capitalise(describeTxn(first))} is not paired as a transfer.`);
    }
    const locked = await lockTxns(tx, [first.id, first.transferPairId]);
    for (const leg of locked.values()) assertPostable(leg);
    await tx
      .update(bankTransactions)
      .set({ transferPairId: null, status: 'unreviewed' })
      .where(inArray(bankTransactions.id, [...locked.keys()]));
  });
}

// ---------------------------------------------------------------------------
// Card refunds
// ---------------------------------------------------------------------------

/**
 * Links a card refund to the charge it reverses (or, with `null`, unlinks it). The
 * refund must be money in, the charge money out on the same account, no larger than
 * the charge and no earlier.
 */
export async function linkRefund(
  refundTxnId: string,
  originalTxnId: string | null,
  ctx: BankingCtx,
): Promise<void> {
  await inBankingTx(ctx, async (tx) => {
    const ids = originalTxnId === null ? [refundTxnId] : [refundTxnId, originalTxnId];
    const locked = await lockTxns(tx, ids);
    const refund = locked.get(refundTxnId);
    if (refund === undefined) throw new BankingError('txn_not_found', `Bank transaction ${refundTxnId} does not exist.`);
    assertPostable(refund);
    if (originalTxnId !== null) {
      const original = locked.get(originalTxnId);
      if (original === undefined) throw new BankingError('txn_not_found', `Bank transaction ${originalTxnId} does not exist.`);
      if (refund.amountCents <= 0 || original.amountCents >= 0) {
        throw new BankingError('refund_invalid', 'A refund is money in, and the charge it reverses is money out.');
      }
      if (refund.bankAccountId !== original.bankAccountId) {
        throw new BankingError('refund_invalid', 'A refund comes back to the account the charge was made on.');
      }
      if (refund.amountCents > Math.abs(original.amountCents)) {
        throw new BankingError('refund_invalid', 'A refund cannot be larger than the charge it reverses.');
      }
      if (refund.txnDate < original.txnDate) {
        throw new BankingError('refund_invalid', 'A refund cannot come before the charge it reverses.');
      }
    }
    await tx
      .update(bankTransactions)
      .set({ refundOfTxnId: originalTxnId })
      .where(eq(bankTransactions.id, refundTxnId));
  });
}

// ---------------------------------------------------------------------------
// Unposting
// ---------------------------------------------------------------------------

export interface UnpostResult {
  txnIds: string[];
  /** The reversal posted; null when the row was only linked to an entry it did not post. */
  reversalEntryId: string | null;
  reversalEntryNo: number | null;
  /** The entry a linked row was released from, left in the ledger untouched. */
  unlinkedEntryNo: number | null;
}

/** A match that is the row's posting, rather than an annotation beside it (a payout link). */
const POSTING_MATCH_TYPES: ReadonlySet<string> = new Set(['receipt', 'bill_payment', ENTRY_MATCH_TYPE]);

/** What a row returning to review keeps of its match: a payout link survives, a posting does not. */
function matchAfterRelease(leg: LockedTxn): { matchedType: LockedTxn['matchedType']; matchedId: string | null } {
  return leg.matchedType !== null && POSTING_MATCH_TYPES.has(leg.matchedType)
    ? { matchedType: null, matchedId: null }
    : { matchedType: leg.matchedType, matchedId: leg.matchedId };
}

/**
 * Takes a posted row out of the ledger and returns it to review with its suggestion
 * intact. A transfer leg takes its partner with it, back to an unposted pair.
 *
 *   - A row the bank feed posted: its entry is reversed.
 *   - A row linked to an entry that was already in the ledger: the link is released and
 *     the entry stays — it records money the owner entered elsewhere.
 *   - A row matched to an invoice or bill: refused. The receipt or bill payment it
 *     created owns that entry and the documents it paid; voiding it undoes both and
 *     returns this row to review.
 *
 * Refused when reconciled, or when the entry's period is closed (the reversal would land
 * in a later month and the row could never re-post to its own).
 */
export async function unpostBankTransaction(txnId: string, ctx: BankingCtx): Promise<UnpostResult> {
  return inBankingTx(ctx, async (tx) => {
    const first = await lockTxn(tx, txnId);
    if (first.journalEntryId === null) {
      throw new BankingError('not_posted', `${capitalise(describeTxn(first))} is not posted.`);
    }
    if (first.matchedType === 'receipt' || first.matchedType === 'bill_payment') {
      const doc = first.matchedType === 'receipt' ? 'receipt' : 'bill payment';
      const where = first.matchedType === 'receipt' ? 'Sales' : 'Purchases';
      throw new BankingError(
        'wrong_status',
        `${capitalise(describeTxn(first))} was matched to an ${first.matchedType === 'receipt' ? 'invoice' : 'bill'} ` +
          `and recorded as a ${doc}. Void the ${doc} in ${where}: that puts the ` +
          `${first.matchedType === 'receipt' ? 'invoice' : 'bill'} back to open and returns this line to review.`,
      );
    }
    const ids = [first.id];
    if (first.status === 'transfer' && first.transferPairId !== null) ids.push(first.transferPairId);
    const locked = await lockTxns(tx, ids);
    const legs = [...locked.values()].filter((leg) => leg.journalEntryId === first.journalEntryId);
    for (const leg of legs) {
      if (isReconciled(leg)) {
        throw new BankingError(
          'reconciled',
          `${capitalise(describeTxn(leg))} is reconciled and locked. Undo the reconciliation before unposting it.`,
        );
      }
    }
    const entryId = first.journalEntryId;
    const linkedOnly = first.matchedType === ENTRY_MATCH_TYPE;
    const legIds = sqlTag.join(
      legs.map((leg) => sqlTag`${leg.id}::uuid`),
      sqlTag`, `,
    );

    let reversal: { entryId: string; entryNo: number } | null = null;
    let unlinkedEntryNo: number | null = null;
    if (linkedOnly) {
      // The entry is someone else's record; only this row's claim on it goes.
      await tx.execute(sqlTag`
        delete from reconciliation_items ri
         using reconciliations r
         where r.id = ri.reconciliation_id
           and r.status = 'in_progress'
           and ri.bank_transaction_id in (${legIds})`);
      const [entry] = (await tx.execute(
        sqlTag`select entry_no::int as entry_no from journal_entries where id = ${entryId}::uuid`,
      )) as unknown as { entry_no: number }[];
      unlinkedEntryNo = entry?.entry_no ?? null;
    } else {
      await assertPeriodOpen(tx, first.txnDate);

      // A cleared item in an in-progress reconciliation stops meaning anything once its
      // line is reversed; take it out rather than leave the reconciliation pointing at it.
      await tx.execute(sqlTag`
        delete from reconciliation_items ri
         using reconciliations r
         where r.id = ri.reconciliation_id
           and r.status = 'in_progress'
           and (ri.bank_transaction_id in (${legIds})
                or ri.journal_line_id in (select id from journal_lines where entry_id = ${entryId}::uuid))`);

      // An entry reversed before the ledger refused to reverse bank entries on its own
      // has no money left to take out: the row only needs releasing.
      const [already] = (await tx.execute(sqlTag`
        select id, entry_no::int as entry_no from journal_entries
         where reverses_id = ${entryId}::uuid and status = 'posted'
         limit 1`)) as unknown as { id: string; entry_no: number }[];
      reversal =
        already !== undefined
          ? { entryId: already.id, entryNo: already.entry_no }
          : await reverseEntry(entryId, {
              userId: ctx.userId,
              tx,
              owner: 'bank',
              memo: `Unposted bank transaction — ${first.txnDate} ${payeeOf(first)}`,
            });
    }

    for (const leg of legs) {
      await tx
        .update(bankTransactions)
        .set({
          journalEntryId: null,
          status: leg.status === 'transfer' ? 'transfer' : 'unreviewed',
          ...matchAfterRelease(leg),
          reviewedBy: null,
          reviewedAt: null,
        })
        .where(eq(bankTransactions.id, leg.id));
    }

    return {
      txnIds: legs.map((leg) => leg.id),
      reversalEntryId: reversal?.entryId ?? null,
      reversalEntryNo: reversal?.entryNo ?? null,
      unlinkedEntryNo,
    };
  });
}

// ---------------------------------------------------------------------------
// Linking to an entry already in the ledger
// ---------------------------------------------------------------------------

export interface LinkedToEntry {
  txnId: string;
  entryId: string;
  entryNo: number;
}

/**
 * Records that an entry already in the ledger — a receipt entered from Sales, a bill
 * paid from Purchases, a manual entry — is this bank row's money. Nothing posts: the row
 * becomes `matched` to the entry (`matched_type = 'entry'`) and counts as posted by it,
 * so the cash is booked once. Unposting the row releases the link and leaves the entry;
 * reversing or voiding the entry sends the row back to review.
 *
 * The entry must be one `bookedCandidates` offers for the row: posted, live, on the
 * row's bank GL account for exactly its amount and direction, near its date, and not
 * claimed by another row.
 */
export async function linkBankTransactionToEntry(
  txnId: string,
  entryId: string,
  ctx: BankingCtx,
): Promise<LinkedToEntry> {
  assertUuid(entryId, 'Journal entry');
  return inBankingTx(ctx, async (tx) => {
    const txn = await lockTxn(tx, txnId);
    assertPostable(txn);
    if (txn.status === 'transfer' || txn.status === 'matched') {
      throw new BankingError(
        'wrong_status',
        `${capitalise(describeTxn(txn))} is ${txn.status === 'transfer' ? 'paired as a transfer' : 'already matched'}. ` +
          `Unpair it first.`,
      );
    }
    // Lock the entry so a concurrent reversal cannot slip between the check and the link.
    await tx.execute(sqlTag`select id from journal_entries where id = ${entryId}::uuid for update`);
    const candidates = await bookedCandidates(
      { glAccountId: txn.bankGlAccountId, amountCents: txn.amountCents, txnDate: txn.txnDate },
      tx,
      { limit: 100 },
    );
    const match = candidates.find((candidate) => candidate.entryId === entryId);
    if (match === undefined) {
      throw new BankingError(
        'not_linkable',
        `That entry cannot be ${describeTxn(txn)}: it must be a live posted entry on ${txn.bankName}'s ledger ` +
          `account for exactly ${formatCents(txn.amountCents)}, dated near ${txn.txnDate}, and not already ` +
          `matched to another bank line.`,
      );
    }

    const updated = await tx
      .update(bankTransactions)
      .set({
        status: 'matched',
        matchedType: ENTRY_MATCH_TYPE,
        matchedId: entryId,
        journalEntryId: entryId,
        reviewedBy: ctx.userId,
        reviewedAt: new Date(),
      })
      .where(and(eq(bankTransactions.id, txn.id), isNull(bankTransactions.journalEntryId)))
      .returning({ id: bankTransactions.id });
    if (updated.length !== 1) {
      throw new BankingError('already_posted', `${capitalise(describeTxn(txn))} was posted by someone else.`);
    }
    return { txnId: txn.id, entryId, entryNo: match.entryNo };
  });
}

// ---------------------------------------------------------------------------
// Rules from a decision
// ---------------------------------------------------------------------------

/**
 * The conditions a rule built from this row starts with: the cleaned payee, or the
 * description when the bank gave no payee. Direction is a separate rule field.
 */
export function defaultRuleConditions(txn: {
  counterparty: string | null;
  description: string | null;
}): RuleCondition[] {
  const payee = cleanPayee(txn.counterparty).name.trim();
  if (payee !== '') return [{ field: 'payee', op: 'contains', value: payee }];
  const description = (txn.description ?? '').trim();
  return [{ field: 'description', op: 'contains', value: description }];
}

export interface RuleFromTransactionOptions {
  accountId: string;
  conditions?: readonly RuleCondition[];
  vendorId?: string | null;
  channelId?: string | null;
  direction?: RuleDirection;
  name?: string;
  priority?: number;
  /** Scope the rule to this row's bank account only. Default: every account. */
  thisAccountOnly?: boolean;
  /** Letting a rule post without review is the owner's call; off unless asked. */
  autoPost?: boolean;
}

export interface CreatedRule {
  id: string;
  name: string;
  conditions: RuleCondition[];
  direction: RuleDirection;
  accountId: string;
  vendorId: string | null;
  autoPost: boolean;
}

/**
 * Saves the decision made on one row as a rule for the next import. The default
 * conditions are the cleaned payee plus the row's direction; the UI may send edited ones.
 */
export async function createRuleFromTransaction(
  txnId: string,
  options: RuleFromTransactionOptions,
  ctx: BankingCtx,
): Promise<CreatedRule> {
  return inBankingTx(ctx, async (tx) => {
    assertUuid(txnId, 'Bank transaction');
    const [txn] = await tx
      .select({
        id: bankTransactions.id,
        bankAccountId: bankTransactions.bankAccountId,
        amountCents: bankTransactions.amountCents,
        counterparty: bankTransactions.counterparty,
        description: bankTransactions.description,
        suggestedVendorId: bankTransactions.suggestedVendorId,
      })
      .from(bankTransactions)
      .where(eq(bankTransactions.id, txnId));
    if (txn === undefined) throw new BankingError('txn_not_found', `Bank transaction ${txnId} does not exist.`);

    const conditions = [...(options.conditions ?? defaultRuleConditions(txn))];
    const parsed = parseRuleConditions(conditions);
    if (parsed.problems.length > 0 || parsed.conditions.length === 0) {
      throw new BankingError(
        'rule_invalid',
        parsed.problems.length > 0 ? parsed.problems.join(' ') : 'A rule needs at least one condition.',
      );
    }
    for (const condition of parsed.conditions) {
      if (condition.value.trim() === '') {
        throw new BankingError('rule_invalid', `The ${condition.field} condition has no text to match.`);
      }
      if (condition.op === 'regex') {
        const inspected = inspectRegexSource(condition.value);
        if (!inspected.safe) {
          throw new BankingError('rule_invalid', `The ${condition.field} pattern cannot be used: ${inspected.reason}.`);
        }
      }
    }
    const direction = options.direction ?? (txn.amountCents < 0 ? 'out' : 'in');
    if (!RULE_DIRECTIONS.includes(direction)) {
      throw new BankingError('rule_invalid', `${JSON.stringify(direction)} is not a rule direction.`);
    }

    const account = (await resolveCounterAccounts(tx, [options.accountId])).get(options.accountId) as CounterAccount;
    const name =
      optionalText(options.name) ??
      `${parsed.conditions[0].value} → ${account.code} ${account.name}`;
    const vendorId = options.vendorId !== undefined ? options.vendorId : txn.suggestedVendorId;

    const [rule] = await tx
      .insert(categorizationRules)
      .values({
        name,
        priority: options.priority ?? 100,
        bankAccountId: options.thisAccountOnly === true ? txn.bankAccountId : null,
        conditions: parsed.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value })),
        direction,
        accountId: account.id,
        vendorId,
        channelId: options.channelId ?? null,
        autoPost: options.autoPost ?? false,
        createdBy: ctx.userId,
      })
      .returning({ id: categorizationRules.id });

    return {
      id: rule.id,
      name,
      conditions: parsed.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value })),
      direction,
      accountId: account.id,
      vendorId,
      autoPost: options.autoPost ?? false,
    };
  });
}

/**
 * Sooz Books — the deterministic suggestion pipeline.
 *
 * Everything an import can work out on its own happens here, before any AI is
 * consulted. Four tiers, in descending order of how much they can be trusted:
 *
 *   1. **Transfers.** The bank told us this money moved between two of the
 *      company's own accounts. It is not income, it is not expense, and no rule
 *      about payees should get a say.
 *   2. **Rules.** The owner wrote a predicate and said what it means. This is the
 *      only tier that may set `autoPost`, and only for a rule flagged `auto_post`.
 *   3. **The vendor's default expense account.** Deliberate configuration on the
 *      vendor record, so it outranks anything inferred from past behaviour.
 *   4. **History.** The account this payee has most often been coded to in the last
 *      twelve months, weighted by how consistent and how numerous those codings are.
 *
 * Below all four is null, which means "the review queue, and an AI suggestion if one
 * is available". Returning null is not a failure; for this company it is the correct
 * answer 37 times over, because every Amazon charge is genuinely ambiguous.
 *
 * Two invariants this file exists to protect:
 *
 *   - **A pull from the owner's personal bank is equity, never revenue.** The seeded
 *     rules code `CHASE COLLEGE` and `Adv SafeBalance Banking` ACH pulls to 3015
 *     Member Contributions. Those pulls are larger than every Square deposit
 *     combined; booking them as income would overstate revenue roughly tenfold.
 *   - **Nothing posts without a human** unless a rule the owner explicitly marked
 *     `auto_post` won outright. A transfer, a card refund or an inferred pairing
 *     never sets `autoPost`, whatever its confidence.
 */

import { sql as sqlTag } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { formatMoneyPlain } from '@/lib/money';
import { dateParts, monthStart, today, type CalendarDate } from '@/lib/dates';

import type { CategorizationRule, RuleEngine } from './rules';
import {
  detectTransfers,
  type IdentifiedTxn,
  type TransferDetection,
  type TransferOptions,
} from './transfers';
import { normalizeDescription } from './normalize';
import { resolveVendor, type VendorIndex, type VendorMatch } from './vendors';

// ---------------------------------------------------------------------------
// The suggestion
// ---------------------------------------------------------------------------

/** Which tier produced the suggestion. */
export type SuggestionSource =
  | 'transfer'
  | 'card_refund'
  | 'rule'
  | 'vendor_default'
  | 'history';

/** The `suggestion_source` enum in the database is coarser than the pipeline is. */
export type DbSuggestionSource = 'rule' | 'history' | 'ai' | 'match';

/**
 * Maps a pipeline tier onto the `suggestion_source` enum for persistence.
 *
 * `transfer` and `card_refund` are matches against another transaction, so they
 * become `match`. `vendor_default` has no enum value of its own; it becomes
 * `history`, the enum's label for "derived from what this company has recorded
 * before", and the exact tier stays legible in `suggestion_reasoning`.
 */
export function toDbSuggestionSource(source: SuggestionSource): DbSuggestionSource {
  switch (source) {
    case 'rule':
      return 'rule';
    case 'transfer':
    case 'card_refund':
      return 'match';
    case 'vendor_default':
    case 'history':
      return 'history';
  }
}

export interface Suggestion {
  readonly accountId: string | null;
  readonly vendorId: string | null;
  readonly customerId: string | null;
  readonly channelId: string | null;
  readonly memo: string | null;
  readonly source: SuggestionSource;
  /** 0..1. */
  readonly confidence: number;
  /** Why, in a sentence a bookkeeper can act on. Written to `suggestion_reasoning`. */
  readonly reasoning: string;
  readonly ruleId: string | null;
  /**
   * True only when a rule marked `auto_post` won and named an account. Every other
   * path through this file leaves it false.
   */
  readonly autoPost: boolean;
  /** The other side of a proposed transfer pair, when there is one. */
  readonly transferPairTxnId: string | null;
  /** The charge a card refund reverses, when it was found. */
  readonly cardRefundOfTxnId: string | null;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  readonly accountId: string;
  readonly uses: number;
  readonly lastUsed: CalendarDate;
}

/** Normalised payee → how that payee has been coded. */
export type PayeeHistory = ReadonlyMap<string, readonly HistoryEntry[]>;

export interface RankedHistory {
  readonly accountId: string;
  readonly uses: number;
  readonly total: number;
  readonly confidence: number;
}

/**
 * Picks the account a payee has most often been coded to, and says how much that is
 * worth.
 *
 * Confidence is `share × (1 − 1/(n+1))`: the share of this payee's history the
 * winning account holds, discounted by how little history there is. One prior
 * coding scores at most 0.5 and never clears the default floor — one observation is
 * an anecdote. Two consistent codings reach 0.67, nine reach 0.9.
 */
export function rankHistory(entries: readonly HistoryEntry[]): RankedHistory | null {
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, entry) => sum + entry.uses, 0);
  if (total <= 0) return null;

  const ordered = [...entries].sort(
    (a, b) =>
      b.uses - a.uses ||
      b.lastUsed.localeCompare(a.lastUsed) ||
      a.accountId.localeCompare(b.accountId),
  );
  const best = ordered[0];
  const share = best.uses / total;
  const confidence = Number((share * (1 - 1 / (best.uses + 1))).toFixed(3));
  return { accountId: best.accountId, uses: best.uses, total, confidence };
}

interface HistoryRow {
  readonly payee_key: string;
  readonly account_id: string;
  readonly uses: number;
  readonly last_used: string;
}

export interface LoadPayeeHistoryOptions {
  /** The day to count back from; defaults to today. */
  readonly asOf?: CalendarDate;
  /** How many calendar months of history to consider. */
  readonly months?: number;
  /** Read inside the caller's transaction instead of on a pooled connection. */
  readonly tx?: Tx;
}

/** The first of the month `months` whole months before `date`. */
function monthsBefore(date: CalendarDate, months: number): CalendarDate {
  const { year, month } = dateParts(monthStart(date));
  const index = year * 12 + (month - 1) - months;
  const shiftedYear = Math.floor(index / 12);
  const shiftedMonth = index - shiftedYear * 12 + 1;
  return `${String(shiftedYear).padStart(4, '0')}-${String(shiftedMonth).padStart(2, '0')}-01`;
}

/**
 * Reads how each payee has actually been coded.
 *
 * "Coded" means the non-bank side of the journal entry the transaction posted to,
 * or — for a transaction a human reviewed but which has not posted yet — the
 * account they accepted. An entry split across several lines contributes its largest
 * line, so a one-off freight line on a big inventory bill does not outvote the
 * inventory itself.
 *
 * `@/db/client` opens its pool on import, so it is required lazily: everything above
 * this line is pure and runs with no database in reach.
 */
export async function loadPayeeHistory(
  options: LoadPayeeHistoryOptions = {},
): Promise<PayeeHistory> {
  const months = Math.max(1, options.months ?? 12);
  const asOf = options.asOf ?? today();
  // Calendar-aligned, so the window never depends on today's day-of-month.
  const since = monthsBefore(asOf, months - 1);

  const statement = sqlTag`
    with coded as (
      select coalesce(nullif(normalize_description(bt.counterparty), ''),
                      bt.description_normalized)                       as payee_key,
             coalesce(line.account_id,
                      case when bt.reviewed_at is not null
                           then bt.suggested_account_id end)           as account_id,
             bt.txn_date
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
       where bt.status in ('categorized', 'matched')
         and bt.txn_date >= ${since}::date
         and bt.txn_date <= ${asOf}::date
    )
    select payee_key,
           account_id,
           count(*)::int          as uses,
           max(txn_date)::text    as last_used
      from coded
     where account_id is not null
       and payee_key <> ''
     group by payee_key, account_id
     order by payee_key, uses desc`;

  const runner = options.tx ?? (await import('@/db/client')).db;
  const rows = (await runner.execute(statement)) as unknown as HistoryRow[];

  const history = new Map<string, HistoryEntry[]>();
  for (const row of rows) {
    const bucket = history.get(row.payee_key);
    const entry: HistoryEntry = {
      accountId: row.account_id,
      uses: row.uses,
      lastUsed: row.last_used,
    };
    if (bucket === undefined) history.set(row.payee_key, [entry]);
    else bucket.push(entry);
  }
  return history;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface SuggestionContext {
  readonly engine: RuleEngine;
  readonly vendors: VendorIndex;
  /** Findings for the whole batch; `suggestBatch` computes this when it is absent. */
  readonly transfers?: TransferDetection;
  readonly history?: PayeeHistory;
  /** Below this, a history suggestion is not worth showing. */
  readonly minHistoryConfidence?: number;
}

const DEFAULT_MIN_HISTORY_CONFIDENCE = 0.5;

/** A rule that names an account and is flagged `auto_post` is as certain as it gets. */
const AUTO_POST_RULE_CONFIDENCE = 0.98;
const RULE_CONFIDENCE = 0.9;
/** A vendor default is configuration, but the payee match underneath it may not be exact. */
const VENDOR_DEFAULT_CEILING = 0.85;

function renderMemo(rule: CategorizationRule, txn: IdentifiedTxn): string | null {
  const payee = (txn.payee ?? '').trim();
  if (rule.memoTemplate === null || rule.memoTemplate === '') {
    return payee === '' ? null : payee;
  }
  return rule.memoTemplate
    .replace(/\{payee\}/g, payee)
    .replace(/\{reference\}/g, (txn.reference ?? '').trim())
    .replace(/\{description\}/g, (txn.description ?? '').trim())
    .replace(/\{date\}/g, txn.txnDate)
    .replace(/\{amount\}/g, formatMoneyPlain(Math.abs(txn.amountCents)));
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Runs the pipeline for one transaction.
 *
 * `ctx.transfers` has to describe the whole batch — both sides of a transfer are
 * usually in different files — so prefer `suggestBatch`, which computes it.
 */
export function suggestForTransaction(
  txn: IdentifiedTxn,
  ctx: SuggestionContext,
): Suggestion | null {
  const transfers = ctx.transfers;
  const vendorMatch = resolveVendor(txn.payee, ctx.vendors);
  const refund = transfers?.cardRefundByTxnId.get(txn.id) ?? null;
  const cardRefundOfTxnId = refund?.original?.id ?? null;

  // ---- 1. transfers the bank labelled --------------------------------------
  const pair = transfers?.pairByTxnId.get(txn.id) ?? null;
  if (pair !== null && pair.basis === 'bank_labelled') {
    const other = pair.outgoing.id === txn.id ? pair.incoming : pair.outgoing;
    return {
      accountId: null,
      vendorId: null,
      customerId: null,
      channelId: null,
      memo: (txn.payee ?? '').trim() || 'Internal transfer',
      source: 'transfer',
      confidence: pair.confidence,
      reasoning: `Internal transfer between the company's own accounts — it must not touch the P&L. ${pair.evidence.join('; ')}.`,
      ruleId: null,
      autoPost: false,
      transferPairTxnId: other.id,
      cardRefundOfTxnId: null,
    };
  }

  const unpairedTransfer = transfers?.unpairedByTxnId.get(txn.id) ?? null;
  if (unpairedTransfer !== null && unpairedTransfer.counterpartyOutsideCompany) {
    // Relay says "transfer" for money from any Relay account, including one that is
    // not the company's. That is outside money — a member contribution, a refund, a
    // loan — and only a human can say which. It is kept as a `transfer`-sourced
    // suggestion so the reasoning travels with it, but it names no account and is
    // never written as an internal transfer (see `proposedStatus` in import.ts).
    return {
      accountId: null,
      vendorId: null,
      customerId: null,
      channelId: null,
      memo: (txn.payee ?? '').trim() || (txn.description ?? '').trim() || null,
      source: 'transfer',
      confidence: 0.3,
      reasoning: `The bank labelled this a transfer, but not between the company's own accounts, so it is money ${unpairedTransfer.side === 'in' ? 'from' : 'to'} outside the company and needs a human to classify it. ${unpairedTransfer.evidence.join('; ')}.`,
      ruleId: null,
      autoPost: false,
      transferPairTxnId: null,
      cardRefundOfTxnId: null,
    };
  }
  if (unpairedTransfer !== null) {
    return {
      accountId: null,
      vendorId: null,
      customerId: null,
      channelId: null,
      memo: (txn.payee ?? '').trim() || 'Internal transfer',
      source: 'transfer',
      confidence: 0.6,
      reasoning: `The bank labelled this an internal transfer, so it is not income or expense, but the other side is not in this batch and has to be paired by hand. ${unpairedTransfer.evidence.join('; ')}.`,
      ruleId: null,
      autoPost: false,
      transferPairTxnId: null,
      cardRefundOfTxnId: null,
    };
  }

  // ---- 2. rules -------------------------------------------------------------
  const evaluation = ctx.engine.evaluate(txn);
  const winner = evaluation.winner;
  if (winner !== null) {
    const isAutoPost = winner.autoPost && winner.accountId !== null;
    // A rule may be certain about the account and still be wrong about the fact
    // that this row is a refund or an inferred transfer. Those never auto-post.
    const blocked = refund !== null || pair !== null;
    const also =
      evaluation.matches.length > 1
        ? ` ${plural(evaluation.matches.length, 'rule')} matched; this one has the lowest priority number (${winner.priority}).`
        : '';
    const refundNote =
      refund !== null
        ? ` This is money coming back on a card — an expense reversal, not income. ${refund.evidence.join('; ')}.`
        : '';
    return {
      accountId: winner.accountId,
      vendorId: winner.vendorId ?? vendorMatch?.vendorId ?? null,
      customerId: winner.customerId,
      channelId: winner.channelId,
      memo: renderMemo(winner, txn),
      source: 'rule',
      confidence: isAutoPost ? AUTO_POST_RULE_CONFIDENCE : RULE_CONFIDENCE,
      reasoning: `Rule "${winner.name}" matched.${also}${refundNote}`,
      ruleId: winner.id,
      autoPost: isAutoPost && !blocked,
      transferPairTxnId: null,
      cardRefundOfTxnId,
    };
  }

  // ---- 2b. an inferred transfer pair ---------------------------------------
  // Below the rules on purpose: the bank did not label this, so it is a guess, and
  // a predicate the owner wrote outranks a guess about two amounts being equal.
  if (pair !== null) {
    const other = pair.outgoing.id === txn.id ? pair.incoming : pair.outgoing;
    return {
      accountId: null,
      vendorId: null,
      customerId: null,
      channelId: null,
      memo: (txn.payee ?? '').trim() || 'Possible internal transfer',
      source: 'transfer',
      confidence: pair.confidence,
      reasoning: `Possible internal transfer — proposed, not applied. ${pair.evidence.join('; ')}.`,
      ruleId: null,
      autoPost: false,
      transferPairTxnId: other.id,
      cardRefundOfTxnId,
    };
  }

  // ---- 3. the vendor's default expense account ------------------------------
  // Only for money out. A vendor's *expense* default says nothing useful about
  // money arriving from them — a returned ACH, a rebate or a deposit coded to the
  // ad account because the payee happens to be Google is a worse answer than the
  // review queue.
  if (
    txn.amountCents < 0 &&
    vendorMatch !== null &&
    vendorMatch.defaultExpenseAccountId !== null
  ) {
    return {
      accountId: vendorMatch.defaultExpenseAccountId,
      vendorId: vendorMatch.vendorId,
      customerId: null,
      channelId: null,
      memo: (txn.payee ?? '').trim() || vendorMatch.vendorName,
      source: 'vendor_default',
      confidence: Math.min(VENDOR_DEFAULT_CEILING, vendorMatch.confidence),
      reasoning: describeVendorDefault(vendorMatch),
      ruleId: null,
      autoPost: false,
      transferPairTxnId: null,
      cardRefundOfTxnId,
    };
  }

  // ---- 4. history -----------------------------------------------------------
  const minHistory = ctx.minHistoryConfidence ?? DEFAULT_MIN_HISTORY_CONFIDENCE;
  const payeeKey = normalizeDescription(txn.payee) || normalizeDescription(txn.description);
  const entries = payeeKey === '' ? undefined : ctx.history?.get(payeeKey);
  const ranked = entries === undefined ? null : rankHistory(entries);
  if (ranked !== null && ranked.confidence >= minHistory) {
    return {
      accountId: ranked.accountId,
      vendorId: vendorMatch?.vendorId ?? null,
      customerId: null,
      channelId: null,
      memo: (txn.payee ?? '').trim() || null,
      source: 'history',
      confidence: ranked.confidence,
      reasoning: `Coded this way ${plural(ranked.uses, 'time')} out of ${ranked.total} for "${payeeKey}" in the last twelve months.`,
      ruleId: null,
      autoPost: false,
      transferPairTxnId: null,
      cardRefundOfTxnId,
    };
  }

  // ---- nothing confident, but a card refund is still worth saying -----------
  if (refund !== null) {
    return {
      accountId: null,
      vendorId: vendorMatch?.vendorId ?? null,
      customerId: null,
      channelId: null,
      memo: (txn.payee ?? '').trim() || null,
      source: 'card_refund',
      confidence: refund.confidence,
      reasoning: `Money in on a card: an expense reversal, not income. ${refund.evidence.join('; ')}.`,
      ruleId: null,
      autoPost: false,
      transferPairTxnId: null,
      cardRefundOfTxnId,
    };
  }

  return null;
}

function describeVendorDefault(match: VendorMatch): string {
  switch (match.method) {
    case 'alias_exact':
      return `Payee matches the stored alias "${match.matchedOn}" for ${match.vendorName}; using that vendor's default expense account.`;
    case 'alias_cleaned':
      return `Payee cleans to the stored alias "${match.matchedOn}" for ${match.vendorName}; using that vendor's default expense account.`;
    case 'vendor_name':
      return `Payee cleans to the vendor name "${match.matchedOn}"; using ${match.vendorName}'s default expense account.`;
    case 'fuzzy':
      return `Payee is a close match for "${match.matchedOn}" (${match.confidence.toFixed(2)} similarity); using ${match.vendorName}'s default expense account.`;
  }
}

export interface BatchSuggestion {
  readonly txn: IdentifiedTxn;
  readonly suggestion: Suggestion | null;
}

export interface SuggestBatchOptions {
  readonly transferOptions?: TransferOptions;
}

/**
 * Runs the pipeline over a whole batch, detecting transfers across it first.
 *
 * The rule engine accumulates its hit counts as it goes; hand `ctx.engine.hits()` to
 * `recordRuleHits` once the import is accepted — one UPDATE, not one per row.
 */
export function suggestBatch(
  txns: readonly IdentifiedTxn[],
  ctx: SuggestionContext,
  options: SuggestBatchOptions = {},
): readonly BatchSuggestion[] {
  const transfers = ctx.transfers ?? detectTransfers(txns, options.transferOptions);
  const withTransfers: SuggestionContext = { ...ctx, transfers };
  return txns.map((txn) => ({ txn, suggestion: suggestForTransaction(txn, withTransfers) }));
}

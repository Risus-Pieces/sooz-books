/**
 * The AI tier, wired into the ledger.
 *
 * `ai-suggest.ts` is pure: it takes rows, asks a model, and returns what survives
 * the guardrails. This module is what the import pipeline actually calls. It picks
 * the rows every deterministic tier declined, loads the chart and the vendor list the
 * prompt is built from, and writes the answers back to `bank_transactions` — in one
 * transaction, guarded so an answer can never land on a row a human has touched.
 *
 * Which rows are asked about:
 *
 *   - rows with no suggested account at all, and
 *   - rows a rule deliberately parked in 7900 Ask My Accountant because the payee
 *     alone cannot decide them — Amazon above all (`relay.md`: "These go to the
 *     review queue with an AI suggestion and no default").
 *
 * Never asked about: anything already `categorized`, `transfer` or `excluded`,
 * anything reviewed, posted or reconciled, and any row whose suggestion is a
 * `match` against another transaction (a transfer leg, a card refund) — that
 * reasoning is about the other row and a model cannot improve on it.
 *
 * What is written: the account, the vendor when the model named a configured one,
 * `suggestion_source = 'ai'`, the confidence and the reasoning — and `rule_id` is
 * cleared, because the rule is no longer where the suggestion came from. `status`
 * stays `unreviewed`. An AI suggestion is a proposal and can never post by itself.
 *
 * An AI failure is never an import failure: no key, no network, a timeout or a bad
 * answer all come back as a report with the reason, and every row keeps the
 * suggestion it had.
 */

import { and, eq, inArray, isNull, or, sql as sqlTag } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { accounts, bankTransactions, vendorAliases, vendors } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';

import type { PromptAccount, PromptVendor } from './ai-prompt';
import {
  resolveSuggestModel,
  suggestWithAIDetailed,
  type AISuggestContext,
} from './ai-suggest';
import { normalizeDescription } from './normalize';
import type { NormalizedTxn } from './types';

/** Everything about the model call a caller may set; the chart and vendors are loaded here. */
export type AiTierOptions = Omit<AISuggestContext, 'accounts' | 'vendors'>;

export interface AiTierReport {
  /** Rows that were eligible and sent to the model. */
  readonly attempted: number;
  /** Rows whose suggestion columns now carry the model's answer. */
  readonly written: number;
  /** Answers the guardrails threw away (unknown account, control account, …). */
  readonly discarded: number;
  /**
   * Rows sent to the model that came back with no answer, or whose answer could not be
   * written (a human reviewed the row mid-call). attempted = written + discarded +
   * unanswered always holds, so a row can never vanish from the report unaccounted.
   */
  readonly unanswered: number;
  readonly modelId: string | null;
  /** One line per failed model call; empty when every call worked. */
  readonly failures: readonly string[];
  /** Why the tier did not run at all, or null when it ran. */
  readonly skippedReason: string | null;
  /** What was written, for the import report. */
  readonly suggestions: ReadonlyArray<{
    readonly txnId: string;
    readonly accountCode: string;
    readonly amountCents: number;
    readonly needsHuman: boolean;
  }>;
}

function emptyReport(attempted: number, skippedReason: string | null): AiTierReport {
  return {
    attempted,
    written: 0,
    discarded: 0,
    unanswered: attempted,
    modelId: null,
    failures: [],
    skippedReason,
    suggestions: [],
  };
}

// ---------------------------------------------------------------------------
// What the prompt is built from
// ---------------------------------------------------------------------------

/**
 * The chart of accounts as the prompt sees it.
 *
 * A rollup is an account something else points at as its parent. Nothing posts to
 * one, so the model is told it is not postable and the guardrails refuse it.
 */
export async function loadPromptAccounts(tx?: Tx): Promise<PromptAccount[]> {
  const exec = tx ?? (await import('@/db/client')).db;
  const rows = await exec
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      description: accounts.description,
      type: accounts.type,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      isBank: accounts.isBank,
      isControl: accounts.isControl,
      active: accounts.active,
    })
    .from(accounts);

  const parents = new Set(rows.map((row) => row.parentId).filter((id): id is string => id !== null));

  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    description: row.description,
    type: row.type,
    subtype: row.subtype,
    postable: !parents.has(row.id),
    isBank: row.isBank,
    isControl: row.isControl,
    active: row.active,
  }));
}

/** The configured vendors, their notes (which carry "never auto-categorize") and their aliases. */
export async function loadPromptVendors(tx?: Tx): Promise<Array<PromptVendor & { readonly id: string }>> {
  const exec = tx ?? (await import('@/db/client')).db;
  const rows = await exec
    .select({
      id: vendors.id,
      name: vendors.name,
      notes: vendors.notes,
      defaultAccountCode: accounts.code,
    })
    .from(vendors)
    .leftJoin(accounts, eq(accounts.id, vendors.defaultExpenseAccountId));

  const aliasRows = await exec
    .select({ vendorId: vendorAliases.vendorId, alias: vendorAliases.alias })
    .from(vendorAliases);

  const aliases = new Map<string, string[]>();
  for (const row of aliasRows) {
    const bucket = aliases.get(row.vendorId);
    if (bucket === undefined) aliases.set(row.vendorId, [row.alias]);
    else bucket.push(row.alias);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    defaultAccountCode: row.defaultAccountCode,
    notes: row.notes,
    aliases: aliases.get(row.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// The tier
// ---------------------------------------------------------------------------

export interface ApplyAiSuggestionsOptions {
  /** Actor for the audit trail. */
  readonly userId: string | null;
  /** Model injection, timeouts and so on. Omit to resolve the model from the environment. */
  readonly ai?: AiTierOptions;
}

/**
 * Asks the model about whichever of `txnIds` every deterministic tier declined, and
 * writes the answers back.
 *
 * Opens its own transaction for the write and holds none during the model call:
 * a ten-second network round trip must never sit inside a database transaction.
 */
export async function applyAiSuggestions(
  txnIds: readonly string[],
  options: ApplyAiSuggestionsOptions,
): Promise<AiTierReport> {
  if (txnIds.length === 0) return emptyReport(0, 'nothing to ask about');

  const ai = options.ai ?? {};
  // Resolve before touching the database: no model means nothing else is worth doing.
  if (resolveSuggestModel({ ...ai, accounts: [] }) === null) {
    return emptyReport(
      0,
      'no model is configured (set ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY); suggestions come from rules, vendors and history only',
    );
  }

  const { db, withActor } = await import('@/db/client');
  const [askMyAccountant] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.code, ACCOUNTS.ASK_MY_ACCOUNTANT))
    .limit(1);
  const parkedAccountId = askMyAccountant?.id ?? null;

  // Rows with no account, or parked in Ask My Accountant, and nothing a human or the
  // matcher has already said about them.
  const eligible =
    parkedAccountId === null
      ? isNull(bankTransactions.suggestedAccountId)
      : or(
          isNull(bankTransactions.suggestedAccountId),
          eq(bankTransactions.suggestedAccountId, parkedAccountId),
        );
  const untouched = and(
    eq(bankTransactions.status, 'unreviewed'),
    isNull(bankTransactions.reviewedAt),
    isNull(bankTransactions.journalEntryId),
    isNull(bankTransactions.reconciliationId),
    isNull(bankTransactions.transferPairId),
    sqlTag`${bankTransactions.suggestionSource} is distinct from 'match'`,
    eligible,
  );

  const candidates = await db
    .select({
      id: bankTransactions.id,
      txnDate: bankTransactions.txnDate,
      description: bankTransactions.description,
      counterparty: bankTransactions.counterparty,
      reference: bankTransactions.reference,
      amountCents: bankTransactions.amountCents,
    })
    .from(bankTransactions)
    .where(and(inArray(bankTransactions.id, [...new Set(txnIds)]), untouched))
    .orderBy(bankTransactions.txnDate, bankTransactions.id);

  if (candidates.length === 0) {
    return emptyReport(0, 'every row already has a deterministic suggestion');
  }

  const [promptAccounts, promptVendors] = await Promise.all([
    loadPromptAccounts(),
    loadPromptVendors(),
  ]);

  const txns: NormalizedTxn[] = candidates.map((txn, index) => ({
    date: txn.txnDate,
    description: txn.description,
    descriptionNormalized: normalizeDescription(txn.description),
    counterparty: txn.counterparty,
    amountCents: txn.amountCents,
    balanceCents: null,
    reference: txn.reference,
    externalId: null,
    rawType: null,
    status: null,
    rowIndex: index,
    raw: {},
    warnings: [],
    usable: true,
  }));

  const result = await suggestWithAIDetailed(txns, {
    ...ai,
    accounts: promptAccounts,
    vendors: promptVendors,
  });

  const failures = result.calls
    .filter((call) => !call.ok)
    .map((call) => `${call.failure?.kind ?? 'unknown'}: ${call.failure?.message ?? 'no detail'}`);

  const codeToId = new Map(
    (await db.select({ id: accounts.id, code: accounts.code }).from(accounts)).map((row) => [
      row.code,
      row.id,
    ]),
  );
  const vendorIdByName = new Map(
    promptVendors.map((vendor) => [normalizeDescription(vendor.name), vendor.id]),
  );

  const written: Array<AiTierReport['suggestions'][number]> = [];

  if (result.suggestions.length > 0) {
    await withActor(options.userId, async (tx) => {
      for (const suggestion of result.suggestions) {
        const txn = candidates[suggestion.rowIndex];
        const accountId = codeToId.get(suggestion.accountCode);
        if (txn === undefined || accountId === undefined) continue;

        const vendorId =
          suggestion.vendorName === null
            ? undefined
            : vendorIdByName.get(normalizeDescription(suggestion.vendorName));
        const review = suggestion.needsHuman ? ' Flagged for a human before it posts.' : '';

        const updated = await tx
          .update(bankTransactions)
          .set({
            suggestedAccountId: accountId,
            // The vendor is a fact about the payee, not about the coding: keep the one
            // the importer already resolved unless the model named a configured vendor.
            ...(vendorId === undefined ? {} : { suggestedVendorId: vendorId }),
            suggestionSource: 'ai',
            suggestionConfidence: suggestion.confidence.toFixed(3),
            suggestionReasoning: `${suggestion.reasoning}${review} (${suggestion.modelId})`,
            // The rule no longer explains the suggestion; leaving it would claim it did.
            ruleId: null,
          })
          .where(and(eq(bankTransactions.id, txn.id), untouched))
          .returning({ id: bankTransactions.id });

        if (updated.length === 0) continue;
        written.push({
          txnId: txn.id,
          accountCode: suggestion.accountCode,
          amountCents: txn.amountCents,
          needsHuman: suggestion.needsHuman,
        });
      }
    });
  }

  return {
    attempted: candidates.length,
    written: written.length,
    discarded: result.discarded.length,
    unanswered: Math.max(0, candidates.length - written.length - result.discarded.length),
    modelId: result.calls[0]?.modelId ?? null,
    failures,
    skippedReason: null,
    suggestions: written,
  };
}

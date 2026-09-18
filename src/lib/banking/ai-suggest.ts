/**
 * Sooz Books — AI-assisted categorization, for the transactions the deterministic
 * pipeline could not answer.
 *
 * `suggest.ts` runs first and wins outright: transfers, the owner's rules, a vendor's
 * configured default account, then twelve months of how a payee has actually been
 * coded. What survives all four tiers is genuinely ambiguous — for Sooz that is the
 * 37 Amazon charges, the big-box stores and the odd restaurant — and this module asks
 * a language model about those, and only those.
 *
 * Three things govern everything below.
 *
 * **The model never posts.** `AISuggestion.autoPost` is typed as the literal `false`.
 * There is no code path, no confidence and no configuration that makes it true. Only a
 * `categorization_rules` row the owner explicitly flagged `auto_post` may post without
 * a human, and that decision is made in `suggest.ts`, not here.
 *
 * **A suggestion is discarded rather than trusted.** Everything that comes back is
 * checked against the chart of accounts that was sent: an unknown code, a rollup, a
 * bank account or a control account is dropped and recorded, and the transaction goes
 * to a human with no suggestion at all. A dropped suggestion costs a click. A wrong
 * one coded into a control account behind the subledger's back costs a reconciliation.
 *
 * **An AI failure is never an import failure.** No API key, no network, a timeout, a
 * rate limit, a response that does not parse — every one of them returns an empty
 * array, and the import proceeds on rules alone. Nothing in this file throws for an
 * operational reason. The failures are recorded on the per-batch report so the UI can
 * say "AI was unavailable" instead of silently suggesting nothing.
 *
 * Rows are matched back by the `rowIndex` we sent, never by position in the returned
 * array. A model that skips a row simply produces no suggestion for it; a model that
 * reorders its answers is still read correctly.
 */

import {
  APICallError,
  JSONParseError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  TypeValidationError,
  generateObject,
} from 'ai';
import type { JSONSchema7, LanguageModelV3, LanguageModelV4 } from '@ai-sdk/provider';
import { UnsupportedFunctionalityError } from '@ai-sdk/provider';
import { z } from 'zod';

import { cleanPayee, normalizeDescription } from './normalize';
import type { NormalizedTxn } from './types';
import {
  SOOZ_COMPANY_CONTEXT,
  buildSuggestPrompt,
  isClearingAccount,
  type CompanyContext,
  type PromptAccount,
  type PromptTxn,
  type PromptVendor,
} from './ai-prompt';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The most transactions to put in one call. Sooz has 110 across nine months; at 40 a
 * call that is three round trips, not 110. The cap is a ceiling as well as a default —
 * a larger batch buys little and costs recall, because the model has to keep every row
 * id straight to the end of a long answer.
 */
export const MAX_BATCH_SIZE = 40;

/**
 * Rows per call when the caller does not choose. Small enough that a full answer for every
 * row — account, confidence and a sentence of reasoning — comes back well inside the
 * timeout: a 37-row batch asked to answer every row ran past 10 seconds and lost all 37.
 * Batches run concurrently, so smaller ones cost no wall-clock time.
 */
export const DEFAULT_BATCH_SIZE = 10;

/** Batches in flight at once. */
export const DEFAULT_CONCURRENCY = 4;

/** Below this, a suggestion is shown but flagged for a human. */
export const DEFAULT_CONFIDENCE_FLOOR = 0.6;

/** Per batch, not per import. Batches run in parallel, so an import waits for the slowest one. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** One retry, then give up. */
export const DEFAULT_MAX_ATTEMPTS = 2;

export const DEFAULT_RETRY_DELAY_MS = 750;

export const DEFAULT_MODEL_ID = 'anthropic/claude-haiku-4-5';

/**
 * Anthropic requires an explicit output budget. Forty rows of
 * `{rowIndex, accountCode, vendorName, confidence, reasoning, needsHuman}` is roughly
 * 3,000 tokens; 8,192 leaves room for a verbose model without inviting an essay.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

// ---------------------------------------------------------------------------
// The suggestion
// ---------------------------------------------------------------------------

export interface AISuggestion {
  /** `NormalizedTxn.rowIndex` of the transaction this is about. */
  readonly rowIndex: number;
  /** A code that was in the chart we sent, is postable, and is neither bank nor control. */
  readonly accountCode: string;
  /** A configured vendor's name, or null when the model did not recognise one. */
  readonly vendorName: string | null;
  /** 0..1, clamped. */
  readonly confidence: number;
  /** One sentence, for `suggestion_reasoning`. */
  readonly reasoning: string;
  /** True below the confidence floor, and always for an always-review payee. */
  readonly needsHuman: boolean;
  /**
   * Always `false`, and typed so that it cannot become anything else. An AI suggestion
   * is never posted without a human, whatever its confidence.
   */
  readonly autoPost: false;
  /** For `suggestion_source`. */
  readonly source: 'ai';
  /** Which model produced it, for the audit trail. */
  readonly modelId: string;
}

/** Why a returned suggestion was thrown away. Recorded, never silent. */
export type AIDiscardReason =
  | 'unknown_row'
  | 'duplicate_row'
  | 'missing_account_code'
  | 'unknown_account'
  | 'inactive_account'
  | 'rollup_account'
  | 'bank_account'
  | 'control_account'
  | 'clearing_account';

export interface AIDiscard {
  readonly rowIndex: number | null;
  readonly accountCode: string | null;
  readonly reason: AIDiscardReason;
}

/** How a batch failed, coarse enough to drive a message and a retry decision. */
export type AIFailureKind =
  | 'no_model'
  | 'timeout'
  | 'rate_limit'
  | 'server_error'
  | 'network'
  | 'invalid_response'
  | 'unknown';

export interface AIFailure {
  readonly kind: AIFailureKind;
  readonly message: string;
  readonly statusCode: number | null;
}

/** Prices as integer micro-USD per token, so the arithmetic below stays exact. */
export interface AIPricing {
  /** Millionths of a dollar per input token. Haiku at $1/MTok is exactly 1. */
  readonly inputMicroUsdPerToken: number;
  /** Millionths of a dollar per output token. */
  readonly outputMicroUsdPerToken: number;
}

/**
 * What one call cost, for the UI.
 *
 * Token counts are whatever the provider reported, `null` when it reported nothing.
 * `costMicroUsd` is filled in only when the caller supplied `pricing`: model prices
 * change and differ per model, so guessing one here would be inventing a number.
 * It is integer micro-USD — a third of a cent is a real amount at these volumes and
 * rounding it to cents would throw the whole import's cost away.
 */
export interface AIBatchReport {
  readonly batchIndex: number;
  readonly rowCount: number;
  readonly modelId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costMicroUsd: number | null;
  readonly durationMs: number;
  /** 1 when it worked first time, 2 when the single retry was used. */
  readonly attempts: number;
  readonly ok: boolean;
  readonly failure: AIFailure | null;
  readonly suggestionCount: number;
  readonly discardCount: number;
}

export interface AISuggestResult {
  readonly suggestions: readonly AISuggestion[];
  /** One per model call, in batch order. Empty when no model was available. */
  readonly calls: readonly AIBatchReport[];
  readonly discarded: readonly AIDiscard[];
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AISuggestContext {
  /**
   * The chart of accounts, as it is in the database today. This is the whitelist:
   * a code that is not in here cannot come out of this module.
   */
  readonly accounts: readonly PromptAccount[];
  /** The configured vendors and their notes. Seeds the always-review list. */
  readonly vendors?: readonly PromptVendor[];
  readonly company?: CompanyContext;
  /** Injected model. Supplied by tests; in production this is resolved from the env. */
  readonly model?: LanguageModelV4 | LanguageModelV3 | string;
  /** Overrides `AI_SUGGEST_MODEL`. */
  readonly modelId?: string;
  /** Overrides `ANTHROPIC_API_KEY`. */
  readonly apiKey?: string;
  /** Overrides `AI_GATEWAY_API_KEY`. */
  readonly gatewayApiKey?: string;
  /** Default {@link DEFAULT_BATCH_SIZE}; clamped to 1..{@link MAX_BATCH_SIZE}. */
  readonly batchSize?: number;
  /** Batches in flight at once. Default {@link DEFAULT_CONCURRENCY}. */
  readonly concurrency?: number;
  /** Default {@link DEFAULT_CONFIDENCE_FLOOR}. */
  readonly confidenceFloor?: number;
  /** Per batch. Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Total attempts per batch, including the first. Default {@link DEFAULT_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly pricing?: AIPricing;
  /** Injected for the Anthropic adapter's own tests. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// The response schema
// ---------------------------------------------------------------------------

/**
 * Deliberately permissive.
 *
 * `confidence` is not `.min(0).max(1)` and `rowIndex` is not `.int()`, because zod
 * validates the whole object: one row where the model wrote `1.2` would throw away the
 * other thirty-nine. The bounds are documented in `.describe()`, which reaches the
 * model as part of the JSON schema, and enforced in `applyGuardrails`, which can
 * discard one row without losing the batch.
 *
 * `accountCode` accepts a number because a model asked for `"6740"` will sometimes
 * write `6740`. It is normalised to a string before it is looked up.
 *
 * Everything but `rowIndex` and `accountCode` is optional, and every default is the
 * cautious direction: a missing confidence is 0, a missing `needsHuman` is true.
 */
const suggestionItemSchema = z.object({
  rowIndex: z
    .number()
    .describe('The row_id from the transaction table, copied exactly. Never renumbered.'),
  accountCode: z
    .union([z.string(), z.number()])
    .describe('One account code from the chart of accounts in the system prompt.'),
  vendorName: z
    .string()
    .nullable()
    .optional()
    .describe('The configured vendor this payee is, or null.'),
  confidence: z
    .number()
    .optional()
    .describe('Between 0 and 1. Your honest probability that this coding survives review.'),
  reasoning: z.string().optional().describe('One sentence naming the evidence you used.'),
  needsHuman: z
    .boolean()
    .optional()
    .describe('True when a person should look at this before it posts.'),
});

const suggestResponseSchema = z.object({
  suggestions: z.array(suggestionItemSchema),
});

type SuggestionItem = z.infer<typeof suggestionItemSchema>;

// ---------------------------------------------------------------------------
// The always-review list
// ---------------------------------------------------------------------------

/**
 * How the owner says "never let this be automatic" in `vendors.notes`.
 *
 * Declarative on purpose. Amazon is the payee that matters for Sooz today — 37
 * transactions covering lab supplies, packaging, office goods and personal purchases
 * under one name — but the rule is "a vendor the owner marked ambiguous", not "the
 * string Amazon". Add `Never auto-categorize.` to a vendor's notes and it joins the
 * list without a code change.
 */
export const ALWAYS_REVIEW_NOTE_PATTERNS: readonly RegExp[] = Object.freeze([
  /never\s+auto[\s-]?categori[sz]/i,
  /do\s+not\s+auto[\s-]?categori[sz]/i,
  /always\s+review/i,
  /ambiguous\s+by\s+design/i,
]);

/** True when the owner's notes on this vendor say it must never be automatic. */
export function vendorAlwaysNeedsReview(vendor: PromptVendor): boolean {
  const notes = vendor.notes ?? '';
  return ALWAYS_REVIEW_NOTE_PATTERNS.some((pattern) => pattern.test(notes));
}

/**
 * The normalised name and aliases of every always-review vendor.
 *
 * Exported so an import report can show which payees are being held back and why.
 */
export function alwaysReviewTerms(
  vendors: readonly PromptVendor[] = [],
): readonly string[] {
  const terms = new Set<string>();
  for (const vendor of vendors) {
    if (!vendorAlwaysNeedsReview(vendor)) continue;
    for (const label of [vendor.name, ...(vendor.aliases ?? [])]) {
      const normalized = normalizeDescription(label);
      if (normalized !== '') terms.add(normalized);
    }
  }
  return Object.freeze([...terms]);
}

/** Whole-word containment: `AMAZON` matches `AMAZON MKTPL`, never `AMAZONIA`. */
function containsWords(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  const hay = haystack.split(' ').filter((w) => w !== '');
  const need = needle.split(' ').filter((w) => w !== '');
  if (need.length === 0 || need.length > hay.length) return false;
  for (let start = 0; start + need.length <= hay.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < need.length; offset += 1) {
      if (hay[start + offset] !== need[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Whether this transaction touches an always-review payee.
 *
 * Checked against the bank's payee, the cleaned payee and the vendor the model claims
 * to have recognised, because any one of the three is enough to make the charge
 * ambiguous.
 */
function needsReviewByPayee(
  payee: string,
  cleaned: string,
  claimedVendor: string | null,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return false;
  const haystacks = [
    normalizeDescription(payee),
    normalizeDescription(cleaned),
    normalizeDescription(claimedVendor),
  ];
  return terms.some((term) => haystacks.some((hay) => containsWords(hay, term)));
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function tidyReasoning(value: string | undefined, accountCode: string): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (text !== '') return text;
  return `Model proposed ${accountCode} without stating a reason.`;
}

export interface GuardrailInput {
  readonly items: readonly SuggestionItem[];
  /**
   * The rows of **this batch**, and only this batch. A model that answers for a row
   * it was not shown is answering about money it never saw, so the id must be scoped
   * to the call rather than to the import.
   */
  readonly rows: ReadonlyMap<number, PromptTxn>;
  readonly accounts: ReadonlyMap<string, PromptAccount>;
  readonly alwaysReview: readonly string[];
  readonly confidenceFloor: number;
  readonly modelId: string;
}

export interface GuardrailOutput {
  readonly suggestions: readonly AISuggestion[];
  readonly discarded: readonly AIDiscard[];
}

/**
 * Turns what the model said into what the review queue is allowed to see.
 *
 * Every rejection is recorded with a reason. Nothing here trusts the model's arithmetic,
 * its spelling of an account code or its own sense of how sure it is.
 */
export function applyGuardrails(input: GuardrailInput): GuardrailOutput {
  const suggestions: AISuggestion[] = [];
  const discarded: AIDiscard[] = [];
  const seen = new Set<number>();

  for (const item of input.items) {
    const rowIndex = Number.isFinite(item.rowIndex) ? Math.trunc(item.rowIndex) : NaN;
    const rawCode = typeof item.accountCode === 'number' ? String(item.accountCode) : item.accountCode;
    const accountCode = (rawCode ?? '').trim();

    const txn = Number.isNaN(rowIndex) ? undefined : input.rows.get(rowIndex);
    if (txn === undefined) {
      // A row we never sent. Answering it would categorize somebody else's transaction.
      discarded.push({
        rowIndex: Number.isNaN(rowIndex) ? null : rowIndex,
        accountCode: accountCode === '' ? null : accountCode,
        reason: 'unknown_row',
      });
      continue;
    }
    if (seen.has(rowIndex)) {
      discarded.push({ rowIndex, accountCode: accountCode === '' ? null : accountCode, reason: 'duplicate_row' });
      continue;
    }

    if (accountCode === '') {
      discarded.push({ rowIndex, accountCode: null, reason: 'missing_account_code' });
      seen.add(rowIndex);
      continue;
    }

    const account = input.accounts.get(accountCode);
    if (account === undefined) {
      discarded.push({ rowIndex, accountCode, reason: 'unknown_account' });
      seen.add(rowIndex);
      continue;
    }
    if (!account.active) {
      discarded.push({ rowIndex, accountCode, reason: 'inactive_account' });
      seen.add(rowIndex);
      continue;
    }
    if (account.isControl) {
      // AR and AP belong to the invoicing and bills subledgers. Nothing else posts there.
      discarded.push({ rowIndex, accountCode, reason: 'control_account' });
      seen.add(rowIndex);
      continue;
    }
    if (account.isBank) {
      // The bank side of a bank transaction is the bank account. Proposing another one
      // would move money between accounts on a model's say-so.
      discarded.push({ rowIndex, accountCode, reason: 'bank_account' });
      seen.add(rowIndex);
      continue;
    }
    if (isClearingAccount(account)) {
      // A clearing account holds a settlement between the sale and the deposit; only the
      // settlement importers and the deterministic payout rules post to it. A model
      // guessing one for a card refund leaves the refund stranded and its charge unnetted.
      discarded.push({ rowIndex, accountCode, reason: 'clearing_account' });
      seen.add(rowIndex);
      continue;
    }
    if (!account.postable) {
      discarded.push({ rowIndex, accountCode, reason: 'rollup_account' });
      seen.add(rowIndex);
      continue;
    }

    seen.add(rowIndex);

    const rawVendorName = item.vendorName ?? null;
    const vendorName =
      rawVendorName === null || rawVendorName.trim() === '' ? null : rawVendorName.trim();
    const confidence = clampConfidence(item.confidence);
    const belowFloor = confidence < input.confidenceFloor;
    const ambiguousPayee = needsReviewByPayee(
      txn.payee,
      txn.cleanedPayee,
      vendorName,
      input.alwaysReview,
    );

    suggestions.push({
      rowIndex,
      accountCode,
      vendorName,
      confidence,
      reasoning: tidyReasoning(item.reasoning, accountCode),
      needsHuman: item.needsHuman === true || belowFloor || ambiguousPayee,
      autoPost: false,
      source: 'ai',
      modelId: input.modelId,
    });
  }

  return { suggestions, discarded };
}

// ---------------------------------------------------------------------------
// The Anthropic adapter
// ---------------------------------------------------------------------------

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface AnthropicContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface AnthropicResponse {
  readonly id?: string;
  readonly model?: string;
  readonly stop_reason?: string | null;
  readonly content?: readonly AnthropicContentBlock[];
  readonly usage?: AnthropicUsage;
}

export interface AnthropicModelOptions {
  readonly apiKey: string;
  /** Bare Anthropic model id, e.g. `claude-haiku-4-5`. No provider prefix. */
  readonly modelId: string;
  readonly baseURL?: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** The forced tool that carries the structured answer back. */
const RESPONSE_TOOL_NAME = 'record_suggestions';

function mapStopReason(reason: string | null | undefined): {
  unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';
  raw: string | undefined;
} {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    // A forced response tool IS the answer, so a tool_use stop is a normal finish.
    case 'tool_use':
      return { unified: 'stop', raw: reason };
    case 'max_tokens':
      return { unified: 'length', raw: reason };
    case 'refusal':
      return { unified: 'content-filter', raw: reason };
    case null:
    case undefined:
      return { unified: 'other', raw: undefined };
    default:
      return { unified: 'other', raw: reason };
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * A minimal `LanguageModelV4` over the Anthropic Messages API.
 *
 * The repository depends on the Vercel AI SDK but not on a provider package, and the
 * credential this deployment has is an Anthropic API key. This adapter is what closes
 * that gap: enough of the specification for `generateObject` and nothing more.
 * Structured output is done with a single forced tool call, which is the only way to
 * get a schema honoured rather than merely requested, and the tool's arguments are
 * handed back as text because that is where `generateObject` looks for its object.
 *
 * Streaming is not implemented. `generateObject` does not stream, and a half-written
 * categorization is of no use to anyone.
 */
export function createAnthropicModel(options: AnthropicModelOptions): LanguageModelV4 {
  const baseURL = (options.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const apiVersion = options.apiVersion ?? '2023-06-01';
  const url = `${baseURL}/v1/messages`;

  return {
    specificationVersion: 'v4',
    provider: 'anthropic',
    modelId: options.modelId,
    supportedUrls: {},

    async doGenerate(callOptions) {
      const systemParts: string[] = [];
      const messages: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> }> = [];

      for (const message of callOptions.prompt) {
        if (message.role === 'system') {
          systemParts.push(message.content);
          continue;
        }
        if (message.role === 'tool') {
          throw new UnsupportedFunctionalityError({ functionality: 'tool result messages' });
        }
        const text: Array<{ type: 'text'; text: string }> = [];
        for (const part of message.content) {
          if (part.type === 'text') text.push({ type: 'text', text: part.text });
          else throw new UnsupportedFunctionalityError({ functionality: `${part.type} content parts` });
        }
        if (text.length > 0) messages.push({ role: message.role, content: text });
      }

      const body: Record<string, unknown> = {
        model: options.modelId,
        max_tokens: callOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        messages,
      };
      if (systemParts.length > 0) body.system = systemParts.join('\n\n');
      if (callOptions.temperature !== undefined) body.temperature = callOptions.temperature;
      if (callOptions.topP !== undefined) body.top_p = callOptions.topP;
      if (callOptions.topK !== undefined) body.top_k = callOptions.topK;
      if (callOptions.stopSequences !== undefined && callOptions.stopSequences.length > 0) {
        body.stop_sequences = callOptions.stopSequences;
      }

      const responseFormat = callOptions.responseFormat;
      const wantsJson = responseFormat?.type === 'json';
      const jsonSchema: JSONSchema7 | undefined =
        responseFormat?.type === 'json' ? responseFormat.schema : undefined;
      if (jsonSchema !== undefined) {
        body.tools = [
          {
            name: RESPONSE_TOOL_NAME,
            description:
              responseFormat?.type === 'json' && responseFormat.description !== undefined
                ? responseFormat.description
                : 'Record the structured answer.',
            input_schema: jsonSchema,
          },
        ];
        body.tool_choice = { type: 'tool', name: RESPONSE_TOOL_NAME };
      }

      const doFetch = options.fetchImpl ?? globalThis.fetch;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': apiVersion,
        'x-api-key': options.apiKey,
      };
      for (const [key, value] of Object.entries(callOptions.headers ?? {})) {
        if (value !== undefined) headers[key] = value;
      }

      const response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: callOptions.abortSignal,
      });

      if (!response.ok) {
        const responseBody = await response.text().catch(() => '');
        throw new APICallError({
          message: `Anthropic API error ${response.status}: ${responseBody.slice(0, 500)}`,
          url,
          requestBodyValues: body,
          statusCode: response.status,
          responseBody,
          isRetryable: isRetryableStatus(response.status),
        });
      }

      const payload = (await response.json()) as AnthropicResponse;
      const blocks = payload.content ?? [];

      const content: Array<{ type: 'text'; text: string }> = [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          // With a forced response tool there is no prose, so this only fires for a
          // plain text call.
          if (!wantsJson || jsonSchema === undefined) content.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use' && block.name === RESPONSE_TOOL_NAME) {
          content.push({ type: 'text', text: JSON.stringify(block.input ?? {}) });
        }
      }

      const usage = payload.usage ?? {};
      const inputTotal = usage.input_tokens;
      const outputTotal = usage.output_tokens;

      return {
        content,
        finishReason: mapStopReason(payload.stop_reason),
        usage: {
          inputTokens: {
            total: inputTotal,
            noCache: inputTotal,
            cacheRead: usage.cache_read_input_tokens,
            cacheWrite: usage.cache_creation_input_tokens,
          },
          outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
        },
        warnings: [],
        response: { id: payload.id, modelId: payload.model },
      };
    },

    doStream() {
      throw new UnsupportedFunctionalityError({ functionality: 'streaming' });
    },
  };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export interface ResolvedSuggestModel {
  readonly model: LanguageModelV4 | LanguageModelV3 | string;
  /** The configured id, provider prefix and all, for the audit trail. */
  readonly modelId: string;
}

function providerOf(modelId: string): string {
  const slash = modelId.indexOf('/');
  return slash === -1 ? '' : modelId.slice(0, slash);
}

function bareModelId(modelId: string): string {
  const slash = modelId.indexOf('/');
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

/**
 * Picks the model, or says there is none.
 *
 * In order: a model the caller injected; the Vercel AI Gateway when its key is set,
 * which resolves the `provider/model` id itself; a direct Anthropic call when the id
 * names Anthropic and an Anthropic key is set. `null` means AI is simply off, which is
 * a supported state — the import runs on rules alone.
 */
export function resolveSuggestModel(ctx: AISuggestContext): ResolvedSuggestModel | null {
  const env: Record<string, string | undefined> =
    typeof process === 'undefined' ? {} : process.env;
  const modelId = ctx.modelId ?? env.AI_SUGGEST_MODEL ?? DEFAULT_MODEL_ID;

  if (ctx.model !== undefined) {
    const id = typeof ctx.model === 'string' ? ctx.model : ctx.model.modelId;
    return { model: ctx.model, modelId: ctx.modelId ?? id };
  }

  const gatewayKey = ctx.gatewayApiKey ?? env.AI_GATEWAY_API_KEY;
  if (gatewayKey !== undefined && gatewayKey.trim() !== '') {
    // The SDK's global provider reads the key from the environment itself.
    return { model: modelId, modelId };
  }

  const anthropicKey = ctx.apiKey ?? env.ANTHROPIC_API_KEY;
  if (
    anthropicKey !== undefined &&
    anthropicKey.trim() !== '' &&
    (providerOf(modelId) === 'anthropic' || providerOf(modelId) === '')
  ) {
    return {
      model: createAnthropicModel({
        apiKey: anthropicKey,
        modelId: bareModelId(modelId),
        fetchImpl: ctx.fetchImpl,
      }),
      modelId,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

function classifyFailure(error: unknown): AIFailure {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? null;
    if (status === 429) {
      return { kind: 'rate_limit', message: error.message, statusCode: status };
    }
    if (status !== null && status >= 500) {
      return { kind: 'server_error', message: error.message, statusCode: status };
    }
    if (status === null) {
      return { kind: 'network', message: error.message, statusCode: null };
    }
    return { kind: 'unknown', message: error.message, statusCode: status };
  }

  // Everything `generateObject` throws once it has a response that will not become
  // the object we asked for.
  if (
    NoObjectGeneratedError.isInstance(error) ||
    NoContentGeneratedError.isInstance(error) ||
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error)
  ) {
    return { kind: 'invalid_response', message: error.message, statusCode: null };
  }

  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return { kind: 'timeout', message: error.message, statusCode: null };
    }
    // `fetch` rejects with a TypeError when it cannot reach the host at all.
    if (error.name === 'TypeError') {
      return { kind: 'network', message: error.message, statusCode: null };
    }
    return { kind: 'unknown', message: error.message, statusCode: null };
  }

  return { kind: 'unknown', message: String(error), statusCode: null };
}

function isRetryable(failure: AIFailure): boolean {
  return failure.kind === 'rate_limit' || failure.kind === 'server_error' || failure.kind === 'network';
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * A parsed bank row, reduced to what the prompt may see.
 *
 * The statement's running balance is dropped here and has no field to land in; so are
 * the raw cells, the warnings and Relay's `Sent By` / `Initiated By` names, which
 * `cleanPayee` peels off the payee before this ever runs.
 */
export function toPromptTxn(txn: NormalizedTxn): PromptTxn {
  const payee = txn.counterparty ?? txn.description;
  return {
    rowId: txn.rowIndex,
    date: txn.date,
    payee,
    cleanedPayee: cleanPayee(payee).name,
    reference: txn.reference,
    amountCents: txn.amountCents,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function costOf(
  pricing: AIPricing | undefined,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (pricing === undefined) return null;
  if (inputTokens === null && outputTokens === null) return null;
  return (
    (inputTokens ?? 0) * pricing.inputMicroUsdPerToken +
    (outputTokens ?? 0) * pricing.outputMicroUsdPerToken
  );
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------

/**
 * Asks the model about a batch of transactions, and returns only what survives the
 * guardrails.
 *
 * Never throws for an operational reason. No key, no network, a timeout, a rate limit
 * or a response that will not parse all produce an empty suggestion list and a recorded
 * failure, and the caller carries on with the deterministic suggestions it already has.
 */
export async function suggestWithAIDetailed(
  txns: readonly NormalizedTxn[],
  ctx: AISuggestContext,
): Promise<AISuggestResult> {
  const resolved = resolveSuggestModel(ctx);
  if (resolved === null) {
    return { suggestions: [], calls: [], discarded: [] };
  }

  // Only rows that parsed cleanly are worth an opinion, and a row id must identify
  // exactly one transaction or a suggestion could land on the wrong money. A repeated
  // `rowIndex` is a caller bug rather than an AI failure, so it is dropped quietly
  // instead of thrown: an import must not die because a caller concatenated two files
  // without renumbering.
  const seenRowIds = new Set<number>();
  const ordered: PromptTxn[] = [];
  for (const txn of txns) {
    if (!txn.usable) continue;
    if (seenRowIds.has(txn.rowIndex)) continue;
    seenRowIds.add(txn.rowIndex);
    ordered.push(toPromptTxn(txn));
  }
  if (ordered.length === 0) {
    return { suggestions: [], calls: [], discarded: [] };
  }

  const accountIndex = new Map(ctx.accounts.map((account) => [account.code, account]));
  const alwaysReview = alwaysReviewTerms(ctx.vendors);
  const confidenceFloor = ctx.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const batchSize = Math.max(1, Math.min(ctx.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE));
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, ctx.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = ctx.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const batches = chunk(ordered, batchSize);

  const runBatch = async (
    batch: readonly PromptTxn[],
    batchIndex: number,
  ): Promise<{
    readonly suggestions: readonly AISuggestion[];
    readonly discarded: readonly AIDiscard[];
    readonly call: AIBatchReport;
  }> => {
    // Scoped to this call: a row id from another batch is one this model was never
    // shown, and an answer for it is discarded as `unknown_row`.
    const batchRows = new Map(batch.map((row) => [row.rowId, row]));
    const { system, user } = buildSuggestPrompt(batch, {
      accounts: ctx.accounts,
      vendors: ctx.vendors,
      company: ctx.company ?? SOOZ_COMPANY_CONTEXT,
      confidenceFloor,
    });

    const startedAt = Date.now();
    let attempts = 0;
    let failure: AIFailure | null = null;
    let items: readonly SuggestionItem[] = [];
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cachedInputTokens: number | null = null;
    let totalTokens: number | null = null;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const result = await generateObject({
          model: resolved.model,
          schema: suggestResponseSchema,
          schemaName: 'BankTransactionSuggestions',
          schemaDescription:
            'One entry for every transaction. Express uncertainty through confidence and needsHuman, not by omitting a row.',
          system,
          prompt: user,
          temperature: 0,
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          // Retries are handled here, so the backoff and the classification stay
          // visible on the batch report rather than inside the SDK.
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
        items = result.object.suggestions;
        inputTokens = result.usage.inputTokens ?? null;
        outputTokens = result.usage.outputTokens ?? null;
        cachedInputTokens = result.usage.inputTokenDetails.cacheReadTokens ?? null;
        totalTokens =
          inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0);
        failure = null;
        break;
      } catch (error) {
        failure = classifyFailure(error);
        if (attempts >= maxAttempts || !isRetryable(failure)) break;
        await delay(retryDelayMs * attempts);
      }
    }

    const batchResult =
      failure === null
        ? applyGuardrails({
            items,
            rows: batchRows,
            accounts: accountIndex,
            alwaysReview,
            confidenceFloor,
            modelId: resolved.modelId,
          })
        : { suggestions: [] as readonly AISuggestion[], discarded: [] as readonly AIDiscard[] };

    return {
      suggestions: batchResult.suggestions,
      discarded: batchResult.discarded,
      call: {
        batchIndex,
        rowCount: batch.length,
        modelId: resolved.modelId,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens,
        costMicroUsd: costOf(ctx.pricing, inputTokens, outputTokens),
        durationMs: Date.now() - startedAt,
        attempts,
        ok: failure === null,
        failure,
        suggestionCount: batchResult.suggestions.length,
        discardCount: batchResult.discarded.length,
      },
    };
  };

  // Batches are independent — each has its own prompt, row map and guardrail pass — so
  // they run a few at a time. Results are reassembled in batch order, so the output is
  // identical to a sequential run whatever order the calls finish in.
  const concurrency = Math.max(1, ctx.concurrency ?? DEFAULT_CONCURRENCY);
  const results: Array<Awaited<ReturnType<typeof runBatch>>> = new Array(batches.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batchIndex = next;
      next += 1;
      results[batchIndex] = await runBatch(batches[batchIndex], batchIndex);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));

  return {
    suggestions: results.flatMap((r) => r.suggestions),
    discarded: results.flatMap((r) => r.discarded),
    calls: results.map((r) => r.call),
  };
}

/**
 * The suggestions alone, for a caller that does not need the per-call report.
 *
 * The import pipeline does not call this directly: `commitImport` runs
 * `applyAiSuggestions` in `./ai-tier`, which selects the rows every deterministic tier
 * declined, calls {@link suggestWithAIDetailed} for the per-call token usage and
 * failures, and writes the answers back to `bank_transactions`.
 */
export async function suggestWithAI(
  txns: readonly NormalizedTxn[],
  ctx: AISuggestContext,
): Promise<AISuggestion[]> {
  const result = await suggestWithAIDetailed(txns, ctx);
  return [...result.suggestions];
}

/**
 * Sooz Books — the categorization rules engine.
 *
 * A `categorization_rules` row is a small, owner-authored predicate over one bank
 * transaction. This module is the only place that decides whether a rule matches,
 * which of several matching rules wins, and how a rule's usage is written back.
 *
 * Three properties matter more than anything else here:
 *
 *   1. **Determinism.** Rules are evaluated in `priority` ascending and the first
 *      match wins. Ties are broken by name then id, so two rules at the same
 *      priority always resolve the same way on every machine and every import.
 *   2. **Total visibility.** Evaluation does not stop at the winner. The UI has to
 *      be able to say "3 rules matched, this one won", and a bookkeeper debugging a
 *      miscategorisation needs the losers as much as the winner.
 *   3. **A bad rule costs one rule, never the import.** Conditions come out of a
 *      jsonb column that a human edits. An unreadable condition or a regex the
 *      linear-time matcher cannot run disables *that rule* with a warning; every
 *      other rule still runs and the file still imports. No pattern can stall the
 *      import: regexes are matched in time linear in their input.
 *
 * Nothing in this module touches the ledger. It produces a decision; posting is a
 * separate, human-approved step.
 */

import { sql as sqlTag } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import type { CalendarDate } from '@/lib/dates';

import { compileLinearRegex, type LinearRegex } from './linear-regex';

// ---------------------------------------------------------------------------
// The transaction a rule is evaluated against
// ---------------------------------------------------------------------------

/**
 * One bank transaction, in the shape the categorization layer needs it.
 *
 * `amountCents` is signed **from the company's point of view**: positive is money
 * in, negative is money out. That convention holds for every format, so a rule's
 * `direction` and amount bounds mean the same thing whatever the source file was.
 *
 * This is deliberately *not* `NormalizedTxn` from `./types`, which is the parser's
 * output: that type describes a row inside one file and so carries no bank account
 * and no identity, both of which a rule scope and a transfer pairing need. Adapting
 * one to the other is mechanical — the bank account comes from the import batch, the
 * id from the persisted row:
 *
 * ```ts
 * { id, bankAccountId,
 *   txnDate: row.date, payee: row.counterparty, description: row.description,
 *   reference: row.reference, type: row.rawType, amountCents: row.amountCents,
 *   status: row.status }
 * ```
 *
 * The type is structural, so anything carrying these fields is a valid input and no
 * importer has to depend on this module.
 */
export interface CategorizableTxn {
  /** `bank_transactions.id` once persisted; any stable key before that. */
  readonly id?: string;
  readonly bankAccountId: string;
  readonly txnDate: CalendarDate;
  /** The counterparty. Relay's `Payee`, a card statement's merchant. */
  readonly payee: string | null;
  /** The raw description line. Relay's is junk; other banks put the memo here. */
  readonly description: string | null;
  /** The source's reference / memo field. Relay's richest signal. */
  readonly reference: string | null;
  /** The source's own transaction-type label, verbatim (`Spend-transfer`, `DEBIT`). */
  readonly type: string | null;
  /** Signed integer cents: positive money in, negative money out. */
  readonly amountCents: number;
  /** `SETTLED` / `RETURNED` / whatever the source calls it. */
  readonly status?: string | null;
  /** Last four of the *counterparty's* account, when the source states one. */
  readonly counterpartyMask?: string | null;
}

// ---------------------------------------------------------------------------
// Rule shape
// ---------------------------------------------------------------------------

export const RULE_FIELDS = ['payee', 'description', 'reference', 'type'] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export const RULE_OPERATORS = [
  'contains',
  'starts_with',
  'ends_with',
  'exact',
  'regex',
  'not_contains',
] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const RULE_DIRECTIONS = ['in', 'out', 'any'] as const;
export type RuleDirection = (typeof RULE_DIRECTIONS)[number];

/** One element of the rule's `conditions` jsonb array. **All** of them must match. */
export interface RuleCondition {
  readonly field: RuleField;
  readonly op: RuleOperator;
  readonly value: string;
}

/** A `categorization_rules` row, camel-cased. */
export interface CategorizationRule {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  /** null means "every bank account". */
  readonly bankAccountId: string | null;
  readonly conditions: readonly RuleCondition[];
  /** Bounds on the **absolute** amount, in cents. */
  readonly amountMinCents: number | null;
  readonly amountMaxCents: number | null;
  readonly direction: RuleDirection;
  readonly accountId: string | null;
  readonly vendorId: string | null;
  readonly customerId: string | null;
  readonly channelId: string | null;
  readonly memoTemplate: string | null;
  /** The only flag that lets an import post without a human. */
  readonly autoPost: boolean;
  readonly active: boolean;
  readonly hitCount: number;
  readonly lastHitAt: string | null;
}

export type RuleWarningCode = 'no_conditions' | 'condition_invalid' | 'regex_rejected';

/** Why a rule was disabled for this run. Surfaced in the import report. */
export interface RuleWarning {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly code: RuleWarningCode;
  readonly message: string;
}

export interface RuleEvaluation {
  /** The rule that decides the suggestion, or null when nothing matched. */
  readonly winner: CategorizationRule | null;
  /** Every rule that matched, in evaluation order. `matches[0] === winner`. */
  readonly matches: readonly CategorizationRule[];
  /** Live view of the engine's warnings, including any raised by this call. */
  readonly warnings: readonly RuleWarning[];
}

// ---------------------------------------------------------------------------
// Reading `conditions` out of jsonb
// ---------------------------------------------------------------------------

export interface ParsedConditions {
  readonly conditions: readonly RuleCondition[];
  /** Human-readable complaints; a non-empty list means the rule is not usable. */
  readonly problems: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the `conditions` jsonb of one rule. Anything unexpected is reported
 * rather than coerced: a condition we do not understand must never be silently
 * dropped, because dropping it makes the rule match *more* transactions, not fewer.
 */
export function parseRuleConditions(raw: unknown): ParsedConditions {
  const problems: string[] = [];
  if (!Array.isArray(raw)) {
    return { conditions: [], problems: ['conditions is not a JSON array'] };
  }
  if (raw.length === 0) {
    return { conditions: [], problems: ['conditions is empty'] };
  }

  const conditions: RuleCondition[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`condition ${index} is not an object`);
      return;
    }
    const { field, op, value } = entry;
    if (typeof field !== 'string' || !(RULE_FIELDS as readonly string[]).includes(field)) {
      problems.push(
        `condition ${index} has field ${JSON.stringify(field)}; expected one of ${RULE_FIELDS.join(', ')}`,
      );
      return;
    }
    if (typeof op !== 'string' || !(RULE_OPERATORS as readonly string[]).includes(op)) {
      problems.push(
        `condition ${index} has op ${JSON.stringify(op)}; expected one of ${RULE_OPERATORS.join(', ')}`,
      );
      return;
    }
    if (typeof value !== 'string' || value === '') {
      problems.push(`condition ${index} has no value`);
      return;
    }
    conditions.push({ field: field as RuleField, op: op as RuleOperator, value });
  });

  return { conditions, problems };
}

// ---------------------------------------------------------------------------
// Regex safety
// ---------------------------------------------------------------------------

/** A pattern longer than this is a bug or an attack, not a bank rule. */
const MAX_REGEX_LENGTH = 200;

/** Non-regex haystacks are short; cap what a regex is allowed to read. */
const DEFAULT_MAX_REGEX_INPUT = 512;

export type RegexInspection =
  | { readonly safe: true; readonly regex: LinearRegex }
  | { readonly safe: false; readonly reason: string };

/**
 * Compiles a user-supplied pattern, or explains why it will not be used.
 *
 * The pattern is compiled with `compileLinearRegex`, never handed to `RegExp` for
 * matching. V8's engine backtracks: `\d*\d*\d*\d*\d*x` or `.*.*.*.*.*!` costs
 * O(n^k) on a string that almost matches, and `RegExp.prototype.test` is synchronous,
 * so no time budget measured around it can stop a match that has already started.
 * Trying to recognise every dangerous shape up front is a heuristic one more shape
 * defeats. The linear-time matcher removes the class of problem instead: every
 * pattern it accepts runs in O(input × pattern), so there is nothing to time out.
 *
 * What it refuses — back-references, lookaround — needs backtracking by definition,
 * and is refused with a reason rather than approximated.
 *
 * Note that the pattern is used **as written** — a regex condition is the one
 * operator that is case-sensitive, because a rule author who reaches for a regex is
 * asking for exactly what they typed.
 */
export function inspectRegexSource(source: string): RegexInspection {
  if (source === '') return { safe: false, reason: 'the pattern is empty' };
  if (source.length > MAX_REGEX_LENGTH) {
    return { safe: false, reason: `the pattern is longer than ${MAX_REGEX_LENGTH} characters` };
  }
  try {
    return { safe: true, regex: compileLinearRegex(source) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { safe: false, reason: detail };
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface RuleEngineOptions {
  /** Longest haystack a regex is shown. */
  readonly maxRegexInputLength?: number;
  /** Warnings raised before the engine was built, e.g. by `loadCategorizationRules`. */
  readonly initialWarnings?: readonly RuleWarning[];
}

export interface RuleEngine {
  /** The rules the engine holds, in evaluation order. */
  readonly rules: readonly CategorizationRule[];
  /** Live: grows as evaluation disables rules. */
  readonly warnings: readonly RuleWarning[];
  /** Rule ids disabled for this run, with the reason in `warnings`. */
  readonly disabledRuleIds: readonly string[];
  evaluate(txn: CategorizableTxn): RuleEvaluation;
  /**
   * Winning-match counts accumulated since the engine was built or `resetHits`
   * was called. Feed straight to `recordRuleHits` — one UPDATE per import, never
   * one per row.
   */
  hits(): ReadonlyMap<string, number>;
  resetHits(): void;
}

interface CompiledCondition {
  readonly condition: RuleCondition;
  /** Lower-cased needle for the case-insensitive operators. */
  readonly needle: string;
  /** Non-null only for `regex`, which is used verbatim and matched in linear time. */
  readonly regex: LinearRegex | null;
}

interface CompiledRule {
  readonly rule: CategorizationRule;
  readonly conditions: readonly CompiledCondition[];
  disabled: boolean;
}

/** priority asc, then name, then id — so evaluation order never depends on row order. */
function compareRules(a: CategorizationRule, b: CategorizationRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

function fieldValue(txn: CategorizableTxn, field: RuleField): string {
  switch (field) {
    case 'payee':
      return txn.payee ?? '';
    case 'description':
      return txn.description ?? '';
    case 'reference':
      return txn.reference ?? '';
    case 'type':
      return txn.type ?? '';
  }
}

function matchesScope(rule: CategorizationRule, txn: CategorizableTxn): boolean {
  if (rule.bankAccountId !== null && rule.bankAccountId !== txn.bankAccountId) return false;
  if (rule.direction === 'in' && txn.amountCents <= 0) return false;
  if (rule.direction === 'out' && txn.amountCents >= 0) return false;
  const magnitude = Math.abs(txn.amountCents);
  if (rule.amountMinCents !== null && magnitude < rule.amountMinCents) return false;
  if (rule.amountMaxCents !== null && magnitude > rule.amountMaxCents) return false;
  return true;
}

export function createRuleEngine(
  rules: readonly CategorizationRule[],
  options: RuleEngineOptions = {},
): RuleEngine {
  const maxInput = options.maxRegexInputLength ?? DEFAULT_MAX_REGEX_INPUT;
  const warnings: RuleWarning[] = [...(options.initialWarnings ?? [])];
  const hits = new Map<string, number>();

  function warn(rule: CategorizationRule, code: RuleWarningCode, message: string): void {
    warnings.push({ ruleId: rule.id, ruleName: rule.name, code, message });
  }

  const ordered = [...rules].sort(compareRules);

  const compiled: CompiledRule[] = ordered.map((rule) => {
    const entry: CompiledRule = { rule, conditions: [], disabled: false };
    if (rule.conditions.length === 0) {
      warn(rule, 'no_conditions', 'the rule has no conditions, so it is ignored');
      return { ...entry, disabled: true };
    }

    const conditions: CompiledCondition[] = [];
    let disabled = false;
    for (const condition of rule.conditions) {
      if (!(RULE_FIELDS as readonly string[]).includes(condition.field)) {
        warn(rule, 'condition_invalid', `unknown field ${JSON.stringify(condition.field)}`);
        disabled = true;
        break;
      }
      if (!(RULE_OPERATORS as readonly string[]).includes(condition.op)) {
        warn(rule, 'condition_invalid', `unknown operator ${JSON.stringify(condition.op)}`);
        disabled = true;
        break;
      }
      if (condition.op === 'regex') {
        const inspection = inspectRegexSource(condition.value);
        if (!inspection.safe) {
          warn(
            rule,
            'regex_rejected',
            `pattern ${JSON.stringify(condition.value)} was refused: ${inspection.reason}`,
          );
          disabled = true;
          break;
        }
        conditions.push({ condition, needle: condition.value, regex: inspection.regex });
        continue;
      }
      conditions.push({ condition, needle: condition.value.toLowerCase(), regex: null });
    }

    return { rule, conditions, disabled };
  });

  function conditionsMatch(entry: CompiledRule, txn: CategorizableTxn): boolean {
    for (const compiledCondition of entry.conditions) {
      const raw = fieldValue(txn, compiledCondition.condition.field).trim();

      if (compiledCondition.regex !== null) {
        const input = raw.length > maxInput ? raw.slice(0, maxInput) : raw;
        if (!compiledCondition.regex.test(input)) return false;
        continue;
      }

      const haystack = raw.toLowerCase();
      const needle = compiledCondition.needle;
      let matched: boolean;
      switch (compiledCondition.condition.op) {
        case 'contains':
          matched = haystack.includes(needle);
          break;
        case 'not_contains':
          matched = !haystack.includes(needle);
          break;
        case 'starts_with':
          matched = haystack.startsWith(needle);
          break;
        case 'ends_with':
          matched = haystack.endsWith(needle);
          break;
        case 'exact':
          matched = haystack === needle;
          break;
        case 'regex':
          // Unreachable: regex conditions carry a compiled pattern or disable the rule.
          matched = false;
          break;
      }
      if (!matched) return false;
    }
    return true;
  }

  return {
    rules: ordered,
    get warnings() {
      return warnings;
    },
    get disabledRuleIds() {
      return compiled.filter((entry) => entry.disabled).map((entry) => entry.rule.id);
    },
    evaluate(txn: CategorizableTxn): RuleEvaluation {
      const matches: CategorizationRule[] = [];
      for (const entry of compiled) {
        if (entry.disabled || !entry.rule.active) continue;
        if (!matchesScope(entry.rule, txn)) continue;
        if (!conditionsMatch(entry, txn)) continue;
        matches.push(entry.rule);
      }
      const winner = matches[0] ?? null;
      if (winner !== null) hits.set(winner.id, (hits.get(winner.id) ?? 0) + 1);
      return { winner, matches, warnings };
    },
    hits() {
      return hits;
    },
    resetHits() {
      hits.clear();
    },
  };
}

/** One-shot convenience for a single transaction. Batches should reuse an engine. */
export function evaluateRules(
  txn: CategorizableTxn,
  rules: readonly CategorizationRule[],
  options?: RuleEngineOptions,
): RuleEvaluation {
  return createRuleEngine(rules, options).evaluate(txn);
}

// ---------------------------------------------------------------------------
// Loading and hit accounting
// ---------------------------------------------------------------------------

interface RuleRow {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly bank_account_id: string | null;
  readonly conditions: unknown;
  readonly amount_min_cents: string | number | null;
  readonly amount_max_cents: string | number | null;
  readonly direction: string;
  readonly account_id: string | null;
  readonly vendor_id: string | null;
  readonly customer_id: string | null;
  readonly channel_id: string | null;
  readonly memo_template: string | null;
  readonly auto_post: boolean;
  readonly active: boolean;
  readonly hit_count: number;
  readonly last_hit_at: Date | string | null;
}

/** `bigint` columns arrive as strings from postgres.js; cents stay exact either way. */
function toCents(value: string | number | null): number | null {
  if (value === null) return null;
  const cents = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Rule amount bound ${String(value)} is not a whole number of cents`);
  }
  return cents;
}

function toDirection(value: string): RuleDirection {
  return (RULE_DIRECTIONS as readonly string[]).includes(value) ? (value as RuleDirection) : 'any';
}

export interface LoadedRules {
  readonly rules: readonly CategorizationRule[];
  /** Rules whose `conditions` jsonb could not be read. They are loaded disabled. */
  readonly warnings: readonly RuleWarning[];
}

export interface LoadRulesOptions {
  /** Keep rules scoped to this bank account plus the account-agnostic ones. */
  readonly bankAccountId?: string | null;
  readonly includeInactive?: boolean;
  /**
   * Read inside the caller's transaction instead of on a pooled connection.
   *
   * Required whenever the caller already holds a transaction: waiting on a second
   * pooled connection while holding the first deadlocks as soon as the pool is
   * exhausted — with a one-connection pool, on the very first import.
   */
  readonly tx?: Tx;
}

/**
 * Reads the rule set.
 *
 * `@/db/client` opens its pool the moment it is imported, so it is pulled in here
 * rather than at module scope: everything above this line is pure and testable with
 * no database in reach.
 */
export async function loadCategorizationRules(
  options: LoadRulesOptions = {},
): Promise<LoadedRules> {
  const bankAccountId = options.bankAccountId ?? null;

  const statement = sqlTag`
    select id, name, priority, bank_account_id, conditions,
           amount_min_cents, amount_max_cents, direction,
           account_id, vendor_id, customer_id, channel_id,
           memo_template, auto_post, active, hit_count, last_hit_at
      from categorization_rules
     where (${options.includeInactive ?? false}::boolean or active)
       and (${bankAccountId}::uuid is null
            or bank_account_id is null
            or bank_account_id = ${bankAccountId}::uuid)
     order by priority, name, id`;

  const runner = options.tx ?? (await import('@/db/client')).db;
  const rows = (await runner.execute(statement)) as unknown as RuleRow[];

  const warnings: RuleWarning[] = [];
  const rules = rows.map((row): CategorizationRule => {
    const parsed = parseRuleConditions(row.conditions);
    for (const problem of parsed.problems) {
      warnings.push({
        ruleId: row.id,
        ruleName: row.name,
        code: 'condition_invalid',
        message: problem,
      });
    }
    // A rule we cannot fully read is loaded with no conditions, which the engine
    // refuses to run. Half-reading it would make it match more, not less.
    const conditions = parsed.problems.length > 0 ? [] : parsed.conditions;
    const lastHitAt = row.last_hit_at;
    return {
      id: row.id,
      name: row.name,
      priority: row.priority,
      bankAccountId: row.bank_account_id,
      conditions,
      amountMinCents: toCents(row.amount_min_cents),
      amountMaxCents: toCents(row.amount_max_cents),
      direction: toDirection(row.direction),
      accountId: row.account_id,
      vendorId: row.vendor_id,
      customerId: row.customer_id,
      channelId: row.channel_id,
      memoTemplate: row.memo_template,
      autoPost: row.auto_post,
      active: row.active,
      hitCount: row.hit_count,
      lastHitAt: lastHitAt instanceof Date ? lastHitAt.toISOString() : lastHitAt,
    };
  });

  return { rules, warnings };
}

export interface RecordRuleHitsOptions {
  /** Actor for the audit trail. */
  readonly userId: string | null;
  /** Join the caller's transaction instead of opening one. */
  readonly tx?: Tx;
  /** Stamp written to `last_hit_at`; defaults to now. */
  readonly at?: Date;
}

/**
 * Writes an import's rule usage back in **one** statement.
 *
 * Doing this per row would be one UPDATE and one audit-log row per transaction on a
 * table the next row is about to read; a 2,000-row import would write 2,000 audit
 * rows that say nothing a single "+2000 hits" row does not.
 *
 * @returns how many rules were updated.
 */
export async function recordRuleHits(
  hits: ReadonlyMap<string, number>,
  options: RecordRuleHitsOptions,
): Promise<number> {
  const counted = [...hits].filter(([, count]) => Number.isSafeInteger(count) && count > 0);
  if (counted.length === 0) return 0;

  const stamp = (options.at ?? new Date()).toISOString();
  const tuples = counted.map(([id, count]) => sqlTag`(${id}::uuid, ${count}::integer)`);
  const statement = sqlTag`
    update categorization_rules as r
       set hit_count   = r.hit_count + v.hits,
           last_hit_at = ${stamp}::timestamptz
      from (values ${sqlTag.join(tuples, sqlTag`, `)}) as v(id, hits)
     where r.id = v.id
    returning r.id`;

  const run = async (tx: Tx): Promise<number> => {
    const updated = await tx.execute(statement);
    return (updated as unknown as readonly unknown[]).length;
  };

  if (options.tx !== undefined) return run(options.tx);
  const { withActor } = await import('@/db/client');
  return withActor(options.userId, run);
}

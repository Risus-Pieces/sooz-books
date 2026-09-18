import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql as sqlTag } from 'drizzle-orm';
import Papa from 'papaparse';
import { afterAll, describe, expect, it } from 'vitest';

import { parseDateInput } from '@/lib/dates';
import { parseMoney } from '@/lib/money';

import {
  createRuleEngine,
  evaluateRules,
  inspectRegexSource,
  loadCategorizationRules,
  parseRuleConditions,
  recordRuleHits,
  type CategorizationRule,
  type CategorizableTxn,
  type RuleCondition,
} from './rules';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rule(overrides: Partial<CategorizationRule> & { id: string }): CategorizationRule {
  return {
    name: overrides.id,
    priority: 100,
    bankAccountId: null,
    conditions: [],
    amountMinCents: null,
    amountMaxCents: null,
    direction: 'any',
    accountId: null,
    vendorId: null,
    customerId: null,
    channelId: null,
    memoTemplate: null,
    autoPost: false,
    active: true,
    hitCount: 0,
    lastHitAt: null,
    ...overrides,
  };
}

function txn(overrides: Partial<CategorizableTxn> = {}): CategorizableTxn {
  return {
    bankAccountId: 'acct-9726',
    txnDate: '2026-02-08',
    payee: 'Amazon',
    description: 'Unknown',
    reference: 'Corporate Card - 1892 (Business Card)',
    type: 'Spend',
    amountCents: -1499,
    ...overrides,
  };
}

function conditions(...list: RuleCondition[]): readonly RuleCondition[] {
  return list;
}

// ---------------------------------------------------------------------------
// Condition operators
// ---------------------------------------------------------------------------

describe('condition operators', () => {
  const cases: ReadonlyArray<[RuleCondition, Partial<CategorizableTxn>, boolean]> = [
    [{ field: 'payee', op: 'contains', value: 'MAZO' }, {}, true],
    [{ field: 'payee', op: 'contains', value: 'target' }, {}, false],
    [{ field: 'payee', op: 'starts_with', value: 'ama' }, {}, true],
    [{ field: 'payee', op: 'starts_with', value: 'mazon' }, {}, false],
    [{ field: 'payee', op: 'ends_with', value: 'ZON' }, {}, true],
    [{ field: 'payee', op: 'exact', value: 'amazon' }, {}, true],
    [{ field: 'payee', op: 'exact', value: 'amazon.com' }, {}, false],
    [{ field: 'payee', op: 'not_contains', value: 'target' }, {}, true],
    [{ field: 'payee', op: 'not_contains', value: 'amazon' }, {}, false],
    [{ field: 'reference', op: 'contains', value: 'corporate card' }, {}, true],
    [{ field: 'type', op: 'exact', value: 'spend' }, {}, true],
    [{ field: 'description', op: 'exact', value: 'unknown' }, {}, true],
  ];

  it.each(cases)('%j matches %j -> %s', (condition, patch, expected) => {
    const evaluation = evaluateRules(txn(patch), [
      rule({ id: 'r', conditions: conditions(condition) }),
    ]);
    expect(evaluation.winner !== null).toBe(expected);
  });

  it('treats a missing field as an empty string', () => {
    const blank = txn({ payee: null, reference: null });
    expect(
      evaluateRules(blank, [
        rule({ id: 'r', conditions: conditions({ field: 'payee', op: 'exact', value: 'amazon' }) }),
      ]).winner,
    ).toBeNull();
    // "not_contains" on an absent field is true: an empty string contains nothing.
    expect(
      evaluateRules(blank, [
        rule({
          id: 'r',
          conditions: conditions({ field: 'payee', op: 'not_contains', value: 'amazon' }),
        }),
      ]).winner?.id,
    ).toBe('r');
  });

  it('requires every condition to match', () => {
    const both = conditions(
      { field: 'payee', op: 'exact', value: 'Relay' },
      { field: 'reference', op: 'contains', value: 'Banking Fees' },
    );
    const fee = txn({ payee: 'Relay', reference: 'Banking Fees', amountCents: -800 });
    expect(evaluateRules(fee, [rule({ id: 'r', conditions: both })]).winner?.id).toBe('r');
    expect(
      evaluateRules(txn({ payee: 'Relay', reference: 'Transfer' }), [
        rule({ id: 'r', conditions: both }),
      ]).winner,
    ).toBeNull();
  });

  it('is case-insensitive everywhere except regex', () => {
    const insensitive = evaluateRules(txn({ payee: 'sp+aff * META store -' }), [
      rule({ id: 'r', conditions: conditions({ field: 'payee', op: 'contains', value: 'Meta Store' }) }),
    ]);
    expect(insensitive.winner?.id).toBe('r');

    const sensitive = evaluateRules(txn({ reference: 'sq260126' }), [
      rule({
        id: 'r',
        conditions: conditions({ field: 'reference', op: 'regex', value: '^SQ[0-9]{6}$' }),
      }),
    ]);
    expect(sensitive.winner).toBeNull();

    const asWritten = evaluateRules(txn({ reference: 'SQ260126' }), [
      rule({
        id: 'r',
        conditions: conditions({ field: 'reference', op: 'regex', value: '^SQ[0-9]{6}$' }),
      }),
    ]);
    expect(asWritten.winner?.id).toBe('r');
  });
});

// ---------------------------------------------------------------------------
// Scope: direction, amount bounds, bank account, active
// ---------------------------------------------------------------------------

describe('rule scope', () => {
  const anyPayee = conditions({ field: 'payee', op: 'contains', value: 'a' });

  it('tests direction against the sign of amountCents', () => {
    const inbound = rule({ id: 'in', direction: 'in', conditions: anyPayee });
    const outbound = rule({ id: 'out', direction: 'out', conditions: anyPayee });
    const either = rule({ id: 'any', direction: 'any', conditions: anyPayee });

    expect(evaluateRules(txn({ amountCents: 3831 }), [inbound]).winner?.id).toBe('in');
    expect(evaluateRules(txn({ amountCents: 3831 }), [outbound]).winner).toBeNull();
    expect(evaluateRules(txn({ amountCents: -3831 }), [outbound]).winner?.id).toBe('out');
    expect(evaluateRules(txn({ amountCents: -3831 }), [inbound]).winner).toBeNull();
    expect(evaluateRules(txn({ amountCents: -3831 }), [either]).winner?.id).toBe('any');
  });

  it('tests the amount bounds against the absolute value', () => {
    const banded = rule({
      id: 'band',
      conditions: anyPayee,
      amountMinCents: 1000,
      amountMaxCents: 5000,
    });
    expect(evaluateRules(txn({ amountCents: -999 }), [banded]).winner).toBeNull();
    expect(evaluateRules(txn({ amountCents: -1000 }), [banded]).winner?.id).toBe('band');
    expect(evaluateRules(txn({ amountCents: 5000 }), [banded]).winner?.id).toBe('band');
    expect(evaluateRules(txn({ amountCents: 5001 }), [banded]).winner).toBeNull();
  });

  it('scopes to one bank account when bankAccountId is set, and to all when it is null', () => {
    const scoped = rule({ id: 'scoped', bankAccountId: 'acct-9973', conditions: anyPayee });
    const global = rule({ id: 'global', bankAccountId: null, conditions: anyPayee });
    expect(evaluateRules(txn(), [scoped]).winner).toBeNull();
    expect(evaluateRules(txn({ bankAccountId: 'acct-9973' }), [scoped]).winner?.id).toBe('scoped');
    expect(evaluateRules(txn(), [global]).winner?.id).toBe('global');
  });

  it('never evaluates an inactive rule', () => {
    expect(
      evaluateRules(txn(), [rule({ id: 'off', active: false, conditions: anyPayee })]).winner,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('ordering', () => {
  const amazon = conditions({ field: 'payee', op: 'exact', value: 'Amazon' });
  const card = conditions({ field: 'reference', op: 'contains', value: 'Corporate Card' });

  it('evaluates priority ascending and lets the first match win', () => {
    const evaluation = evaluateRules(txn({ amountCents: 3831 }), [
      rule({ id: 'amazon', name: 'Amazon — always review', priority: 90, conditions: amazon }),
      rule({ id: 'refund', name: 'Card refund', priority: 70, conditions: card, direction: 'in' }),
    ]);
    expect(evaluation.winner?.id).toBe('refund');
  });

  it('returns every rule that matched, winner first', () => {
    const evaluation = evaluateRules(txn({ amountCents: 3831 }), [
      rule({ id: 'amazon', priority: 90, conditions: amazon }),
      rule({ id: 'refund', priority: 70, conditions: card, direction: 'in' }),
      rule({ id: 'nope', priority: 10, conditions: conditions({ field: 'payee', op: 'exact', value: 'Target' }) }),
    ]);
    expect(evaluation.matches.map((r) => r.id)).toEqual(['refund', 'amazon']);
    expect(evaluation.winner?.id).toBe(evaluation.matches[0].id);
  });

  it('breaks priority ties by name then id, whatever order the rules arrive in', () => {
    const a = rule({ id: 'zzz', name: 'Alpha', priority: 50, conditions: amazon });
    const b = rule({ id: 'aaa', name: 'Beta', priority: 50, conditions: amazon });
    expect(evaluateRules(txn(), [a, b]).winner?.id).toBe('zzz');
    expect(evaluateRules(txn(), [b, a]).winner?.id).toBe('zzz');
  });
});

// ---------------------------------------------------------------------------
// Reading conditions out of jsonb
// ---------------------------------------------------------------------------

describe('parseRuleConditions', () => {
  it('accepts the seeded shape', () => {
    const parsed = parseRuleConditions([
      { op: 'exact', field: 'payee', value: 'Relay' },
      { op: 'contains', field: 'reference', value: 'Banking Fees' },
    ]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.conditions).toHaveLength(2);
  });

  it('reports rather than coerces anything it does not understand', () => {
    expect(parseRuleConditions({}).problems).toEqual(['conditions is not a JSON array']);
    expect(parseRuleConditions([]).problems).toEqual(['conditions is empty']);
    expect(parseRuleConditions([{ field: 'memo', op: 'contains', value: 'x' }]).problems)
      .toHaveLength(1);
    expect(parseRuleConditions([{ field: 'payee', op: 'sounds_like', value: 'x' }]).problems)
      .toHaveLength(1);
    expect(parseRuleConditions([{ field: 'payee', op: 'contains' }]).problems).toHaveLength(1);
  });

  it('loads a rule with unreadable conditions as one that cannot match', () => {
    // Dropping the bad condition and keeping the rest would make the rule match
    // MORE transactions than its author wrote, which is the dangerous direction.
    const parsed = parseRuleConditions([
      { field: 'payee', op: 'contains', value: 'Amazon' },
      { field: 'payee', op: 'sounds_like', value: 'Amazon' },
    ]);
    expect(parsed.problems).toHaveLength(1);
    const engine = createRuleEngine([rule({ id: 'r', conditions: [] })]);
    expect(engine.evaluate(txn()).winner).toBeNull();
    expect(engine.warnings.map((w) => w.code)).toEqual(['no_conditions']);
  });
});

// ---------------------------------------------------------------------------
// Regex safety
// ---------------------------------------------------------------------------

describe('regex safety', () => {
  it('accepts the patterns real rules use', () => {
    expect(inspectRegexSource('^SQ[0-9]{6}$').safe).toBe(true);
    expect(inspectRegexSource('PO SOOZ-\\d{4}-\\d{3}').safe).toBe(true);
    expect(inspectRegexSource('(FEDEX|UPS)').safe).toBe(true);
  });

  it('refuses what a linear-time matcher cannot run, and what does not compile', () => {
    expect(inspectRegexSource('(a)\\1').safe).toBe(false); // back-reference
    expect(inspectRegexSource('foo(?=bar)').safe).toBe(false); // lookahead
    expect(inspectRegexSource('(?<!x)y').safe).toBe(false); // lookbehind
    expect(inspectRegexSource('(unclosed').safe).toBe(false);
    expect(inspectRegexSource('a{2,').safe).toBe(true); // a literal brace, not a quantifier
    expect(inspectRegexSource('[').safe).toBe(false); // does not compile
    expect(inspectRegexSource('a'.repeat(201)).safe).toBe(false);
  });

  /**
   * The patterns below all pass any "is this a repeated group?" check, or are the
   * classic nested-quantifier case, and all of them backtrack polynomially or
   * exponentially in V8. `\d*\d*\d*\d*\d*x` alone took 2.2 s at 80 characters and
   * did not finish in 180 s at 200. Matched in linear time, each finishes in
   * milliseconds at the full 512-character input cap.
   */
  it('matches adversarial patterns in linear time instead of hanging the import', () => {
    const cases: Array<{ pattern: string; input: string; expected: boolean }> = [
      { pattern: '\\d*\\d*\\d*\\d*\\d*x', input: '1'.repeat(512), expected: false },
      { pattern: '.*.*.*.*.*!', input: 'a'.repeat(512), expected: false },
      { pattern: '^(a+)+$', input: `${'a'.repeat(510)}!`, expected: false },
      { pattern: '(a|a)*$', input: `${'a'.repeat(511)}!`, expected: true },
      { pattern: '(\\d+)+x', input: '9'.repeat(512), expected: false },
      { pattern: '(.*a){20}', input: 'a'.repeat(512), expected: true },
    ];

    for (const { pattern, input, expected } of cases) {
      const inspection = inspectRegexSource(pattern);
      expect(inspection.safe, pattern).toBe(true);
      if (!inspection.safe) continue;
      const started = performance.now();
      const matched = inspection.regex.test(input);
      const elapsed = performance.now() - started;
      expect(matched, pattern).toBe(expected);
      expect(elapsed, `${pattern} took ${elapsed.toFixed(1)}ms`).toBeLessThan(250);
    }
  });

  it('evaluates a rule with a catastrophic pattern quickly and still lets it decide', () => {
    const adversarial = txn({ reference: '1'.repeat(600), amountCents: -100 });
    const engine = createRuleEngine([
      rule({
        id: 'poly',
        name: 'Polynomial',
        priority: 10,
        conditions: conditions({ field: 'reference', op: 'regex', value: '\\d*\\d*\\d*\\d*\\d*x' }),
      }),
      rule({
        id: 'good',
        name: 'Still works',
        priority: 20,
        conditions: conditions({ field: 'reference', op: 'contains', value: '111' }),
      }),
    ]);

    const started = performance.now();
    const evaluation = engine.evaluate(adversarial);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(250);
    expect(evaluation.winner?.id).toBe('good');
    expect(engine.disabledRuleIds).toEqual([]);
    expect(engine.warnings).toEqual([]);
  });

  it('disables a rule whose pattern needs backtracking, and says why', () => {
    const engine = createRuleEngine([
      rule({
        id: 'backref',
        name: 'Back-reference',
        priority: 10,
        conditions: conditions({ field: 'payee', op: 'regex', value: '(a)\\1' }),
      }),
    ]);
    expect(engine.evaluate(txn({ payee: 'aa', amountCents: -100 })).winner).toBeNull();
    expect(engine.disabledRuleIds).toEqual(['backref']);
    expect(engine.warnings[0]?.code).toBe('regex_rejected');
    expect(engine.warnings[0]?.message).toMatch(/back-reference/);
  });

  it('caps how much text a regex is shown', () => {
    const engine = createRuleEngine(
      [
        rule({
          id: 'r',
          conditions: conditions({ field: 'description', op: 'regex', value: 'END$' }),
        }),
      ],
      { maxRegexInputLength: 16 },
    );
    expect(engine.evaluate(txn({ description: `${'x'.repeat(64)}END` })).winner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hit accounting
// ---------------------------------------------------------------------------

describe('hit accounting', () => {
  it('counts winners, not every rule that matched', () => {
    const engine = createRuleEngine([
      rule({ id: 'refund', priority: 70, direction: 'in', conditions: conditions({ field: 'reference', op: 'contains', value: 'Corporate Card' }) }),
      rule({ id: 'amazon', priority: 90, conditions: conditions({ field: 'payee', op: 'exact', value: 'Amazon' }) }),
    ]);
    engine.evaluate(txn({ amountCents: 3831 }));
    engine.evaluate(txn({ amountCents: 1499 }));
    engine.evaluate(txn({ amountCents: -1499 }));
    expect([...engine.hits()]).toEqual([
      ['refund', 2],
      ['amazon', 1],
    ]);
    engine.resetHits();
    expect(engine.hits().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The real Relay statements, against the seeded rules
// ---------------------------------------------------------------------------

interface RelayRow {
  readonly Date: string;
  readonly Payee: string;
  readonly 'Account #': string;
  readonly 'Transaction Type': string;
  readonly Description: string;
  readonly Reference: string;
  readonly Status: string;
  readonly Amount: string;
}

const RELAY_DIR = fileURLToPath(new URL('../../../data/statements/relay', import.meta.url));

/** Reads the 36 real statement exports into the shape the engine takes. */
function loadRelayTxns(): Array<CategorizableTxn & { readonly mask: string }> {
  if (!existsSync(RELAY_DIR)) return [];
  const out: Array<CategorizableTxn & { readonly mask: string }> = [];
  for (const file of readdirSync(RELAY_DIR).filter((f) => f.endsWith('.csv')).sort()) {
    const mask = /#(\d{4})/.exec(file)?.[1] ?? 'unknown';
    const parsed = Papa.parse<RelayRow>(readFileSync(`${RELAY_DIR}/${file}`, 'utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    for (const row of parsed.data) {
      if (!row.Date) continue;
      out.push({
        mask,
        bankAccountId: `acct-${mask}`,
        txnDate: parseDateInput(row.Date),
        payee: row.Payee === '' ? null : row.Payee,
        description: row.Description === '' ? null : row.Description,
        reference: row.Reference === '' ? null : row.Reference,
        type: row['Transaction Type'],
        amountCents: parseMoney(row.Amount),
        status: row.Status,
        counterpartyMask: row['Account #'] === '' ? null : row['Account #'],
      });
    }
  }
  return out;
}

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const DATABASE_URL = databaseUrl();
if (DATABASE_URL !== undefined) process.env.DATABASE_URL = DATABASE_URL;

const RELAY_TXNS = loadRelayTxns();

describe('the real Relay statements', () => {
  it('has the statement fixtures on disk', () => {
    // These tests are worth nothing without the real files, so a missing folder
    // fails loudly rather than quietly skipping.
    expect(existsSync(RELAY_DIR), `real Relay statements are missing from ${RELAY_DIR}`).toBe(true);
  });

  it('reads all 110 transactions across the four accounts', () => {
    expect(RELAY_TXNS).toHaveLength(110);
    const byMask = new Map<string, number>();
    for (const t of RELAY_TXNS) byMask.set(t.mask, (byMask.get(t.mask) ?? 0) + 1);
    expect([...byMask].sort()).toEqual([
      ['9726', 106],
      ['9973', 4],
    ]);
  });

  it('signs every amount from the company point of view', () => {
    for (const t of RELAY_TXNS) {
      expect(Number.isSafeInteger(t.amountCents)).toBe(true);
      expect(t.amountCents).not.toBe(0);
      const spend = (t.type ?? '').startsWith('Spend');
      expect(spend ? t.amountCents < 0 : t.amountCents > 0).toBe(true);
    }
  });
});

describe.skipIf(!DATABASE_URL || RELAY_TXNS.length === 0)('seeded rules over the real data', () => {
  afterAll(async () => {
    const cache = globalThis as typeof globalThis & {
      __soozBooksSql?: { end: () => Promise<void> };
      __soozBooksDb?: unknown;
    };
    const pool = cache.__soozBooksSql;
    delete cache.__soozBooksSql;
    delete cache.__soozBooksDb;
    if (pool !== undefined) await pool.end();
  });

  it('loads every seeded rule with readable conditions', async () => {
    const loaded = await loadCategorizationRules();
    expect(loaded.warnings).toEqual([]);
    expect(loaded.rules.length).toBeGreaterThanOrEqual(37);
    for (const r of loaded.rules) expect(r.conditions.length).toBeGreaterThan(0);
    const engine = createRuleEngine(loaded.rules);
    expect(engine.warnings).toEqual([]);
  }, 30_000);

  it('fires the four auto-post rules on exactly the right transactions', async () => {
    const loaded = await loadCategorizationRules();
    const engine = createRuleEngine(loaded.rules);
    const byName = new Map<string, number>();
    for (const t of RELAY_TXNS) {
      const winner = engine.evaluate(t).winner;
      if (winner === null) continue;
      byName.set(winner.name, (byName.get(winner.name) ?? 0) + 1);
    }

    expect(byName.get('Relay banking fees')).toBe(2);
    // Seven deposits across five Square batch references
    // (SQ260126 x3, SQ260202, SQ260211, SQ260217, SQ260831).
    expect(byName.get('Square payout to clearing')).toBe(7);
    expect(byName.get('Member contribution — Chase College')).toBe(5);
    expect(byName.get('Member contribution — BofA SafeBalance')).toBe(7);

    const autoPostRules = new Set(
      loaded.rules.filter((r) => r.autoPost).map((r) => r.name),
    );
    expect([...autoPostRules].sort()).toEqual([
      'Member contribution — BofA SafeBalance',
      'Member contribution — Chase College',
      'Relay banking fees',
      'Square payout to clearing',
    ]);

    const autoPosted = [...byName]
      .filter(([name]) => autoPostRules.has(name))
      .reduce((sum, [, count]) => sum + count, 0);
    expect(autoPosted).toBe(21);
  }, 30_000);

  it('never lets an auto-post rule claim an Amazon transaction', async () => {
    const loaded = await loadCategorizationRules();
    const engine = createRuleEngine(loaded.rules);
    const amazon = RELAY_TXNS.filter((t) => t.payee === 'Amazon');
    expect(amazon).toHaveLength(37);
    for (const t of amazon) {
      const winner = engine.evaluate(t).winner;
      expect(winner).not.toBeNull();
      expect(winner?.autoPost).toBe(false);
    }
  }, 30_000);

  it('accumulates hits and writes them back in one statement', async () => {
    const loaded = await loadCategorizationRules();
    const engine = createRuleEngine(loaded.rules);
    let matched = 0;
    for (const t of RELAY_TXNS) {
      if (engine.evaluate(t).winner !== null) matched += 1;
    }
    const hits = engine.hits();
    expect(hits.size).toBeGreaterThan(0);
    expect([...hits.values()].reduce((a, b) => a + b, 0)).toBe(matched);

    const { db } = await import('@/db/client');
    const target = loaded.rules.find((r) => r.name === 'Relay banking fees');
    expect(target).toBeDefined();
    const ruleId = target?.id ?? '';

    class Rollback extends Error {}
    let before = -1;
    let after = -1;
    let stamped: unknown = null;
    let updated = -1;

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sqlTag`select set_config('app.user_id', '', true)`);
        const start = (await tx.execute(
          sqlTag`select hit_count from categorization_rules where id = ${ruleId}::uuid`,
        )) as unknown as Array<{ hit_count: number }>;
        before = Number(start[0].hit_count);

        updated = await recordRuleHits(new Map([[ruleId, 7]]), { userId: null, tx });

        const end = (await tx.execute(
          sqlTag`select hit_count, last_hit_at from categorization_rules where id = ${ruleId}::uuid`,
        )) as unknown as Array<{ hit_count: number; last_hit_at: unknown }>;
        after = Number(end[0].hit_count);
        stamped = end[0].last_hit_at;

        // Roll back: the seeded rules are shared state other tests read.
        throw new Rollback('done');
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(updated).toBe(1);
    expect(after).toBe(before + 7);
    expect(stamped).not.toBeNull();

    expect(await recordRuleHits(new Map(), { userId: null })).toBe(0);
  }, 30_000);
});

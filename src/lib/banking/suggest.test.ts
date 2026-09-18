import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql as sqlTag } from 'drizzle-orm';
import Papa from 'papaparse';
import { afterAll, describe, expect, it } from 'vitest';

import { parseDateInput } from '@/lib/dates';
import { parseMoney } from '@/lib/money';

import {
  createRuleEngine,
  loadCategorizationRules,
  type CategorizationRule,
} from './rules';
import { detectTransfers, type IdentifiedTxn } from './transfers';
import {
  loadPayeeHistory,
  rankHistory,
  suggestBatch,
  suggestForTransaction,
  toDbSuggestionSource,
  type HistoryEntry,
  type PayeeHistory,
  type Suggestion,
  type SuggestionContext,
} from './suggest';
import { normalizeDescription } from './normalize';
import {
  buildVendorIndex,
  loadVendorIndex,
  type VendorAliasRecord,
  type VendorRecord,
} from './vendors';

// ---------------------------------------------------------------------------
// Pure fixtures
// ---------------------------------------------------------------------------

function rule(overrides: Partial<CategorizationRule> & { id: string }): CategorizationRule {
  return {
    name: overrides.id,
    priority: 100,
    bankAccountId: null,
    conditions: [{ field: 'payee', op: 'contains', value: 'acme' }],
    amountMinCents: null,
    amountMaxCents: null,
    direction: 'any',
    accountId: 'a-rule',
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

function txn(overrides: Partial<IdentifiedTxn> = {}): IdentifiedTxn {
  return {
    id: 't1',
    bankAccountId: 'bank-1',
    txnDate: '2026-05-14',
    payee: 'Acme Supply',
    description: null,
    reference: null,
    type: 'Spend',
    amountCents: -12345,
    ...overrides,
  };
}

const VENDORS: readonly VendorRecord[] = [
  {
    id: 'v-acme',
    name: 'Acme Supply',
    displayName: null,
    vendorType: 'other',
    defaultExpenseAccountId: 'a-vendor',
    active: true,
  },
];
const ALIASES: readonly VendorAliasRecord[] = [
  {
    id: 'al-1',
    vendorId: 'v-acme',
    alias: 'Acme Supply',
    aliasNormalized: 'ACME SUPPLY',
    source: 'manual',
  },
];
const VENDOR_INDEX = buildVendorIndex(VENDORS, ALIASES);

function context(rules: readonly CategorizationRule[], extra: Partial<SuggestionContext> = {}): SuggestionContext {
  return { engine: createRuleEngine(rules), vendors: VENDOR_INDEX, ...extra };
}

const HISTORY: PayeeHistory = new Map<string, readonly HistoryEntry[]>([
  ['ACME SUPPLY', [{ accountId: 'a-history', uses: 6, lastUsed: '2026-04-01' }]],
]);

// ---------------------------------------------------------------------------
// History ranking
// ---------------------------------------------------------------------------

describe('rankHistory', () => {
  it('returns null on no history', () => {
    expect(rankHistory([])).toBeNull();
    expect(rankHistory([{ accountId: 'a', uses: 0, lastUsed: '2026-01-01' }])).toBeNull();
  });

  it('discounts a single observation below the acting floor', () => {
    const ranked = rankHistory([{ accountId: 'a', uses: 1, lastUsed: '2026-01-01' }]);
    expect(ranked?.confidence).toBe(0.5);
    // The default floor is 0.5 and the comparison is >=, so one prior coding is
    // exactly on the line; two consistent ones clear it comfortably.
    expect(rankHistory([{ accountId: 'a', uses: 2, lastUsed: '2026-01-01' }])?.confidence).toBe(
      0.667,
    );
    expect(rankHistory([{ accountId: 'a', uses: 9, lastUsed: '2026-01-01' }])?.confidence).toBe(0.9);
  });

  it('weighs consistency as well as volume', () => {
    const split = rankHistory([
      { accountId: 'a', uses: 5, lastUsed: '2026-01-01' },
      { accountId: 'b', uses: 5, lastUsed: '2026-02-01' },
    ]);
    expect(split?.uses).toBe(5);
    expect(split?.total).toBe(10);
    // A coin flip between two accounts is worth about half of a unanimous one.
    expect(split?.confidence).toBeCloseTo(0.417, 3);
    expect(rankHistory([{ accountId: 'a', uses: 5, lastUsed: '2026-01-01' }])?.confidence).toBe(
      0.833,
    );
  });

  it('breaks a tie on recency, then deterministically on account id', () => {
    const recent = rankHistory([
      { accountId: 'b', uses: 3, lastUsed: '2026-01-01' },
      { accountId: 'a', uses: 3, lastUsed: '2026-06-01' },
    ]);
    expect(recent?.accountId).toBe('a');
    const identical = rankHistory([
      { accountId: 'b', uses: 3, lastUsed: '2026-06-01' },
      { accountId: 'a', uses: 3, lastUsed: '2026-06-01' },
    ]);
    expect(identical?.accountId).toBe('a');
  });
});

describe('toDbSuggestionSource', () => {
  it('maps every pipeline tier onto the database enum', () => {
    expect(toDbSuggestionSource('rule')).toBe('rule');
    expect(toDbSuggestionSource('transfer')).toBe('match');
    expect(toDbSuggestionSource('card_refund')).toBe('match');
    expect(toDbSuggestionSource('vendor_default')).toBe('history');
    expect(toDbSuggestionSource('history')).toBe('history');
  });
});

// ---------------------------------------------------------------------------
// Tier order
// ---------------------------------------------------------------------------

describe('pipeline order', () => {
  it('a bank-labelled transfer outranks everything, and books to no account', () => {
    const out = txn({ id: 'out', bankAccountId: 'bank-1', type: 'Spend-transfer', amountCents: -5000 });
    const into = txn({ id: 'in', bankAccountId: 'bank-2', type: 'Receive-transfer', amountCents: 5000 });
    const transfers = detectTransfers([out, into]);
    const ctx = context([rule({ id: 'r', autoPost: true })], { transfers, history: HISTORY });

    const suggestion = suggestForTransaction(out, ctx);
    expect(suggestion?.source).toBe('transfer');
    expect(suggestion?.accountId).toBeNull();
    expect(suggestion?.transferPairTxnId).toBe('in');
    expect(suggestion?.autoPost).toBe(false);
    expect(suggestion?.reasoning).toMatch(/must not touch the P&L/);
  });

  it('a labelled transfer with no counterpart still refuses to be income or expense', () => {
    const lonely = txn({ id: 'lonely', type: 'Receive-transfer', amountCents: 455, payee: null, counterpartyMask: '3474' });
    const transfers = detectTransfers([lonely]);
    const suggestion = suggestForTransaction(lonely, context([], { transfers }));
    expect(suggestion?.source).toBe('transfer');
    expect(suggestion?.accountId).toBeNull();
    expect(suggestion?.transferPairTxnId).toBeNull();
    expect(suggestion?.reasoning).toMatch(/paired by hand/);
  });

  it('a labelled transfer from an account that is not the company’s is outside money for a human', () => {
    const lonely = txn({ id: 'lonely', type: 'Receive-transfer', amountCents: 455, payee: null, counterpartyMask: '3474' });
    const transfers = detectTransfers([lonely], {
      bankAccountMasks: new Map([['acct-9726', '9726'], ['acct-9973', '9973']]),
    });
    const suggestion = suggestForTransaction(lonely, context([], { transfers }));
    expect(suggestion?.source).toBe('transfer');
    expect(suggestion?.accountId).toBeNull();
    expect(suggestion?.transferPairTxnId).toBeNull();
    expect(suggestion?.autoPost).toBe(false);
    expect(suggestion?.reasoning).toMatch(/money from outside the company/);
    expect(suggestion?.reasoning).not.toMatch(/not income or expense/);
  });

  it('a rule outranks the vendor default and history', () => {
    const suggestion = suggestForTransaction(
      txn(),
      context([rule({ id: 'r', accountId: 'a-rule' })], { history: HISTORY }),
    );
    expect(suggestion?.source).toBe('rule');
    expect(suggestion?.accountId).toBe('a-rule');
    expect(suggestion?.ruleId).toBe('r');
    expect(suggestion?.vendorId).toBe('v-acme');
    expect(suggestion?.confidence).toBe(0.9);
  });

  it('the vendor default outranks history', () => {
    const suggestion = suggestForTransaction(txn(), context([], { history: HISTORY }));
    expect(suggestion?.source).toBe('vendor_default');
    expect(suggestion?.accountId).toBe('a-vendor');
    expect(suggestion?.vendorId).toBe('v-acme');
    expect(suggestion?.confidence).toBe(0.85);
  });

  it('a vendor expense default is never offered for money coming in', () => {
    const suggestion = suggestForTransaction(txn({ amountCents: 1000, type: 'Receive' }), context([]));
    expect(suggestion).toBeNull();
  });

  it('history is the last resort', () => {
    const noDefault = buildVendorIndex(
      [{ ...VENDORS[0], defaultExpenseAccountId: null }],
      ALIASES,
    );
    const suggestion = suggestForTransaction(
      txn(),
      { engine: createRuleEngine([]), vendors: noDefault, history: HISTORY },
    );
    expect(suggestion?.source).toBe('history');
    expect(suggestion?.accountId).toBe('a-history');
    expect(suggestion?.confidence).toBe(0.857);
    expect(suggestion?.reasoning).toMatch(/Coded this way 6 times out of 6/);
  });

  it('returns null rather than guessing', () => {
    const empty = buildVendorIndex([], []);
    expect(
      suggestForTransaction(txn({ payee: 'Someone Brand New' }), {
        engine: createRuleEngine([]),
        vendors: empty,
      }),
    ).toBeNull();
  });

  it('will not act on thin history', () => {
    const noDefault = buildVendorIndex([{ ...VENDORS[0], defaultExpenseAccountId: null }], ALIASES);
    const thin: PayeeHistory = new Map([
      ['ACME SUPPLY', [{ accountId: 'a-history', uses: 1, lastUsed: '2026-04-01' }]],
    ]);
    expect(
      suggestForTransaction(txn(), {
        engine: createRuleEngine([]),
        vendors: noDefault,
        history: thin,
        minHistoryConfidence: 0.6,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auto-post
// ---------------------------------------------------------------------------

describe('auto-post', () => {
  it('only a matched auto_post rule that names an account may set it', () => {
    const posted = suggestForTransaction(
      txn(),
      context([rule({ id: 'r', autoPost: true, accountId: 'a-rule' })]),
    );
    expect(posted?.autoPost).toBe(true);
    expect(posted?.confidence).toBe(0.98);

    const noAccount = suggestForTransaction(
      txn(),
      context([rule({ id: 'r', autoPost: true, accountId: null })]),
    );
    expect(noAccount?.autoPost).toBe(false);
  });

  it('never auto-posts a card refund, whatever rule won', () => {
    const card = 'Corporate Card - 1892 (Business Card)';
    const refund = txn({ id: 'r1', amountCents: 3831, type: 'Receive', reference: card });
    const charge = txn({ id: 'c1', txnDate: '2026-05-10', amountCents: -3831, type: 'Spend', reference: card });
    const transfers = detectTransfers([charge, refund]);
    const suggestion = suggestForTransaction(
      refund,
      context([rule({ id: 'r', autoPost: true, accountId: 'a-rule' })], { transfers }),
    );
    expect(suggestion?.source).toBe('rule');
    expect(suggestion?.autoPost).toBe(false);
    expect(suggestion?.cardRefundOfTxnId).toBe('c1');
    expect(suggestion?.reasoning).toMatch(/expense reversal, not income/);
  });

  it('flags a card refund even when no rule and no vendor claim it', () => {
    const card = 'Corporate Card - 1892 (Business Card)';
    const refund = txn({ id: 'r1', payee: 'Nobody At All', amountCents: 999, type: 'Receive', reference: card });
    const transfers = detectTransfers([refund]);
    const suggestion = suggestForTransaction(refund, {
      engine: createRuleEngine([]),
      vendors: buildVendorIndex([], []),
      transfers,
    });
    expect(suggestion?.source).toBe('card_refund');
    expect(suggestion?.accountId).toBeNull();
    expect(suggestion?.autoPost).toBe(false);
  });
});

describe('memo', () => {
  it('falls back to the payee', () => {
    expect(suggestForTransaction(txn(), context([rule({ id: 'r' })]))?.memo).toBe('Acme Supply');
  });

  it('renders the rule template', () => {
    const suggestion = suggestForTransaction(
      txn({ reference: 'PO SOOZ-2026-001' }),
      context([rule({ id: 'r', memoTemplate: '{payee} — {reference} — {date} — {amount}' })]),
    );
    expect(suggestion?.memo).toBe('Acme Supply — PO SOOZ-2026-001 — 2026-05-14 — 123.45');
  });
});

// ---------------------------------------------------------------------------
// The real Relay statements, end to end
// ---------------------------------------------------------------------------

const RELAY_DIR = fileURLToPath(new URL('../../../data/statements/relay', import.meta.url));

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

function loadRelayRows(): Array<{ row: RelayRow; mask: string; index: number; file: string }> {
  if (!existsSync(RELAY_DIR)) return [];
  const out: Array<{ row: RelayRow; mask: string; index: number; file: string }> = [];
  for (const file of readdirSync(RELAY_DIR).filter((f) => f.endsWith('.csv')).sort()) {
    const mask = /#(\d{4})/.exec(file)?.[1] ?? 'unknown';
    const parsed = Papa.parse<RelayRow>(readFileSync(`${RELAY_DIR}/${file}`, 'utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    parsed.data.forEach((row, index) => {
      if (!row.Date) return;
      out.push({ row, mask, index, file });
    });
  }
  return out;
}

function toTxn(
  entry: { row: RelayRow; mask: string; index: number; file: string },
  bankAccountIdByMask: ReadonlyMap<string, string>,
): IdentifiedTxn {
  const { row, mask, index, file } = entry;
  return {
    id: `${file}#${index}`,
    bankAccountId: bankAccountIdByMask.get(mask) ?? `acct-${mask}`,
    txnDate: parseDateInput(row.Date),
    payee: row.Payee === '' ? null : row.Payee,
    description: row.Description === '' ? null : row.Description,
    reference: row.Reference === '' ? null : row.Reference,
    type: row['Transaction Type'],
    amountCents: parseMoney(row.Amount),
    status: row.Status,
    counterpartyMask: row['Account #'] === '' ? null : row['Account #'],
  };
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

const RELAY_ROWS = loadRelayRows();

interface Pipeline {
  readonly results: ReadonlyArray<{ txn: IdentifiedTxn; suggestion: Suggestion | null }>;
  readonly ruleNameById: ReadonlyMap<string, string>;
  readonly autoPostRuleIds: ReadonlySet<string>;
  readonly accountCodeById: ReadonlyMap<string, string>;
  readonly accountTypeByCode: ReadonlyMap<string, string>;
  readonly idByCode: ReadonlyMap<string, string>;
}

/**
 * `history: 'none'` runs without payee history — what the rules and the vendor index decide
 * alone, independent of which rows the live books have posted so far.
 */
async function runPipeline(options: { history?: 'live' | 'none' } = {}): Promise<Pipeline> {
  const { sql } = await import('@/db/client');

  const bankRows = await sql<Array<{ id: string; mask: string | null }>>`
    select id, mask from bank_accounts`;
  const bankAccountIdByMask = new Map(
    bankRows.filter((r) => r.mask !== null).map((r) => [r.mask as string, r.id]),
  );
  const masks = new Map<string, string | null>(bankRows.map((r) => [r.id, r.mask]));

  const accountRows = await sql<Array<{ id: string; code: string; type: string }>>`
    select id, code, type::text as type from accounts`;
  const accountCodeById = new Map(accountRows.map((r) => [r.id, r.code]));
  const accountTypeByCode = new Map(accountRows.map((r) => [r.code, r.type]));
  const idByCode = new Map(accountRows.map((r) => [r.code, r.id]));

  const loaded = await loadCategorizationRules();
  const engine = createRuleEngine(loaded.rules);
  const vendors = await loadVendorIndex();
  const history: PayeeHistory =
    options.history === 'none' ? new Map() : await loadPayeeHistory({ asOf: '2026-09-30' });

  const txns = RELAY_ROWS.map((entry) => toTxn(entry, bankAccountIdByMask));
  const results = suggestBatch(
    txns,
    { engine, vendors, history },
    { transferOptions: { bankAccountMasks: masks } },
  );

  return {
    results,
    ruleNameById: new Map(loaded.rules.map((r) => [r.id, r.name])),
    autoPostRuleIds: new Set(loaded.rules.filter((r) => r.autoPost).map((r) => r.id)),
    accountCodeById,
    accountTypeByCode,
    idByCode,
  };
}

// One pool for the whole file: each `describe` below shares it, so it is closed
// once, here, rather than under the first block that happens to finish.
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

describe('real Relay statements', () => {
  it('has the statement fixtures on disk', () => {
    expect(existsSync(RELAY_DIR), `real Relay statements are missing from ${RELAY_DIR}`).toBe(true);
    expect(RELAY_ROWS).toHaveLength(110);
  });
});

describe.skipIf(!DATABASE_URL || RELAY_ROWS.length === 0)('the pipeline over the real data', () => {
  it('auto-posts exactly the four rules the owner marked, and nothing else', async () => {
    const { results, ruleNameById, autoPostRuleIds } = await runPipeline();

    const autoPosted = results.filter((r) => r.suggestion?.autoPost === true);
    const byRule = new Map<string, number>();
    for (const entry of autoPosted) {
      const name = ruleNameById.get(entry.suggestion?.ruleId ?? '') ?? '(none)';
      byRule.set(name, (byRule.get(name) ?? 0) + 1);
    }

    expect([...byRule].sort()).toEqual([
      ['Member contribution — BofA SafeBalance', 7],
      ['Member contribution — Chase College', 5],
      ['Relay banking fees', 2],
      // Seven deposits across five Square batches: SQ260126 carries three.
      ['Square payout to clearing', 7],
    ]);
    expect(autoPosted).toHaveLength(21);

    // Nothing auto-posts except through one of those four rules.
    for (const entry of autoPosted) {
      expect(entry.suggestion?.source).toBe('rule');
      expect(autoPostRuleIds.has(entry.suggestion?.ruleId ?? '')).toBe(true);
    }
    for (const entry of results) {
      if (entry.suggestion?.autoPost === true) continue;
      expect(entry.suggestion?.autoPost ?? false).toBe(false);
    }
  }, 60_000);

  it('sends every Amazon transaction to 7900 Ask My Accountant and never auto-posts one', async () => {
    const { results, accountCodeById } = await runPipeline();
    const amazon = results.filter((r) => r.txn.payee === 'Amazon');
    expect(amazon).toHaveLength(37);

    for (const entry of amazon) {
      const suggestion = entry.suggestion;
      expect(suggestion, `no suggestion for ${entry.txn.id}`).not.toBeNull();
      expect(
        accountCodeById.get(suggestion?.accountId ?? ''),
        `${entry.txn.txnDate} ${entry.txn.amountCents}`,
      ).toBe('7900');
      expect(suggestion?.autoPost).toBe(false);
      expect(suggestion?.source).toBe('rule');
    }

    // Including the three that are money coming back on the card.
    const refunds = amazon.filter((r) => r.txn.amountCents > 0);
    expect(refunds).toHaveLength(3);
    for (const refund of refunds) {
      expect(accountCodeById.get(refund.suggestion?.accountId ?? '')).toBe('7900');
    }
    const withOriginal = refunds.filter((r) => r.suggestion?.cardRefundOfTxnId !== null);
    expect(withOriginal).toHaveLength(2);
  }, 60_000);

  it('books every owner funding pull to equity, and never to revenue', async () => {
    const { results, accountCodeById, accountTypeByCode } = await runPipeline();

    const pulls = results.filter((r) => r.txn.reference === 'ACH Pull');
    expect(pulls).toHaveLength(12);
    // $5,673.46 across the nine months — more than every Square deposit combined,
    // which is why coding these as revenue would overstate income roughly tenfold.
    expect(pulls.reduce((sum, r) => sum + r.txn.amountCents, 0)).toBe(567346);

    for (const entry of pulls) {
      const code = accountCodeById.get(entry.suggestion?.accountId ?? '');
      expect(code, `${entry.txn.txnDate} ${entry.txn.payee}`).toBe('3015');
      expect(accountTypeByCode.get('3015')).toBe('equity');
      expect(entry.suggestion?.autoPost).toBe(true);
    }

    // And said the same way round: no revenue account anywhere near them.
    const revenueCodes = new Set(
      [...accountTypeByCode].filter(([, type]) => type === 'revenue').map(([code]) => code),
    );
    expect(revenueCodes.size).toBeGreaterThan(0);
    for (const entry of pulls) {
      const code = accountCodeById.get(entry.suggestion?.accountId ?? '') ?? '';
      expect(revenueCodes.has(code)).toBe(false);
    }
  }, 60_000);

  it('keeps Square deposits in the clearing account rather than straight to revenue', async () => {
    const { results, accountCodeById } = await runPipeline();
    const payouts = results.filter((r) => /^SQ\d{6}$/.test(r.txn.reference ?? ''));
    expect(payouts).toHaveLength(7);
    expect(new Set(payouts.map((r) => r.txn.reference)).size).toBe(5);
    for (const entry of payouts) {
      // 1150 Square Clearing: the Square settlement importer clears it later with
      // full gross detail, so the processing fee is not lost.
      expect(accountCodeById.get(entry.suggestion?.accountId ?? '')).toBe('1150');
    }
    expect(payouts.reduce((sum, r) => sum + r.txn.amountCents, 0)).toBe(27200);
  }, 60_000);

  it('routes all three bank-labelled transfers away from the P&L', async () => {
    const { results } = await runPipeline();
    const transfers = results.filter((r) => (r.txn.type ?? '').includes('-transfer'));
    expect(transfers).toHaveLength(3);
    for (const entry of transfers) {
      expect(entry.suggestion?.source).toBe('transfer');
      expect(entry.suggestion?.accountId).toBeNull();
      expect(entry.suggestion?.autoPost).toBe(false);
    }
    const paired = transfers.filter((r) => r.suggestion?.transferPairTxnId !== null);
    expect(paired).toHaveLength(2);
    expect(transfers.filter((r) => r.suggestion?.transferPairTxnId === null)).toHaveLength(1);
  }, 60_000);

  it('leaves only the genuinely undecidable rows for review', async () => {
    // Rules and vendors alone: once Square deposits are posted, payee history also (rightly)
    // suggests 1150 for Square's one-cent verification credit, which is not what this pins.
    const { results, accountCodeById } = await runPipeline({ history: 'none' });

    const undecided = results.filter((r) => r.suggestion === null);
    expect(
      undecided.map((r) => [r.txn.txnDate, r.txn.payee, r.txn.amountCents, r.txn.reference]),
    ).toEqual([
      // Square's one-cent account verification credit.
      ['2026-01-20', 'Square Inc', 1, 'ACCTVERIFY'],
      ['2026-02-17', 'RICE UNIVERSITY', 2000, 'PAYMENTS'],
      // The ACH that bounced; the importer handles RETURNED rows, not the rules.
      ['2026-05-15', 'GOOGLE', 1000, 'Returned received ACH transaction #417940311 due to: Account has insufficient funds - Initiated By Unknown Payee'],
    ]);

    const suggested = results.filter((r) => r.suggestion !== null);
    expect(suggested).toHaveLength(107);

    // Everything that did get an account got a real one.
    for (const entry of suggested) {
      const accountId = entry.suggestion?.accountId;
      if (accountId === null || accountId === undefined) continue;
      expect(accountCodeById.has(accountId)).toBe(true);
    }
  }, 60_000);

  it('explains every suggestion it makes', async () => {
    const { results } = await runPipeline();
    for (const entry of results) {
      if (entry.suggestion === null) continue;
      expect(entry.suggestion.reasoning.length).toBeGreaterThan(10);
      expect(entry.suggestion.confidence).toBeGreaterThan(0);
      expect(entry.suggestion.confidence).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// History, against the live schema
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_URL)('loadPayeeHistory', () => {
  it('counts how a payee has been coded, and feeds the pipeline', async () => {
    const { db } = await import('@/db/client');
    const payee = `ZZ HISTORY FIXTURE ${Math.random().toString(36).slice(2, 10)}`;
    const key = normalizeDescription(payee);

    class Rollback extends Error {}
    let history: PayeeHistory = new Map();
    let officeUses = 0;
    let softwareUses = 0;
    let historyConfidence = 0;

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sqlTag`select set_config('app.user_id', '', true)`);
        const [bank] = (await tx.execute(
          sqlTag`select id from bank_accounts order by mask limit 1`,
        )) as unknown as Array<{ id: string }>;
        const accounts = (await tx.execute(
          sqlTag`select id, code from accounts where code in ('6740', '6610')`,
        )) as unknown as Array<{ id: string; code: string }>;
        const office = accounts.find((a) => a.code === '6740')?.id ?? '';
        const software = accounts.find((a) => a.code === '6610')?.id ?? '';

        // Four prior codings for one payee: office three times, software once.
        const rows: ReadonlyArray<[string, string, number]> = [
          ['2026-03-01', office, -1000],
          ['2026-04-01', office, -2000],
          ['2026-04-15', office, -2500],
          ['2026-05-01', software, -3000],
        ];
        let n = 0;
        for (const [date, accountId, cents] of rows) {
          n += 1;
          await tx.execute(sqlTag`
            insert into bank_transactions
              (bank_account_id, txn_date, description, description_normalized, counterparty,
               amount_cents, fingerprint, status, suggested_account_id, reviewed_at)
            values (${bank.id}::uuid, ${date}::date, ${payee}, normalize_description(${payee}),
                    ${payee}, ${cents}::bigint, ${`${key}-${n}`}, 'categorized',
                    ${accountId}::uuid, now())`);
        }

        history = await loadPayeeHistory({ asOf: '2026-09-30', tx });
        const entries = history.get(key) ?? [];
        officeUses = entries.find((e) => e.accountId === office)?.uses ?? 0;
        softwareUses = entries.find((e) => e.accountId === software)?.uses ?? 0;

        const ranked = rankHistory(entries);
        expect(ranked?.accountId).toBe(office);
        historyConfidence = ranked?.confidence ?? 0;

        // And the pipeline uses it when nothing better is available.
        const suggestion = suggestForTransaction(
          {
            id: 'new',
            bankAccountId: bank.id,
            txnDate: '2026-06-01',
            payee,
            description: payee,
            reference: null,
            type: 'Spend',
            amountCents: -1500,
          },
          {
            engine: createRuleEngine([]),
            vendors: buildVendorIndex([], []),
            history,
            minHistoryConfidence: 0.5,
          },
        );
        expect(suggestion?.source).toBe('history');
        expect(suggestion?.accountId).toBe(office);

        // Never leave fixtures behind: bank_transactions is shared state.
        throw new Rollback('done');
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(officeUses).toBe(3);
    expect(softwareUses).toBe(1);
    // 3 of 4 codings, discounted for a sample of three: 0.75 x 0.75.
    expect(historyConfidence).toBe(0.563);

    const { sql } = await import('@/db/client');
    const left = await sql<Array<{ count: string }>>`
      select count(*)::text as count from bank_transactions where counterparty = ${payee}`;
    expect(Number(left[0].count)).toBe(0);
  }, 60_000);

  it('runs against the live schema with no fixtures at all', async () => {
    const history = await loadPayeeHistory({ asOf: '2026-09-30', months: 12 });
    expect(history).toBeInstanceOf(Map);
  }, 30_000);
});

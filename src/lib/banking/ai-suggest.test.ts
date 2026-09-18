/**
 * Sooz Books — the AI categorization layer.
 *
 * Three kinds of test live here, and only the last one touches a network.
 *
 *   1. **The prompt**, asserted purely. `buildSuggestPrompt` is a function from data to
 *      two strings, so the wording of the guardrails — member contributions are equity,
 *      ingredients capitalize to inventory, never propose a bank or control account —
 *      is checked the way any other pure function is.
 *   2. **The guardrails**, against a stubbed model. Every rule in `applyGuardrails` has
 *      a test that makes a model say the wrong thing and proves the wrong thing does not
 *      reach the review queue.
 *   3. **One integration test**, skipped unless `ANTHROPIC_API_KEY` and the real
 *      statements are both present. It sends the ten genuinely ambiguous transactions
 *      from this company's own bank records and asserts that whatever comes back
 *      validates and survives every guardrail.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APICallError } from 'ai';
import type { JSONSchema7, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ALWAYS_REVIEW_NOTE_PATTERNS,
  DEFAULT_CONFIDENCE_FLOOR,
  MAX_BATCH_SIZE,
  alwaysReviewTerms,
  createAnthropicModel,
  resolveSuggestModel,
  suggestWithAI,
  suggestWithAIDetailed,
  toPromptTxn,
  vendorAlwaysNeedsReview,
  type AISuggestContext,
} from './ai-suggest';
import {
  PROMPT_SECTIONS,
  SOOZ_COMPANY_CONTEXT,
  TXN_TABLE_HEADER,
  buildSuggestPrompt,
  selectableAccounts,
  type PromptAccount,
  type PromptVendor,
} from './ai-prompt';
import type { NormalizedTxn } from './types';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, '../../..');

/**
 * Vitest does not run through Next.js, so nothing loads `.env.local`. Only keys that
 * are not already set are filled in, so an explicit environment always wins.
 */
function loadEnvLocal(): void {
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function account(
  code: string,
  name: string,
  type: string,
  overrides: Partial<PromptAccount> = {},
): PromptAccount {
  return {
    code,
    name,
    description: `${name} description.`,
    type,
    subtype: null,
    postable: true,
    isBank: false,
    isControl: false,
    active: true,
    ...overrides,
  };
}

/**
 * A small chart with one of everything the guardrails care about: a rollup, a bank
 * account, both control accounts and a deactivated account.
 */
const CHART: readonly PromptAccount[] = [
  account('1000', 'Cash & Bank', 'asset', { postable: false, description: 'Rollup only.' }),
  account('1011', 'Relay — Operating Expenses ••9726', 'asset', { isBank: true }),
  account('1200', 'Accounts Receivable', 'asset', { isControl: true }),
  account('1320', 'Raw Ingredients', 'asset'),
  account('1330', 'Packaging Materials', 'asset'),
  account('2000', 'Accounts Payable', 'liability', { isControl: true }),
  account('3015', 'Member Contributions', 'equity'),
  account('3020', 'Owner Draws & Distributions', 'equity'),
  account('4015', 'Direct & Market Sales (Square)', 'revenue'),
  account('6120', 'Meta & Google Ads', 'expense'),
  account('6310', 'Formulation & Bench Work', 'expense'),
  account('6730', 'Meals & Entertainment', 'expense'),
  account('6740', 'Office Supplies & Postage', 'expense'),
  account('6750', 'Dues & Subscriptions', 'expense', { active: false }),
  account('7900', 'Ask My Accountant', 'expense'),
];

const AMAZON_VENDOR: PromptVendor = {
  name: 'Amazon',
  defaultAccountCode: null,
  notes:
    'Ambiguous by design: lab supplies, packaging, office goods and personal purchases all land here. Never auto-categorize.',
  aliases: ['Amazon'],
};

const VENDORS: readonly PromptVendor[] = [
  AMAZON_VENDOR,
  { name: 'Target', defaultAccountCode: '6740', notes: null, aliases: ['Target'] },
  { name: 'Meta', defaultAccountCode: '6120', notes: 'Meta advertising. Recurring ~$53.31.', aliases: ['Meta Store', 'SP+AFF * META STORE -'] },
];

function txn(rowIndex: number, overrides: Partial<NormalizedTxn> = {}): NormalizedTxn {
  const payee = overrides.counterparty ?? overrides.description ?? 'Amazon';
  return {
    date: '2026-02-28',
    description: payee,
    descriptionNormalized: payee.toUpperCase(),
    counterparty: payee,
    amountCents: -1395,
    balanceCents: 36457,
    reference: 'Corporate Card - 1892 (Business Card)',
    externalId: null,
    rawType: 'Spend',
    status: 'SETTLED',
    rowIndex,
    raw: {},
    warnings: [],
    usable: true,
    ...overrides,
  };
}

interface StubUsage {
  readonly input: number;
  readonly output: number;
}

function objectResult(payload: unknown, usage: StubUsage = { input: 1200, output: 300 }) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    finishReason: { unified: 'stop' as const, raw: 'end_turn' },
    usage: {
      inputTokens: {
        total: usage.input,
        noCache: usage.input,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
    },
    warnings: [],
  };
}

/** A model that always answers with the same object. */
function modelReturning(payload: unknown, usage?: StubUsage): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: 'stub-model',
    doGenerate: async () => objectResult(payload, usage),
  });
}

/** A model that answers with raw text — used to prove a malformed answer is survivable. */
function modelReturningText(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: 'stub-model',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: 'end_turn' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 2, text: 2, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function modelThrowing(error: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: 'stub-model',
    doGenerate: async () => {
      throw error;
    },
  });
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `stub ${statusCode}`,
    url: 'https://example.invalid/v1/messages',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

/** The context the stub tests share: an injected model, no environment, no retry wait. */
function ctxWith(model: AISuggestContext['model'], overrides: Partial<AISuggestContext> = {}): AISuggestContext {
  return {
    accounts: CHART,
    vendors: VENDORS,
    model,
    retryDelayMs: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

describe('buildSuggestPrompt', () => {
  const prompt = buildSuggestPrompt(
    [
      toPromptTxn(txn(0)),
      toPromptTxn(
        txn(1, { counterparty: 'CHASE COLLEGE', amountCents: 200000, reference: 'ACH Pull', date: '2026-09-01' }),
      ),
    ],
    { accounts: CHART, vendors: VENDORS },
  );

  it('has every section, in order, exactly once', () => {
    const positions = PROMPT_SECTIONS.map((heading) => prompt.system.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const heading of PROMPT_SECTIONS) {
      expect(prompt.system.split(heading)).toHaveLength(2);
    }
  });

  it('renders the chart as code — name — description', () => {
    expect(prompt.system).toContain('1320 — Raw Ingredients — Raw Ingredients description.');
    expect(prompt.system).toContain('7900 — Ask My Accountant — Ask My Accountant description.');
  });

  it('offers only postable, active, non-bank, non-control accounts', () => {
    const offered = selectableAccounts(CHART).map((a) => a.code);
    expect(offered).toEqual(['1320', '1330', '3015', '3020', '4015', '6120', '6310', '6730', '6740', '7900']);

    // The rollup, the bank account, both control accounts and the deactivated
    // account are not merely discouraged — they are not in the list at all.
    for (const excluded of ['1000 —', '1011 —', '1200 —', '2000 —', '6750 —']) {
      expect(prompt.system).not.toContain(excluded);
    }
  });

  it('carries the company context that changes the answers', () => {
    expect(prompt.system).toContain('Pre-launch CPG beverage brand');
    expect(prompt.system).toMatch(/member contribution — equity, never revenue/);
    expect(prompt.system).toMatch(/capitalized to inventory/);
    expect(prompt.system).toContain('1320 Raw Ingredients');
    expect(prompt.system).toContain('1330 Packaging Materials');
    expect(prompt.system).toContain(SOOZ_COMPANY_CONTEXT.name);
  });

  it('states the guardrails the code also enforces', () => {
    expect(prompt.system).toMatch(/Never propose a bank account, a credit card account or a control account/);
    expect(prompt.system).toMatch(/Accounts Receivable, Accounts Payable/);
    expect(prompt.system).toMatch(/is a member contribution to equity/);
    expect(prompt.system).toMatch(/do not guess/);
    expect(prompt.system).toMatch(/owner draw \(3020\)/);
    expect(prompt.system).toMatch(/A human reviews every suggestion/);
  });

  it('tells the model the row id is the key, not the position', () => {
    expect(prompt.system).toMatch(/copied exactly[\s\S]*never be guessed or renumbered/);
    expect(prompt.system).toMatch(/Skip a transaction entirely rather than inventing an answer/);
  });

  it('echoes the confidence floor it will be judged against', () => {
    expect(prompt.system).toContain(`Anything below ${DEFAULT_CONFIDENCE_FLOOR} confidence`);
    const strict = buildSuggestPrompt([], { accounts: CHART, confidenceFloor: 0.9 });
    expect(strict.system).toContain('Anything below 0.9 confidence');
  });

  it('lists the vendors with the account each usually maps to', () => {
    expect(prompt.system).toContain('- Meta — usually 6120 — also appears as Meta Store, SP+AFF * META STORE - — Meta advertising. Recurring ~$53.31.');
    expect(prompt.system).toContain('- Amazon — no default account — decide from the evidence');
  });

  it('renders the transactions with direction and an unsigned amount', () => {
    expect(prompt.user).toContain(TXN_TABLE_HEADER);
    expect(prompt.user).toContain(
      '0 | 2026-02-28 | Amazon | Amazon | Corporate Card - 1892 (Business Card) | out | 13.95',
    );
    expect(prompt.user).toContain('1 | 2026-09-01 | CHASE COLLEGE | CHASE COLLEGE | ACH Pull | in | 2000.00');
    expect(prompt.user).toContain('# Transactions to categorize (2)');
  });

  it('never sends the statement balance', () => {
    // The row above carries balanceCents 36457. PromptTxn has no field for it, so the
    // only way it could reach the model is a caller mistake this type makes impossible.
    expect(prompt.user).not.toContain('364.57');
    expect(prompt.user).not.toContain('36457');
    expect(prompt.system).not.toContain('balance');
  });

  it('does not let a payee invent a column', () => {
    const piped = buildSuggestPrompt(
      [toPromptTxn(txn(4, { counterparty: 'ACH | RETURN | WIRE' }))],
      { accounts: CHART },
    );
    const row = piped.user.split('\n').at(-1) ?? '';
    expect(row.split(' | ')).toHaveLength(7);
    expect(row).toContain('ACH / RETURN / WIRE');
  });

  it('renders an empty field as a dash rather than an empty column', () => {
    const bare = buildSuggestPrompt([toPromptTxn(txn(9, { reference: null }))], { accounts: CHART });
    expect(bare.user).toContain('| - | out |');
  });
});

// ---------------------------------------------------------------------------
// The always-review list
// ---------------------------------------------------------------------------

describe('the always-review list', () => {
  it('is read off the owner’s vendor notes, not off a hardcoded name', () => {
    expect(vendorAlwaysNeedsReview(AMAZON_VENDOR)).toBe(true);
    expect(vendorAlwaysNeedsReview({ name: 'Amazon', defaultAccountCode: null, notes: 'Office goods.' })).toBe(false);
    expect(vendorAlwaysNeedsReview({ name: 'Anything', defaultAccountCode: null, notes: 'Always review.' })).toBe(true);
    expect(vendorAlwaysNeedsReview({ name: 'Anything', defaultAccountCode: null, notes: 'Do not auto-categorise.' })).toBe(true);
    expect(vendorAlwaysNeedsReview({ name: 'Anything', defaultAccountCode: null, notes: null })).toBe(false);
  });

  it('collects the vendor’s name and every alias, normalised', () => {
    expect(alwaysReviewTerms(VENDORS)).toEqual(['AMAZON']);
    expect(
      alwaysReviewTerms([
        { name: "Dave's Hot Chicken", defaultAccountCode: '6730', notes: 'Always review.', aliases: ['DAVESHOTCHICKEN'] },
      ]),
      // `normalizeDescription` turns the apostrophe into a space, exactly as the
      // Postgres function does, so the vendor name and the bank's own spelling are
      // both on the list and either one is enough to hold the charge back.
    ).toEqual(['DAVE S HOT CHICKEN', 'DAVESHOTCHICKEN']);
  });

  it('has patterns that match the note the database actually carries', () => {
    expect(ALWAYS_REVIEW_NOTE_PATTERNS.some((p) => p.test(AMAZON_VENDOR.notes ?? ''))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

describe('guardrails', () => {
  it('discards an account code that is not in the chart of accounts', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '9999', vendorName: null, confidence: 0.95, reasoning: 'Invented.', needsHuman: false },
      ],
    });
    const result = await suggestWithAIDetailed([txn(0)], ctxWith(model));

    expect(result.suggestions).toEqual([]);
    expect(result.discarded).toEqual([{ rowIndex: 0, accountCode: '9999', reason: 'unknown_account' }]);
  });

  it('discards a control account — AR and AP belong to the subledgers', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '1200', vendorName: null, confidence: 1, reasoning: 'Receivable.', needsHuman: false },
        { rowIndex: 1, accountCode: '2000', vendorName: null, confidence: 1, reasoning: 'Payable.', needsHuman: false },
      ],
    });
    const result = await suggestWithAIDetailed([txn(0), txn(1)], ctxWith(model));

    expect(result.suggestions).toEqual([]);
    expect(result.discarded.map((d) => d.reason)).toEqual(['control_account', 'control_account']);
  });

  it('discards a bank account', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '1011', vendorName: null, confidence: 1, reasoning: 'Bank.', needsHuman: false },
      ],
    });
    const result = await suggestWithAIDetailed([txn(0)], ctxWith(model));

    expect(result.suggestions).toEqual([]);
    expect(result.discarded[0]).toEqual({ rowIndex: 0, accountCode: '1011', reason: 'bank_account' });
  });

  it('discards a rollup and a deactivated account', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '1000', vendorName: null, confidence: 1, reasoning: 'Cash.', needsHuman: false },
        { rowIndex: 1, accountCode: '6750', vendorName: null, confidence: 1, reasoning: 'Dues.', needsHuman: false },
      ],
    });
    const result = await suggestWithAIDetailed([txn(0), txn(1)], ctxWith(model));

    expect(result.suggestions).toEqual([]);
    expect(result.discarded.map((d) => d.reason)).toEqual(['rollup_account', 'inactive_account']);
  });

  it('clamps confidence into [0,1]', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '6740', vendorName: null, confidence: 1.8, reasoning: 'Sure.', needsHuman: false },
        { rowIndex: 1, accountCode: '6740', vendorName: null, confidence: -0.4, reasoning: 'Unsure.', needsHuman: false },
      ],
    });
    const result = await suggestWithAIDetailed(
      [txn(0, { counterparty: 'Michaels' }), txn(1, { counterparty: 'Dollar Tree' })],
      ctxWith(model),
    );

    expect(result.suggestions.map((s) => s.confidence)).toEqual([1, 0]);
    // Clamping to 0 puts it below the floor, so it is flagged even though the model said not to.
    expect(result.suggestions.map((s) => s.needsHuman)).toEqual([false, true]);
  });

  it('flags anything below the confidence floor, which is configurable', async () => {
    const payload = {
      suggestions: [
        { rowIndex: 0, accountCode: '6740', vendorName: null, confidence: 0.55, reasoning: 'Probably supplies.', needsHuman: false },
      ],
    };
    const txns = [txn(0, { counterparty: 'Michaels' })];

    const lenient = await suggestWithAIDetailed(txns, ctxWith(modelReturning(payload), { confidenceFloor: 0.5 }));
    expect(lenient.suggestions[0].needsHuman).toBe(false);

    const defaulted = await suggestWithAIDetailed(txns, ctxWith(modelReturning(payload)));
    expect(defaulted.suggestions[0].needsHuman).toBe(true);

    const strict = await suggestWithAIDetailed(txns, ctxWith(modelReturning(payload), { confidenceFloor: 0.9 }));
    expect(strict.suggestions[0].needsHuman).toBe(true);
  });

  it('never sets autoPost, whatever the model says or how sure it is', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '6120', vendorName: 'Meta', confidence: 1, reasoning: 'Meta ads.', needsHuman: false, autoPost: true },
      ],
    });
    const suggestions = await suggestWithAI([txn(0, { counterparty: 'Meta Store' })], ctxWith(model));

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].autoPost).toBe(false);
    expect(suggestions[0].source).toBe('ai');
    // The extra key the model invented is not carried through either.
    expect(Object.keys(suggestions[0]).sort()).toEqual([
      'accountCode',
      'autoPost',
      'confidence',
      'modelId',
      'needsHuman',
      'reasoning',
      'rowIndex',
      'source',
      'vendorName',
    ]);
  });

  it('marks an always-review payee for a human however confident the model is', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '6740', vendorName: 'Amazon', confidence: 0.99, reasoning: 'Office supplies.', needsHuman: false },
      ],
    });
    const result = await suggestWithAIDetailed([txn(0, { counterparty: 'Amazon' })], ctxWith(model));

    expect(result.suggestions[0].confidence).toBe(0.99);
    expect(result.suggestions[0].needsHuman).toBe(true);
  });

  it('holds back an always-review payee only because the owner’s note says so', async () => {
    const payload = {
      suggestions: [
        { rowIndex: 0, accountCode: '6740', vendorName: 'Amazon', confidence: 0.99, reasoning: 'Office supplies.', needsHuman: false },
      ],
    };
    const txns = [txn(0, { counterparty: 'Amazon' })];

    // Same payee, same answer — but the note no longer says "never auto-categorize".
    const unmarked = await suggestWithAIDetailed(
      txns,
      ctxWith(modelReturning(payload), {
        vendors: [{ name: 'Amazon', defaultAccountCode: '6740', notes: 'Office goods.' }],
      }),
    );
    expect(unmarked.suggestions[0].needsHuman).toBe(false);

    // And the marking follows the note onto an entirely different vendor.
    const marked = await suggestWithAIDetailed(
      [txn(0, { counterparty: 'Target' })],
      ctxWith(
        modelReturning({
          suggestions: [
            { rowIndex: 0, accountCode: '6740', vendorName: 'Target', confidence: 0.99, reasoning: 'Supplies.', needsHuman: false },
          ],
        }),
        { vendors: [{ name: 'Target', defaultAccountCode: '6740', notes: 'Always review.', aliases: ['Target'] }] },
      ),
    );
    expect(marked.suggestions[0].needsHuman).toBe(true);
  });

  it('matches an always-review vendor on whole words only', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '6740', vendorName: null, confidence: 0.99, reasoning: 'Supplies.', needsHuman: false },
      ],
    });
    // "AMAZONIA" is not "AMAZON"; the charge is not held back by accident.
    const result = await suggestWithAIDetailed([txn(0, { counterparty: 'AMAZONIA FOODS' })], ctxWith(model));
    expect(result.suggestions[0].needsHuman).toBe(false);

    const marketplace = await suggestWithAIDetailed([txn(0, { counterparty: 'AMAZON MKTPL US' })], ctxWith(model));
    expect(marketplace.suggestions[0].needsHuman).toBe(true);
  });

  it('discards a row id it was never given', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '6740', vendorName: null, confidence: 0.9, reasoning: 'Ours.', needsHuman: false },
        { rowIndex: 41, accountCode: '6740', vendorName: null, confidence: 0.9, reasoning: 'Invented.', needsHuman: false },
      ],
    });
    const result = await suggestWithAIDetailed([txn(0, { counterparty: 'Michaels' })], ctxWith(model));

    expect(result.suggestions.map((s) => s.rowIndex)).toEqual([0]);
    expect(result.discarded).toEqual([{ rowIndex: 41, accountCode: '6740', reason: 'unknown_row' }]);
  });

  it('keeps the first answer for a row and discards a second', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '6740', vendorName: null, confidence: 0.9, reasoning: 'First.', needsHuman: false },
        { rowIndex: 0, accountCode: '6730', vendorName: null, confidence: 0.95, reasoning: 'Second.', needsHuman: false },
      ],
    });
    const result = await suggestWithAIDetailed([txn(0, { counterparty: 'Michaels' })], ctxWith(model));

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].reasoning).toBe('First.');
    expect(result.discarded).toEqual([{ rowIndex: 0, accountCode: '6730', reason: 'duplicate_row' }]);
  });

  it('keys on the row id, so a skipped or reordered answer never misaligns', async () => {
    const model = modelReturning({
      suggestions: [
        // Row 2 first, row 0 second, rows 1 and 3 not answered at all.
        { rowIndex: 2, accountCode: '6120', vendorName: 'Meta', confidence: 0.92, reasoning: 'Meta ads.', needsHuman: false },
        { rowIndex: 0, accountCode: '6310', vendorName: null, confidence: 0.88, reasoning: 'Formulation.', needsHuman: false },
      ],
    });
    const txns = [
      txn(0, { counterparty: 'FIRESTONE CONSUL' }),
      txn(1, { counterparty: 'Amazon' }),
      txn(2, { counterparty: 'Meta Store' }),
      txn(3, { counterparty: 'Walmart' }),
    ];
    const result = await suggestWithAIDetailed(txns, ctxWith(model));

    expect(result.suggestions.map((s) => [s.rowIndex, s.accountCode])).toEqual([
      [2, '6120'],
      [0, '6310'],
    ]);
    expect(result.discarded).toEqual([]);
  });

  it('defaults a partial row in the cautious direction', async () => {
    const model = modelReturning({
      // No confidence, no needsHuman, no reasoning, no vendorName.
      suggestions: [{ rowIndex: 0, accountCode: 6740 }],
    });
    const result = await suggestWithAIDetailed([txn(0, { counterparty: 'Michaels' })], ctxWith(model));

    expect(result.suggestions[0]).toMatchObject({
      rowIndex: 0,
      accountCode: '6740',
      vendorName: null,
      confidence: 0,
      needsHuman: true,
      autoPost: false,
    });
    expect(result.suggestions[0].reasoning).toBe('Model proposed 6740 without stating a reason.');
  });

  it('ignores a row that did not parse', async () => {
    const model = modelReturning({
      suggestions: [
        { rowIndex: 0, accountCode: '6740', vendorName: null, confidence: 0.9, reasoning: 'Supplies.', needsHuman: false },
      ],
    });
    const result = await suggestWithAIDetailed([txn(0, { usable: false })], ctxWith(model));

    expect(result.suggestions).toEqual([]);
    expect(result.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

describe('batching', () => {
  it('sends at most 40 transactions per call and never one call per row', async () => {
    const txns = Array.from({ length: 95 }, (_, i) => txn(i, { counterparty: 'Michaels' }));
    const model = new MockLanguageModelV4({
      modelId: 'stub-model',
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        const user = options.prompt.find((m) => m.role === 'user');
        const text = user?.role === 'user' && user.content[0].type === 'text' ? user.content[0].text : '';
        const ids = [...text.matchAll(/^(\d+) \| /gm)].map((m) => Number(m[1]));
        return objectResult({
          suggestions: ids.map((rowIndex) => ({
            rowIndex,
            accountCode: '6740',
            vendorName: null,
            confidence: 0.8,
            reasoning: 'Craft supplies.',
            needsHuman: false,
          })),
        });
      },
    });

    const result = await suggestWithAIDetailed(txns, ctxWith(model));

    expect(MAX_BATCH_SIZE).toBe(40);
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(result.calls.map((c) => c.rowCount)).toEqual([40, 40, 15]);
    expect(result.suggestions).toHaveLength(95);
    expect(result.suggestions.map((s) => s.rowIndex)).toEqual(txns.map((t) => t.rowIndex));
  });

  it('honours a smaller batch size and caps a larger one', async () => {
    const txns = Array.from({ length: 10 }, (_, i) => txn(i, { counterparty: 'Michaels' }));

    const small = new MockLanguageModelV4({ modelId: 'stub-model', doGenerate: async () => objectResult({ suggestions: [] }) });
    await suggestWithAIDetailed(txns, ctxWith(small, { batchSize: 4 }));
    expect(small.doGenerateCalls).toHaveLength(3);

    const huge = new MockLanguageModelV4({ modelId: 'stub-model', doGenerate: async () => objectResult({ suggestions: [] }) });
    await suggestWithAIDetailed(
      Array.from({ length: 50 }, (_, i) => txn(i, { counterparty: 'Michaels' })),
      ctxWith(huge, { batchSize: 500 }),
    );
    expect(huge.doGenerateCalls).toHaveLength(2);
  });

  it('will not let one batch answer for another batch’s rows', async () => {
    const txns = Array.from({ length: 4 }, (_, i) => txn(i, { counterparty: 'Michaels' }));
    let call = 0;
    const model = new MockLanguageModelV4({
      modelId: 'stub-model',
      doGenerate: async () => {
        call += 1;
        // Both calls answer for row 0. Only the first batch was shown it; the second
        // batch holds rows 2 and 3, so its answer is about a transaction it never saw.
        return objectResult({
          suggestions: [
            { rowIndex: 0, accountCode: '6740', vendorName: null, confidence: 0.9, reasoning: `Call ${call}.`, needsHuman: false },
          ],
        });
      },
    });

    const result = await suggestWithAIDetailed(txns, ctxWith(model, { batchSize: 2 }));

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(result.suggestions.map((s) => s.reasoning)).toEqual(['Call 1.']);
    expect(result.discarded).toEqual([{ rowIndex: 0, accountCode: '6740', reason: 'unknown_row' }]);
  });

  it('drops a repeated row id rather than categorizing one transaction twice', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'stub-model',
      doGenerate: async () =>
        objectResult({
          suggestions: [
            { rowIndex: 7, accountCode: '6740', vendorName: null, confidence: 0.9, reasoning: 'Supplies.', needsHuman: false },
          ],
        }),
    });

    // Two different transactions sharing a row id — a caller that concatenated files
    // without renumbering. The import must not die, and the second must not be coded.
    const result = await suggestWithAIDetailed(
      [txn(7, { counterparty: 'Michaels', amountCents: -500 }), txn(7, { counterparty: 'Target', amountCents: -900 })],
      ctxWith(model),
    );

    const user = model.doGenerateCalls[0].prompt.find((m) => m.role === 'user');
    const text = user?.role === 'user' && user.content[0].type === 'text' ? user.content[0].text : '';
    expect([...text.matchAll(/^7 \| /gm)]).toHaveLength(1);
    expect(result.suggestions).toHaveLength(1);
  });

  it('lets one failed batch cost only its own rows', async () => {
    const txns = Array.from({ length: 6 }, (_, i) => txn(i, { counterparty: 'Michaels' }));
    let call = 0;
    const model = new MockLanguageModelV4({
      modelId: 'stub-model',
      doGenerate: async () => {
        call += 1;
        if (call === 1) throw apiError(400);
        return objectResult({
          suggestions: [
            { rowIndex: 3, accountCode: '6740', vendorName: null, confidence: 0.9, reasoning: 'Supplies.', needsHuman: false },
          ],
        });
      },
    });

    const result = await suggestWithAIDetailed(txns, ctxWith(model, { batchSize: 3 }));

    expect(result.calls.map((c) => c.ok)).toEqual([false, true]);
    expect(result.suggestions.map((s) => s.rowIndex)).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe('cost', () => {
  it('reports the token usage of every call', async () => {
    const model = modelReturning({ suggestions: [] }, { input: 4210, output: 618 });
    const result = await suggestWithAIDetailed([txn(0)], ctxWith(model));

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({
      batchIndex: 0,
      rowCount: 1,
      modelId: 'stub-model',
      inputTokens: 4210,
      outputTokens: 618,
      totalTokens: 4828,
      attempts: 1,
      ok: true,
      failure: null,
      costMicroUsd: null,
    });
    expect(result.calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('prices a call in exact integer micro-USD when the caller supplies a price', async () => {
    const model = modelReturning({ suggestions: [] }, { input: 4210, output: 618 });
    const result = await suggestWithAIDetailed(
      [txn(0)],
      ctxWith(model, { pricing: { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 5 } }),
    );

    // 4210 * 1 + 618 * 5 = 7300 micro-USD = $0.0073. Integers throughout.
    expect(result.calls[0].costMicroUsd).toBe(7300);
    expect(Number.isInteger(result.calls[0].costMicroUsd)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Degrading gracefully
// ---------------------------------------------------------------------------

describe('degrading gracefully', () => {
  const chart: Pick<AISuggestContext, 'accounts'> = { accounts: CHART };

  it('returns nothing when there is no key and no model', async () => {
    const ctx: AISuggestContext = { ...chart, apiKey: '', gatewayApiKey: '', modelId: 'anthropic/claude-haiku-4-5' };
    expect(resolveSuggestModel(ctx)).toBeNull();

    const result = await suggestWithAIDetailed([txn(0)], ctx);
    expect(result).toEqual({ suggestions: [], calls: [], discarded: [] });
  });

  it('survives a network failure and reports it', async () => {
    const model = modelThrowing(new TypeError('fetch failed'));
    const result = await suggestWithAIDetailed([txn(0)], ctxWith(model));

    expect(result.suggestions).toEqual([]);
    expect(result.calls[0].ok).toBe(false);
    expect(result.calls[0].failure?.kind).toBe('network');
  });

  it('survives a timeout and does not retry one', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'stub-model',
      doGenerate: ({ abortSignal }: LanguageModelV4CallOptions) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener('abort', () => {
            reject(abortSignal.reason);
          });
        }),
    });

    const result = await suggestWithAIDetailed([txn(0)], ctxWith(model, { timeoutMs: 25 }));

    expect(result.suggestions).toEqual([]);
    expect(result.calls[0].failure?.kind).toBe('timeout');
    expect(result.calls[0].attempts).toBe(1);
  });

  it('retries a 429 exactly once, then gives up', async () => {
    const model = modelThrowing(apiError(429));
    const result = await suggestWithAIDetailed([txn(0)], ctxWith(model));

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(result.suggestions).toEqual([]);
    expect(result.calls[0]).toMatchObject({ ok: false, attempts: 2 });
    expect(result.calls[0].failure).toMatchObject({ kind: 'rate_limit', statusCode: 429 });
  });

  it('retries a 5xx and keeps the answer when the retry works', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      modelId: 'stub-model',
      doGenerate: async () => {
        call += 1;
        if (call === 1) throw apiError(503);
        return objectResult({
          suggestions: [
            { rowIndex: 0, accountCode: '6310', vendorName: null, confidence: 0.9, reasoning: 'Formulation work.', needsHuman: false },
          ],
        });
      },
    });

    const result = await suggestWithAIDetailed([txn(0, { counterparty: 'FIRESTONE CONSUL' })], ctxWith(model));

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(result.calls[0]).toMatchObject({ ok: true, attempts: 2 });
    expect(result.suggestions[0].accountCode).toBe('6310');
  });

  it('does not retry a 4xx that will never succeed', async () => {
    const model = modelThrowing(apiError(401));
    const result = await suggestWithAIDetailed([txn(0)], ctxWith(model));

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(result.calls[0].failure).toMatchObject({ kind: 'unknown', statusCode: 401 });
  });

  it('survives a malformed response', async () => {
    const result = await suggestWithAIDetailed([txn(0)], ctxWith(modelReturningText('Sure! Here you go.')));

    expect(result.suggestions).toEqual([]);
    expect(result.calls[0].failure?.kind).toBe('invalid_response');
  });

  it('survives a response of the wrong shape', async () => {
    const result = await suggestWithAIDetailed([txn(0)], ctxWith(modelReturning({ answers: 'none' })));

    expect(result.suggestions).toEqual([]);
    expect(result.calls[0].failure?.kind).toBe('invalid_response');
  });

  it('never throws, whatever the model does', async () => {
    const models = [
      modelThrowing(new Error('boom')),
      modelThrowing('a string, not an error'),
      modelReturningText('{'),
      modelReturning({ suggestions: null }),
    ];
    for (const model of models) {
      await expect(suggestWithAI([txn(0)], ctxWith(model))).resolves.toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The Anthropic adapter
// ---------------------------------------------------------------------------

describe('the Anthropic adapter', () => {
  interface Captured {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }

  function stubFetch(
    respond: (captured: Captured) => { status: number; payload: unknown },
  ): { fetchImpl: typeof globalThis.fetch; calls: Captured[] } {
    const calls: Captured[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const captured: Captured = {
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(captured);
      const { status, payload } = respond(captured);
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { fetchImpl, calls };
  }

  const schema: JSONSchema7 = {
    type: 'object',
    properties: { suggestions: { type: 'array', items: { type: 'object' } } },
    required: ['suggestions'],
  };

  it('asks for structured output with a forced tool call', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      payload: {
        id: 'msg_1',
        model: 'claude-haiku-4-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'record_suggestions', input: { suggestions: [] } }],
        usage: { input_tokens: 2048, output_tokens: 96, cache_read_input_tokens: 512 },
      },
    }));

    const model = createAnthropicModel({ apiKey: 'sk-test', modelId: 'claude-haiku-4-5', fetchImpl });
    const result = await model.doGenerate({
      prompt: [
        { role: 'system', content: 'You are a bookkeeper.' },
        { role: 'user', content: [{ type: 'text', text: 'row 0' }] },
      ],
      responseFormat: { type: 'json', schema, name: 'BankTransactionSuggestions' },
      temperature: 0,
      maxOutputTokens: 4096,
    });

    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe('sk-test');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].body).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      temperature: 0,
      system: 'You are a bookkeeper.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'row 0' }] }],
      tool_choice: { type: 'tool', name: 'record_suggestions' },
    });
    expect(calls[0].body.tools).toEqual([
      expect.objectContaining({ name: 'record_suggestions', input_schema: schema }),
    ]);

    // The tool arguments come back as the text `generateObject` parses.
    expect(result.content).toEqual([{ type: 'text', text: '{"suggestions":[]}' }]);
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'tool_use' });
    expect(result.usage.inputTokens.total).toBe(2048);
    expect(result.usage.inputTokens.cacheRead).toBe(512);
    expect(result.usage.outputTokens.total).toBe(96);
  });

  it('marks a 429 and a 5xx retryable, and a 400 not', async () => {
    for (const [status, retryable] of [[429, true], [503, true], [400, false], [401, false]] as const) {
      const { fetchImpl } = stubFetch(() => ({ status, payload: { error: { message: 'nope' } } }));
      const model = createAnthropicModel({ apiKey: 'sk-test', modelId: 'claude-haiku-4-5', fetchImpl });
      let error: unknown = null;
      try {
        await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
      } catch (thrown) {
        error = thrown;
      }

      expect(APICallError.isInstance(error)).toBe(true);
      expect(APICallError.isInstance(error) && error.statusCode).toBe(status);
      expect(APICallError.isInstance(error) && error.isRetryable).toBe(retryable);
    }
  });

  it('drives a whole suggestion run end to end, with no network', async () => {
    const { fetchImpl, calls } = stubFetch((captured) => {
      const user = String(
        ((captured.body.messages as Array<{ content: Array<{ text: string }> }>)[0].content[0]).text,
      );
      const ids = [...user.matchAll(/^(\d+) \| /gm)].map((m) => Number(m[1]));
      return {
        status: 200,
        payload: {
          id: 'msg_2',
          model: 'claude-haiku-4-5',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'tu_2',
              name: 'record_suggestions',
              input: {
                suggestions: ids.map((rowIndex) => ({
                  rowIndex,
                  accountCode: '1320',
                  vendorName: 'Jedwards International',
                  confidence: 0.91,
                  reasoning: 'Bulk oils bought for formulation capitalize to raw ingredients.',
                  needsHuman: false,
                })),
              },
            },
          ],
          usage: { input_tokens: 3311, output_tokens: 140 },
        },
      };
    });

    const result = await suggestWithAIDetailed([txn(0, { counterparty: 'Jedwards International Inc.' })], {
      accounts: CHART,
      vendors: VENDORS,
      apiKey: 'sk-test',
      modelId: 'anthropic/claude-haiku-4-5',
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.model).toBe('claude-haiku-4-5');
    expect(result.suggestions).toEqual([
      {
        rowIndex: 0,
        accountCode: '1320',
        vendorName: 'Jedwards International',
        confidence: 0.91,
        reasoning: 'Bulk oils bought for formulation capitalize to raw ingredients.',
        needsHuman: false,
        autoPost: false,
        source: 'ai',
        modelId: 'anthropic/claude-haiku-4-5',
      },
    ]);
    expect(result.calls[0]).toMatchObject({ inputTokens: 3311, outputTokens: 140, totalTokens: 3451 });
  });
});

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

describe('resolveSuggestModel', () => {
  const chart = { accounts: CHART } as const;

  it('prefers an injected model', () => {
    const model = modelReturning({ suggestions: [] });
    expect(resolveSuggestModel({ ...chart, model })).toEqual({ model, modelId: 'stub-model' });
  });

  it('uses the gateway when its key is set, passing the provider-prefixed id through', () => {
    expect(
      resolveSuggestModel({ ...chart, gatewayApiKey: 'vck_test', modelId: 'anthropic/claude-haiku-4-5' }),
    ).toEqual({ model: 'anthropic/claude-haiku-4-5', modelId: 'anthropic/claude-haiku-4-5' });
  });

  it('falls back to a direct Anthropic call, stripping the provider prefix', () => {
    const resolved = resolveSuggestModel({
      ...chart,
      gatewayApiKey: '',
      apiKey: 'sk-test',
      modelId: 'anthropic/claude-haiku-4-5',
    });
    expect(resolved).not.toBeNull();
    expect(typeof resolved?.model).toBe('object');
    expect(resolved?.modelId).toBe('anthropic/claude-haiku-4-5');
    expect(typeof resolved?.model === 'object' && resolved.model.modelId).toBe('claude-haiku-4-5');
  });

  it('returns null for a provider it has no credential for', () => {
    expect(
      resolveSuggestModel({ ...chart, gatewayApiKey: '', apiKey: 'sk-test', modelId: 'openai/gpt-5' }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The one integration test
// ---------------------------------------------------------------------------

/**
 * Sends the ten genuinely ambiguous transactions out of this company's own bank
 * records — the Amazon charges, Target, Walmart and Dave's Hot Chicken — to the real
 * model, against the real 164-account chart of accounts and the real 32 vendors.
 *
 * Skipped unless `ANTHROPIC_API_KEY`, `DATABASE_URL` and the gitignored statements are
 * all present, because none of the three can be assumed on a fresh checkout.
 */
describe('integration: the real ambiguous transactions', () => {
  beforeAll(() => {
    loadEnvLocal();
  });

  const hasKey = (): boolean => {
    loadEnvLocal();
    return (process.env.ANTHROPIC_API_KEY ?? '').trim() !== '' || (process.env.AI_GATEWAY_API_KEY ?? '').trim() !== '';
  };
  const hasDb = (): boolean => {
    loadEnvLocal();
    return (process.env.DATABASE_URL ?? '').trim() !== '';
  };

  interface Live {
    accounts: PromptAccount[];
    vendors: PromptVendor[];
    txns: NormalizedTxn[];
  }

  async function loadLive(): Promise<Live> {
    const { parityClient, readRelay, RELAY_PROFILE, relayFilenames } = await import('./__fixtures__/support');
    const { applyProfile } = await import('./apply-profile');

    const sql = parityClient();
    try {
      const accountRows = await sql<
        Array<{
          code: string;
          name: string;
          description: string | null;
          type: string;
          subtype: string | null;
          is_bank: boolean;
          is_control: boolean;
          active: boolean;
          postable: boolean;
        }>
      >`
        select a.code, a.name, a.description, a.type::text as type, a.subtype,
               a.is_bank, a.is_control, a.active,
               not exists (select 1 from accounts c where c.parent_id = a.id) as postable
        from accounts a
        order by a.code
      `;
      const vendorRows = await sql<
        Array<{ name: string; default_account_code: string | null; notes: string | null; aliases: string[] }>
      >`
        select v.name,
               acc.code as default_account_code,
               v.notes,
               coalesce(array_remove(array_agg(al.alias), null), '{}') as aliases
        from vendors v
        left join accounts acc on acc.id = v.default_expense_account_id
        left join vendor_aliases al on al.vendor_id = v.id
        group by v.name, acc.code, v.notes
        order by v.name
      `;

      const accounts: PromptAccount[] = accountRows.map((row) => ({
        code: row.code,
        name: row.name,
        description: row.description,
        type: row.type,
        subtype: row.subtype,
        postable: row.postable,
        isBank: row.is_bank,
        isControl: row.is_control,
        active: row.active,
      }));
      const vendors: PromptVendor[] = vendorRows.map((row) => ({
        name: row.name,
        defaultAccountCode: row.default_account_code,
        notes: row.notes,
        aliases: row.aliases,
      }));

      const ambiguous = /^(amazon|target|walmart|daveshotchicken)$/i;
      const txns: NormalizedTxn[] = [];
      for (const filename of relayFilenames()) {
        const parsed = applyProfile(await readRelay(filename), RELAY_PROFILE);
        for (const row of parsed.rows) {
          if (!row.usable) continue;
          if (!ambiguous.test((row.counterparty ?? '').trim())) continue;
          // rowIndex is only unique within a file; renumber across the corpus.
          txns.push({ ...row, rowIndex: txns.length });
        }
      }

      return { accounts, vendors, txns: txns.slice(0, 10) };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  it.skipIf(!hasDb())('seeds the always-review list from the live vendor notes', async () => {
    const { vendors } = await loadLive();
    const terms = alwaysReviewTerms(vendors);

    // Nothing in this module names Amazon. It is on the list because the owner wrote
    // "Never auto-categorize." on the vendor record.
    expect(terms).toContain('AMAZON');
    const amazon = vendors.find((v) => v.name === 'Amazon');
    expect(amazon?.notes ?? '').toMatch(/Never auto-categorize/i);
  }, 60_000);

  it.skipIf(!hasKey() || !hasDb())(
    'validates and survives every guardrail against the live model',
    async () => {
      const { accounts, vendors, txns } = await loadLive();
      expect(txns).toHaveLength(10);

      const result = await suggestWithAIDetailed(txns, {
        accounts,
        vendors,
        timeoutMs: 60_000,
        retryDelayMs: 1_000,
      });

      const report = {
        model: result.calls[0]?.modelId ?? null,
        ok: result.calls.map((c) => c.ok),
        failures: result.calls.map((c) => c.failure),
        tokens: result.calls.map((c) => ({ in: c.inputTokens, out: c.outputTokens })),
        discarded: result.discarded,
        sent: txns.map((t) => ({ row: t.rowIndex, date: t.date, payee: t.counterparty, cents: t.amountCents })),
        suggestions: result.suggestions.map((s) => ({
          row: s.rowIndex,
          account: s.accountCode,
          vendor: s.vendorName,
          confidence: s.confidence,
          needsHuman: s.needsHuman,
          reasoning: s.reasoning,
        })),
      };
      // The point of this test is what the model actually said. Print it.
      process.stdout.write(`\n[ai-suggest integration]\n${JSON.stringify(report, null, 2)}\n`);
      if (result.calls[0]?.ok !== true) {
        // Say so loudly. A green tick here would otherwise read as "the model was
        // checked", when in fact the provider was never reached and the guardrails
        // below were asserted against an empty list.
        process.stdout.write(
          `[ai-suggest integration] MODEL NOT REACHED — ${result.calls[0]?.failure?.kind ?? 'no call'}. ` +
            'The guardrails were not exercised against a live answer; only the degradation path was.\n',
        );
      }

      // One call, because ten rows is one batch.
      expect(result.calls).toHaveLength(1);

      const byCode = new Map(accounts.map((a) => [a.code, a]));
      const sentRows = new Set(txns.map((t) => t.rowIndex));
      const seen = new Set<number>();

      for (const suggestion of result.suggestions) {
        // Every guardrail, restated as an assertion against a live answer.
        expect(sentRows.has(suggestion.rowIndex)).toBe(true);
        expect(seen.has(suggestion.rowIndex)).toBe(false);
        seen.add(suggestion.rowIndex);

        const account = byCode.get(suggestion.accountCode);
        expect(account, `account ${suggestion.accountCode}`).toBeDefined();
        expect(account?.active).toBe(true);
        expect(account?.postable).toBe(true);
        expect(account?.isBank).toBe(false);
        expect(account?.isControl).toBe(false);

        expect(suggestion.confidence).toBeGreaterThanOrEqual(0);
        expect(suggestion.confidence).toBeLessThanOrEqual(1);
        expect(suggestion.reasoning.trim()).not.toBe('');
        expect(suggestion.autoPost).toBe(false);
        expect(suggestion.source).toBe('ai');

        if (suggestion.confidence < DEFAULT_CONFIDENCE_FLOOR) {
          expect(suggestion.needsHuman).toBe(true);
        }

        const payee = (txns.find((t) => t.rowIndex === suggestion.rowIndex)?.counterparty ?? '').toUpperCase();
        if (payee.includes('AMAZON')) {
          // The most important assertion in this file: however sure the model is,
          // an Amazon charge goes to a human.
          expect(suggestion.needsHuman).toBe(true);
        }
      }

      // And if the model was unreachable, the import still got a usable answer.
      if (!result.calls[0].ok) {
        expect(result.suggestions).toEqual([]);
      }
    },
    180_000,
  );
});

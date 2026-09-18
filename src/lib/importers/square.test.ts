/**
 * Square settlement importer tests.
 *
 * Two kinds of data meet here and they must not be confused:
 *
 *   - **The Square side is synthetic.** No real Square export exists yet. The
 *     `square-*.csv` fixtures are built from the inferred column contract in
 *     `docs/formats/square.md` §4a and the identities in §6. They prove the
 *     parser does what this repository says it does; they cannot prove Square
 *     writes files that shape. §11 of that document is the real gate.
 *   - **The bank side is real.** The seven Relay rows in `RELAY_SQUARE_ROWS` are
 *     transcribed verbatim from `data/statements/relay/Relay 2026-0{1,2,8}-01
 *     #9726.csv` — the actual Square deposits into Sooz's operating account.
 *     They are the only real Square-related data in the system, they total
 *     $272.00, and `matchSquarePayoutToBankTransaction` is tested against them.
 *
 * The fixture net totals are chosen to equal the real deposit totals, so the two
 * halves can be tested against each other end to end.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readFile } from '@/lib/banking/read-file';
import type { ParsedFile } from '@/lib/banking/types';
import { parseMoney } from '@/lib/money';

import {
  assertSettlementBalances,
  buildSquareClearingEntry,
  detectSquareSettlements,
  matchSquarePayoutToBankTransaction,
  parseSquareBankReference,
  parseSquareSettlements,
  previewSquareSettlements,
  settlementKey,
  squareBankReference,
  SquareFormatError,
  SquareSettlementNotBalancedError,
  SQUARE_COMPONENT_ACCOUNT_ROLE,
  SQUARE_IMPORTER_ID,
  type BankTransactionCandidate,
  type SquareParseOptions,
  type SquareSettlement,
} from './square';

const FIXTURES = join(__dirname, '__fixtures__');

function readFixture(name: string): Promise<ParsedFile> {
  return readFile(readFileSync(join(FIXTURES, name)), name);
}

function readInline(text: string, filename = 'inline.csv'): Promise<ParsedFile> {
  return readFile(Buffer.from(text, 'utf8'), filename);
}

async function parseFixture(
  name: string,
  options: SquareParseOptions = {},
): Promise<ReturnType<typeof parseSquareSettlements>> {
  return parseSquareSettlements(await readFixture(name), options);
}

function bySettlement(settlements: readonly SquareSettlement[]): Map<string, SquareSettlement> {
  return new Map(settlements.map((settlement) => [settlement.bankReference, settlement]));
}

// ---------------------------------------------------------------------------
// The real bank side
// ---------------------------------------------------------------------------

/**
 * The seven real Square deposits into Relay #9726, January–August 2026.
 *
 * Transcribed from the statement files. Note 2026-01-26: **three** rows share
 * the reference `SQ260126`, summing to $165.74. One Square batch, three ACH
 * credits. This is the case that breaks any one-payout-to-one-deposit matcher.
 */
const RELAY_SQUARE_ROWS: readonly BankTransactionCandidate[] = Object.freeze([
  { id: 'relay-1', date: '2026-01-26', amountCents: 16167, reference: 'SQ260126' },
  { id: 'relay-2', date: '2026-01-26', amountCents: 325, reference: 'SQ260126' },
  { id: 'relay-3', date: '2026-01-26', amountCents: 82, reference: 'SQ260126' },
  { id: 'relay-4', date: '2026-02-02', amountCents: 6770, reference: 'SQ260202' },
  { id: 'relay-5', date: '2026-02-11', amountCents: 1041, reference: 'SQ260211' },
  { id: 'relay-6', date: '2026-02-17', amountCents: 1434, reference: 'SQ260217' },
  { id: 'relay-7', date: '2026-08-31', amountCents: 1381, reference: 'SQ260831' },
]);

/**
 * Real rows from the same statements that must never be matched to a payout.
 *
 * `acctverify-*` are the two genuine `Square Inc` rows of 2026-01-20: the
 * micro-deposit pair Square sends to verify a newly linked bank account. Same
 * payee as every payout, no `SQ` code, netting to zero. They are why the match
 * is keyed on the reference and not on the payee.
 */
const RELAY_NOISE_ROWS: readonly BankTransactionCandidate[] = Object.freeze([
  { id: 'noise-1', date: '2026-01-26', amountCents: 900, reference: 'ACH Pull' },
  { id: 'noise-2', date: '2026-01-26', amountCents: -899, reference: 'Corporate Card - 1892' },
  { id: 'noise-3', date: '2026-01-26', amountCents: -2969, reference: 'Corporate Card - 1892' },
  { id: 'noise-4', date: '2026-02-02', amountCents: -1338, reference: 'Corporate Card - 1892' },
  { id: 'noise-5', date: '2026-08-31', amountCents: -800, reference: 'Banking Fees' },
  {
    id: 'acctverify-out',
    date: '2026-01-20',
    amountCents: -1,
    reference: 'ACCTVERIFY - Initiated By Unknown Payee',
  },
  { id: 'acctverify-in', date: '2026-01-20', amountCents: 1, reference: 'ACCTVERIFY' },
]);

const ALL_RELAY_ROWS: readonly BankTransactionCandidate[] = Object.freeze([
  ...RELAY_SQUARE_ROWS,
  ...RELAY_NOISE_ROWS,
]);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('detectSquareSettlements', () => {
  it('accepts the settlement export and names what it recognised', async () => {
    const result = detectSquareSettlements(await readFixture('square-settlements.csv'));

    expect(result.ok).toBe(true);
    expect(result.importerId).toBe(SQUARE_IMPORTER_ID);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.fields.settlement_date).toBe('Settlement Date');
    expect(result.fields.net_total).toBe('Net Total');
    expect(result.fields.discounts).toBe('Discounts & Comps');
    expect(result.reasons.join(' ')).toContain('Net Total');
    expect(result.rejection).toBeUndefined();
  });

  it('resolves alias spellings, case and punctuation', async () => {
    const result = detectSquareSettlements(await readFixture('square-settlements-messy.csv'));

    expect(result.ok).toBe(true);
    expect(result.fields.settlement_date).toBe('Payout Date');
    expect(result.fields.settlement_id).toBe('Payout ID');
    expect(result.fields.net_total).toBe('Payout Amount');
    expect(result.fields.gross_sales).toBe('Gross');
    expect(result.fields.returns).toBe('Refunds');
    expect(result.fields.fees).toBe('Fee');
    expect(result.fields.net_sales).toBe('Net Sale');
    expect(result.fields.total_collected).toBe('Total');
  });

  it('rejects the per-payment Transactions CSV by name, with a remedy', async () => {
    const result = detectSquareSettlements(await readFixture('square-transactions.csv'));

    expect(result.ok).toBe(false);
    expect(result.rejection?.code).toBe('square.wrong_report.transactions_csv');
    expect(result.rejection?.message).toContain('one row per payment');
    expect(result.rejection?.remedy).toContain('Transfers report');
    expect(result.warnings.some((warning) => warning.severity === 'fatal')).toBe(true);
  });

  it('accepts per-payment rows when the file says which payout they belong to', async () => {
    const parsed = await readInline(
      [
        'Date,Deposit ID,Transaction ID,Payment ID,Gross Sales,Tax,Total Collected,Fees,Net Total',
        '2026-01-24,dep_1,txn_a,pmt_a,12.00,0.96,12.96,-0.44,12.52',
        '2026-01-24,dep_1,txn_b,pmt_b,150.00,11.72,161.72,-4.50,157.22',
      ].join('\n'),
    );
    const result = detectSquareSettlements(parsed);

    expect(result.ok).toBe(true);
    expect(result.fields.settlement_id).toBe('Deposit ID');

    // Two payment rows collapse into one settlement and its identity still ties.
    const settlements = parseSquareSettlements(parsed).settlements;
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.key).toBe('x:dep_1');
    expect(settlements[0]?.reportedNetCents).toBe(16974);
    expect(assertSettlementBalances(settlements[0] as SquareSettlement).ok).toBe(true);
  });

  it('rejects a file with no payout total rather than guessing one', async () => {
    const parsed = await readInline('Settlement Date,Gross Sales,Tax\n2026-01-26,10.00,0.80\n');
    const result = detectSquareSettlements(parsed);

    expect(result.ok).toBe(false);
    expect(result.rejection?.code).toBe('square.missing_required_columns');
    expect(result.rejection?.message).toContain('Net Total');
    expect(() => parseSquareSettlements(parsed)).toThrow(SquareFormatError);
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseSquareSettlements', () => {
  it('reads the five settlements and their bank references', async () => {
    const parsed = await parseFixture('square-settlements.csv');

    expect(parsed.rowCount).toBe(5);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.settlements.map((settlement) => settlement.date)).toEqual([
      '2026-01-26',
      '2026-02-02',
      '2026-02-11',
      '2026-02-17',
      '2026-08-31',
    ]);
    expect(parsed.settlements.map((settlement) => settlement.bankReference)).toEqual([
      'SQ260126',
      'SQ260202',
      'SQ260211',
      'SQ260217',
      'SQ260831',
    ]);
    expect(parsed.settlements.map((settlement) => settlement.reportedNetCents)).toEqual([
      16574, 6770, 1041, 1434, 1381,
    ]);
  });

  it('totals exactly the $272.00 that reached the bank', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    const total = parsed.settlements.reduce(
      (sum, settlement) => sum + settlement.reportedNetCents,
      0,
    );

    expect(total).toBe(27200);
    expect(total).toBe(RELAY_SQUARE_ROWS.reduce((sum, row) => sum + row.amountCents, 0));
  });

  it('decomposes a settlement into components and keeps derived columns separate', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    const jan = bySettlement(parsed.settlements).get('SQ260126');

    expect(jan?.componentCents).toEqual({
      gross_sales: 16200,
      returns: 0,
      partial_refunds: 0,
      discounts: -400,
      service_charges: 0,
      gift_card_sales: 0,
      tax: 1268,
      tip: 0,
      fees: -494,
      other: 0,
    });
    // Derived: read for the identity, never a component and never posted.
    expect(jan?.netSalesCents).toBe(15800);
    expect(jan?.totalCollectedCents).toBe(17068);
    expect(jan?.lines.map((line) => line.component)).not.toContain('net_sales');
  });

  it('reads tips, service charges and partial refunds on the August settlement', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    const aug = bySettlement(parsed.settlements).get('SQ260831');

    expect(aug?.componentCents.service_charges).toBe(50);
    expect(aug?.componentCents.tip).toBe(100);
    expect(aug?.componentCents.partial_refunds).toBe(-250);
    expect(aug?.componentCents.discounts).toBe(-100);
    expect(aug?.reportedNetCents).toBe(1381);
  });

  it('tags every component line with its semantic account role', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    const aug = bySettlement(parsed.settlements).get('SQ260831');
    const roles = new Map(aug?.lines.map((line) => [line.component, line.accountRole]));

    expect(roles.get('gross_sales')).toBe('square_sales');
    expect(roles.get('tax')).toBe('sales_tax_payable');
    expect(roles.get('fees')).toBe('payment_processing_fees');
    expect(roles.get('discounts')).toBe('coupons_and_promotions');
    expect(roles.get('partial_refunds')).toBe('returns_and_allowances');
    expect(roles.get('tip')).toBe('other_sales_income');
    expect(SQUARE_COMPONENT_ACCOUNT_ROLE.other).toBe('ask_my_accountant');
  });

  it('absorbs a BOM, dollar signs, thousands separators and parenthesised negatives', async () => {
    const parsed = await parseFixture('square-settlements-messy.csv');
    const april = parsed.settlements.find((settlement) => settlement.date === '2026-04-06');

    expect(april?.componentCents.gross_sales).toBe(124000);
    expect(april?.componentCents.returns).toBe(-4000);
    expect(april?.componentCents.discounts).toBe(-6000);
    expect(april?.componentCents.fees).toBe(-3411);
    expect(april?.reportedNetCents).toBe(119709);
    // The date cell carried a clock; a ledger only ever wants the calendar date.
    expect(april?.date).toBe('2026-04-06');
    expect(april?.currency).toBe('USD');
  });

  it('keeps an unrecognised money column instead of dropping it', async () => {
    const parsed = await parseFixture('square-settlements-messy.csv');
    const withOther = parsed.settlements.find((settlement) => settlement.date === '2026-04-13');

    expect(parsed.unmappedColumns).toEqual([
      { header: 'Bitcoin Conversion', count: 3, amountCents: -2500 },
    ]);
    expect(withOther?.componentCents.other).toBe(-2500);
    expect(
      parsed.warnings.some((warning) => warning.code === 'header.unknown_money_column'),
    ).toBe(true);
    // Kept, so the payout identity still ties.
    expect(assertSettlementBalances(withOther as SquareSettlement).ok).toBe(true);
  });

  it('reports the columns the file did not carry rather than treating them as zero', async () => {
    const parsed = await parseFixture('square-settlements-messy.csv');

    expect(parsed.absentColumns).toContain('service_charges');
    expect(parsed.absentColumns).toContain('gift_card_sales');
    expect(parsed.absentColumns).toContain('partial_refunds');
    expect(parsed.absentColumns).not.toContain('gross_sales');
  });

  it('skips an all-zero row without blocking the file', async () => {
    const parsed = await parseFixture('square-settlements-messy.csv');

    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0]?.code).toBe('row.no_amounts');
    expect(previewSquareSettlements(parsed).blockingSkippedRows).toBe(0);
    expect(previewSquareSettlements(parsed).ok).toBe(true);
  });

  it('skips an unreadable row, and that one does block the file', async () => {
    const parsed = parseSquareSettlements(
      await readInline(
        [
          'Settlement Date,Gross Sales,Tax,Total Collected,Fees,Net Total',
          '2026-05-04,100.00,8.00,108.00,-3.00,105.00',
          'not-a-date,50.00,4.00,54.00,-1.50,52.50',
        ].join('\n'),
      ),
    );

    expect(parsed.settlements).toHaveLength(1);
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0]?.code).toBe('date.unparsable');

    const preview = previewSquareSettlements(parsed);
    expect(preview.blockingSkippedRows).toBe(1);
    expect(preview.ok).toBe(false);
  });

  it('groups per-payment rows into one settlement by settlement id', async () => {
    const parsed = parseSquareSettlements(
      await readInline(
        [
          'Payout Date,Payout ID,Gross Sales,Tax,Total Collected,Fees,Net Total',
          '2026-02-01,po_1,40.00,3.20,43.20,-1.22,41.98',
          '2026-02-02,po_1,25.00,2.00,27.00,-0.80,26.20',
        ].join('\n'),
      ),
    );

    expect(parsed.settlements).toHaveLength(1);
    const settlement = parsed.settlements[0] as SquareSettlement;
    expect(settlement.componentCents.gross_sales).toBe(6500);
    expect(settlement.reportedNetCents).toBe(6818);
    // A settlement spanning dates keeps the earliest; the match window covers the rest.
    expect(settlement.date).toBe('2026-02-01');
    expect(settlement.rowIndexes).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

describe('fingerprints', () => {
  it('is deterministic across two parses of the same file', async () => {
    const first = await parseFixture('square-settlements.csv');
    const second = await parseFixture('square-settlements.csv');

    expect(first.settlements.map((settlement) => settlement.key)).toEqual(
      second.settlements.map((settlement) => settlement.key),
    );
    expect(first.settlements[0]?.lines.map((line) => line.fingerprint)).toEqual(
      second.settlements[0]?.lines.map((line) => line.fingerprint),
    );
  });

  it('gives every settlement and every line its own key', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    const keys = parsed.settlements.map((settlement) => settlement.key);
    const lines = parsed.settlements.flatMap((settlement) =>
      settlement.lines.map((line) => line.fingerprint),
    );

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('short-circuits to the native id when the file carries one', async () => {
    const parsed = await parseFixture('square-settlements-messy.csv');

    expect(parsed.settlements.map((settlement) => settlement.key)).toEqual([
      'x:sqpay_2026_0406_A1',
      'x:sqpay_2026_0413_B2',
    ]);
    expect(settlementKey('sqpay_1', 'USD', '2026-01-26', 16574)).toBe('x:sqpay_1');
  });

  it('hashes date, currency and total when there is no native id', () => {
    const key = settlementKey(null, 'USD', '2026-01-26', 16574);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(settlementKey(null, 'USD', '2026-01-26', 16575));
    expect(key).not.toBe(settlementKey(null, 'USD', '2026-01-27', 16574));
    expect(key).not.toBe(settlementKey(null, 'CAD', '2026-01-26', 16574));
    // Currency case is not a difference; the payout is the same payout.
    expect(key).toBe(settlementKey(null, 'usd', '2026-01-26', 16574));
  });
});

// ---------------------------------------------------------------------------
// The identity
// ---------------------------------------------------------------------------

describe('assertSettlementBalances', () => {
  it('ties every settlement in the happy-path fixture, to the cent', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    const reports = parsed.settlements.map(assertSettlementBalances);

    for (const report of reports) {
      expect(report.ok).toBe(true);
      expect(report.diagnosis).toBe('ties');
      expect(report.differenceCents).toBe(0);
      expect(report.assertions.every((assertion) => assertion.passed)).toBe(true);
      expect(report.assertions.map((assertion) => assertion.id)).toEqual([
        'square.net_sales',
        'square.total_collected',
        'square.net_total',
      ]);
    }
  });

  it('marks the payout identity fatal and the derived ones warn', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    const report = assertSettlementBalances(parsed.settlements[0] as SquareSettlement);
    const severities = new Map(
      report.assertions.map((assertion) => [assertion.id, assertion.severity]),
    );

    expect(severities.get('square.net_total')).toBe('fatal');
    expect(severities.get('square.net_sales')).toBe('warn');
    expect(severities.get('square.total_collected')).toBe('warn');
  });

  it('rejects a settlement that does not tie and reports the difference', async () => {
    const parsed = await parseFixture('square-settlements-unbalanced.csv');
    const [good, bad] = parsed.settlements.map(assertSettlementBalances);

    expect(good?.ok).toBe(true);
    expect(bad?.ok).toBe(false);
    expect(bad?.diagnosis).toBe('off_by');
    // Components compute $84.05; the file reports a payout of $84.18.
    expect(bad?.differenceCents).toBe(-13);
    expect(bad?.message).toContain('$84.05');
    expect(bad?.message).toContain('$84.18');
    expect(bad?.message).toContain('-$0.13');
    expect(bad?.message).toContain('never plug the difference');

    const fatal = bad?.assertions.find((assertion) => assertion.id === 'square.net_total');
    expect(fatal?.passed).toBe(false);
    expect(fatal?.expectedCents).toBe(8418);
    expect(fatal?.actualCents).toBe(8405);
  });

  it('diagnoses an inverted sign convention instead of silently mirroring the entry', async () => {
    const parsed = await parseFixture('square-settlements-positive-outflows.csv');
    const reports = parsed.settlements.map(assertSettlementBalances);

    expect(reports.map((report) => report.ok)).toEqual([false, false]);
    expect(reports.map((report) => report.diagnosis)).toEqual([
      'ties_if_outflows_negated',
      'ties_if_outflows_negated',
    ]);
    expect(reports[0]?.message).toContain('outflowsArePositive: true');
    expect(reports[0]?.message).toContain('docs/formats/square.md');
  });

  it('ties that same file once told the outflows are positive', async () => {
    const parsed = await parseFixture('square-settlements-positive-outflows.csv', {
      outflowsArePositive: true,
    });
    const reports = parsed.settlements.map(assertSettlementBalances);

    expect(reports.every((report) => report.ok)).toBe(true);
    expect(parsed.settlements.map((settlement) => settlement.componentCents.discounts)).toEqual([
      -400, -100,
    ]);
    expect(parsed.settlements.map((settlement) => settlement.componentCents.fees)).toEqual([
      -494, -47,
    ]);
    // And the payouts are the real deposits again.
    expect(parsed.settlements.map((settlement) => settlement.reportedNetCents)).toEqual([
      16574, 1381,
    ]);
  });

  it('diagnoses an unmapped column that turns out not to be a component', async () => {
    const parsed = parseSquareSettlements(
      await readInline(
        [
          'Settlement Date,Gross Sales,Tax,Total Collected,Fees,Net Total,Running Balance',
          '2026-05-04,100.00,8.00,108.00,-3.00,105.00,"1,234.56"',
        ].join('\n'),
      ),
    );
    const report = assertSettlementBalances(parsed.settlements[0] as SquareSettlement);

    expect(report.ok).toBe(false);
    expect(report.diagnosis).toBe('ties_without_unmapped');
    expect(report.message).toContain('$1,234.56');
    expect(report.message).toContain('alias table');
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe('previewSquareSettlements', () => {
  it('summarises the happy-path file and clears it to post', async () => {
    const preview = previewSquareSettlements(await parseFixture('square-settlements.csv'));

    expect(preview.ok).toBe(true);
    expect(preview.importerId).toBe(SQUARE_IMPORTER_ID);
    expect(preview.settlementCount).toBe(5);
    expect(preview.rowCount).toBe(5);
    expect(preview.failedSettlements).toBe(0);
    expect(preview.needsReview).toBe(0);
    expect(preview.dateRange).toEqual({ min: '2026-01-26', max: '2026-08-31' });
    expect(preview.netTotalCents).toBe(27200);
    expect(preview.fileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('totals each component across the file', async () => {
    const preview = previewSquareSettlements(await parseFixture('square-settlements.csv'));
    const totals = new Map(
      preview.byComponent.map((component) => [component.component, component.amountCents]),
    );

    expect(totals.get('gross_sales')).toBe(16200 + 6445 + 1000 + 2000 + 1500);
    expect(totals.get('returns')).toBe(-600);
    expect(totals.get('discounts')).toBe(-500);
    expect(totals.get('tax')).toBe(1268 + 516 + 79 + 93 + 128);
    expect(totals.get('fees')).toBe(-494 - 191 - 38 - 59 - 47);
    expect(totals.get('tip')).toBe(100);

    // Gross less every deduction is exactly what reached the bank.
    const everything = preview.byComponent.reduce(
      (sum, component) => sum + component.amountCents,
      0,
    );
    expect(everything).toBe(preview.netTotalCents);
  });

  it('blocks a file whose settlement does not tie, and says why', async () => {
    const preview = previewSquareSettlements(
      await parseFixture('square-settlements-unbalanced.csv'),
    );

    expect(preview.ok).toBe(false);
    expect(preview.failedSettlements).toBe(1);
    expect(preview.needsReview).toBe(1);
    expect(preview.settlements.map((settlement) => settlement.ok)).toEqual([true, false]);
    expect(
      preview.warnings.filter((warning) => warning.code === 'settlement.identity_failed'),
    ).toHaveLength(1);
  });

  it('raises the sign convention to the whole file, not just the row', async () => {
    const preview = previewSquareSettlements(
      await parseFixture('square-settlements-positive-outflows.csv'),
    );

    expect(preview.ok).toBe(false);
    expect(
      preview.warnings.some((warning) => warning.code === 'settlement.outflow_sign'),
    ).toBe(true);
  });

  it('counts a settlement carrying an unmapped component as needing review', async () => {
    const preview = previewSquareSettlements(await parseFixture('square-settlements-messy.csv'));

    expect(preview.ok).toBe(true);
    expect(preview.failedSettlements).toBe(0);
    expect(preview.needsReview).toBe(1);
    expect(preview.unmappedColumns[0]?.header).toBe('Bitcoin Conversion');
  });
});

// ---------------------------------------------------------------------------
// The draft entry
// ---------------------------------------------------------------------------

describe('buildSquareClearingEntry', () => {
  it('debits clearing by exactly what the bank will deposit', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    const entry = buildSquareClearingEntry(
      bySettlement(parsed.settlements).get('SQ260126') as SquareSettlement,
    );
    const clearing = entry.lines.find((line) => line.accountRole === 'square_clearing');

    expect(clearing?.debitCents).toBe(16574);
    expect(clearing?.creditCents).toBe(0);
    expect(entry.bankReference).toBe('SQ260126');
    expect(entry.sourceType).toBe(SQUARE_IMPORTER_ID);
    expect(entry.date).toBe('2026-01-26');
  });

  it('books revenue gross and the fee as an expense, never net', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    const entry = buildSquareClearingEntry(
      bySettlement(parsed.settlements).get('SQ260126') as SquareSettlement,
    );
    const byRole = new Map(
      entry.lines.map((line) => [line.accountRole, { dr: line.debitCents, cr: line.creditCents }]),
    );

    expect(byRole.get('square_sales')).toEqual({ dr: 0, cr: 16200 });
    expect(byRole.get('payment_processing_fees')).toEqual({ dr: 494, cr: 0 });
    expect(byRole.get('coupons_and_promotions')).toEqual({ dr: 400, cr: 0 });
    expect(byRole.get('sales_tax_payable')).toEqual({ dr: 0, cr: 1268 });
    // Revenue is the gross $162.00, not the $165.74 the bank shows.
    expect(byRole.get('square_sales')?.cr).toBeGreaterThan(16574 - 494);
  });

  it('balances every settlement in the file', async () => {
    const parsed = await parseFixture('square-settlements.csv');

    for (const settlement of parsed.settlements) {
      const entry = buildSquareClearingEntry(settlement);
      expect(entry.totalDebitsCents).toBe(entry.totalCreditsCents);
      expect(entry.totalDebitsCents).toBeGreaterThan(0);
      for (const line of entry.lines) {
        expect(line.debitCents === 0 || line.creditCents === 0).toBe(true);
        expect(line.debitCents + line.creditCents).toBeGreaterThan(0);
      }
    }
  });

  it('routes an unmapped component to Ask My Accountant rather than guessing', async () => {
    const parsed = await parseFixture('square-settlements-messy.csv');
    const settlement = parsed.settlements.find(
      (candidate) => candidate.componentCents.other !== 0,
    ) as SquareSettlement;
    const entry = buildSquareClearingEntry(settlement);
    const suspense = entry.lines.find((line) => line.accountRole === 'ask_my_accountant');

    expect(suspense?.debitCents).toBe(2500);
    expect(entry.totalDebitsCents).toBe(entry.totalCreditsCents);
  });

  it('refuses to draft an entry for a settlement that does not tie', async () => {
    const parsed = await parseFixture('square-settlements-unbalanced.csv');
    const bad = parsed.settlements[1] as SquareSettlement;

    expect(() => buildSquareClearingEntry(bad)).toThrow(SquareSettlementNotBalancedError);
    try {
      buildSquareClearingEntry(bad);
    } catch (error) {
      expect(error).toBeInstanceOf(SquareSettlementNotBalancedError);
      expect((error as SquareSettlementNotBalancedError).report.differenceCents).toBe(-13);
    }
  });
});

// ---------------------------------------------------------------------------
// The SQ reference
// ---------------------------------------------------------------------------

describe('squareBankReference', () => {
  it('produces the code Relay actually stamps, for all five real payouts', () => {
    expect(squareBankReference('2026-01-26')).toBe('SQ260126');
    expect(squareBankReference('2026-02-02')).toBe('SQ260202');
    expect(squareBankReference('2026-02-11')).toBe('SQ260211');
    expect(squareBankReference('2026-02-17')).toBe('SQ260217');
    expect(squareBankReference('2026-08-31')).toBe('SQ260831');
  });

  it('round-trips every real reference back to its date', () => {
    for (const row of RELAY_SQUARE_ROWS) {
      const date = parseSquareBankReference(row.reference);
      expect(date).toBe(row.date);
      expect(squareBankReference(date as string)).toBe(row.reference);
    }
  });

  it('finds the code wherever the bank wraps it', () => {
    expect(parseSquareBankReference('SQ260126')).toBe('2026-01-26');
    expect(parseSquareBankReference('sq260126')).toBe('2026-01-26');
    expect(parseSquareBankReference('ACH CREDIT SQ260126 SQUARE INC')).toBe('2026-01-26');
  });

  it('returns null rather than a plausible wrong date', () => {
    expect(parseSquareBankReference(null)).toBeNull();
    expect(parseSquareBankReference('')).toBeNull();
    expect(parseSquareBankReference('ACH Pull')).toBeNull();
    expect(parseSquareBankReference('Corporate Card - 1892 (Business Card)')).toBeNull();
    // Month 13 and February 30 are not dates, and must not be coerced into one.
    expect(parseSquareBankReference('SQ261301')).toBeNull();
    expect(parseSquareBankReference('SQ260230')).toBeNull();
    // Too few and too many digits are not the code.
    expect(parseSquareBankReference('SQ26012')).toBeNull();
    expect(parseSquareBankReference('SQ2601260')).toBeNull();
  });

  it('refuses a date that is not a calendar date', () => {
    expect(() => squareBankReference('1/26/2026')).toThrow(/YYYY-MM-DD/);
  });
});

// ---------------------------------------------------------------------------
// The bank match — against the real Relay rows
// ---------------------------------------------------------------------------

describe('matchSquarePayoutToBankTransaction against the real Relay statements', () => {
  it('matches all three 2026-01-26 deposits to one payout', () => {
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:jan', depositDate: '2026-01-26', netCents: 16574 },
      ALL_RELAY_ROWS,
    );

    expect(match.status).toBe('matched');
    expect(match.matchedBy).toBe('reference');
    expect(match.matched.map((row) => row.id)).toEqual(['relay-1', 'relay-2', 'relay-3']);
    expect(match.matched.map((row) => row.amountCents)).toEqual([16167, 325, 82]);
    expect(match.matchedCents).toBe(16574);
    expect(match.differenceCents).toBe(0);
    expect(match.bankReference).toBe('SQ260126');
    expect(match.reason).toContain('3 deposits');
  });

  it('never matches the same-day ACH pull or card charges', () => {
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:jan', depositDate: '2026-01-26', netCents: 16574 },
      ALL_RELAY_ROWS,
    );

    // The +$9.00 CHASE COLLEGE pull on 2026-01-26 is a member contribution, not
    // Square revenue. It must not be considered, let alone matched.
    expect(match.considered.map((row) => row.id)).not.toContain('noise-1');
    expect(match.matched.map((row) => row.id)).not.toContain('noise-1');
  });

  it('never matches the real ACCTVERIFY micro-deposit pair', () => {
    // 2026-01-20: two genuine `Square Inc` rows, -$0.01 and +$0.01, verifying the
    // newly linked bank account. Same payee as every payout; no SQ code. A match
    // keyed on the payee would book a penny of phantom revenue.
    for (const payout of [
      { key: 'x:jan20', depositDate: '2026-01-20', netCents: 1 },
      { key: 'x:jan20-out', depositDate: '2026-01-20', netCents: -1 },
      { key: 'x:jan', depositDate: '2026-01-26', netCents: 16574 },
    ]) {
      const match = matchSquarePayoutToBankTransaction(payout, ALL_RELAY_ROWS);
      const ids = [...match.considered, ...match.matched].map((row) => row.id);
      expect(ids).not.toContain('acctverify-in');
      expect(ids).not.toContain('acctverify-out');
    }

    expect(parseSquareBankReference('ACCTVERIFY - Initiated By Unknown Payee')).toBeNull();
  });

  it('matches each of the four single-deposit payouts', () => {
    const payouts = [
      { key: 'x:feb02', depositDate: '2026-02-02', netCents: 6770, id: 'relay-4' },
      { key: 'x:feb11', depositDate: '2026-02-11', netCents: 1041, id: 'relay-5' },
      { key: 'x:feb17', depositDate: '2026-02-17', netCents: 1434, id: 'relay-6' },
      { key: 'x:aug31', depositDate: '2026-08-31', netCents: 1381, id: 'relay-7' },
    ];

    for (const payout of payouts) {
      const match = matchSquarePayoutToBankTransaction(payout, ALL_RELAY_ROWS);
      expect(match.status).toBe('matched');
      expect(match.matched.map((row) => row.id)).toEqual([payout.id]);
      expect(match.differenceCents).toBe(0);
    }
  });

  it('clears every real Square deposit when the whole fixture is matched through', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    const matches = parsed.settlements.map((settlement) =>
      matchSquarePayoutToBankTransaction(
        {
          key: settlement.key,
          depositDate: settlement.date,
          netCents: settlement.reportedNetCents,
        },
        ALL_RELAY_ROWS,
      ),
    );

    expect(matches.map((match) => match.status)).toEqual([
      'matched',
      'matched',
      'matched',
      'matched',
      'matched',
    ]);

    const matchedIds = matches.flatMap((match) => match.matched.map((row) => row.id)).sort();
    expect(matchedIds).toEqual(RELAY_SQUARE_ROWS.map((row) => row.id).sort());
    expect(matches.reduce((sum, match) => sum + match.matchedCents, 0)).toBe(27200);
  });

  it('picks the right subset when a stray deposit shares the code', () => {
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:jan', depositDate: '2026-01-26', netCents: 16574 },
      [...RELAY_SQUARE_ROWS, { id: 'stray', date: '2026-01-26', amountCents: 500, reference: 'SQ260126' }],
    );

    expect(match.status).toBe('matched');
    expect(match.matchedBy).toBe('reference_subset');
    expect(match.matched.map((row) => row.id)).toEqual(['relay-1', 'relay-2', 'relay-3']);
    expect(match.considered).toHaveLength(4);
  });

  it('refuses to choose when two subsets both tie', () => {
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:feb11', depositDate: '2026-02-11', netCents: 1041 },
      [
        { id: 'a', date: '2026-02-11', amountCents: 1041, reference: 'SQ260211' },
        { id: 'b', date: '2026-02-11', amountCents: 1041, reference: 'SQ260211' },
      ],
    );

    expect(match.status).toBe('ambiguous');
    expect(match.matched).toEqual([]);
    expect(match.alternatives).toHaveLength(2);
    expect(match.reason).toContain('will not pick one');
  });

  it('calls a short payout partial, with the amount still in transit', () => {
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:jan', depositDate: '2026-01-26', netCents: 17000 },
      ALL_RELAY_ROWS,
    );

    expect(match.status).toBe('partial');
    expect(match.matchedCents).toBe(16574);
    expect(match.differenceCents).toBe(426);
    expect(match.matched).toHaveLength(3);
    expect(match.reason).toContain('still in transit');
  });

  it('calls an over-covered payout unmatched rather than guessing a subset', () => {
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:jan', depositDate: '2026-01-26', netCents: 16000 },
      ALL_RELAY_ROWS,
    );

    expect(match.status).toBe('unmatched');
    expect(match.matched).toEqual([]);
    expect(match.matchedCents).toBe(16574);
    expect(match.reason).toContain('Two payouts');
  });

  it('reports a payout with no deposit at all', () => {
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:sep', depositDate: '2026-09-14', netCents: 5000 },
      ALL_RELAY_ROWS,
    );

    expect(match.status).toBe('unmatched');
    expect(match.considered).toEqual([]);
    expect(match.differenceCents).toBe(5000);
    expect(match.reason).toContain('has not landed');
  });

  it('finds a deposit whose code trails the settlement date', () => {
    // Square's close of day is 5 PM PT and nothing settles on a Saturday, so a
    // batch closed Friday 2026-02-13 lands Tuesday 2026-02-17 — Monday the 16th
    // was Presidents' Day. The real +$14.34 row is stamped SQ260217.
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:feb13', depositDate: '2026-02-13', netCents: 1434 },
      ALL_RELAY_ROWS,
    );

    expect(match.status).toBe('matched');
    expect(match.matched.map((row) => row.id)).toEqual(['relay-6']);
    expect(match.acceptedReferences).toContain('SQ260217');
    expect(match.bankReference).toBe('SQ260213');
  });

  it('does not reach past the lag window', () => {
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:feb13', depositDate: '2026-02-13', netCents: 1434 },
      ALL_RELAY_ROWS,
      { lagDays: 1 },
    );

    expect(match.status).toBe('unmatched');
    expect(match.considered).toEqual([]);
  });

  it('matches a negative payout against a bank debit', () => {
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:clawback', depositDate: '2026-05-04', netCents: -2500 },
      [
        { id: 'debit', date: '2026-05-04', amountCents: -2500, reference: 'SQ260504' },
        { id: 'credit', date: '2026-05-04', amountCents: 2500, reference: 'SQ260504' },
      ],
    );

    expect(match.status).toBe('matched');
    expect(match.matched.map((row) => row.id)).toEqual(['debit']);
  });

  it('expects no deposit for a payout that nets to zero', () => {
    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:zero', depositDate: '2026-05-04', netCents: 0 },
      ALL_RELAY_ROWS,
    );

    expect(match.status).toBe('unmatched');
    expect(match.reason).toContain('nets to zero');
  });

  it('will not brute-force an unreasonable number of candidates', () => {
    const many: BankTransactionCandidate[] = Array.from({ length: 16 }, (_, index) => ({
      id: `row-${index}`,
      date: '2026-01-26',
      amountCents: 100 + index,
      reference: 'SQ260126',
    }));

    const match = matchSquarePayoutToBankTransaction(
      { key: 'x:jan', depositDate: '2026-01-26', netCents: 300 },
      many,
    );

    expect(match.status).toBe('ambiguous');
    expect(match.reason).toContain('too many to search exhaustively');
  });
});

// ---------------------------------------------------------------------------
// The whole pipeline
// ---------------------------------------------------------------------------

describe('the settlement clears to zero against the real bank rows', () => {
  it('leaves Square Clearing at exactly nothing for every payout', async () => {
    const parsed = await parseFixture('square-settlements.csv');
    expect(previewSquareSettlements(parsed).ok).toBe(true);

    let clearingBalance = 0;

    for (const settlement of parsed.settlements) {
      // The settlement side: debit clearing by the payout's net.
      const entry = buildSquareClearingEntry(settlement);
      for (const line of entry.lines) {
        if (line.accountRole !== 'square_clearing') continue;
        clearingBalance += line.debitCents - line.creditCents;
      }

      // The bank side: each matched deposit credits clearing.
      const match = matchSquarePayoutToBankTransaction(
        {
          key: settlement.key,
          depositDate: settlement.date,
          netCents: settlement.reportedNetCents,
        },
        ALL_RELAY_ROWS,
      );
      expect(match.status).toBe('matched');
      for (const row of match.matched) clearingBalance -= row.amountCents;
    }

    expect(clearingBalance).toBe(0);
  });

  it('recognises the $272.00 the bank actually received', () => {
    const fromStatements = RELAY_SQUARE_ROWS.reduce((sum, row) => sum + row.amountCents, 0);

    expect(fromStatements).toBe(parseMoney('272.00'));
  });
});

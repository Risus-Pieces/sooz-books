/**
 * The settlement parsers and the entry builder, against the synthetic fixtures in
 * `docs/formats/` (copied to `./__fixtures__`). Pure: nothing here touches the database.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ACCOUNTS } from '@/lib/ledger/coa';
import { sumCents } from '@/lib/money';

import { roleOfLine } from './accounts';
import { parseAmazonSettlement } from './amazon';
import { ChannelError } from './errors';
import { parseFaireSettlements } from './faire';
import { type EntryLineInput, buildPayoutEntry } from './entry';
import { parseShopifyPayouts } from './shopify';
import { type ParsedSettlement, SettlementFormatError, type SettlementLineDraft } from './types';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))));
}

function text(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

const encode = (value: string) => new TextEncoder().encode(value);

function total(lines: readonly SettlementLineDraft[], predicate: (line: SettlementLineDraft) => boolean): number {
  return sumCents(lines.filter(predicate).map((line) => line.amountCents));
}

function entryInputs(settlement: ParsedSettlement): EntryLineInput[] {
  return settlement.lines.map((line, index) => ({
    lineNo: index + 1,
    lineType: line.lineType,
    amountCents: line.amountCents,
    description: line.label,
    recordedRole: line.role,
  }));
}

function entryFor(settlement: ParsedSettlement) {
  return buildPayoutEntry(entryInputs(settlement), {
    provider: settlement.provider,
    channelCode: null,
    channelId: null,
    memo: settlement.key,
  });
}

function sides(plan: ReturnType<typeof buildPayoutEntry>): { debits: number; credits: number } {
  return {
    debits: sumCents(plan.lines.map((l) => l.debitCents ?? 0)),
    credits: sumCents(plan.lines.map((l) => l.creditCents ?? 0)),
  };
}

function netOn(plan: ReturnType<typeof buildPayoutEntry>, code: string): number {
  return sumCents(plan.lines.filter((l) => l.accountCode === code).map((l) => (l.creditCents ?? 0) - (l.debitCents ?? 0)));
}

// ---------------------------------------------------------------------------
// Amazon
// ---------------------------------------------------------------------------

describe('Amazon settlement flat file v2', () => {
  const parsed = parseAmazonSettlement(fixture('amazon-settlement-22558491237.txt'), { filename: 'amazon.txt' });
  const [settlement] = parsed.settlements;

  it('asserts Σ amount == total-amount exactly, and pads the 23-field row', () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.rowCount).toBe(32);
    expect(settlement.key).toBe('22558491237');
    expect(settlement.reportedNetCents).toBe(368_02);
    const identity = settlement.assertions.find((a) => a.id === 'amazon.sum_equals_total');
    expect(identity).toMatchObject({ passed: true, expectedCents: 368_02, actualCents: 368_02, differenceCents: 0 });
    expect(total(settlement.lines, () => true)).toBe(368_02);
    expect(settlement).toMatchObject({ periodStart: '2026-03-02', periodEnd: '2026-03-16', depositDate: '2026-03-18', currency: 'USD' });
  });

  it('buckets every row class the research document works through (§7e)', () => {
    const lines = settlement.lines;
    expect(total(lines, (l) => l.role === 'channel_sales')).toBe(224_93);
    expect(total(lines, (l) => l.role === 'shipping_income')).toBe(5_99);
    expect(total(lines, (l) => l.role === 'liquidation_sales')).toBe(7_42);
    expect(total(lines, (l) => l.role === 'discounts_promotions')).toBe(-12_00);
    expect(total(lines, (l) => l.role === 'returns_allowances')).toBe(-29_99);
    expect(total(lines, (l) => l.role === 'selling_fees')).toBe(-29_23);
    expect(total(lines, (l) => l.role === 'platform_fees')).toBe(-39_99);
    expect(total(lines, (l) => l.role === 'fulfillment_fees' || l.role === 'storage_fees')).toBe(-125_12);
    expect(total(lines, (l) => l.role === 'advertising')).toBe(-84_25);
    expect(total(lines, (l) => l.role === 'reimbursement_income')).toBe(26_94);
    expect(total(lines, (l) => l.lineType === 'reserve_released')).toBe(612_87);
    expect(total(lines, (l) => l.lineType === 'reserve_held')).toBe(-189_55);
  });

  it('pairs facilitator tax into offsetting halves that never become Sooz-collected tax', () => {
    const facilitator = settlement.lines.filter((l) => l.lineType === 'facilitator_tax');
    expect(facilitator.map((l) => l.amountCents).sort((a, b) => a - b)).toEqual([-17_08, 17_08]);
    expect(settlement.lines.some((l) => l.role === 'sales_tax_payable')).toBe(false);
  });

  it('builds a balanced entry that debits clearing the net and never touches 2200', () => {
    const plan = entryFor(settlement);
    expect(plan.clearingAccountCode).toBe(ACCOUNTS.CLEARING_AMAZON);
    expect(plan.clearingCents).toBe(368_02);
    const { debits, credits } = sides(plan);
    expect(debits).toBe(credits);
    expect(plan.lines.some((l) => l.accountCode === ACCOUNTS.SALES_TAX_PAYABLE)).toBe(false);
    expect(plan.facilitatorGrossCents).toBe(34_16);
    expect(netOn(plan, ACCOUNTS.SALES_AMAZON)).toBe(224_93);
    expect(netOn(plan, ACCOUNTS.FBA_FEES)).toBe(-125_12);
    expect(netOn(plan, ACCOUNTS.ADS_AMAZON)).toBe(-84_25);
    expect(netOn(plan, ACCOUNTS.MISC_INCOME)).toBe(26_94);
    expect(netOn(plan, ACCOUNTS.OTHER_RECEIVABLES)).toBe(612_87 - 189_55);
  });

  it('keeps a zero-total settlement: the P&L is real even when no cash moves (§5c)', () => {
    const zero = parseAmazonSettlement(fixture('amazon-settlement-22558491999.txt'), { filename: 'zero.txt' });
    expect(zero.ok).toBe(true);
    const [s] = zero.settlements;
    expect(s.reportedNetCents).toBe(0);
    const plan = entryFor(s);
    expect(plan.clearingCents).toBe(0);
    expect(plan.lines.some((l) => l.accountCode === ACCOUNTS.CLEARING_AMAZON)).toBe(false);
    const { debits, credits } = sides(plan);
    expect(debits).toBe(credits);
  });

  it('refuses a truncated file: the identity fails and the file is not ok', () => {
    const body = text('amazon-settlement-22558491237.txt').split('\n');
    const truncated = body.filter((line) => !line.includes('Cost of Advertising')).join('\n');
    const result = parseAmazonSettlement(encode(truncated), { filename: 'truncated.txt' });
    expect(result.ok).toBe(false);
    const identity = result.settlements[0].assertions.find((a) => a.id === 'amazon.sum_equals_total');
    expect(identity).toMatchObject({ passed: false, differenceCents: 84_25 });
  });

  it('routes an unknown triple to Ask My Accountant rather than dropping it', () => {
    const body = text('amazon-settlement-22558491999.txt').replace('\tSubscription\t', '\tBrandNewFeeType\t');
    const result = parseAmazonSettlement(encode(body), { filename: 'new-fee.txt' });
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain('amazon.unmapped');
    const unmapped = result.settlements[0].lines.find((l) => l.label.includes('BrandNewFeeType'));
    expect(unmapped).toMatchObject({ lineType: 'other', role: 'ask_my_accountant', amountCents: -39_99 });
  });

  it('flags tax Amazon did not withhold as Sooz-collected, with no state', () => {
    const body = text('amazon-settlement-22558491999.txt')
      .split('\n')
      .filter((line) => !line.includes('MarketplaceFacilitatorTax-Principal'))
      .join('\n')
      .replace('0.00\tUSD', '4.95\tUSD');
    const result = parseAmazonSettlement(encode(body), { filename: 'residual.txt' });
    expect(result.ok).toBe(true);
    const residual = result.settlements[0].lines.find((l) => l.role === 'sales_tax_payable');
    expect(residual).toMatchObject({ amountCents: 4_95, jurisdiction: null, taxRegime: 'unknown' });
    expect(result.issues.map((i) => i.code)).toContain('amazon.tax_residual');
  });

  it('rejects V1 files, comma re-saves and web pages by name', () => {
    const v1 = text('amazon-settlement-22558491999.txt').replace('amount-type\tamount-description', 'shipment-fee-type\tshipment-fee-amount');
    expect(() => parseAmazonSettlement(encode(v1), { filename: 'v1.txt' })).toThrow(SettlementFormatError);
    const comma = text('amazon-settlement-22558491999.txt').replace(/\t/g, ',');
    expect(() => parseAmazonSettlement(encode(comma), { filename: 'resaved.csv' })).toThrow(/re-saved by a spreadsheet/);
    expect(() => parseAmazonSettlement(encode('<html><body>Sign in</body></html>'), { filename: 'x.txt' })).toThrow(/web page/);
  });
});

// ---------------------------------------------------------------------------
// Faire
// ---------------------------------------------------------------------------

describe('Faire payout summary', () => {
  it('locks the payout identity and splits the file into batches by payout date', async () => {
    const parsed = await parseFaireSettlements(fixture('faire-payout-summary.csv'), { filename: 'faire.csv' });
    expect(parsed.ok).toBe(true);
    expect(parsed.candidate).toBe('gross_order_total_shipping_reimbursed');
    expect(parsed.settlements.map((s) => [s.periodEnd, s.reportedNetCents])).toEqual([
      ['2026-08-04', 4385_56],
      ['2026-08-11', 8796_58],
      ['2026-08-18', 6559_37],
    ]);
    for (const s of parsed.settlements) {
      expect(s.assertions.every((a) => a.passed)).toBe(true);
      expect(total(s.lines, () => true)).toBe(s.reportedNetCents);
    }
  });

  it('recovers damages as the residual and never posts Faire-borne Insider fees or facilitator tax', async () => {
    const parsed = await parseFaireSettlements(fixture('faire-payout-summary.csv'), { filename: 'faire.csv' });
    const [first, , third] = parsed.settlements;
    expect(total(first.lines, (l) => l.lineType === 'refund')).toBe(-32_00);
    expect(total(third.lines, (l) => l.lineType === 'refund')).toBe(-(18_00 + 86_40));
    // Insider fees charged to the brand post; those charged to Faire (22.80 on row 2) do not.
    expect(total(first.lines, (l) => l.label === 'Insider Fees Charged to Brand')).toBe(-122_20);
    expect(first.lines.some((l) => l.label.includes('Charged to Faire'))).toBe(false);
    expect(parsed.settlements.flatMap((s) => s.lines).some((l) => l.role === 'sales_tax_payable' || l.role === 'facilitator_tax')).toBe(false);

    const plan = entryFor(first);
    expect(plan.clearingAccountCode).toBe(ACCOUNTS.CLEARING_FAIRE);
    expect(plan.clearingCents).toBe(4385_56);
    expect(netOn(plan, ACCOUNTS.SALES_WHOLESALE)).toBe(5140_00);
    const { debits, credits } = sides(plan);
    expect(debits).toBe(credits);
  });

  it('fails loudly when no payout formula holds', async () => {
    const body = text('faire-payout-summary.csv').replace('2026-08-04,1431.52,', '2026-08-04,1400.00,').replace('2026-08-04,2342.10,', '2026-08-04,2000.00,');
    const parsed = await parseFaireSettlements(encode(body), { filename: 'broken.csv' });
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.map((i) => i.code)).toContain('faire.identity_unresolved');
  });

  it('refuses a new, unmapped fee column and an Excel-mangled order number', async () => {
    const extra = text('faire-payout-summary.csv').replace('Ship with Faire', 'Ship with Faire,Mystery Fee');
    await expect(parseFaireSettlements(encode(extra), { filename: 'new-col.csv' })).rejects.toThrow(/Mystery Fee/);
    const mangled = text('faire-payout-summary.csv').replace('R9VX2C6B', '1.2E+08');
    await expect(parseFaireSettlements(encode(mangled), { filename: 'excel.csv' })).rejects.toThrow(/scientific notation/);
  });
});

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

describe('Shopify payouts', () => {
  const parse = (balance = fixture('shopify-balance-transactions-2026-09-14.csv'), orders: Uint8Array | null = fixture('shopify-orders-2026-09-10.csv')) =>
    parseShopifyPayouts({
      balance: { filename: 'balance.csv', bytes: balance },
      ...(orders === null ? {} : { orders: { filename: 'orders.csv', bytes: orders } }),
    });

  it('ties the payout to its control row and leaves pending rows out', async () => {
    const parsed = await parse();
    expect(parsed.ok).toBe(true);
    expect(parsed.settlements).toHaveLength(1);
    const [payout] = parsed.settlements;
    expect(payout.reportedNetCents).toBe(560_28);
    expect(payout.assertions.every((a) => a.passed)).toBe(true);
    expect(total(payout.lines, () => true)).toBe(560_28);
    expect(parsed.issues.map((i) => i.code)).toContain('shopify.pending_rows');
  });

  it('decomposes the charges into gross, discounts, shipping, tax and tip (§7e)', async () => {
    const [payout] = (await parse()).settlements;
    const lines = payout.lines;
    // Charges: 993.62 = gross − discounts + shipping + tax + tip. The CAD order converts at its own
    // implied rate; half-up rounding puts 289.01 in gross and 9.99 in tip where §7e shows 289.00 / 10.00.
    expect(total(lines, (l) => l.role === 'channel_sales')).toBe(968_01);
    expect(total(lines, (l) => l.role === 'discounts_promotions')).toBe(-66_37);
    expect(total(lines, (l) => l.lineType === 'tip')).toBe(9_99);
    expect(total(lines, (l) => l.role === 'payment_processing_fees')).toBe(-(35_18 + 15_00));
    expect(total(lines, (l) => l.role === 'platform_fees')).toBe(-139_90);
    expect(total(lines, (l) => l.role === 'outbound_shipping')).toBe(-89_39);
    // Refunds split from their orders: #0987 product 49.00, #1002 product 58.00.
    expect(total(lines, (l) => l.lineType === 'refund')).toBe(-107_00);
    // Disputes whose orders are not in the export go whole to contra-revenue, flagged.
    expect(total(lines, (l) => l.lineType === 'chargeback')).toBe(-72_40);
    expect(total(lines, (l) => l.lineType === 'chargeback_reversal')).toBe(48_75);
    expect(payout.issues.filter((i) => i.code === 'shopify.undecomposed')).toHaveLength(2);
  });

  it('tags tax by state, keeps Shop app tax as facilitator tax that nets to zero, and GST as foreign', async () => {
    const [payout] = (await parse()).settlements;
    const tax = payout.lines.filter((l) => l.role === 'sales_tax_payable');
    const byState = Object.fromEntries(tax.filter((l) => l.jurisdiction !== null).map((l) => [l.jurisdiction, l.amountCents]));
    // TX: 1.25 collected on #1002 and refunded in the same payout.
    expect(byState).toEqual({ NY: 9_45, CA: 19_40, IL: 3_65, WA: 9_00, AZ: -5_30 });
    expect(tax.find((l) => l.taxRegime === 'foreign')).toMatchObject({ amountCents: 20_57, jurisdiction: null });
    const facilitator = payout.lines.filter((l) => l.lineType === 'facilitator_tax');
    expect(facilitator.map((l) => l.amountCents).sort((a, b) => a - b)).toEqual([-11_72, 11_72]);
    expect(facilitator.every((l) => l.jurisdiction === 'CA')).toBe(true);

    const plan = entryFor(payout);
    const { debits, credits } = sides(plan);
    expect(debits).toBe(credits);
    expect(plan.clearingCents).toBe(560_28);
    // 2200 carries only what Sooz collected: 9.45 + 19.40 + 3.65 + 9.00 − 5.30 + 20.57 (GST).
    expect(netOn(plan, ACCOUNTS.SALES_TAX_PAYABLE)).toBe(56_77);
  });

  it('refuses a payout with a charge whose order is missing, an unknown type, or a broken Net', async () => {
    const noOrders = await parse(undefined, null);
    expect(noOrders.ok).toBe(false);
    expect(noOrders.settlements[0].issues.map((i) => i.code)).toContain('shopify.order_missing');

    const unknown = text('shopify-balance-transactions-2026-09-14.csv').replace(',billing_debit,', ',mystery_type,');
    const unknownParsed = await parse(encode(unknown));
    expect(unknownParsed.ok).toBe(false);
    expect(unknownParsed.issues.map((i) => i.code)).toContain('shopify.unknown_type');

    const broken = text('shopify-balance-transactions-2026-09-14.csv').replace('118.45,3.73,114.72', '118.45,3.73,114.27');
    const brokenParsed = await parse(encode(broken));
    expect(brokenParsed.ok).toBe(false);
    expect(brokenParsed.issues.map((i) => i.code)).toContain('shopify.net_identity');
  });
});

// ---------------------------------------------------------------------------
// The entry builder
// ---------------------------------------------------------------------------

describe('buildPayoutEntry', () => {
  const ctx = { provider: 'square' as const, channelCode: 'DTC', channelId: null, memo: 'test' };

  it('posts a Square settlement the way docs/formats/square.md §7d works it', () => {
    const plan = buildPayoutEntry(
      [
        { lineNo: 1, lineType: 'gross_sales', amountCents: 162_00, description: 'Gross Sales', recordedRole: 'square_sales' },
        { lineNo: 2, lineType: 'discount', amountCents: -4_00, description: 'Discounts & Comps', recordedRole: 'coupons_and_promotions' },
        { lineNo: 3, lineType: 'sales_tax_collected', amountCents: 12_68, description: 'Tax', recordedRole: 'sales_tax_payable' },
        { lineNo: 4, lineType: 'processing_fee', amountCents: -4_94, description: 'Fees', recordedRole: 'payment_processing_fees' },
      ],
      ctx,
    );
    expect(plan.clearingAccountCode).toBe(ACCOUNTS.CLEARING_SQUARE);
    const byCode = Object.fromEntries(plan.lines.map((l) => [l.accountCode, (l.debitCents ?? 0) - (l.creditCents ?? 0)]));
    expect(byCode).toEqual({
      [ACCOUNTS.CLEARING_SQUARE]: 165_74,
      [ACCOUNTS.SALES_SQUARE]: -162_00,
      [ACCOUNTS.COUPONS_AND_PROMOS]: 4_00,
      [ACCOUNTS.SALES_TAX_PAYABLE]: -12_68,
      [ACCOUNTS.PAYMENT_PROCESSING_FEES]: 4_94,
    });
  });

  it('refuses facilitator tax that does not net to zero', () => {
    expect(() =>
      buildPayoutEntry(
        [
          { lineNo: 1, lineType: 'gross_sales', amountCents: 100_00, description: null, recordedRole: null },
          { lineNo: 2, lineType: 'facilitator_tax', amountCents: 8_25, description: null, recordedRole: null },
        ],
        { ...ctx, provider: 'amazon', channelCode: 'AMAZON' },
      ),
    ).toThrow(ChannelError);
  });

  it('treats a facilitator line as facilitator tax whatever role text rides along', () => {
    expect(roleOfLine('facilitator_tax', 'sales_tax_payable')).toBe('facilitator_tax');
    expect(roleOfLine('sales_tax_collected', null)).toBe('sales_tax_payable');
    expect(roleOfLine('other', 'square_sales')).toBe('channel_sales');
    expect(roleOfLine('other', 'not-a-role')).toBe('ask_my_accountant');
  });

  it('refuses advertising outside Amazon rather than guessing an account', () => {
    expect(() =>
      buildPayoutEntry(
        [
          { lineNo: 1, lineType: 'gross_sales', amountCents: 10_00, description: null, recordedRole: null },
          { lineNo: 2, lineType: 'advertising', amountCents: -1_00, description: null, recordedRole: null },
        ],
        { ...ctx, provider: 'shopify' },
      ),
    ).toThrow(/advertising/);
  });
});

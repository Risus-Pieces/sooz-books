/**
 * Distributor remittance parser tests.
 *
 * Every fixture is SYNTHETIC and comes from docs/formats/distributor-deductions.md
 * §7.3 and §8 — Sooz has no distributor yet, so no real UNFI or KeHE file exists.
 * The fixtures prove the parser does what the specification says; the first real
 * export is the gate for the header aliases (§0).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readFile } from '@/lib/banking/read-file';
import type { ParsedFile } from '@/lib/banking/types';

import {
  type RemittanceRow,
  adviceArithmetic,
  isPostable,
  parseRemittance,
  remittancePaymentKey,
} from './remittance';

const FIXTURES = join(__dirname, '..', 'trade', '__fixtures__');

function fixture(name: string): Promise<ParsedFile> {
  return readFile(readFileSync(join(FIXTURES, name)), name);
}

function inline(text: string, name = 'inline.csv'): Promise<ParsedFile> {
  return readFile(Buffer.from(text, 'utf8'), name);
}

/** The fields both KeHE exports carry, so the clean and the dirty file can be compared. */
function core(row: RemittanceRow) {
  return {
    paymentNumber: row.paymentNumber,
    paymentDate: row.paymentDate,
    paymentTotalCents: row.paymentTotalCents,
    regionDc: row.regionDc,
    lineType: row.lineType,
    referenceInvoiceNumber: row.referenceInvoiceNumber,
    invoiceDate: row.invoiceDate,
    reasonCode: row.reasonCode,
    lineAmountCents: row.lineAmountCents,
    currency: row.currency,
  };
}

describe('parseRemittance — the §7.3 worked example', () => {
  it('reads one $10,000 invoice paid with $9,150 and three deductions to the cent', async () => {
    const result = parseRemittance(await fixture('kehe_worked_example_2026-09-11.csv'));
    expect(result.issues).toEqual([]);
    expect(result.sourceSystem).toBe('KEHE');
    expect(result.advices).toHaveLength(1);

    const [advice] = result.advices;
    expect(isPostable(advice)).toBe(true);
    expect(advice.paymentNumber).toBe('0009941177');
    expect(advice.paymentDate).toBe('2026-09-11');
    expect(advice.paymentTotalCents).toBe(915_000);
    expect(advice.paymentKey).toBe(remittancePaymentKey('KEHE', null, '0009941177'));
    expect(advice.rows.map((r) => [r.lineType, r.documentNumber, r.reasonCode, r.lineAmountCents])).toEqual([
      ['INVOICE', null, null, 1_000_000],
      ['DEDUCTION', 'INV4471001H', 'H', -42_000],
      ['DEDUCTION', 'INV4471001IA', 'IA', -6_500],
      ['DEDUCTION', 'INV4471001C', 'C', -36_500],
    ]);
    expect(advice.rows[1].dealNumber).toBe('88214');
    expect(advice.rows[1].itemUpc).toBe('00857392004112');
    expect(advice.rows[3].quantity).toBe('24');
    expect(advice.rows[3].unitAmount).toBe('15.2100');
    expect(adviceArithmetic(advice)).toEqual({
      invoicesCents: 1_000_000,
      adjustmentsCents: -85_000,
      computedCents: 915_000,
      paymentTotalCents: 915_000,
      balanced: true,
    });
  });
});

describe('parseRemittance — §8 sample files', () => {
  it('KeHE canonical: 15 rows tie to $17,242.31', async () => {
    const result = parseRemittance(await fixture('kehe_remittance_2026-09-11.csv'));
    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(15);
    const [advice] = result.advices;
    expect(isPostable(advice)).toBe(true);
    const math = adviceArithmetic(advice);
    expect(math.invoicesCents).toBe(1_960_775);
    expect(math.adjustmentsCents).toBe(-273_044 + 36_500);
    expect(math.computedCents).toBe(1_724_231);
    expect(advice.rows.filter((r) => r.lineType === 'REPAYMENT').map((r) => r.lineAmountCents)).toEqual([36_500]);
    expect(advice.rows.find((r) => r.lineType === 'DISCOUNT')?.reasonCode).toBe('CD');
  });

  it('UNFI East: region is part of the payment identity and the rows tie to $15,020.93', async () => {
    const result = parseRemittance(await fixture('unfi_remittance_east_2026-09-04.csv'));
    expect(result.issues).toEqual([]);
    const [advice] = result.advices;
    expect(advice.regionDc).toBe('EAST');
    expect(advice.paymentKey).toBe('UNFI|EAST|EAST-9876543');
    expect(adviceArithmetic(advice).balanced).toBe(true);
    expect(advice.paymentTotalCents).toBe(1_502_093);
    const credit = advice.rows.find((r) => r.lineType === 'CREDIT');
    expect(credit?.reasonCode).toBe('PB');
    expect(credit?.lineAmountCents).toBe(62_400);
    expect(advice.rows.find((r) => r.reasonCode === 'UOI0826')?.dealNumber).toBe('UOI0826');
  });

  it('KeHE dirty grid (BOM, preamble, $, Debit/Credit, embedded newline, merged cells, footer) matches the clean file', async () => {
    const dirty = parseRemittance(await fixture('kehe_remittance_2026-09-11_dirty.csv'), { sourceSystem: 'KEHE' });
    const clean = parseRemittance(await fixture('kehe_remittance_2026-09-11.csv'));

    expect(dirty.issues).toEqual([]);
    expect(dirty.headerRow).toBe(3);
    expect(dirty.advices).toHaveLength(1);
    const [advice] = dirty.advices;
    expect(advice.issues.map((i) => i.code)).toEqual(['advice.total_from_footer']);
    expect(isPostable(advice)).toBe(true);
    expect(advice.paymentTotalCents).toBe(1_724_231);

    expect(dirty.rows.map(core)).toEqual(clean.rows.map(core));
    // The embedded newlines collapse, so the fingerprint is stable across re-wraps.
    expect(dirty.rows[3].reasonDescription).toBe('MCB PROMO BILLBACK DEAL 88214 08/01-08/28 SPROUTS SW DIV');
    // KeHE's prefixed invoice number is the deduction's own document number.
    expect(dirty.rows[3].documentNumber).toBe('INV4471001H');
    expect(dirty.rows[14].documentNumber).toBe('INV4390117PB');
  });

  it('refuses to guess the source when "Invoice Number" is ambiguous', async () => {
    const result = parseRemittance(await fixture('kehe_remittance_2026-09-11_dirty.csv'));
    expect(result.issues.map((i) => i.code)).toEqual(['source.unknown']);
    expect(result.advices).toEqual([]);
  });
});

const HEAD = 'source_system,payment_number,payment_date,payment_total,line_type,document_number,reference_invoice_number,reason_code,reason_description,line_amount,currency';

describe('parseRemittance — sign and structure rules', () => {
  it('quarantines an advice whose lines do not equal the payment (§6.1)', async () => {
    const result = parseRemittance(
      await inline(
        [
          HEAD,
          'KEHE,P1,09/11/2026,900.00,INVOICE,,INV1,,,1000.00,USD',
          'KEHE,P1,09/11/2026,900.00,DEDUCTION,INV1H,INV1,H,PROMO,-50.00,USD',
        ].join('\n'),
      ),
    );
    const [advice] = result.advices;
    expect(isPostable(advice)).toBe(false);
    expect(advice.issues.map((i) => i.code)).toContain('advice.identity');
  });

  it('forces "Deduction Amount" negative and honours a D/C flag over the printed sign', async () => {
    const forced = parseRemittance(
      await inline(
        [
          'Check Number,Check Date,Payment Total,Invoice Number,Prefix,Description,Deduction Amount',
          'C1,09/11/2026,580.00,INV9,,INVOICE,',
          'C1,09/11/2026,580.00,INV9H,H,PROMO,420.00',
        ].join('\n'),
      ),
      { sourceSystem: 'KEHE' },
    );
    // The invoice row has no deduction amount: it is unreadable, and its payment is quarantined.
    expect(forced.advices[0].issues.map((i) => i.code)).toContain('advice.amount.missing');

    const flagged = parseRemittance(
      await inline(
        [
          'source_system,payment_number,payment_date,payment_total,reference_invoice_number,reason_code,line_amount,d/c,currency',
          'UNFI,EAST-1,09/04/2026,580.00,INV9,,1000.00,C,USD',
          'UNFI,EAST-1,09/04/2026,580.00,INV9,01,420.00,D,USD',
        ].join('\n'),
      ),
    );
    expect(flagged.rows.map((r) => r.lineAmountCents)).toEqual([100_000, -42_000]);
    expect(isPostable(flagged.advices[0])).toBe(true);
  });

  it('reads parentheses and trailing minus, and quarantines a comma decimal', async () => {
    const ok = parseRemittance(
      await inline(
        [
          HEAD,
          'KEHE,P2,09/11/2026,"$1,000.00",INVOICE,,INV1,,,"$1,122.00",USD',
          'KEHE,P2,09/11/2026,"$1,000.00",DEDUCTION,INV1H,INV1,H,A,(100.00),USD',
          'KEHE,P2,09/11/2026,"$1,000.00",DEDUCTION,INV1G,INV1,G,B,22.00-,USD',
        ].join('\n'),
      ),
    );
    expect(ok.rows.map((r) => r.lineAmountCents)).toEqual([112_200, -10_000, -2_200]);
    expect(isPostable(ok.advices[0])).toBe(true);

    const comma = parseRemittance(
      await inline([HEAD, 'KEHE,P3,09/11/2026,"10,50",INVOICE,,INV1,,,"10,50",USD'].join('\n')),
    );
    expect(comma.issues.some((i) => i.code === 'amount.comma_decimal' && i.severity === 'fatal')).toBe(true);
  });

  it('fails loudly on an unmapped header rather than guessing', async () => {
    const result = parseRemittance(
      await inline([`${HEAD},Mystery Column`, 'KEHE,P1,09/11/2026,1.00,INVOICE,,INV1,,,1.00,USD,x'].join('\n')),
    );
    expect(result.issues.map((i) => [i.code, i.message])).toEqual([['header.unmapped', 'unmapped header: "Mystery Column"']]);
    expect(result.advices).toEqual([]);
  });

  it('numbers identical lines instead of dropping them (§5.2 level 5)', async () => {
    const result = parseRemittance(
      await inline(
        [
          HEAD,
          'KEHE,P4,09/11/2026,870.00,INVOICE,,INV1,,,1000.00,USD',
          'KEHE,P4,09/11/2026,870.00,DEDUCTION,,INV1,IA,MCB ADMIN FEE,-65.00,USD',
          'KEHE,P4,09/11/2026,870.00,DEDUCTION,,INV1,IA,MCB ADMIN FEE,-65.00,USD',
        ].join('\n'),
      ),
    );
    const [advice] = result.advices;
    expect(advice.rows.map((r) => r.occurrence)).toEqual([0, 0, 1]);
    expect(advice.issues.map((i) => i.code)).toEqual(['line.duplicate']);
    expect(isPostable(advice)).toBe(true);
  });

  it('splits one file into one advice per payment and rejects non-USD', async () => {
    const result = parseRemittance(
      await inline(
        [
          HEAD,
          'KEHE,P5,09/11/2026,100.00,INVOICE,,INV1,,,100.00,USD',
          'KEHE,P6,09/12/2026,200.00,INVOICE,,INV2,,,200.00,CAD',
        ].join('\n'),
      ),
    );
    expect(result.advices.map((a) => [a.paymentNumber, isPostable(a)])).toEqual([
      ['P5', true],
      ['P6', false],
    ]);
    expect(result.advices[1].issues.map((i) => i.code)).toContain('advice.currency');
  });

  it('keeps a row with no payment out of the advice and says why (an open claim)', async () => {
    const result = parseRemittance(
      await inline(
        [HEAD, 'KEHE,,09/11/2026,,DEDUCTION,INV1H,INV1,H,PENDING,-5.00,USD'].join('\n'),
      ),
    );
    expect(result.issues.map((i) => i.code)).toEqual(['row.no_payment']);
    expect(result.advices).toEqual([]);
  });
});

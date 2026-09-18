/**
 * The Relay importer, against the real corpus and against the shapes the corpus
 * does not happen to contain.
 *
 * `data/statements/relay/` holds 36 genuine exports covering four accounts from
 * January to September 2026. Everything asserted about them is a fact checked
 * against the files, not against a description of them. The handful of shapes the
 * nine months never produced — two identical charges on one day, an edited
 * balance column, a file renamed by hand — are built inline, because they are
 * exactly the cases a real month will eventually produce and nobody will be
 * watching when it does.
 *
 * Nothing here touches the database. The parsing layer is pure by construction
 * and this suite keeps it that way.
 */

import { describe, expect, it } from 'vitest';

import { readFile } from '@/lib/banking/read-file';
import type { ParsedFile } from '@/lib/banking/types';

import {
  readRelay,
  relayAccountMask,
  relayFilenames,
} from '@/lib/banking/__fixtures__/support';

import { detectImporter } from './registry';
import {
  detectRelay,
  parseRelay,
  parseRelayFilename,
  parseRelayReference,
  previewRelay,
  relayExpectedPeriod,
  relayImporter,
  squareBatchDate,
  RELAY_HEADER,
  RELAY_IMPORTER_ID,
  type RelayRow,
} from './relay';
import type { ImporterContext } from './types';

const ACCOUNT_9726 = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_9973 = '22222222-2222-4222-8222-222222222222';

const CTX: ImporterContext = { bankAccountId: ACCOUNT_9726, bankAccountMask: '9726' };

const HEADER_LINE = RELAY_HEADER.join(',');

function inline(text: string, filename: string): Promise<ParsedFile> {
  return readFile(Buffer.from(text, 'utf8'), filename);
}

async function parseInline(text: string, filename: string, ctx: ImporterContext = CTX) {
  return parseRelay(await inline(text, filename), ctx);
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

describe('parseRelayFilename', () => {
  it('reads the account and the period out of a full-month export', () => {
    expect(parseRelayFilename('Relay 2026-03-01 #9726.csv')).toEqual({
      mask: '9726',
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      partial: false,
    });
  });

  it('recognises a (Partial) month and says so', () => {
    expect(parseRelayFilename('Relay (Partial) 2026-09-01 #9973.csv')).toEqual({
      mask: '9973',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      partial: true,
    });
  });

  it('gets February right in a non-leap year, which is where a naive +1 month fails', () => {
    expect(parseRelayFilename('Relay 2026-02-01 #9726.csv')?.periodEnd).toBe('2026-02-28');
  });

  it('ignores a leading path', () => {
    expect(parseRelayFilename('/tmp/downloads/Relay 2026-01-01 #9972.csv')?.mask).toBe('9972');
  });

  it('returns null rather than guessing at a file somebody renamed', () => {
    expect(parseRelayFilename('january statement.csv')).toBeNull();
    expect(parseRelayFilename('Relay 2026-13-01 #9726.csv')).toBeNull();
    expect(parseRelayFilename('Relay 2026-03-01 #972.csv')).toBeNull();
  });

  it('names every one of the 36 real files', () => {
    const named = relayFilenames().map(parseRelayFilename);
    expect(named.filter((entry) => entry === null)).toHaveLength(0);
    expect(named.filter((entry) => entry?.partial === true)).toHaveLength(4);
  });

  it('exposes the expected period for the review queue', () => {
    expect(relayExpectedPeriod('Relay 2026-09-01 #9726.csv')).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
    });
    expect(relayExpectedPeriod('nope.csv')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('detectRelay', () => {
  it('auto-selects a real export and preselects its account and period', async () => {
    const file = await readRelay('Relay 2026-05-01 #9726.csv');
    const detection = detectRelay(file);

    expect(detection.importerId).toBe(RELAY_IMPORTER_ID);
    expect(detection.confidence).toBeGreaterThanOrEqual(0.9);
    expect(detection.accountMask).toBe('9726');
    expect(detection.periodStart).toBe('2026-05-01');
    expect(detection.periodEnd).toBe('2026-05-31');
    expect(detection.partial).toBe(false);
    expect(detection.rejection).toBeUndefined();
    expect(detection.reasons[0]).toContain('header matches');
  });

  it('flags a (Partial) file so the caller knows the rows will arrive again', async () => {
    const file = await readRelay('Relay (Partial) 2026-09-01 #9726.csv');
    const detection = detectRelay(file);
    expect(detection.partial).toBe(true);
    expect(detection.reasons.join(' ')).toContain('(Partial)');
  });

  it('recognises all 36 real files on the header alone', async () => {
    for (const filename of relayFilenames()) {
      const file = await readRelay(filename);
      expect(detectRelay(file).confidence, filename).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('still recognises a file somebody renamed, at lower confidence and with no account', async () => {
    const file = await readRelay('Relay 2026-05-01 #9726.csv');
    const detection = detectRelay({ ...file, filename: 'bank export (1).csv' });

    expect(detection.confidence).toBeCloseTo(0.92, 5);
    expect(detection.accountMask).toBeNull();
    expect(detection.periodStart).toBeNull();
    expect(detection.reasons.join(' ')).toContain('not Relay');
  });

  it('accepts a header-only file: an account with no activity still exports', async () => {
    const file = await inline(`${HEADER_LINE}\n`, 'Relay 2026-06-01 #9727.csv');
    const detection = detectRelay(file);
    expect(detection.confidence).toBeGreaterThanOrEqual(0.9);
    expect(detection.reasons.join(' ')).toContain('header only');
  });

  it('refuses a file named like a Relay export whose header is not Relay’s', async () => {
    const file = await inline(
      'Date,Description,Amount\n5/1/2026,Something,-1.00\n',
      'Relay 2026-05-01 #9726.csv',
    );
    const detection = detectRelay(file);

    expect(detection.confidence).toBe(0);
    expect(detection.rejection?.code).toBe('relay.header_mismatch');
    expect(detection.rejection?.remedy).toContain('Download the statement again');
  });

  it('does not claim a file that is not Relay at all', async () => {
    const file = await inline(
      'Posting Date,Details,Amount,Balance\n05/01/2026,COFFEE,-4.79,100.00\n',
      'chase.csv',
    );
    expect(detectRelay(file).confidence).toBe(0);
  });
});

describe('the registry', () => {
  it('selects the Relay importer for a real export', async () => {
    const file = await readRelay('Relay 2026-02-01 #9726.csv');
    const outcome = detectImporter(file);
    expect(outcome.kind).toBe('selected');
    if (outcome.kind === 'selected') expect(outcome.importer.id).toBe(RELAY_IMPORTER_ID);
  });

  it('surfaces a rejection rather than offering a second-best parse', async () => {
    const file = await inline('Date,Amount\n5/1/2026,-1.00\n', 'Relay 2026-05-01 #9726.csv');
    const outcome = detectImporter(file);
    expect(outcome.kind).toBe('rejected');
  });

  it('says it does not know a format it does not know', async () => {
    const file = await inline('a,b,c\n1,2,3\n', 'mystery.csv');
    expect(detectImporter(file).kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// The whole corpus
// ---------------------------------------------------------------------------

describe('the 36 real statements, through the importer', () => {
  it('parses every one, ties every balance chain, and finds 110 transactions', async () => {
    let usable = 0;
    const byAccount: Record<string, number> = {};

    for (const filename of relayFilenames()) {
      const mask = relayAccountMask(filename);
      const file = await readRelay(filename);
      const parsed = parseRelay(file, { bankAccountId: ACCOUNT_9726, bankAccountMask: mask });

      expect(parsed.balanceChain?.ok, filename).toBe(true);
      expect(
        parsed.issues.filter((issue) => issue.severity === 'fatal'),
        filename,
      ).toEqual([]);

      const rows = parsed.rows.filter((row) => row.usable);
      usable += rows.length;
      byAccount[mask] = (byAccount[mask] ?? 0) + rows.length;
    }

    expect(usable).toBe(110);
    // Two of the four Relay accounts have no activity at all across nine months.
    expect(byAccount['9727']).toBe(0);
    expect(byAccount['9972']).toBe(0);
  });

  it('treats the 25 header-only files as zero-row imports, not errors', async () => {
    let empty = 0;

    for (const filename of relayFilenames()) {
      const file = await readRelay(filename);
      const parsed = parseRelay(file, {
        bankAccountId: ACCOUNT_9726,
        bankAccountMask: relayAccountMask(filename),
      });
      if (parsed.stats.dataRows !== 0) continue;

      empty += 1;
      expect(parsed.rows, filename).toEqual([]);
      expect(parsed.balanceChain?.ok, filename).toBe(true);
      expect(
        parsed.issues.every((issue) => issue.severity === 'info'),
        filename,
      ).toBe(true);

      const summary = previewRelay(parsed.rows, parsed.header, parsed);
      expect(summary.rowCount, filename).toBe(0);
      expect(summary.dateRange, filename).toBeNull();
      expect(summary.assertions.every((assertion) => assertion.passed), filename).toBe(true);
    }

    expect(empty).toBe(25);
  });

  it('never surfaces Relay’s junk Description column', async () => {
    let unknownInSource = 0;

    for (const filename of relayFilenames()) {
      const file = await readRelay(filename);
      const parsed = parseRelay(file, CTX);

      for (const row of parsed.rows) {
        if ((row.raw['Description'] ?? '').trim() === 'Unknown') unknownInSource += 1;
        expect(row.description, `${filename} row ${row.rowIndex}`).not.toBe('Unknown');
        expect(row.memo, `${filename} row ${row.rowIndex}`).not.toBe('Unknown');
        expect(row.memo.length, `${filename} row ${row.rowIndex}`).toBeGreaterThan(0);
      }
    }

    // The column really is junk on three quarters of the corpus, which is the
    // whole reason the profile maps Payee and not Description.
    expect(unknownInSource).toBe(75);
  });

  it('orders every file oldest-first, whatever order Relay wrote it in', async () => {
    for (const filename of relayFilenames()) {
      const file = await readRelay(filename);
      const parsed = parseRelay(file, CTX);
      const dates = parsed.rows.filter((row) => row.usable).map((row) => row.date);
      expect([...dates].sort(), filename).toEqual(dates);
      if (dates.length > 1) expect(parsed.balanceChain?.direction, filename).toBe('descending');
    }
  });

  it('keeps every amount a whole number of cents, signed the company’s way', async () => {
    for (const filename of relayFilenames()) {
      const file = await readRelay(filename);
      const parsed = parseRelay(file, CTX);
      for (const row of parsed.rows.filter((r) => r.usable)) {
        expect(Number.isSafeInteger(row.amountCents), `${filename} ${row.rowIndex}`).toBe(true);
        expect(row.amountCents).not.toBe(0);
        const sign = (row.raw['Amount'] ?? '').trim().startsWith('-') ? -1 : 1;
        expect(Math.sign(row.amountCents), `${filename} ${row.rowIndex}`).toBe(sign);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// One real month, in detail
// ---------------------------------------------------------------------------

describe('Relay (Partial) 2026-09-01 #9726.csv', () => {
  async function parse() {
    return parseRelay(await readRelay('Relay (Partial) 2026-09-01 #9726.csv'), CTX);
  }

  it('reads 13 rows and ties the balance chain from 1550.04 to 529.67', async () => {
    const parsed = await parse();
    expect(parsed.rows).toHaveLength(13);
    expect(parsed.balanceChain?.ok).toBe(true);
    expect(parsed.balanceChain?.checked).toBe(13);
    expect(parsed.balanceChain?.openingBalanceCents).toBe(55004);
    expect(parsed.balanceChain?.closingBalanceCents).toBe(52967);
  });

  it('summarises the month the way the preview pane shows it', async () => {
    const parsed = await parse();
    const summary = previewRelay(parsed.rows, parsed.header, parsed);

    expect(summary.rowCount).toBe(13);
    expect(summary.dateRange).toEqual({ min: '2026-09-01', max: '2026-09-15' });
    expect(summary.totals.inflowCents).toBe(310000);
    expect(summary.totals.outflowCents).toBe(-312037);
    expect(summary.totals.netCents).toBe(-2037);
    expect(summary.byType).toEqual([
      { type: 'Spend', count: 10, amountCents: -312037 },
      { type: 'Receive', count: 3, amountCents: 310000 },
    ]);
    expect(summary.assertions.find((a) => a.id === 'bank.balance_chain')?.passed).toBe(true);
    expect(summary.assertions.find((a) => a.id === 'relay.dates_within_period')?.passed).toBe(true);
  });

  it('maps Payee to the memo and Reference to the detail, and keeps the sender for the audit trail', async () => {
    const parsed = await parse();
    const blue = parsed.rows.find((row) => row.description === 'Blue Pacific Flavors');

    expect(blue).toBeDefined();
    expect(blue?.amountCents).toBe(-84300);
    expect(blue?.counterpartyMask).toBe('1672');
    expect(blue?.detail).toBe('PO SOOZ-2026-001 / CO10191');
    expect(blue?.sentBy).toBe('Boxuan Zhao');
    // The raw reference is kept verbatim: it is what the audit trail needs.
    expect(blue?.reference).toBe('PO SOOZ-2026-001 / CO10191 - Sent By Boxuan Zhao');
  });

  it('sees the founder’s ACH pulls for what they are: money in, from a personal account', async () => {
    const parsed = await parse();
    const pulls = parsed.rows.filter((row) => row.detail === 'ACH Pull');

    expect(pulls).toHaveLength(3);
    expect(pulls.map((row) => row.amountCents)).toEqual([200000, 100000, 10000]);
    expect(pulls.every((row) => row.amountCents > 0)).toBe(true);
    // The importer states the facts and categorizes nothing: whether this is
    // equity or a loan is the owner's decision, not the parser's.
    expect(pulls.every((row) => row.transactionType === 'Receive')).toBe(true);
  });

  it('pulls the card last-four out of the reference', async () => {
    const parsed = await parse();
    const fedex = parsed.rows.find((row) => row.description.startsWith('FEDEX'));
    expect(fedex?.cardLastFour).toBe('8796');
    expect(fedex?.virtualCard).toBe(true);

    const lab = parsed.rows.find((row) => row.description === 'LAB ALLEY LLC');
    expect(lab?.cardLastFour).toBe('1892');
    expect(lab?.virtualCard).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RETURNED
// ---------------------------------------------------------------------------

describe('a returned ACH', () => {
  it('is imported, flagged, barred from posting and linked to the settled row that cancels it', async () => {
    const file = await readRelay('Relay 2026-05-01 #9726.csv');
    const parsed = parseRelay(file, CTX);

    const returned = parsed.rows.filter((row) => row.returned);
    expect(returned).toHaveLength(1);

    const [row] = returned;
    expect(row.date).toBe('2026-05-15');
    expect(row.description).toBe('GOOGLE');
    expect(row.amountCents).toBe(1000);
    expect(row.settlementStatus).toBe('RETURNED');
    expect(row.detail).toContain('Returned received ACH transaction');
    expect(row.initiatedBy).toBe('Unknown Payee');

    // The counterpart is the same day, same payee, exactly the opposite amount.
    expect(row.returnedPairRowIndex).not.toBeNull();
    const counterpart = parsed.rows.find((r) => r.rowIndex === row.returnedPairRowIndex);
    expect(counterpart?.amountCents).toBe(-1000);
    expect(counterpart?.description).toBe('GOOGLE');
    expect(counterpart?.date).toBe('2026-05-15');
    expect(counterpart?.returnedPairRowIndex).toBe(row.rowIndex);

    // Both sides are excluded: together they net to zero and no money moved.
    const summary = previewRelay(parsed.rows, parsed.header, parsed);
    expect(summary.excluded).toBe(2);
    expect(summary.needsReview).toBe(parsed.rows.length - 2);

    const warning = parsed.issues.find((issue) => issue.code === 'relay.returned');
    expect(warning?.severity).toBe('warn');
    expect(warning?.message).toContain('barred from posting');
  });

  it('still moves the running balance, which is why the row is kept rather than dropped', async () => {
    const file = await readRelay('Relay 2026-05-01 #9726.csv');
    const parsed = parseRelay(file, CTX);
    // The real file's chain only ties because the returned +10.00 is counted.
    // Dropping the row — the obvious reading of "it never settled" — breaks it.
    expect(parsed.balanceChain?.ok).toBe(true);
    expect(parsed.balanceChain?.breaks).toEqual([]);
  });

  it('does not pair a returned row with an unrelated amount that merely matches', async () => {
    const parsed = await parseInline(
      [
        HEADER_LINE,
        '5/17/2026,Rice Parking,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-10.00,USD,4.59',
        '5/15/2026,GOOGLE,,Receive,,"Returned received ACH transaction #1 due to: Account has insufficient funds",RETURNED,+10.00,USD,14.59',
        '5/15/2026,Amazon,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-17.99,USD,4.59',
      ].join('\n'),
      'Relay 2026-05-01 #9726.csv',
    );

    const returned = parsed.rows.find((row) => row.returned);
    expect(returned?.returnedPairRowIndex).toBeNull();
    expect(
      parsed.issues.find((issue) => issue.code === 'relay.returned')?.message,
    ).toContain('is not in this file');
  });

  it('pairs a return that settles days after the debit it reverses', async () => {
    // ACH returns usually land one to several business days later. A same-day-only
    // rule left the -10.00 debit postable as an ad expense while the +10.00 that
    // cancels it was excluded.
    const parsed = await parseInline(
      [
        HEADER_LINE,
        '5/30/2026,GOOGLE,,Receive,,"Returned received ACH transaction #2 due to: Account has insufficient funds",RETURNED,+10.00,USD,20.00',
        '5/29/2026,GOOGLE,,Spend,Unknown,"GOOGLE  |  PURCHASE",SETTLED,-10.00,USD,10.00',
        '5/20/2026,Square Inc,,Receive,,"SQ260520",SETTLED,+20.00,USD,20.00',
      ].join('\n'),
      'Relay 2026-05-01 #9726.csv',
    );

    const returned = parsed.rows.find((row) => row.returned);
    const original = parsed.rows.find((row) => row.amountCents === -1000);
    expect(returned?.returnedPairRowIndex).toBe(original?.rowIndex);
    expect(original?.returnedPairRowIndex).toBe(returned?.rowIndex);
    expect(previewRelay(parsed.rows, parsed.header, parsed).excluded).toBe(2);
    expect(parsed.issues.find((issue) => issue.code === 'relay.returned')?.message).toContain(
      'settled row of 2026-05-29',
    );
  });

  it('prefers the nearest earlier original and never one dated after the return or outside the window', async () => {
    const parsed = await parseInline(
      [
        HEADER_LINE,
        '5/31/2026,GOOGLE,,Spend,Unknown,"GOOGLE  |  PURCHASE",SETTLED,-10.00,USD,0.00',
        '5/28/2026,GOOGLE,,Receive,,"Returned received ACH transaction #3 due to: Account has insufficient funds",RETURNED,+10.00,USD,10.00',
        '5/26/2026,GOOGLE,,Spend,Unknown,"GOOGLE  |  PURCHASE",SETTLED,-10.00,USD,0.00',
        '5/3/2026,GOOGLE,,Spend,Unknown,"GOOGLE  |  PURCHASE",SETTLED,-10.00,USD,10.00',
        '5/1/2026,Square Inc,,Receive,,"SQ260501",SETTLED,+20.00,USD,20.00',
      ].join('\n'),
      'Relay 2026-05-01 #9726.csv',
    );

    const returned = parsed.rows.find((row) => row.returned);
    const paired = parsed.rows.find((row) => row.rowIndex === returned?.returnedPairRowIndex);
    // 5/26 is two days before; 5/3 is 25 days before (outside the window); 5/31 is after.
    expect(paired?.date).toBe('2026-05-26');
    expect(parsed.rows.filter((row) => row.returnedPairRowIndex !== null)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Square
// ---------------------------------------------------------------------------

describe('Square references', () => {
  it('decodes SQ + YYMMDD into the batch date', () => {
    expect(squareBatchDate('SQ260126')).toBe('2026-01-26');
    expect(squareBatchDate('SQ260831')).toBe('2026-08-31');
  });

  it('refuses a shape that is not a calendar date rather than inventing one', () => {
    expect(squareBatchDate('SQ260230')).toBeNull();
    expect(squareBatchDate('SQ261301')).toBeNull();
    expect(squareBatchDate('Corporate Card - 1892 (Business Card)')).toBeNull();
    expect(squareBatchDate(null)).toBeNull();
  });

  it('decodes every Square deposit in the corpus', async () => {
    const found: Array<{ date: string; batch: string | null; cents: number }> = [];

    for (const filename of relayFilenames()) {
      const parsed = parseRelay(await readRelay(filename), CTX);
      for (const row of parsed.rows) {
        if (row.squareBatchDate === null) continue;
        found.push({ date: row.date, batch: row.squareBatchDate, cents: row.amountCents });
      }
    }

    expect(found.length).toBeGreaterThan(0);
    // Every Square row is money in, and the batch date is the same day the
    // deposit landed in this company's data.
    expect(found.every((entry) => entry.cents > 0)).toBe(true);
    expect(found.every((entry) => entry.batch === entry.date)).toBe(true);
  });
});

describe('parseRelayReference', () => {
  it('strips the metadata suffixes and keeps them separately', () => {
    expect(
      parseRelayReference('SO 0480072 / PO SOOZ-2026-003 / Sooz Beverage LLC - Sent By Boxuan Zhao'),
    ).toEqual({
      detail: 'SO 0480072 / PO SOOZ-2026-003 / Sooz Beverage LLC',
      sentBy: 'Boxuan Zhao',
      initiatedBy: null,
      cardLastFour: null,
      virtualCard: false,
    });
  });

  it('keeps a bare reference whole — it is not a payee and must not be cleaned like one', () => {
    const parsed = parseRelayReference('Corporate Card - 1892 (Business Card)');
    expect(parsed.detail).toBe('Corporate Card - 1892 (Business Card)');
    expect(parsed.cardLastFour).toBe('1892');
  });

  it('never returns an empty detail for a non-empty reference', () => {
    expect(parseRelayReference('- Sent By Boxuan Zhao').detail).toBe('- Sent By Boxuan Zhao');
    expect(parseRelayReference('   ').detail).toBeNull();
    expect(parseRelayReference(null).detail).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fingerprints and the (Partial) problem, before any database is involved
// ---------------------------------------------------------------------------

/**
 * A synthetic complete September for ••9726, built on the real partial export.
 *
 * The partial file stops on 9/15 with a balance of 529.67; the three rows added
 * here continue that chain forward, so the full month is a strict superset of the
 * partial in exactly the way Relay produces one.
 */
async function septemberPartialAndFull(): Promise<{ partial: ParsedFile; full: ParsedFile }> {
  const partial = await readRelay('Relay (Partial) 2026-09-01 #9726.csv');
  const lines = partial.rows.map((row) =>
    row.map((cell) => (/[",]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','),
  );
  const [header, ...body] = lines;

  const later = [
    '9/28/2026,Relay,,Spend,,"Banking Fees",SETTLED,-8.00,USD,538.77',
    '9/22/2026,Square Inc,,Receive,,"SQ260922",SETTLED,+42.10,USD,546.77',
    '9/18/2026,Amazon,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-25.00,USD,504.67',
  ];

  const full = await inline(
    [header, ...later, ...body].join('\n'),
    'Relay 2026-09-01 #9726.csv',
  );

  return { partial, full };
}

describe('the (Partial) problem, at the fingerprint level', () => {
  it('gives every shared row the same fingerprint in the partial and the full month', async () => {
    const { partial, full } = await septemberPartialAndFull();

    const partialRows = parseRelay(partial, CTX).rows;
    const fullRows = parseRelay(full, CTX).rows;

    expect(partialRows).toHaveLength(13);
    expect(fullRows).toHaveLength(16);

    const partialPrints = new Set(partialRows.map((row) => row.fingerprint));
    const fullPrints = new Set(fullRows.map((row) => row.fingerprint));

    expect(partialPrints.size).toBe(13);
    expect(fullPrints.size).toBe(16);
    for (const print of partialPrints) expect(fullPrints.has(print)).toBe(true);

    const fresh = [...fullPrints].filter((print) => !partialPrints.has(print));
    expect(fresh).toHaveLength(3);
  });

  it('scopes the fingerprint to the account, so two accounts never collide', async () => {
    const { partial } = await septemberPartialAndFull();
    const here = parseRelay(partial, CTX).rows.map((row) => row.fingerprint);
    const there = parseRelay(partial, { bankAccountId: ACCOUNT_9973 }).rows.map(
      (row) => row.fingerprint,
    );
    expect(here.some((print) => there.includes(print))).toBe(false);
  });

  it('numbers two genuinely identical charges on one day, oldest first', async () => {
    const parsed = await parseInline(
      [
        HEADER_LINE,
        '1/28/2026,Target,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-8.19,USD,83.62',
        '1/28/2026,Target,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-8.19,USD,91.81',
        '1/27/2026,Square Inc,,Receive,,"SQ260127",SETTLED,+13.81,USD,100.00',
      ].join('\n'),
      'Relay 2026-01-01 #9726.csv',
    );

    expect(parsed.balanceChain?.ok).toBe(true);
    const targets = parsed.rows.filter((row) => row.description === 'Target');
    expect(targets.map((row) => row.occurrence)).toEqual([0, 1]);
    expect(new Set(targets.map((row) => row.fingerprint)).size).toBe(2);
  });

  it('numbers a partial month’s duplicates the same way the full month does', async () => {
    const dayRows = [
      '1/28/2026,Target,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-8.19,USD,83.62',
      '1/28/2026,Target,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-8.19,USD,91.81',
      '1/27/2026,Square Inc,,Receive,,"SQ260127",SETTLED,+13.81,USD,100.00',
    ];

    const partial = await parseInline(
      [HEADER_LINE, ...dayRows].join('\n'),
      'Relay (Partial) 2026-01-01 #9726.csv',
    );
    const full = await parseInline(
      [
        HEADER_LINE,
        '1/30/2026,Michaels,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-12.00,USD,71.62',
        ...dayRows,
      ].join('\n'),
      'Relay 2026-01-01 #9726.csv',
    );

    const partialPrints = new Set(partial.rows.map((row) => row.fingerprint));
    const fullPrints = new Set(full.rows.map((row) => row.fingerprint));
    // Oldest-first numbering makes the partial a prefix of the full month. In
    // file order — newest first — the second Target would be #0 in one file and
    // #1 in the other, and the month would duplicate itself.
    for (const print of partialPrints) expect(fullPrints.has(print)).toBe(true);
    expect(fullPrints.size).toBe(partialPrints.size + 1);
  });

  it('keeps the balance out of the key, because a later transaction changes it', async () => {
    const row = (balance: string) =>
      `1/27/2026,Square Inc,,Receive,,"SQ260127",SETTLED,+13.81,USD,${balance}`;

    const a = await parseInline([HEADER_LINE, row('100.00')].join('\n'), 'Relay 2026-01-01 #9726.csv');
    const b = await parseInline([HEADER_LINE, row('250.00')].join('\n'), 'Relay 2026-01-01 #9726.csv');

    expect(a.rows[0].fingerprint).toBe(b.rows[0].fingerprint);
  });

  it('matches the importer’s own fingerprint function', async () => {
    const { partial } = await septemberPartialAndFull();
    const parsed = parseRelay(partial, CTX);
    for (const row of parsed.rows) {
      expect(relayImporter.fingerprint(row as RelayRow, CTX)).toBe(row.fingerprint);
    }
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('what the importer refuses to let through', () => {
  it('raises a fatal issue when the balance chain does not tie', async () => {
    const parsed = await parseInline(
      [
        HEADER_LINE,
        '1/28/2026,Target,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-8.19,USD,83.62',
        // The 1/27 row that would explain the jump has been removed.
        '1/26/2026,Square Inc,,Receive,,"SQ260126",SETTLED,+13.81,USD,100.00',
      ].join('\n'),
      'Relay 2026-01-01 #9726.csv',
    );

    expect(parsed.balanceChain?.ok).toBe(false);
    const fatal = parsed.issues.filter((issue) => issue.severity === 'fatal');
    expect(fatal).toHaveLength(1);
    expect(fatal[0].code).toBe('balance.chain_broken');
    expect(fatal[0].message).toContain('does not tie');
    expect(fatal[0].rawRow).toBeDefined();
    expect(fatal[0].remedy).toContain('Re-download');
  });

  it('refuses one account’s statement imported into another', async () => {
    const file = await readRelay('Relay 2026-05-01 #9726.csv');
    const parsed = parseRelay(file, { bankAccountId: ACCOUNT_9973, bankAccountMask: '9973' });

    const fatal = parsed.issues.find((issue) => issue.code === 'relay.account_mismatch');
    expect(fatal?.severity).toBe('fatal');
    expect(fatal?.message).toContain('••9726');
    expect(fatal?.remedy).toContain('#9973');
  });

  it('skips a zero-amount row rather than writing a transaction the ledger forbids', async () => {
    const parsed = await parseInline(
      [
        HEADER_LINE,
        '1/28/2026,Some Merchant,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,+0.00,USD,100.00',
        '1/26/2026,Square Inc,,Receive,,"SQ260126",SETTLED,+13.81,USD,100.00',
      ].join('\n'),
      'Relay 2026-01-01 #9726.csv',
    );

    const zero = parsed.rows.find((row) => row.amountCents === 0);
    expect(zero?.usable).toBe(false);
    expect(zero?.fingerprint).toBe('');
    expect(parsed.issues.some((issue) => issue.code === 'amount.zero')).toBe(true);
  });

  it('warns when a row falls outside the month its filename names', async () => {
    const parsed = await parseInline(
      [
        HEADER_LINE,
        '2/03/2026,Amazon,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-5.00,USD,95.00',
        '1/26/2026,Square Inc,,Receive,,"SQ260126",SETTLED,+13.81,USD,100.00',
      ].join('\n'),
      'Relay 2026-01-01 #9726.csv',
    );

    expect(parsed.issues.some((issue) => issue.code === 'date.out_of_range')).toBe(true);
    const summary = previewRelay(parsed.rows, parsed.header, parsed);
    const assertion = summary.assertions.find((a) => a.id === 'relay.dates_within_period');
    expect(assertion?.passed).toBe(false);
    expect(assertion?.severity).toBe('warn');
  });

  it('keeps an unrecognised Transaction Type rather than dropping the row', async () => {
    const parsed = await parseInline(
      [
        HEADER_LINE,
        '1/26/2026,Relay,,Sweep,Unknown,"Something New",SETTLED,-5.00,USD,95.00',
        '1/25/2026,Square Inc,,Receive,,"SQ260125",SETTLED,+13.81,USD,100.00',
      ].join('\n'),
      'Relay 2026-01-01 #9726.csv',
    );

    const row = parsed.rows.find((r) => r.rawType === 'Sweep');
    expect(row?.usable).toBe(true);
    expect(row?.transactionType).toBeNull();
    const warning = parsed.issues.find((issue) => issue.code === 'type.unknown');
    expect(warning?.severity).toBe('warn');
    expect(warning?.message).toContain('"Sweep"');
  });
});

// ---------------------------------------------------------------------------
// Internal transfers
// ---------------------------------------------------------------------------

describe('internal transfers', () => {
  it('reads the label Relay puts on both legs', async () => {
    const parsed = await parseInline(
      [
        HEADER_LINE,
        '2/20/2026,Operating Expenses,9973,Receive-transfer,,"Transfer",SETTLED,+50.00,USD,150.00',
        '2/18/2026,Square Inc,,Receive,,"SQ260218",SETTLED,+13.81,USD,100.00',
      ].join('\n'),
      'Relay 2026-02-01 #9726.csv',
    );

    const transfer = parsed.rows.find((row) => row.internalTransfer);
    expect(transfer?.transactionType).toBe('Receive-transfer');
    expect(transfer?.counterpartyMask).toBe('9973');
    expect(transfer?.amountCents).toBe(5000);
  });

  it('finds the three labelled transfer legs the corpus actually contains', async () => {
    let out = 0;
    let inbound = 0;

    for (const filename of relayFilenames()) {
      const parsed = parseRelay(await readRelay(filename), CTX);
      for (const row of parsed.rows) {
        if (row.transactionType === 'Spend-transfer') out += 1;
        if (row.transactionType === 'Receive-transfer') inbound += 1;
      }
    }

    expect(out).toBe(1);
    expect(inbound).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';

import { readFile } from '@/lib/banking/read-file';

import { GENERIC_IMPORTER_ID } from './generic';
import { PLAID_IMPORTER_ID, parsePlaid, plaidImporter, toPlaidCsv } from './plaid';
import { detectImporter } from './registry';

const BANK = '11111111-1111-4111-8111-111111111111';

async function file(text: string, name = 'plaid-feed.csv') {
  return readFile(Buffer.from(text, 'utf8'), name);
}

const LINES = [
  { date: '2026-10-02', description: 'RELAY FEE', payee: 'Relay', amount: '-1.50', transactionId: 'tx-2' },
  { date: '2026-10-01', description: 'ZELLE FROM RISUS, "TOP-UP"', payee: null, amount: '250', transactionId: 'tx-1' },
];

describe('the Plaid feed importer', () => {
  it('is chosen for its own layout and only for it', async () => {
    const feed = detectImporter(await file(toPlaidCsv(LINES)));
    expect(feed.kind).toBe('selected');
    if (feed.kind === 'selected') expect(feed.importer.id).toBe(PLAID_IMPORTER_ID);

    const lookalike = detectImporter(await file('Date,Description,Payee,Amount\n2026-10-01,X,Y,-1.00'));
    expect(lookalike.kind === 'selected' ? lookalike.importer.id : null).not.toBe(PLAID_IMPORTER_ID);
    if (lookalike.kind === 'selected') expect(lookalike.importer.id).toBe(GENERIC_IMPORTER_ID);
  });

  it('reads signed amounts as integer cents, oldest first, with commas and quotes intact', async () => {
    const parsed = parsePlaid(await file(toPlaidCsv(LINES)), { bankAccountId: BANK });
    expect(parsed.rows.map((row) => [row.date, row.amountCents, row.externalId])).toEqual([
      ['2026-10-01', 25_000, 'tx-1'],
      ['2026-10-02', -150, 'tx-2'],
    ]);
    expect(parsed.rows[0].description).toBe('ZELLE FROM RISUS, "TOP-UP"');
    expect(parsed.rows[1].counterparty).toBe('Relay');
  });

  it("keys each row on Plaid's id, so a re-sync is the same row", async () => {
    const parsed = parsePlaid(await file(toPlaidCsv(LINES)), { bankAccountId: BANK });
    expect(plaidImporter.fingerprint(parsed.rows[0], { bankAccountId: BANK })).toBe('x:tx-1');
  });

  it("ignores a mapping saved on the account, which was made for that bank's own export", async () => {
    const parsed = parsePlaid(await file(toPlaidCsv(LINES)), {
      bankAccountId: BANK,
      profile: { date_column: 'Payee', mode: 'signed', amount_column: 'Date' },
    });
    expect(parsed.rows.every((row) => row.usable)).toBe(true);
    expect(parsed.rows[0].amountCents).toBe(25_000);
  });
});

import { describe, expect, it } from 'vitest';

import { readFile } from '@/lib/banking/read-file';
import { fixtureBytes, readRelay } from '@/lib/banking/__fixtures__/support';

import { GENERIC_IMPORTER_ID, missingProfileColumns, parseGeneric } from './generic';
import { RELAY_IMPORTER_ID } from './relay';
import { detectImporter } from './registry';
import { hasFatal } from './types';

const CHASE = [
  'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
  'DEBIT,03/05/2026,ACME SUPPLY CO,-60.50,ACH_DEBIT,800.00,',
  'CREDIT,03/03/2026,CUSTOMER PAYMENT,125.50,ACH_CREDIT,860.50,',
  'DEBIT,03/02/2026,ACME SUPPLY CO,-250.00,ACH_DEBIT,735.00,',
].join('\n');

function inline(text: string, filename: string) {
  return readFile(Buffer.from(text, 'utf8'), filename);
}

describe('the registry fallback', () => {
  it('reads a Chase export through a column mapping instead of refusing it', async () => {
    const outcome = detectImporter(await inline(CHASE, 'Chase1234_Activity.CSV'));
    expect(outcome.kind).toBe('selected');
    if (outcome.kind === 'selected') expect(outcome.importer.id).toBe(GENERIC_IMPORTER_ID);
  });

  it('never outvotes a dedicated importer', async () => {
    const outcome = detectImporter(await readRelay('Relay 2026-05-01 #9726.csv'));
    expect(outcome.kind).toBe('selected');
    if (outcome.kind === 'selected') expect(outcome.importer.id).toBe(RELAY_IMPORTER_ID);
  });

  it('reads an XLSX statement too', async () => {
    const outcome = detectImporter(await readFile(fixtureBytes('date-serials.xlsx'), 'statement.xlsx'));
    expect(outcome.kind).toBe('selected');
    if (outcome.kind === 'selected') expect(outcome.importer.id).toBe(GENERIC_IMPORTER_ID);
  });
});

describe('parseGeneric', () => {
  it('proposes a mapping, marks it unconfirmed, and signs amounts from the company’s side', async () => {
    const file = await readFile(fixtureBytes('debit-credit.csv'), 'debit-credit.csv');
    const parsed = parseGeneric(file, { bankAccountId: '00000000-0000-4000-8000-000000000001' });

    expect(parsed.issues.find((issue) => issue.code === 'profile.unconfirmed')?.severity).toBe('warn');
    expect(hasFatal(parsed.issues)).toBe(false);
    expect(parsed.balanceChain?.ok).toBe(true);
    expect(parsed.rows.map((row) => row.amountCents)).toEqual([100000, -25000, 12550, -1500, -6050]);
    expect(new Set(parsed.rows.map((row) => row.fingerprint)).size).toBe(5);
  });

  it('refuses a saved mapping that does not fit the file', async () => {
    const file = await inline(CHASE, 'Chase1234_Activity.CSV');
    const profile = { date_column: 'Date', mode: 'signed' as const, amount_column: 'Amount' };
    expect(missingProfileColumns(file, profile)).toEqual(['Date']);

    const parsed = parseGeneric(file, { bankAccountId: '00000000-0000-4000-8000-000000000001', profile });
    expect(parsed.issues.find((issue) => issue.code === 'profile.columns_missing')?.severity).toBe('fatal');
  });

  it('blocks a file whose running balance does not tie', async () => {
    const file = await inline(
      ['Date,Description,Amount,Balance', '2026-03-01,A,10.00,10.00', '2026-03-02,B,-2.00,9.00'].join('\n'),
      'bank.csv',
    );
    const parsed = parseGeneric(file, {
      bankAccountId: '00000000-0000-4000-8000-000000000001',
      profile: {
        date_column: 'Date',
        mode: 'signed',
        amount_column: 'Amount',
        balance_column: 'Balance',
        description_columns: ['Description'],
      },
    });
    expect(parsed.issues.some((issue) => issue.code === 'balance.chain_broken' && issue.severity === 'fatal')).toBe(true);
  });
});

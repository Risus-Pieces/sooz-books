/**
 * Transactions pulled from Plaid, read through the same pipeline as an uploaded statement.
 *
 * The nightly bank sync (`@/lib/feeds/sync`) writes the new posted transactions for one account as a
 * small CSV in exactly this layout and hands it to `previewImport` / `commitImport`, so a Plaid line
 * gets the same de-duplication, transfer pairing, refunds, rules and AI suggestions as a line from a
 * Relay export. Nothing else produces this layout, and the header is matched exactly, so no uploaded
 * file is ever read as a feed.
 *
 * The mapping is fixed. A saved mapping on the bank account is ignored: it was made for that bank's
 * own export and could read these columns wrongly. The Plaid transaction id is the row's external id,
 * which makes the fingerprint `x:<id>`: a transaction synced twice is the same row.
 */

import type { ImportProfile, ParsedFile } from '@/lib/banking/types';

import { type GenericRow, genericFingerprint, parseGeneric, previewGeneric } from './generic';
import type { DetectionResult, Importer, ImporterContext, ImporterParseResult } from './types';

export const PLAID_IMPORTER_ID = 'bank.plaid';
export const PLAID_IMPORTER_LABEL = 'Bank feed (Plaid)';
export const PLAID_COLUMNS = ['Date', 'Description', 'Payee', 'Amount', 'Plaid Transaction ID'] as const;

const PLAID_PROFILE: ImportProfile = Object.freeze({
  name: 'Plaid feed',
  file_type: 'csv',
  header_row: 0,
  date_column: 'Date',
  date_format: 'YYYY-MM-DD',
  description_columns: ['Description'],
  counterparty_column: 'Payee',
  mode: 'signed',
  amount_column: 'Amount',
  external_id_column: 'Plaid Transaction ID',
});

/** One line the sync writes. `amount` is a decimal string in company terms: positive is money in. */
export interface PlaidFeedLine {
  date: string;
  description: string;
  payee: string | null;
  amount: string;
  transactionId: string;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The feed's lines as the CSV this importer reads, oldest first. */
export function toPlaidCsv(lines: readonly PlaidFeedLine[]): string {
  const sorted = [...lines].sort((a, b) => (a.date === b.date ? a.transactionId.localeCompare(b.transactionId) : a.date < b.date ? -1 : 1));
  return [
    PLAID_COLUMNS.join(','),
    ...sorted.map((line) =>
      [line.date, line.description, line.payee ?? '', line.amount, line.transactionId].map(csvCell).join(','),
    ),
  ].join('\n');
}

function isPlaidHeader(file: ParsedFile): boolean {
  const header = file.rows[0];
  return (
    file.format === 'csv' &&
    header !== undefined &&
    header.length === PLAID_COLUMNS.length &&
    PLAID_COLUMNS.every((column, index) => header[index] === column)
  );
}

export function detectPlaid(file: ParsedFile): DetectionResult {
  return isPlaidHeader(file)
    ? { importerId: PLAID_IMPORTER_ID, label: PLAID_IMPORTER_LABEL, confidence: 0.99, reasons: ['Header is the Plaid feed layout.'] }
    : { importerId: PLAID_IMPORTER_ID, label: PLAID_IMPORTER_LABEL, confidence: 0, reasons: ['Not the Plaid feed layout.'] };
}

export function parsePlaid(file: ParsedFile, ctx: ImporterContext): ImporterParseResult<GenericRow> {
  // Always the fixed mapping, whatever the account has saved.
  const { profile: _ignored, ...rest } = ctx;
  return parseGeneric(file, { ...rest, profile: PLAID_PROFILE });
}

export const plaidImporter: Importer<GenericRow> = Object.freeze({
  id: PLAID_IMPORTER_ID,
  label: PLAID_IMPORTER_LABEL,
  detect: detectPlaid,
  parse: parsePlaid,
  fingerprint: genericFingerprint,
  preview: previewGeneric,
});

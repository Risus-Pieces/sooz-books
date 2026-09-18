/**
 * Any bank's CSV or XLSX statement, read through a column mapping.
 *
 * Relay has a dedicated importer because its format is known to the byte. Every
 * other bank — Chase, Amex, Mercury, a credit union's XLSX — comes through here:
 * the file is read with an `import_profiles` mapping, and when the account has no
 * mapping that fits the file yet, `detectColumns` proposes one.
 *
 * A proposed mapping is exactly that. It is shown in the preview for a human to
 * confirm or correct, and `commitImport` refuses a generic file until the mapping
 * has been saved with `saveImportProfile` — a guessed sign convention inverts every
 * amount in the file, and nothing about the rows would look wrong until the bank
 * reconciliation did. Once saved, the mapping is the account's default and the next
 * statement from the same bank imports without the question being asked again.
 *
 * The balance chain is checked exactly as it is for Relay: when the file carries a
 * running balance, every step must tie or nothing is written.
 */

import { type CalendarDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

import { applyProfile, readRawRows, resolveProfile } from '@/lib/banking/apply-profile';
import { validateBalanceChain } from '@/lib/banking/balance-chain';
import { detectColumns } from '@/lib/banking/detect';
import { assignOccurrences, rowFingerprint } from '@/lib/banking/fingerprint';
import type { ImportProfile, NormalizedTxn, ParsedFile } from '@/lib/banking/types';

import type {
  Assertion,
  DetectionResult,
  FileHeader,
  Importer,
  ImporterContext,
  ImporterParseResult,
  Issue,
  PreviewSummary,
  SourceFile,
} from './types';
import { skippedToIssue, toIssue } from './types';

export const GENERIC_IMPORTER_ID = 'bank.generic';
export const GENERIC_IMPORTER_LABEL = 'Bank statement (column mapping)';

export interface GenericRow extends NormalizedTxn {
  /** 0-based index among rows identical in (date, amount, normalised description). */
  readonly occurrence: number;
  readonly fingerprint: string;
}

// ---------------------------------------------------------------------------
// Profile fit
// ---------------------------------------------------------------------------

/**
 * The columns a mapping names that this file does not have, by header.
 *
 * Empty means the mapping can read the file. A saved mapping is only applied to a
 * file it fits: an account's Chase mapping must never be used to read an Amex export
 * that happens to be uploaded to the same account.
 */
export function missingProfileColumns(file: ParsedFile, profile: ImportProfile): string[] {
  const resolved = resolveProfile(profile);
  const { headers } = readRawRows(file, {
    skipRows: resolved.skip_rows,
    headerRow: resolved.header_row,
  });
  const present = new Set(headers.map((header) => header.trim().toLowerCase()));

  const required: string[] = [resolved.date_column];
  if (resolved.mode === 'signed') required.push(resolved.amount_column ?? '');
  if (resolved.mode === 'debit_credit') {
    required.push(resolved.debit_column ?? '', resolved.credit_column ?? '');
  }
  if (resolved.mode === 'amount_with_type') {
    required.push(resolved.amount_column ?? '', resolved.type_column ?? '');
  }
  const optional = [
    ...resolved.description_columns,
    resolved.counterparty_column,
    resolved.balance_column,
    resolved.reference_column,
    resolved.external_id_column,
  ].filter((column): column is string => column !== null && column !== '');

  return [...required, ...optional].filter(
    (column) => column === '' || !present.has(column.trim().toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Whether the columns can be worked out at all.
 *
 * This importer is the registry's fallback, consulted only when no dedicated
 * importer recognised the file, so its confidence never competes with Relay's.
 */
export function detectGeneric(file: ParsedFile, source?: SourceFile): DetectionResult {
  const detection = detectColumns(file);
  const filename = source?.filename ?? file.filename;

  if (!detection.ok) {
    return {
      importerId: GENERIC_IMPORTER_ID,
      label: GENERIC_IMPORTER_LABEL,
      confidence: 0,
      reasons: [
        `the columns of "${filename}" could not be worked out: ${
          detection.warnings.map((warning) => warning.message).join('; ') ||
          'no date and amount columns were found'
        }`,
      ],
      accountMask: null,
      periodStart: null,
      periodEnd: null,
      partial: false,
    };
  }

  return {
    importerId: GENERIC_IMPORTER_ID,
    label: GENERIC_IMPORTER_LABEL,
    confidence: detection.confidence,
    reasons: [
      'no dedicated importer recognised this file, so it is read through a column mapping',
      ...detection.reasons,
    ],
    accountMask: null,
    periodStart: null,
    periodEnd: null,
    partial: false,
  };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function buildHeader(rows: readonly NormalizedTxn[], direction: string): FileHeader {
  const dates = rows
    .filter((row) => row.usable && row.date !== '')
    .map((row) => row.date as CalendarDate);
  return {
    accountOrChannelId: null,
    currency: 'USD',
    periodStart: dates.length === 0 ? null : dates.reduce((a, b) => (a < b ? a : b)),
    periodEnd: dates.length === 0 ? null : dates.reduce((a, b) => (a > b ? a : b)),
    controlTotalCents: null,
    sortOrder: direction === 'ascending' ? 'asc' : direction === 'descending' ? 'desc' : 'unsorted',
    partial: false,
  };
}

/**
 * Parses with the saved mapping in `ctx.profile`, or with a proposed one when there
 * is none. Never throws for a data reason.
 */
export function parseGeneric(
  file: ParsedFile,
  ctx: ImporterContext,
): ImporterParseResult<GenericRow> {
  const issues: Issue[] = [];
  let profile: ImportProfile;

  if (ctx.profile !== undefined) {
    profile = ctx.profile;
  } else {
    const detection = detectColumns(file);
    profile = detection.profile;
    for (const warning of detection.warnings) issues.push(toIssue(warning));
    issues.push({
      severity: 'warn',
      code: 'profile.unconfirmed',
      message: `This file was read with a column mapping worked out automatically (${Math.round(
        detection.confidence * 100,
      )}% confidence, ${detection.signConvention.evidence}). Check which column is the date, which is the amount and which way the sign runs, then save the mapping — the file cannot be imported until a person has confirmed it.`,
      remedy: 'Confirm or correct the proposed mapping and save it with saveImportProfile, then preview the file again.',
    });
  }

  const missing = missingProfileColumns(file, profile);
  if (missing.length > 0) {
    issues.push({
      severity: 'fatal',
      code: 'profile.columns_missing',
      message: `The column mapping${profile.name ? ` "${profile.name}"` : ''} names columns this file does not have: ${missing
        .map((column) => (column === '' ? '(a required column was left blank)' : `"${column}"`))
        .join(', ')}.`,
      remedy: 'Pick the columns again for this file and save the mapping.',
    });
  }

  const parsed = applyProfile(file, profile);
  for (const warning of parsed.warnings) issues.push(toIssue(warning));
  for (const row of parsed.rows) for (const warning of row.warnings) issues.push(toIssue(warning));
  for (const skipped of parsed.skipped) issues.push(skippedToIssue(skipped));

  const chain = validateBalanceChain(parsed.rows, {
    ...(ctx.openingBalanceCents === undefined ? {} : { openingBalanceCents: ctx.openingBalanceCents }),
  });
  if (!chain.ok) {
    for (const broken of chain.breaks) {
      issues.push({
        severity: 'fatal',
        code: 'balance.chain_broken',
        message: `The running balance does not tie at row ${broken.rowIndex + 1}: the file says ${formatMoney(broken.actual)} where the previous balance plus this row's amount gives ${formatMoney(broken.expected)}, a difference of ${formatMoney(broken.delta)}. Rows are missing, the sign convention is inverted, or the file has been edited.`,
        rowIndex: broken.rowIndex,
        remedy:
          'Check the amount columns and the sign in the mapping; if they are right, download the statement again.',
      });
    }
  }

  const ordered = chain.ordered;
  const occurrences = assignOccurrences(ordered);
  const rows: GenericRow[] = ordered.map((row, index) => ({
    ...row,
    occurrence: occurrences[index],
    fingerprint:
      row.usable && row.date !== ''
        ? rowFingerprint({
            bankAccountId: ctx.bankAccountId,
            date: row.date,
            amountCents: row.amountCents,
            description: row.description,
            externalId: row.externalId,
            occurrence: occurrences[index],
          })
        : '',
  }));

  return {
    rows,
    issues,
    header: buildHeader(parsed.rows, chain.direction),
    skipped: parsed.skipped,
    stats: {
      physicalLines: file.rows.length,
      dataRows: parsed.meta.dataRowCount,
      skipped: parsed.meta.skippedCount,
      unusable: parsed.meta.flaggedCount,
    },
    profile,
    balanceChain: chain,
  };
}

export function genericFingerprint(row: GenericRow, ctx: ImporterContext): string {
  return rowFingerprint({
    bankAccountId: ctx.bankAccountId,
    date: row.date,
    amountCents: row.amountCents,
    description: row.description,
    externalId: row.externalId,
    occurrence: row.occurrence,
  });
}

export function previewGeneric(
  rows: readonly GenericRow[],
  _header: FileHeader,
  parsed?: ImporterParseResult<GenericRow>,
): PreviewSummary {
  const usable = rows.filter((row) => row.usable);
  const dates = usable.map((row) => row.date).filter((date): date is CalendarDate => date !== '');

  let inflowCents = 0;
  let outflowCents = 0;
  const byType = new Map<string, { count: number; amountCents: number }>();
  for (const row of usable) {
    if (row.amountCents > 0) inflowCents += row.amountCents;
    else outflowCents += row.amountCents;
    const label = (row.rawType ?? '').trim() || (row.amountCents > 0 ? '(money in)' : '(money out)');
    const bucket = byType.get(label) ?? { count: 0, amountCents: 0 };
    bucket.count += 1;
    bucket.amountCents += row.amountCents;
    byType.set(label, bucket);
  }

  const chain = parsed?.balanceChain ?? null;
  const assertions: Assertion[] = [];
  if (chain !== null && chain.checked > 0) {
    const worst = chain.breaks[0];
    assertions.push({
      id: 'bank.balance_chain',
      label: 'balance[n] == balance[n−1] + amount[n], across the whole file',
      severity: 'fatal',
      passed: chain.ok,
      expectedCents: worst?.expected ?? 0,
      actualCents: worst?.actual ?? 0,
      differenceCents: worst?.delta ?? 0,
      detail: chain.ok
        ? `${chain.checked} balance steps tie, read ${chain.direction}.`
        : `${chain.breaks.length} of ${chain.checked} balance steps do not tie.`,
    });
  }

  return {
    rowCount: usable.length,
    dateRange:
      dates.length === 0
        ? null
        : {
            min: dates.reduce((a, b) => (a < b ? a : b)),
            max: dates.reduce((a, b) => (a > b ? a : b)),
          },
    totals: { inflowCents, outflowCents, netCents: inflowCents + outflowCents },
    byType: [...byType]
      .map(([type, bucket]) => ({ type, count: bucket.count, amountCents: bucket.amountCents }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    assertions,
    needsReview: usable.length,
    excluded: 0,
  };
}

export const genericBankImporter: Importer<GenericRow> = Object.freeze({
  id: GENERIC_IMPORTER_ID,
  label: GENERIC_IMPORTER_LABEL,
  detect: detectGeneric,
  parse: parseGeneric,
  fingerprint: genericFingerprint,
  preview: previewGeneric,
});

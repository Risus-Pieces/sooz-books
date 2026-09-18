/**
 * Relay bank statement CSV — Sooz's primary intake format.
 *
 * Written from the 36 real exports in `data/statements/relay/`, not from vendor
 * documentation; `docs/formats/relay.md` is the spec derived from the same files
 * and this module implements it. The facts that shape the code:
 *
 *  - **The filename carries the account and the period.** `Relay 2026-03-01
 *    #9726.csv`, or `Relay (Partial) 2026-09-01 #9726.csv` for a month that has
 *    not closed. It preselects the bank account and bounds the expected dates.
 *  - **A header-only file is a valid import of zero rows.** 25 of the 36 real
 *    files are exactly that: an account with no activity still exports its
 *    header. An importer that calls zero data rows an error fails two thirds of
 *    the time.
 *  - **`(Partial)` files come back as complete months.** The same rows arrive
 *    twice, every month, by design. Deduplication is the normal path, not the
 *    exception, and a high duplicate count on the second import of a month is
 *    reported as normal rather than as a problem.
 *  - **`Description` is the literal string `Unknown` on 75 of 110 rows** and
 *    empty on the rest. It is never read. `Payee` is the memo and `Reference` is
 *    the detail; a ledger where three quarters of the entries say "Unknown" is
 *    the failure this rule exists to prevent.
 *  - **`RETURNED` money never moved.** The row is imported — it is on the
 *    statement and it moves the running balance, so dropping it would break the
 *    chain — but it is barred from posting and linked to the settled row it
 *    cancels, which may be days earlier and in an earlier statement.
 *  - **Rows arrive newest-first.** They are ordered chronologically before
 *    anything is numbered, because the occurrence index that makes a re-imported
 *    partial month recognisable is only stable oldest-first.
 */

import { daysBetween, monthEnd, type CalendarDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

import { applyProfile } from '@/lib/banking/apply-profile';
import { validateBalanceChain } from '@/lib/banking/balance-chain';
import { assignOccurrences, rowFingerprint } from '@/lib/banking/fingerprint';
import { normalizeDescription } from '@/lib/banking/normalize';
import type {
  BalanceChainResult,
  ImportProfile,
  NormalizedTxn,
  ParsedFile,
} from '@/lib/banking/types';

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

export const RELAY_IMPORTER_ID = 'bank.relay.csv';
export const RELAY_IMPORTER_LABEL = 'Relay business banking (CSV)';

/** All 36 real files share this header exactly, in this order. */
export const RELAY_HEADER: readonly string[] = Object.freeze([
  'Date',
  'Payee',
  'Account #',
  'Transaction Type',
  'Description',
  'Reference',
  'Status',
  'Amount',
  'Currency',
  'Balance',
]);

/** `Relay [(Partial) ]YYYY-MM-01 #NNNN.csv`. */
const FILENAME_PATTERN = /^Relay (\(Partial\) )?(\d{4})-(\d{2})-01 #(\d{4})\.csv$/i;

/**
 * The built-in column mapping, byte-identical to the `Relay CSV` rows seeded in
 * `import_profiles`.
 *
 * Two choices in here are load-bearing. `description_columns` is `['Payee']` and
 * not `['Description']`, because Relay's `Description` is the string `Unknown`.
 * And the `RETURNED` rule's action is `flag`, not `skip`: a returned ACH still
 * moves the statement's running balance, so dropping the row would break the one
 * check that proves the file was parsed completely.
 */
export const RELAY_PROFILE: ImportProfile = Object.freeze({
  name: 'Relay CSV',
  file_type: 'csv',
  delimiter: ',',
  encoding: 'utf-8',
  skip_rows: 0,
  header_row: 0,
  date_column: 'Date',
  date_format: 'M/D/YYYY',
  description_columns: ['Payee'],
  counterparty_column: 'Payee',
  mode: 'signed',
  amount_column: 'Amount',
  type_column: 'Transaction Type',
  status_column: 'Status',
  balance_column: 'Balance',
  reference_column: 'Reference',
  invert_sign: false,
  skip_row_rules: [
    {
      field: 'Status',
      op: 'exact',
      value: 'RETURNED',
      action: 'flag',
      reason: 'Returned ACH — did not settle',
    },
  ],
  detected_from_filename: '^Relay( \\(Partial\\))? \\d{4}-\\d{2}-01 #(\\d{4})\\.csv$',
} satisfies ImportProfile);

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

export const RELAY_TRANSACTION_TYPES = [
  'Spend',
  'Receive',
  'Spend-transfer',
  'Receive-transfer',
] as const;
export type RelayTransactionType = (typeof RELAY_TRANSACTION_TYPES)[number];

export type RelayStatus = 'SETTLED' | 'RETURNED';

/**
 * One Relay statement line, with everything the format encodes pulled out of the
 * strings it hides them in.
 *
 * It extends `NormalizedTxn` so it is writable to `bank_transactions` with no
 * translation layer: `description` is the payee, `reference` is the raw
 * `Reference` including the ` - Sent By …` suffix that the audit trail needs, and
 * `memo`/`detail` below are the cleaned forms meant for a human.
 */
export interface RelayRow extends NormalizedTxn {
  /** Last four of the *counterparty's* account, from `Account #`. Empty on 104 of 110 real rows. */
  readonly counterpartyMask: string | null;
  readonly settlementStatus: RelayStatus;
  /** True when `Status` is `RETURNED`: this money never moved and must not post. */
  readonly returned: boolean;
  /** `Transaction Type` as the file wrote it, when it is one Relay actually emits. */
  readonly transactionType: RelayTransactionType | null;
  /** True for `Spend-transfer` / `Receive-transfer` — money between the company's own Relay accounts. */
  readonly internalTransfer: boolean;
  /** What a human should read. The payee, cleaned of processor noise. Never `Unknown`. */
  readonly memo: string;
  /** `Reference` with the ` - Sent By X` / ` - Initiated By X` metadata removed. */
  readonly detail: string | null;
  /** The name from ` - Sent By X`, kept for the audit trail rather than the memo. */
  readonly sentBy: string | null;
  /** The name from ` - Initiated By X`. */
  readonly initiatedBy: string | null;
  /** The Square payout batch date decoded from an `SQ260126` reference. */
  readonly squareBatchDate: CalendarDate | null;
  /** The card last-four embedded in `Corporate Card - 1892 (Business Card)`. */
  readonly cardLastFour: string | null;
  /** True for `Corporate Card - 8796 (Business Virtual Card)`. */
  readonly virtualCard: boolean;
  /** `rowIndex` of the settled row this returned row cancels, when one was found. */
  readonly returnedPairRowIndex: number | null;
  /** 0-based index among rows identical in (date, amount, normalised description). */
  readonly occurrence: number;
  /** `rowFingerprint` over this row, scoped to the bank account it is imported into. */
  readonly fingerprint: string;
}

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

export interface RelayFilenameInfo {
  readonly mask: string;
  readonly periodStart: CalendarDate;
  readonly periodEnd: CalendarDate;
  readonly partial: boolean;
}

/**
 * Reads the account and the period out of a Relay export's name.
 *
 * Returns null rather than guessing: a file the user renamed is imported on the
 * strength of its header alone, with no preselected account and no expected
 * period, which is the safe failure.
 */
export function parseRelayFilename(filename: string): RelayFilenameInfo | null {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const match = FILENAME_PATTERN.exec(base.trim());
  if (match === null) return null;

  const periodStart = `${match[2]}-${match[3]}-01`;
  const month = Number(match[3]);
  if (month < 1 || month > 12) return null;

  return {
    mask: match[4],
    periodStart,
    periodEnd: monthEnd(periodStart),
    partial: match[1] !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function headerCells(file: ParsedFile): string[] {
  return (file.rows[0] ?? []).map((cell) => cell.trim());
}

function headersMatch(cells: readonly string[]): boolean {
  if (cells.length !== RELAY_HEADER.length) return false;
  return RELAY_HEADER.every(
    (expected, index) => cells[index].toLowerCase() === expected.toLowerCase(),
  );
}

const HEADER_CONFIDENCE = 0.92;
const FILENAME_BONUS = 0.06;

/**
 * Recognises a Relay export.
 *
 * The header is the evidence that matters: ten columns in one exact order, which
 * no other bank in this system emits. A matching filename raises the confidence
 * further and — more usefully — names the account and the period.
 *
 * A file *named* like a Relay export whose header is not Relay's is rejected
 * outright rather than guessed at. In practice that means someone opened it in
 * Excel and saved it back, which reorders and re-types columns silently; parsing
 * it anyway would put the balance in the amount column and nobody would notice
 * until the trial balance did.
 */
export function detectRelay(file: ParsedFile, source?: SourceFile): DetectionResult {
  const filename = source?.filename ?? file.filename;
  const named = parseRelayFilename(filename);
  const cells = headerCells(file);
  const matched = headersMatch(cells);
  const reasons: string[] = [];

  if (!matched) {
    if (named !== null) {
      return {
        importerId: RELAY_IMPORTER_ID,
        label: RELAY_IMPORTER_LABEL,
        confidence: 0,
        reasons: [
          `"${filename}" is named exactly like a Relay export but its first row is not the Relay header`,
          `expected ${RELAY_HEADER.length} columns (${RELAY_HEADER.join(', ')}), found ${cells.length} (${cells.join(', ') || 'nothing'})`,
        ],
        rejection: {
          code: 'relay.header_mismatch',
          message: `"${filename}" claims to be a Relay statement but its columns are not Relay's. The usual cause is the file having been opened and re-saved in Excel, which rewrites the header and re-types the amounts.`,
          remedy:
            'Download the statement again from the Relay dashboard (the account → Statements → CSV) and import it without opening it first.',
        },
        accountMask: named.mask,
        periodStart: named.periodStart,
        periodEnd: named.periodEnd,
        partial: named.partial,
      };
    }

    return {
      importerId: RELAY_IMPORTER_ID,
      label: RELAY_IMPORTER_LABEL,
      confidence: 0,
      reasons: [
        `the first row is not the Relay header: expected ${RELAY_HEADER.join(', ')}`,
      ],
      accountMask: null,
      periodStart: null,
      periodEnd: null,
      partial: false,
    };
  }

  reasons.push(
    `the header matches Relay's ten columns exactly, in order (${RELAY_HEADER.join(', ')})`,
  );

  let confidence = HEADER_CONFIDENCE;
  if (named !== null) {
    confidence = Math.min(1, confidence + FILENAME_BONUS);
    reasons.push(
      `the filename is Relay's own export name, so the account is ••${named.mask} and the period is ${named.periodStart} to ${named.periodEnd}`,
    );
    if (named.partial) {
      reasons.push(
        'the name says (Partial): this month has not closed, and these rows will arrive again in the complete export',
      );
    }
  } else {
    reasons.push(
      `"${filename}" is not Relay's own export name, so neither the account nor the period could be read from it`,
    );
  }

  const dataRows = Math.max(0, file.rows.length - 1);
  reasons.push(
    dataRows === 0
      ? 'header only, zero data rows — normal for a Relay account with no activity in the month'
      : `${dataRows} data row${dataRows === 1 ? '' : 's'}`,
  );

  return {
    importerId: RELAY_IMPORTER_ID,
    label: RELAY_IMPORTER_LABEL,
    confidence,
    reasons,
    accountMask: named?.mask ?? null,
    periodStart: named?.periodStart ?? null,
    periodEnd: named?.periodEnd ?? null,
    partial: named?.partial ?? false,
  };
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

const CARD_REFERENCE = /^Corporate Card\s*-\s*(\d{4})\s*\(([^)]*)\)/i;
const SQUARE_REFERENCE = /\bSQ(\d{2})(\d{2})(\d{2})\b/;
/** Relay's own audit-trail suffixes. Metadata, never part of the memo. */
const SENT_BY = /\s*-\s*Sent\s+By\s+(.+?)\s*$/i;
const INITIATED_BY = /\s*-\s*Initiated\s+By\s+(.+?)\s*$/i;

function relayTransactionType(raw: string | null): RelayTransactionType | null {
  if (raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  return (
    RELAY_TRANSACTION_TYPES.find((value) => value.toLowerCase() === trimmed) ?? null
  );
}

/**
 * Decodes Relay's Square payout reference. `SQ260126` is `SQ` + `YYMMDD`, so it
 * names the batch Square settled, which is not always the day the money landed.
 * Returns null for a shape that is not a real calendar date rather than inventing
 * one.
 */
export function squareBatchDate(reference: string | null): CalendarDate | null {
  if (reference === null) return null;
  const match = SQUARE_REFERENCE.exec(reference);
  if (match === null) return null;

  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const candidate = `${year}-${match[2]}-${match[3]}`;
  // Rejects 02-30 and friends without ever constructing a Date in local time.
  if (monthEnd(`${year}-${match[2]}-01`) < candidate) return null;
  return candidate;
}

interface ReferenceParts {
  readonly detail: string | null;
  readonly sentBy: string | null;
  readonly initiatedBy: string | null;
  readonly cardLastFour: string | null;
  readonly virtualCard: boolean;
}

/**
 * Splits a Relay `Reference` into the part a human should read and the metadata
 * that belongs in the audit trail.
 *
 * `PO SOOZ-2026-001 / CO10191 - Sent By Boxuan Zhao` is a purchase-order
 * reference plus who pushed the payment. The name is real and worth keeping; it
 * is not part of the memo.
 *
 * Only those two suffixes come off. `cleanPayee` is deliberately not used here:
 * it strips processor prefixes and trailing digit runs, which is right for a
 * merchant name and wrong for a reference, where `PO SOOZ-2026-001` and
 * `Corporate Card - 1892` are the whole point.
 */
export function parseRelayReference(reference: string | null): ReferenceParts {
  const raw = (reference ?? '').trim();
  if (raw === '') {
    return { detail: null, sentBy: null, initiatedBy: null, cardLastFour: null, virtualCard: false };
  }

  let detail = raw;
  let sentBy: string | null = null;
  let initiatedBy: string | null = null;

  const sent = SENT_BY.exec(detail);
  if (sent !== null) {
    sentBy = sent[1];
    detail = detail.slice(0, sent.index);
  }

  const initiated = INITIATED_BY.exec(detail);
  if (initiated !== null) {
    initiatedBy = initiated[1];
    detail = detail.slice(0, initiated.index);
  }

  detail = detail.replace(/[\s\-–—/|,;:]+$/, '').trim();
  const card = CARD_REFERENCE.exec(raw);

  return {
    // Never return an empty detail for a non-empty reference: if the whole
    // string was metadata, the metadata is all there is and the raw form is
    // better than nothing.
    detail: detail === '' ? raw : detail,
    sentBy,
    initiatedBy,
    cardLastFour: card === null ? null : card[1],
    virtualCard: card !== null && /virtual/i.test(card[2]),
  };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** The `Account #` column, which `import_profiles` has no slot for. */
function counterpartyMask(raw: Record<string, string>): string | null {
  const value = (raw['Account #'] ?? '').trim();
  return value === '' ? null : value;
}

function relayStatus(row: NormalizedTxn): RelayStatus {
  return (row.status ?? '').trim().toUpperCase() === 'RETURNED' ? 'RETURNED' : 'SETTLED';
}

/**
 * How far before a return its settled original may be dated.
 *
 * An ACH return usually settles one to several business days after the debit it
 * reverses (NACHA allows two banking days for most return reasons, longer for an
 * unauthorised-debit claim), and it can land in the next month's statement.
 * Fourteen calendar days is ten business days: wide enough for the real cases,
 * narrow enough that a return is not paired with an unrelated earlier charge of
 * the same size to the same payee.
 */
export const RETURN_WINDOW_DAYS = 14;

/**
 * Links each `RETURNED` row to the settled row it cancels, within this file.
 *
 * The pair has to be tight or it is worse than nothing: exactly equal and opposite
 * amounts, the same payee once normalised, and the original dated on or before
 * the return by at most {@link RETURN_WINDOW_DAYS}. The nearest such row wins, so
 * a same-day original is always preferred. The one real occurrence in nine months
 * is `5/15/2026 GOOGLE +10.00 RETURNED` against `5/15/2026 GOOGLE -10.00 SETTLED`;
 * requiring the same payee is what keeps it from matching the `5/17/2026 Rice
 * Parking -10.00` in the same file.
 *
 * A return whose original is in an earlier statement is not found here, because
 * that statement is not in this file; `commitImport` looks for it in the ledger.
 */
function linkReturnedPairs(rows: readonly NormalizedTxn[]): Map<number, number> {
  const links = new Map<number, number>();
  const claimed = new Set<number>();

  const settled = rows.filter((row) => row.usable && row.date !== '' && relayStatus(row) === 'SETTLED');
  const payeeOf = (row: NormalizedTxn): string =>
    normalizeDescription(row.counterparty ?? row.description);

  for (const row of rows) {
    if (!row.usable || row.date === '' || relayStatus(row) !== 'RETURNED') continue;
    const returnDate = row.date;
    const payee = payeeOf(row);

    let best: NormalizedTxn | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const candidate of settled) {
      if (claimed.has(candidate.rowIndex)) continue;
      if (candidate.amountCents !== -row.amountCents) continue;
      if (payeeOf(candidate) !== payee) continue;
      const gap = daysBetween(candidate.date as CalendarDate, returnDate);
      if (gap < 0 || gap > RETURN_WINDOW_DAYS) continue;
      if (gap < bestGap) {
        best = candidate;
        bestGap = gap;
      }
    }
    if (best === null) continue;

    claimed.add(best.rowIndex);
    links.set(row.rowIndex, best.rowIndex);
    links.set(best.rowIndex, row.rowIndex);
  }

  return links;
}

function buildHeader(
  rows: readonly NormalizedTxn[],
  named: RelayFilenameInfo | null,
): FileHeader {
  const dates = rows.filter((row) => row.usable && row.date !== '').map((row) => row.date);
  const currencies = new Set(
    rows.map((row) => (row.raw['Currency'] ?? '').trim().toUpperCase()).filter((value) => value !== ''),
  );

  return {
    accountOrChannelId: named?.mask ?? null,
    currency: currencies.size === 1 ? [...currencies][0] : 'USD',
    periodStart: named?.periodStart ?? (dates.length > 0 ? dates.reduce((a, b) => (a < b ? a : b)) : null),
    periodEnd: named?.periodEnd ?? (dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : null),
    // Relay prints no totals row and states no control total anywhere. The
    // running balance is the only identity this format offers, and it is a good
    // one.
    controlTotalCents: null,
    sortOrder: rows.length <= 1 ? 'unsorted' : 'desc',
    partial: named?.partial ?? false,
  };
}

/**
 * Parses a Relay export into fingerprinted, chronologically ordered rows.
 *
 * Never throws for a data reason. A row that cannot be read is reported with its
 * raw text and the rest of the file still imports; a file with no data rows at
 * all returns zero rows and no error, because that is what an account with no
 * activity looks like.
 */
export function parseRelay(file: ParsedFile, ctx: ImporterContext): ImporterParseResult<RelayRow> {
  const named = parseRelayFilename(file.filename);
  const profile = ctx.profile ?? RELAY_PROFILE;
  const issues: Issue[] = [];

  const parsed = applyProfile(file, profile, {
    ...(named === null
      ? {}
      : { expectedPeriod: { start: named.periodStart, end: named.periodEnd } }),
  });

  for (const warning of parsed.warnings) issues.push(toIssue(warning));
  for (const row of parsed.rows) for (const warning of row.warnings) issues.push(toIssue(warning));
  for (const skipped of parsed.skipped) issues.push(skippedToIssue(skipped));

  // The balance chain does two jobs at once: it proves the parse is complete and
  // it decides the chronological direction. Relay exports newest-first, and the
  // occurrence index is only stable oldest-first, so this ordering is not a
  // presentation choice — it is what keeps a re-imported partial month from
  // renumbering its own rows and duplicating them.
  const chain: BalanceChainResult = validateBalanceChain(parsed.rows, {
    ...(ctx.openingBalanceCents === undefined
      ? {}
      : { openingBalanceCents: ctx.openingBalanceCents }),
  });

  if (!chain.ok) {
    for (const broken of chain.breaks) {
      // `rowIndex` counts data rows; the physical line is that plus the header.
      const rawRow = file.rows[parsed.meta.headerRowIndex + 1 + broken.rowIndex];
      issues.push({
        severity: 'fatal',
        code: 'balance.chain_broken',
        message: `The running balance does not tie at row ${broken.rowIndex + 1}: the file says ${formatMoney(broken.actual)} where the previous balance plus this row's amount gives ${formatMoney(broken.expected)}, a difference of ${formatMoney(broken.delta)}. Rows are missing from this file or it has been edited.`,
        rowIndex: broken.rowIndex,
        ...(rawRow === undefined ? {} : { rawRow }),
        remedy:
          'Re-download the statement from the Relay dashboard without opening it, and import the whole month rather than a hand-trimmed range.',
      });
    }
  }

  const ordered = chain.ordered;
  const occurrences = assignOccurrences(ordered);
  const links = linkReturnedPairs(ordered);

  const rows: RelayRow[] = ordered.map((row, index) => {
    const status = relayStatus(row);
    const reference = parseRelayReference(row.reference);
    const type = relayTransactionType(row.rawType);
    const occurrence = occurrences[index];

    return {
      ...row,
      counterpartyMask: counterpartyMask(row.raw),
      settlementStatus: status,
      returned: status === 'RETURNED',
      transactionType: type,
      internalTransfer: type === 'Spend-transfer' || type === 'Receive-transfer',
      memo: (row.counterparty ?? row.description).trim(),
      detail: reference.detail,
      sentBy: reference.sentBy,
      initiatedBy: reference.initiatedBy,
      squareBatchDate: squareBatchDate(row.reference),
      cardLastFour: reference.cardLastFour,
      virtualCard: reference.virtualCard,
      returnedPairRowIndex: links.get(row.rowIndex) ?? null,
      occurrence,
      fingerprint:
        row.usable && row.date !== ''
          ? rowFingerprint({
              bankAccountId: ctx.bankAccountId,
              date: row.date,
              amountCents: row.amountCents,
              description: row.description,
              occurrence,
            })
          : '',
    };
  });

  const byRowIndex = new Map(rows.map((row) => [row.rowIndex, row]));
  for (const row of rows) {
    if (!row.returned) continue;
    const original =
      row.returnedPairRowIndex === null ? undefined : byRowIndex.get(row.returnedPairRowIndex);
    issues.push({
      severity: 'warn',
      code: 'relay.returned',
      message:
        original === undefined
          ? `${row.date} ${row.memo} ${formatMoney(row.amountCents)} is a RETURNED ACH: it did not settle, so it is imported for the record but barred from posting. The settled row it reverses is not in this file; the import looks for it among the transactions already imported.`
          : `${row.date} ${row.memo} ${formatMoney(row.amountCents)} is a RETURNED ACH cancelling the ${original.date === row.date ? 'settled row on the same day' : `settled row of ${original.date}`} for the opposite amount. Both sides are imported and both are barred from posting: together they net to zero and no money moved.`,
      rowIndex: row.rowIndex,
      remedy: 'Nothing to do unless the pair is wrong; a returned ACH is not income and not an expense.',
    });
  }

  const unknownTypes = new Map<string, number>();
  for (const row of rows) {
    if (row.transactionType !== null || !row.usable) continue;
    const raw = (row.rawType ?? '').trim();
    if (raw === '') continue;
    unknownTypes.set(raw, (unknownTypes.get(raw) ?? 0) + 1);
  }
  for (const [type, count] of unknownTypes) {
    issues.push({
      severity: 'warn',
      code: 'type.unknown',
      message: `Relay has started writing a Transaction Type this importer does not know: "${type}" on ${count} row${count === 1 ? '' : 's'}. The rows are imported; the type is kept verbatim and is worth reading before they are categorized.`,
      field: 'Transaction Type',
    });
  }

  if (named !== null && ctx.bankAccountMask != null && named.mask !== ctx.bankAccountMask) {
    issues.push({
      severity: 'fatal',
      code: 'relay.account_mismatch',
      message: `"${file.filename}" is account ••${named.mask}'s statement, but it is being imported into ••${ctx.bankAccountMask}. Importing one Relay account's rows into another would misstate both balances and could not be undone by a re-import.`,
      remedy: `Import this file into the ••${named.mask} account, or pick the file whose name ends #${ctx.bankAccountMask}.`,
    });
  }

  return {
    rows,
    issues,
    header: buildHeader(parsed.rows, named),
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

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * The per-row deduplication key, scoped to the account.
 *
 * Relay ships no transaction id of any kind, so the key is
 * `sha256(account | date | cents | normalise(payee) | occurrence)` — and
 * deliberately not the running balance (it changes whenever a later row is
 * added), the category (banks recategorise retroactively), the filename or the
 * row index, any of which would make the same transaction look new on the second
 * import of a month.
 */
export function relayFingerprint(row: RelayRow, ctx: ImporterContext): string {
  return rowFingerprint({
    bankAccountId: ctx.bankAccountId,
    date: row.date,
    amountCents: row.amountCents,
    description: row.description,
    occurrence: row.occurrence,
  });
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * The §1.4 summary and the one identity this format offers.
 *
 * Relay prints no totals row, so there is nothing to tie a sum to. What it does
 * print is a running balance on every row, which is a stronger check than a
 * control total: a control total proves the sum is right, the balance chain
 * proves every individual row is.
 */
export function previewRelay(
  rows: readonly RelayRow[],
  header: FileHeader,
  parsed?: ImporterParseResult<RelayRow>,
): PreviewSummary {
  const usable = rows.filter((row) => row.usable);
  const dates = usable.map((row) => row.date).filter((date): date is CalendarDate => date !== '');

  let inflowCents = 0;
  let outflowCents = 0;
  const byType = new Map<string, { count: number; amountCents: number }>();

  for (const row of usable) {
    if (row.amountCents > 0) inflowCents += row.amountCents;
    else outflowCents += row.amountCents;

    const key = row.transactionType ?? (row.rawType ?? '').trim();
    const label = key === '' ? '(no type)' : key;
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
        ? `${chain.checked} balance steps tie, read ${chain.direction}. Opening ${formatMoney(chain.openingBalanceCents ?? 0)}, closing ${formatMoney(chain.closingBalanceCents ?? 0)}.`
        : `${chain.breaks.length} of ${chain.checked} balance steps do not tie; the first is at row ${(worst?.rowIndex ?? 0) + 1}.`,
    });
  } else if (chain !== null) {
    assertions.push({
      id: 'bank.balance_chain',
      label: 'balance[n] == balance[n−1] + amount[n], across the whole file',
      severity: 'fatal',
      passed: true,
      expectedCents: 0,
      actualCents: 0,
      differenceCents: 0,
      detail:
        rows.length === 0
          ? 'No data rows to chain. A header-only Relay export is an account with no activity that month, not an error.'
          : 'No row in this file carries a balance, so there is nothing to chain.',
    });
  }

  const { periodStart, periodEnd } = header;
  if (periodStart !== null && periodEnd !== null && dates.length > 0) {
    const outside = dates.filter((date) => date < periodStart || date > periodEnd).length;
    assertions.push({
      id: 'relay.dates_within_period',
      label: 'every row falls inside the month the filename names',
      severity: 'warn',
      passed: outside === 0,
      expectedCents: 0,
      actualCents: 0,
      differenceCents: 0,
      detail:
        outside === 0
          ? `all ${dates.length} rows fall between ${periodStart} and ${periodEnd}`
          : `${outside} row${outside === 1 ? '' : 's'} fall outside ${periodStart}..${periodEnd}`,
    });
  }

  const excluded = usable.filter(
    (row) => row.returned || row.returnedPairRowIndex !== null,
  ).length;

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
    // Everything a Relay file carries needs a human decision: the file states no
    // category and never will. What it does not need is the returned pair, which
    // nets to zero and is barred from posting outright.
    needsReview: usable.length - excluded,
    excluded,
  };
}

// ---------------------------------------------------------------------------
// The importer
// ---------------------------------------------------------------------------

/**
 * `toEntries` is absent on purpose. A Relay row says `-8.19 Target` and nothing
 * at all about which account that belongs in; the contra account comes from a
 * rule, a vendor default or a human, none of which is in the file. The entry is
 * built later from the reviewed `bank_transactions` row.
 */
export const relayImporter: Importer<RelayRow> = Object.freeze({
  id: RELAY_IMPORTER_ID,
  label: RELAY_IMPORTER_LABEL,
  detect: detectRelay,
  parse: parseRelay,
  fingerprint: relayFingerprint,
  preview: previewRelay,
});

/** The window a Relay statement is expected to cover, read off its own filename. */
export function relayExpectedPeriod(
  filename: string,
): { start: CalendarDate; end: CalendarDate } | null {
  const named = parseRelayFilename(filename);
  return named === null ? null : { start: named.periodStart, end: named.periodEnd };
}

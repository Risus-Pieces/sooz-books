/**
 * Square settlements, from an uploaded export into `payout_imports`.
 *
 * `./square` parses a settlement export, asserts each settlement's arithmetic and
 * matches a payout to the Relay deposits that carry its `SQ` + YYMMDD reference.
 * This module is the intake around it: it is what a script or the upload screen
 * calls, and the only code that writes `payout_imports` and `payout_lines`.
 *
 * Why it matters: the auto-post rule "Square payout to clearing" codes every Square
 * deposit to 1150 Square Clearing. Those deposits are *net* of Square's fee. Only
 * the settlement says what the gross sale, the tax and the fee were, so until a
 * settlement is imported, clearing holds a debit balance and 4015 revenue and 5540
 * fees are zero. Each settlement written here carries that gross decomposition and
 * is linked to the deposits that clear it.
 *
 * What it guarantees:
 *
 *   - **Nothing is written unless the whole file ties.** Any settlement failing its
 *     fatal identity, or any row lost to an unreadable date or amount, refuses the
 *     file (`previewSquareSettlements().ok`). A partly imported settlement file
 *     would clear some deposits and strand the rest.
 *   - **Re-importing is free.** Each settlement is keyed by `settlementKey` (the
 *     Square settlement id when the file has one) in `payout_imports.external_id`,
 *     unique per provider. An overlapping date range imports only what is new.
 *     `file_hash` is deliberately left null: one export holds many settlements and
 *     the column's unique index allows one row per file.
 *   - **A deposit clears one payout.** Matched bank rows are marked
 *     `matched_type = 'payout'`, `matched_id = <payout_imports.id>`, and a row
 *     already matched is never offered to another payout. Three deposits clearing
 *     one payout (2026-01-26: +161.67, +3.25, +0.82) are all linked.
 *   - **Accounts are resolved when posting, not here.** Each line keeps its semantic
 *     account role (`square_sales`, `payment_processing_fees`, …; the role → account
 *     table is `docs/formats/square.md` §7b), and `clearing_account_id` /
 *     `payout_lines.account_id` are left for the posting phase to fill.
 *
 * No real Square export has been seen yet (see `./square`). The format contract is
 * inferred; validate the parser against a real export before posting from it.
 */

import { and, eq, inArray, isNull, sql as sqlTag } from 'drizzle-orm';

import { bankTransactions, channels, payoutImports, payoutLines, type ImportIssue } from '@/db/schema';
import { fileHash } from '@/lib/banking/fingerprint';
import { readFile } from '@/lib/banking/read-file';
import type { CalendarDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

import {
  SquareFormatError,
  assertSettlementBalances,
  matchSquarePayoutToBankTransaction,
  parseSquareSettlements,
  previewSquareSettlements,
  type BankTransactionCandidate,
  type SettlementBalanceReport,
  type SquareComponent,
  type SquareParseOptions,
  type SquarePayoutMatch,
  type SquarePayoutMatchStatus,
  type SquareSettlement,
  type SquarePreview,
  type SquareWarning,
} from './square';

/**
 * The channel a Square settlement belongs to.
 *
 * Square is the processor for Sooz's direct and market sales, which the seed files
 * under DTC (migration 0011 points Square Clearing's `clearing_for_channel_id` at it).
 */
const SQUARE_CHANNEL_CODE = 'DTC';

/** `bank_transactions.matched_type` for a deposit cleared by a payout. */
const PAYOUT_MATCH_TYPE = 'payout';

type PayoutLineType =
  | 'gross_sales'
  | 'refund'
  | 'discount'
  | 'gift_card'
  | 'sales_tax_collected'
  | 'tip'
  | 'processing_fee'
  | 'other';

const LINE_TYPE: Readonly<Record<SquareComponent, PayoutLineType>> = Object.freeze({
  gross_sales: 'gross_sales',
  returns: 'refund',
  partial_refunds: 'refund',
  discounts: 'discount',
  // No line type of its own; the component in `raw` keeps it distinct from "other".
  service_charges: 'other',
  gift_card_sales: 'gift_card',
  tax: 'sales_tax_collected',
  tip: 'tip',
  fees: 'processing_fee',
  other: 'other',
});

export class SquareImportError extends Error {
  readonly code: string;
  readonly remedy: string | null;

  constructor(code: string, message: string, remedy: string | null = null) {
    super(message);
    this.name = 'SquareImportError';
    this.code = code;
    this.remedy = remedy;
  }
}

export interface ImportSquareSettlementsInput {
  readonly filename: string;
  readonly bytes: Uint8Array | ArrayBuffer;
  /** Actor for the audit trail. */
  readonly userId: string | null;
  readonly parseOptions?: SquareParseOptions;
  /** Days after a settlement date whose `SQ` codes still count as its deposit. Default 5. */
  readonly lagDays?: number;
  /** Parse, assert and match, and write nothing. */
  readonly dryRun?: boolean;
}

export interface SquareSettlementOutcome {
  readonly key: string;
  readonly settlementId: string | null;
  readonly date: CalendarDate;
  readonly bankReference: string;
  readonly grossCents: number;
  readonly feesCents: number;
  readonly netCents: number;
  /** `already_imported` when a previous file carried this settlement. */
  readonly outcome: 'new' | 'already_imported';
  readonly payoutImportId: string | null;
  readonly match: {
    readonly status: SquarePayoutMatchStatus;
    readonly bankTransactionIds: readonly string[];
    readonly differenceCents: number;
    readonly reason: string;
  } | null;
}

export interface SquareImportResult {
  readonly filename: string;
  readonly fileHash: string;
  readonly preview: SquarePreview;
  readonly settlements: readonly SquareSettlementOutcome[];
  /** Settlements written by this call. Zero on a dry run. */
  readonly inserted: number;
  readonly alreadyImported: number;
  /** Bank deposits linked to a payout by this call. */
  readonly depositsLinked: number;
  readonly written: boolean;
}

interface PlannedSettlement {
  readonly settlement: SquareSettlement;
  readonly report: SettlementBalanceReport;
  /** The `payout_imports.id` of an earlier import of this settlement. */
  readonly alreadyId: string | null;
  readonly match: SquarePayoutMatch | null;
}

function toIssue(warning: SquareWarning): ImportIssue {
  return {
    severity: warning.severity,
    code: warning.code,
    message: warning.message,
    ...(warning.rowIndex === undefined ? {} : { rowIndex: warning.rowIndex }),
    ...(warning.field === undefined ? {} : { field: warning.field }),
  };
}

/**
 * Imports a Square settlement export.
 *
 * Throws `SquareImportError` when the file is not a settlement export or does not
 * tie (nothing is written in either case). On a dry run an untied file is returned
 * with `preview.ok === false` instead, so the screen can show why.
 */
export async function importSquareSettlements(
  input: ImportSquareSettlementsInput,
): Promise<SquareImportResult> {
  const bytes = input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : input.bytes;
  const hash = fileHash(bytes);
  const file = await readFile(bytes, input.filename);

  let parsed: ReturnType<typeof parseSquareSettlements>;
  try {
    parsed = parseSquareSettlements(file, input.parseOptions ?? {});
  } catch (error) {
    if (error instanceof SquareFormatError) {
      throw new SquareImportError(error.code, error.message, error.remedy);
    }
    throw error;
  }

  const preview = previewSquareSettlements(parsed);
  if (!preview.ok && input.dryRun !== true) {
    const reasons = preview.warnings
      .filter((warning) => warning.severity === 'fatal' || warning.severity === 'error')
      .map((warning) => warning.message);
    throw new SquareImportError(
      'square.not_importable',
      `"${input.filename}" cannot be imported, and nothing from it was written: ${
        reasons.join(' ') ||
        (preview.settlementCount === 0 ? 'it holds no settlements.' : 'a settlement does not tie.')
      }`,
      'Export the settlement report again from the Square Dashboard; never adjust a figure to make it tie.',
    );
  }

  const { db, withActor } = await import('@/db/client');

  const keys = parsed.settlements.map((settlement) => settlement.key);
  const existing =
    keys.length === 0
      ? []
      : await db
          .select({ id: payoutImports.id, externalId: payoutImports.externalId })
          .from(payoutImports)
          .where(and(eq(payoutImports.provider, 'square'), inArray(payoutImports.externalId, keys)));
  const existingByKey = new Map(existing.map((row) => [row.externalId, row.id]));

  // Deposits carrying an SQ code that no payout has claimed yet.
  const deposits = await db
    .select({
      id: bankTransactions.id,
      date: bankTransactions.txnDate,
      amountCents: bankTransactions.amountCents,
      reference: bankTransactions.reference,
      description: bankTransactions.description,
    })
    .from(bankTransactions)
    .where(
      and(
        sqlTag`${bankTransactions.reference} ~* 'SQ[0-9]{6}'`,
        isNull(bankTransactions.matchedId),
        isNull(bankTransactions.reconciliationId),
      ),
    )
    .orderBy(bankTransactions.txnDate, bankTransactions.id);

  const claimed = new Set<string>();
  const planned = parsed.settlements.map((settlement): PlannedSettlement => {
    const report = assertSettlementBalances(settlement);
    const alreadyId = existingByKey.get(settlement.key) ?? null;
    if (alreadyId !== null) return { settlement, report, alreadyId, match: null };

    const candidates: BankTransactionCandidate[] = deposits.filter((row) => !claimed.has(row.id));
    const match = matchSquarePayoutToBankTransaction(
      { key: settlement.key, depositDate: settlement.date, netCents: settlement.reportedNetCents },
      candidates,
      input.lagDays === undefined ? {} : { lagDays: input.lagDays },
    );
    // A partial match is money still in transit; only a full match claims deposits.
    if (match.status === 'matched') for (const row of match.matched) claimed.add(row.id);
    return { settlement, report, alreadyId: null, match };
  });

  const outcomes: SquareSettlementOutcome[] = [];
  let inserted = 0;
  let depositsLinked = 0;

  const describe = (
    entry: PlannedSettlement,
    payoutImportId: string | null,
    outcome: 'new' | 'already_imported',
  ): SquareSettlementOutcome => ({
    key: entry.settlement.key,
    settlementId: entry.settlement.settlementId,
    date: entry.settlement.date,
    bankReference: entry.settlement.bankReference,
    grossCents: entry.settlement.componentCents.gross_sales,
    feesCents: entry.settlement.componentCents.fees,
    netCents: entry.settlement.reportedNetCents,
    outcome,
    payoutImportId,
    match:
      entry.match === null
        ? null
        : {
            status: entry.match.status,
            bankTransactionIds:
              entry.match.status === 'matched' ? entry.match.matched.map((row) => row.id) : [],
            differenceCents: entry.match.differenceCents,
            reason: entry.match.reason,
          },
  });

  if (input.dryRun === true) {
    for (const entry of planned) {
      outcomes.push(describe(entry, entry.alreadyId, entry.alreadyId === null ? 'new' : 'already_imported'));
    }
    return {
      filename: input.filename,
      fileHash: hash,
      preview,
      settlements: outcomes,
      inserted: 0,
      alreadyImported: planned.filter((entry) => entry.alreadyId !== null).length,
      depositsLinked: 0,
      written: false,
    };
  }

  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.code, SQUARE_CHANNEL_CODE))
    .limit(1);
  if (channel === undefined) {
    throw new SquareImportError(
      'square.channel_missing',
      `No ${SQUARE_CHANNEL_CODE} channel exists to file Square settlements under.`,
    );
  }

  await withActor(input.userId, async (tx) => {
    for (const entry of planned) {
      if (entry.alreadyId !== null) {
        outcomes.push(describe(entry, entry.alreadyId, 'already_imported'));
        continue;
      }

      const { settlement, report, match } = entry;
      const netAssertion = report.assertions.find((assertion) => assertion.id === 'square.net_total');
      const matchedRows = match !== null && match.status === 'matched' ? match.matched : [];
      const depositDate =
        matchedRows.length === 0
          ? null
          : matchedRows.map((row) => row.date).reduce((a, b) => (a > b ? a : b));

      const warnings: ImportIssue[] = [
        ...settlement.warnings.map(toIssue),
        {
          severity: 'info',
          code: 'square.source_file',
          message: `Imported from "${input.filename}" (sha256 ${hash}).`,
        },
      ];
      if (match !== null) {
        warnings.push({
          severity: match.status === 'matched' ? 'info' : 'warn',
          code: `square.deposit_${match.status}`,
          message: match.reason,
        });
      }

      const [row] = await tx
        .insert(payoutImports)
        .values({
          provider: 'square',
          channelId: channel.id,
          externalId: settlement.key,
          periodStart: settlement.date,
          periodEnd: settlement.date,
          depositDate,
          reportedTotalCents: settlement.reportedNetCents,
          computedTotalCents: netAssertion?.actualCents ?? settlement.reportedNetCents,
          grossCents: settlement.componentCents.gross_sales,
          feesCents: settlement.componentCents.fees,
          netCents: settlement.reportedNetCents,
          status: matchedRows.length > 0 ? 'deposited' : 'imported',
          discrepancyCents: report.differenceCents,
          filename: input.filename,
          fileHash: null,
          bankTransactionId: matchedRows.length === 1 ? matchedRows[0].id : null,
          warnings,
          importedBy: input.userId,
        })
        .onConflictDoNothing({
          target: [payoutImports.provider, payoutImports.externalId],
          where: sqlTag`${payoutImports.externalId} is not null`,
        })
        .returning({ id: payoutImports.id });

      if (row === undefined) {
        // Another import of the same settlement landed between the read and the write.
        outcomes.push(describe({ ...entry, match: null }, null, 'already_imported'));
        continue;
      }
      inserted += 1;

      // A column the file carries with a zero in it is not a line of the payout.
      const lines = settlement.lines.filter((line) => line.amountCents !== 0);
      if (lines.length > 0) {
        await tx.insert(payoutLines).values(
          lines.map((line, index) => ({
            payoutImportId: row.id,
            lineNo: index + 1,
            lineType: LINE_TYPE[line.component],
            postedDate: settlement.date,
            externalRef: settlement.settlementId,
            amountCents: line.amountCents,
            description: `${line.label} — ${settlement.bankReference}`,
            raw: {
              component: line.component,
              label: line.label,
              accountRole: line.accountRole,
              fingerprint: line.fingerprint,
              rowIndexes: line.rowIndexes.join(','),
            },
          })),
        );
      }

      if (matchedRows.length > 0) {
        const ids = matchedRows.map((candidate) => candidate.id);
        const linked = await tx
          .update(bankTransactions)
          .set({ matchedType: PAYOUT_MATCH_TYPE, matchedId: row.id })
          .where(
            and(
              inArray(bankTransactions.id, ids),
              isNull(bankTransactions.matchedId),
              isNull(bankTransactions.reconciliationId),
            ),
          )
          .returning({ id: bankTransactions.id });
        if (linked.length !== ids.length) {
          throw new SquareImportError(
            'square.deposit_changed',
            `A deposit for ${settlement.bankReference} (${formatMoney(settlement.reportedNetCents)}) was matched or reconciled while this import ran. Nothing was written; import the file again.`,
          );
        }
        depositsLinked += linked.length;
      }

      outcomes.push(describe(entry, row.id, 'new'));
    }
  });

  return {
    filename: input.filename,
    fileHash: hash,
    preview,
    settlements: outcomes,
    inserted,
    alreadyImported: outcomes.filter((outcome) => outcome.outcome === 'already_imported').length,
    depositsLinked,
    written: true,
  };
}

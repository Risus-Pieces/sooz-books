/**
 * Shopify, Amazon and Faire settlements, from an uploaded export into `payout_imports`.
 *
 * The same contract, and the same guarantees, as the Square intake
 * (`@/lib/importers/square-intake`):
 *
 *   - **Nothing is written unless the whole file ties.** Every settlement's fatal identity
 *     must pass and no row may be lost; otherwise the file is refused (a dry run returns the
 *     parse instead, so the screen can say why).
 *   - **Re-importing is free.** Each settlement is keyed by its provider key in
 *     `payout_imports.external_id`, unique per provider. A settlement already imported is
 *     skipped; one whose key matches but whose total differs is refused, because a closed
 *     settlement never changes and a changed one means an edited file.
 *   - **Accounts are resolved when posting, not here.** Each line keeps its semantic role in
 *     `payout_lines.raw.accountRole`; `./post` turns roles into accounts.
 *   - **Nothing posts from here.** Importing records the settlement. Posting it is a
 *     separate, human-approved step (`postPayout`).
 *
 * A deposit that is the only candidate for a settlement — the exact net, from the provider,
 * inside the deposit window — is linked to it, as the Square intake links `SQ` deposits.
 */

import { and, desc, eq, inArray, lt, sql as sqlTag } from 'drizzle-orm';

import { bankTransactions, channels, payoutImports, payoutLines, type ImportIssue, type PayoutLineType } from '@/db/schema';
import { UnreadableFileError } from '@/lib/banking/read-file';
import type { CalendarDate } from '@/lib/dates';
import type { Issue } from '@/lib/importers/types';
import type { LedgerDb } from '@/lib/ledger/post';
import { formatMoney, sumCents } from '@/lib/money';

import { PROVIDER_CHANNEL, PROVIDER_LABEL, type SettlementProvider } from './accounts';
import { parseAmazonSettlement } from './amazon';
import { type ChannelCtx, inChannelTx } from './context';
import { ChannelError } from './errors';
import { type FaireCandidate, parseFaireSettlements } from './faire';
import { PAYOUT_MATCH_TYPE, findDepositCandidates } from './post';
import { parseShopifyPayouts } from './shopify';
import { type ParsedSettlement, type SettlementFile, SettlementFormatError } from './types';

export interface UploadedFile {
  readonly filename: string;
  readonly bytes: Uint8Array | ArrayBuffer;
}

export type ChannelImportInput =
  | { readonly provider: 'shopify'; readonly balance: UploadedFile; readonly orders?: UploadedFile }
  | { readonly provider: 'amazon'; readonly file: UploadedFile }
  | { readonly provider: 'faire'; readonly file: UploadedFile; readonly candidate?: FaireCandidate };

export interface ChannelImportOptions {
  /** Parse, assert and look for deposits, and write nothing. */
  readonly dryRun?: boolean;
}

export interface SettlementOutcome {
  readonly key: string;
  readonly periodEnd: CalendarDate;
  readonly netCents: number;
  readonly grossCents: number;
  readonly lineCount: number;
  readonly outcome: 'new' | 'already_imported';
  readonly payoutImportId: string | null;
  /** The bank deposit linked to it, when exactly one candidate existed. */
  readonly depositId: string | null;
}

export interface ChannelImportResult {
  readonly provider: SettlementProvider;
  readonly filename: string;
  readonly fileHash: string;
  readonly parsed: SettlementFile;
  readonly settlements: readonly SettlementOutcome[];
  readonly inserted: number;
  readonly alreadyImported: number;
  readonly depositsLinked: number;
  readonly written: boolean;
}

function toBytes(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
}

/** Parses the upload with its provider's importer. Throws `ChannelError('not_importable')` for a file that is not one. */
export async function parseChannelFile(input: ChannelImportInput): Promise<SettlementFile> {
  try {
    switch (input.provider) {
      case 'shopify':
        return await parseShopifyPayouts({
          balance: { filename: input.balance.filename, bytes: toBytes(input.balance.bytes) },
          ...(input.orders === undefined ? {} : { orders: { filename: input.orders.filename, bytes: toBytes(input.orders.bytes) } }),
        });
      case 'amazon':
        return parseAmazonSettlement(toBytes(input.file.bytes), { filename: input.file.filename });
      case 'faire':
        return await parseFaireSettlements(toBytes(input.file.bytes), {
          filename: input.file.filename,
          ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
        });
    }
  } catch (error) {
    if (error instanceof SettlementFormatError) throw new ChannelError('not_importable', error.message, error.remedy);
    if (error instanceof UnreadableFileError) throw new ChannelError('not_importable', error.message, error.remedy);
    throw error;
  }
}

function issuesOf(file: SettlementFile, settlement: ParsedSettlement): ImportIssue[] {
  const toImport = (issue: Issue): ImportIssue => ({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    ...(issue.rowIndex === undefined ? {} : { rowIndex: issue.rowIndex }),
    ...(issue.rawRow === undefined ? {} : { rawRow: [...issue.rawRow] }),
    ...(issue.field === undefined ? {} : { field: issue.field }),
    ...(issue.remedy === undefined ? {} : { remedy: issue.remedy }),
  });
  return [
    ...settlement.issues.map(toImport),
    ...file.issues.filter((issue) => issue.severity !== 'info').map(toImport),
    ...settlement.assertions.map((a) => ({
      severity: a.passed ? ('info' as const) : a.severity,
      code: a.id,
      message: a.detail ?? a.label,
    })),
    {
      severity: 'info',
      code: `${file.provider}.source_file`,
      message: `Imported from "${file.filename}" (sha256 ${file.fileHash}) by ${file.importerId}.`,
    },
    ...(settlement.depositDate === null
      ? []
      : [{ severity: 'info' as const, code: `${file.provider}.expected_deposit`, message: `The provider dates the payout ${settlement.depositDate}.` }]),
  ];
}

const FEE_TYPES: ReadonlySet<PayoutLineType> = new Set<PayoutLineType>([
  'referral_fee',
  'processing_fee',
  'fulfillment_fee',
  'storage_fee',
  'shipping_cost',
  'advertising',
  'subscription_fee',
]);

/** The one unclaimed deposit that can be this settlement's, or null when there is none or more than one. */
async function soleDeposit(
  tx: LedgerDb,
  provider: string,
  netCents: number,
  from: CalendarDate,
  claimed: ReadonlySet<string>,
): Promise<string | null> {
  const matches = (await findDepositCandidates(tx, provider, netCents, from)).filter((row) => !claimed.has(row.id));
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * Imports a Shopify, Amazon or Faire settlement export.
 *
 * @throws {ChannelError} `not_importable` when the file is not the provider's export or does
 *   not tie (nothing is written); `invalid_input` when a settlement's key was imported
 *   before with a different total.
 */
export async function importChannelSettlements(
  input: ChannelImportInput,
  ctx: ChannelCtx,
  options: ChannelImportOptions = {},
): Promise<ChannelImportResult> {
  const parsed = await parseChannelFile(input);
  const dryRun = options.dryRun === true;
  const label = PROVIDER_LABEL[parsed.provider];

  if (!parsed.ok && !dryRun) {
    const reasons = [
      ...parsed.issues.filter((i) => i.severity === 'fatal' || i.severity === 'error').map((i) => i.message),
      ...parsed.settlements.flatMap((s) => [
        ...s.issues.filter((i) => i.severity === 'fatal').map((i) => i.message),
        ...s.assertions.filter((a) => !a.passed && a.severity === 'fatal').map((a) => a.detail ?? a.label),
      ]),
    ];
    throw new ChannelError(
      'not_importable',
      `"${parsed.filename}" cannot be imported, and nothing from it was written: ${reasons.join(' ') || 'it does not tie.'}`,
      `Export the ${label} file again; never adjust a figure to make it tie.`,
    );
  }

  const run = async (tx: LedgerDb): Promise<ChannelImportResult> => {
    const keys = parsed.settlements.map((s) => s.key);
    const existing =
      keys.length === 0
        ? []
        : await tx
            .select({ id: payoutImports.id, externalId: payoutImports.externalId, reported: payoutImports.reportedTotalCents })
            .from(payoutImports)
            .where(and(eq(payoutImports.provider, parsed.provider), inArray(payoutImports.externalId, keys)));
    const existingByKey = new Map(existing.map((row) => [row.externalId, row]));

    // A Shopify payout key carries its total; the same payout date with another total is an edited payout.
    if (parsed.provider === 'shopify') {
      for (const settlement of parsed.settlements) {
        if (existingByKey.has(settlement.key)) continue;
        const prefix = settlement.key.slice(0, settlement.key.lastIndexOf(':') + 1);
        const [clash] = await tx
          .select({ externalId: payoutImports.externalId })
          .from(payoutImports)
          .where(and(eq(payoutImports.provider, 'shopify'), sqlTag`${payoutImports.externalId} like ${`${prefix}%`}`))
          .limit(1);
        if (clash !== undefined) {
          throw new ChannelError(
            'invalid_input',
            `A Shopify payout dated ${settlement.periodEnd} was already imported with a different total (${clash.externalId}). A paid payout never changes; nothing was written.`,
            'Compare the two exports in Shopify before importing again.',
          );
        }
      }
    }
    for (const settlement of parsed.settlements) {
      const prior = existingByKey.get(settlement.key);
      if (prior !== undefined && prior.reported !== settlement.reportedNetCents) {
        throw new ChannelError(
          'invalid_input',
          `${label} settlement ${settlement.key} was imported before with a total of ${formatMoney(prior.reported ?? 0)}; this file says ${formatMoney(settlement.reportedNetCents)}. A closed settlement never changes, so nothing was written.`,
          'Re-download the settlement from the provider; the file may have been edited.',
        );
      }
    }

    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.code, PROVIDER_CHANNEL[parsed.provider]))
      .limit(1);
    if (channel === undefined) {
      throw new ChannelError('not_found', `No ${PROVIDER_CHANNEL[parsed.provider]} channel exists to file ${label} settlements under.`);
    }

    const outcomes: SettlementOutcome[] = [];
    const claimed = new Set<string>();
    let inserted = 0;
    let depositsLinked = 0;

    for (const settlement of parsed.settlements) {
      const gross = sumCents(settlement.lines.filter((l) => l.lineType === 'gross_sales').map((l) => l.amountCents));
      const base = {
        key: settlement.key,
        periodEnd: settlement.periodEnd,
        netCents: settlement.reportedNetCents,
        grossCents: gross,
        lineCount: settlement.lines.length,
      };
      const prior = existingByKey.get(settlement.key);
      if (prior !== undefined) {
        outcomes.push({ ...base, outcome: 'already_imported', payoutImportId: prior.id, depositId: null });
        continue;
      }

      const depositId = await soleDeposit(tx, parsed.provider, settlement.reportedNetCents, settlement.depositDate ?? settlement.periodEnd, claimed);
      if (depositId !== null) claimed.add(depositId);
      if (dryRun) {
        outcomes.push({ ...base, outcome: 'new', payoutImportId: null, depositId });
        continue;
      }

      const warnings = issuesOf(parsed, settlement);
      if (parsed.provider === 'amazon') warnings.push(...(await reserveChain(tx, settlement)));

      const [row] = await tx
        .insert(payoutImports)
        .values({
          provider: parsed.provider,
          channelId: channel.id,
          externalId: settlement.key,
          periodStart: settlement.periodStart,
          periodEnd: settlement.periodEnd,
          depositDate: null,
          reportedTotalCents: settlement.reportedNetCents,
          computedTotalCents: sumCents(settlement.lines.map((l) => l.amountCents)),
          grossCents: gross,
          feesCents: sumCents(settlement.lines.filter((l) => FEE_TYPES.has(l.lineType)).map((l) => l.amountCents)),
          netCents: settlement.reportedNetCents,
          status: 'imported',
          discrepancyCents: sumCents(settlement.lines.map((l) => l.amountCents)) - settlement.reportedNetCents,
          filename: parsed.filename,
          fileHash: null,
          warnings,
          importedBy: ctx.userId,
        })
        .onConflictDoNothing({
          target: [payoutImports.provider, payoutImports.externalId],
          where: sqlTag`${payoutImports.externalId} is not null`,
        })
        .returning({ id: payoutImports.id });
      if (row === undefined) {
        outcomes.push({ ...base, outcome: 'already_imported', payoutImportId: null, depositId: null });
        continue;
      }
      inserted += 1;

      if (settlement.lines.length > 0) {
        await tx.insert(payoutLines).values(
          settlement.lines.map((line, index) => ({
            payoutImportId: row.id,
            lineNo: index + 1,
            lineType: line.lineType,
            postedDate: line.postedDate,
            externalRef: line.externalRef,
            sku: line.sku,
            quantity: line.quantity,
            amountCents: line.amountCents,
            jurisdiction: line.jurisdiction,
            description: line.label,
            raw: {
              accountRole: line.role,
              label: line.label,
              fingerprint: line.fingerprint,
              rowIndexes: line.rowIndexes.join(','),
              taxRegime: line.taxRegime,
              taxSide: line.taxSide,
              taxableCents: line.taxableCents === null ? null : String(line.taxableCents),
            },
          })),
        );
      }

      if (depositId !== null) {
        const linked = await tx
          .update(bankTransactions)
          .set({ matchedType: PAYOUT_MATCH_TYPE, matchedId: row.id })
          .where(and(eq(bankTransactions.id, depositId), sqlTag`${bankTransactions.matchedId} is null`))
          .returning({ id: bankTransactions.id, date: bankTransactions.txnDate });
        if (linked.length === 1) {
          depositsLinked += 1;
          await tx
            .update(payoutImports)
            .set({ depositDate: linked[0].date, bankTransactionId: depositId, status: 'deposited' })
            .where(eq(payoutImports.id, row.id));
        }
      }
      outcomes.push({ ...base, outcome: 'new', payoutImportId: row.id, depositId });
    }

    return {
      provider: parsed.provider,
      filename: parsed.filename,
      fileHash: parsed.fileHash,
      parsed,
      settlements: outcomes,
      inserted,
      alreadyImported: outcomes.filter((o) => o.outcome === 'already_imported').length,
      depositsLinked,
      written: !dryRun,
    };
  };

  if (dryRun) {
    const exec = ctx.tx ?? (await import('@/db/client')).db;
    return run(exec);
  }
  return inChannelTx(ctx, run);
}

/**
 * `|Current Reserve Amount(N)| == Previous Reserve Amount Balance(N+1)` across consecutive
 * Amazon settlements (`docs/formats/amazon.md` §5b). A break means a settlement file was
 * never imported — the best completeness check the system has.
 */
async function reserveChain(tx: LedgerDb, settlement: ParsedSettlement): Promise<ImportIssue[]> {
  if (settlement.periodStart === null) return [];
  const [previous] = await tx
    .select({ id: payoutImports.id, externalId: payoutImports.externalId })
    .from(payoutImports)
    .where(and(eq(payoutImports.provider, 'amazon'), lt(payoutImports.periodEnd, sqlTag`${settlement.periodStart}::date + 1::int`)))
    .orderBy(desc(payoutImports.periodEnd))
    .limit(1);
  if (previous === undefined) return [];
  const held = await tx
    .select({ amount: payoutLines.amountCents })
    .from(payoutLines)
    .where(and(eq(payoutLines.payoutImportId, previous.id), eq(payoutLines.lineType, 'reserve_held')));
  const heldCents = -sumCents(held.map((r) => r.amount));
  const released = sumCents(settlement.lines.filter((l) => l.lineType === 'reserve_released').map((l) => l.amountCents));
  if (heldCents === released) {
    return [{ severity: 'info', code: 'amazon.reserve_chain', message: `Reserve chains from settlement ${previous.externalId}: ${formatMoney(released)}.` }];
  }
  return [
    {
      severity: 'warn',
      code: 'amazon.reserve_chain',
      message: `Settlement ${previous.externalId} held back ${formatMoney(heldCents)} in reserve, but this one releases ${formatMoney(released)}. A settlement between them may never have been imported.`,
      remedy: 'Check Seller Central → Payments → All Statements for a settlement missing from the books.',
    },
  ];
}

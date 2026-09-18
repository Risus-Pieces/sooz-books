/**
 * Importing a distributor remittance into the books.
 *
 * One advice (one payment) becomes, in one transaction:
 *
 *  - a `remittances` row keyed by the payment (§5.2 level 2) and a
 *    `remittance_lines` row per canonical line, kept verbatim;
 *  - ONE balanced journal entry (./plan.ts): cash to Undeposited Funds, AR
 *    relieved at the full gross of every invoice, valid trade spend charged to
 *    its promotion's accrual or to contra revenue, disputable claims and
 *    unmapped codes to Deductions Receivable, repayments out of it;
 *  - a `deductions` row per short-pay line, with its dispute deadline;
 *  - a receipt applying the cash to the invoices, and each invoice's
 *    `deducted_cents` moved by the deductions linked to it.
 *
 * An advice that fails its arithmetic, or that the plan cannot post, is
 * quarantined: nothing is written and every reason is returned. A payment
 * already imported is skipped and says when and as which entry. Unknown invoice
 * numbers and unknown reason codes are never dropped: the cash for an unknown
 * invoice stays on the customer as an unapplied credit, and an unknown code
 * lands in Deductions Receivable as an open, unclassified deduction — both
 * reported in the result and kept in `remittances.warnings`.
 */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import {
  type PaymentMethod,
  customers,
  deductions,
  invoices,
  journalEntries,
  promotions,
  receiptApplications,
  receipts,
  remittanceLines,
  remittances,
} from '@/db/schema';
import { accountByCode, accountById, appliedAtFor, isMoneyAccount } from '@/lib/arap/common';
import { nextDocumentNumber } from '@/lib/arap/numbering';
import { adjustInvoice } from '@/lib/arap/settlement';
import type { ParsedFile } from '@/lib/banking/types';
import type { Issue } from '@/lib/importers/types';
import {
  type RemittanceAdvice,
  type RemittanceRow,
  type RemittanceSource,
  isPostable,
  parseRemittance,
} from '@/lib/importers/remittance';
import { postJournalEntry } from '@/lib/ledger/post';

import {
  type LedgerDb,
  type TradeContext,
  TRADE_ACCOUNT_CODES,
  accountIdsByCode,
  normalizeDocNo,
  requireUuid,
  runTrade,
} from './common';
import { invalidInput, notFound } from './errors';
import { type PlanInvoice, type PlannedDeduction, type RemittancePlan, planRemittance } from './plan';
import { recordPromotionCharge, remainingAccrualCents } from './promotions';
import { loadReasonCodes } from './reason-codes';

export interface RemittanceImportOptions {
  /** The distributor, as a customer. The bookkeeper chooses it when uploading. */
  customerId: string;
  /** Where the cash waits for the bank line. Defaults to 1040 Undeposited Funds. */
  depositAccountId?: string;
}

export type AdviceOutcome =
  | {
      status: 'posted';
      paymentKey: string;
      paymentNumber: string;
      remittanceId: string;
      entryId: string;
      entryNo: number;
      receiptId: string | null;
      deductionIds: string[];
      plan: RemittancePlan;
      issues: Issue[];
    }
  | { status: 'skipped'; paymentKey: string; paymentNumber: string; remittanceId: string; message: string; issues: Issue[] }
  | { status: 'quarantined'; paymentKey: string; paymentNumber: string; issues: Issue[] };

const PAYMENT_METHOD: Readonly<Record<string, PaymentMethod>> = {
  ACH: 'ach',
  EFT: 'ach',
  CHK: 'check',
  CHECK: 'check',
  FWT: 'wire',
  WIRE: 'wire',
};

function rawOf(row: RemittanceRow): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v === null ? null : String(v);
  return out;
}

export async function loadPlanInputs(
  tx: LedgerDb,
  advice: RemittanceAdvice,
  customerId: string,
): Promise<{ invoices: PlanInvoice[]; promotions: { id: string; name: string; authorizationNo: string; remainingAccrualCents: number }[]; openDeductions: { id: string; deductionNo: string; invoiceNo: string | null; openCents: number }[]; existingNos: Set<string> }> {
  const refs = new Set<string>();
  for (const row of advice.rows) {
    for (const ref of [row.referenceInvoiceNumber, row.lineType === 'INVOICE' ? row.documentNumber : null]) {
      const k = normalizeDocNo(ref);
      if (k !== null) refs.add(k);
    }
  }
  const normalized = (column: typeof invoices.invoiceNo | typeof invoices.externalId) =>
    sql`upper(regexp_replace(coalesce(${column}, ''), '[^A-Za-z0-9]', '', 'g'))`;
  const invoiceRows =
    refs.size === 0
      ? []
      : await tx
          .select()
          .from(invoices)
          .where(
            sql`${normalized(invoices.invoiceNo)} in ${[...refs]} or ${normalized(invoices.externalId)} in ${[...refs]}`,
          )
          .orderBy(invoices.id)
          .for('update');

  const promoRows = await tx
    .select({ id: promotions.id, name: promotions.name, authorizationNo: promotions.authorizationNo })
    .from(promotions)
    .where(
      and(
        eq(promotions.customerId, customerId),
        isNotNull(promotions.authorizationNo),
        inArray(promotions.status, ['planned', 'active', 'completed']),
      ),
    )
    .for('update');
  const promos = [];
  for (const p of promoRows) {
    promos.push({
      id: p.id,
      name: p.name,
      authorizationNo: p.authorizationNo ?? '',
      remainingAccrualCents: await remainingAccrualCents(tx, p.id),
    });
  }

  const open = await tx
    .select({
      id: deductions.id,
      deductionNo: deductions.deductionNo,
      invoiceNo: deductions.invoiceNo,
      amount: deductions.amountCents,
      recovered: deductions.recoveredCents,
      writtenOff: deductions.writtenOffCents,
    })
    .from(deductions)
    .where(
      and(
        eq(deductions.customerId, customerId),
        inArray(deductions.treatment, ['dispute', 'suspense']),
        inArray(deductions.status, ['open', 'disputed', 'partially_recovered']),
      ),
    )
    .orderBy(deductions.deductionDate, deductions.id)
    .for('update');

  const candidateNos = advice.rows.map((row) =>
    row.documentNumber !== null
      ? `${advice.sourceSystem}-${row.documentNumber}`
      : `${advice.sourceSystem}-${advice.paymentNumber}-R${row.sourceRowNumber}`,
  );
  const taken = await tx
    .select({ no: deductions.deductionNo })
    .from(deductions)
    .where(sql`split_part(${deductions.deductionNo}, '#', 1) in ${candidateNos.length > 0 ? candidateNos : ['']}`);

  return {
    invoices: invoiceRows.map((inv) => ({
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      externalId: inv.externalId,
      customerId: inv.customerId,
      channelId: inv.channelId,
      invoiceDate: inv.invoiceDate,
      status: inv.status,
      openCents: inv.totalCents - inv.paidCents - inv.creditedCents - inv.deductedCents,
    })),
    promotions: promos,
    openDeductions: open
      .map((d) => ({ id: d.id, deductionNo: d.deductionNo, invoiceNo: d.invoiceNo, openCents: d.amount - d.recovered - d.writtenOff }))
      .filter((d) => d.openCents > 0),
    existingNos: new Set(taken.map((t) => t.no)),
  };
}

/** Books one advice. Runs in the caller's transaction or its own. */
export async function postRemittanceAdvice(
  advice: RemittanceAdvice,
  options: RemittanceImportOptions,
  ctx: TradeContext,
): Promise<AdviceOutcome> {
  const base = { paymentKey: advice.paymentKey, paymentNumber: advice.paymentNumber };
  if (!isPostable(advice)) return { ...base, status: 'quarantined', issues: [...advice.issues] };
  requireUuid('customerId', options.customerId);

  return runTrade(ctx, async (tx) => {
    // §5.2 level 2: a payment already booked is a re-import. Skip it; never merge.
    const [existing] = await tx
      .select({ id: remittances.id, createdAt: remittances.createdAt, entryNo: journalEntries.entryNo })
      .from(remittances)
      .leftJoin(journalEntries, eq(journalEntries.id, remittances.journalEntryId))
      .where(
        and(
          eq(remittances.sourceSystem, advice.sourceSystem),
          sql`coalesce(${remittances.regionDc}, '') = ${advice.regionDc ?? ''}`,
          eq(remittances.paymentNumber, advice.paymentNumber),
        ),
      );
    if (existing !== undefined) {
      return {
        ...base,
        status: 'skipped',
        remittanceId: existing.id,
        message: `Payment ${advice.paymentNumber} was already imported on ${existing.createdAt.toISOString().slice(0, 10)}${existing.entryNo === null ? '' : ` as JE #${existing.entryNo}`}.`,
        issues: [...advice.issues],
      };
    }

    const [customer] = await tx
      .select({ id: customers.id, name: customers.name, channelId: customers.channelId })
      .from(customers)
      .where(eq(customers.id, options.customerId));
    if (customer === undefined) throw notFound('Customer', options.customerId);

    const deposit =
      options.depositAccountId === undefined
        ? await accountByCode(tx, TRADE_ACCOUNT_CODES.undepositedFunds)
        : await accountById(tx, options.depositAccountId);
    if (!isMoneyAccount(deposit) || deposit.subtype === 'credit_card' || deposit.isControl) {
      throw invalidInput(`${deposit.code} ${deposit.name} cannot receive a distributor payment.`);
    }

    const inputs = await loadPlanInputs(tx, advice, customer.id);
    const plan = planRemittance(advice, {
      customerId: customer.id,
      customerChannelId: customer.channelId,
      depositAccountId: deposit.id,
      reasonCodes: await loadReasonCodes(tx),
      invoices: inputs.invoices,
      promotions: inputs.promotions,
      openDeductions: inputs.openDeductions,
      existingDeductionNos: inputs.existingNos,
    });
    if (!plan.postable) return { ...base, status: 'quarantined', issues: plan.issues };

    // The remittance and its lines, verbatim.
    const [remittance] = await tx
      .insert(remittances)
      .values({
        customerId: customer.id,
        remittanceDate: advice.paymentDate,
        reference: advice.paymentNumber,
        totalCents: advice.paymentTotalCents,
        invoicesGrossCents: plan.invoicesGrossCents,
        deductionsCents: plan.deductionsCents,
        repaymentsCents: plan.repaymentsCents,
        filename: advice.filename,
        fileHash: advice.fileHash,
        status: 'posted',
        warnings: plan.issues.map(({ rawRow, ...rest }) => (rawRow === undefined ? rest : { ...rest, rawRow: [...rawRow] })),
        importedBy: ctx.userId,
        sourceSystem: advice.sourceSystem,
        paymentNumber: advice.paymentNumber,
        regionDc: advice.regionDc,
        paymentMethod: advice.paymentMethod,
        adviceNumber: advice.adviceNumber,
      })
      .returning();

    const invoiceIdByRow = new Map<number, string>();
    for (const d of plan.deductions) if (d.invoiceId !== null) invoiceIdByRow.set(d.rowIndex, d.invoiceId);
    const invoiceByKey = new Map<string, string>();
    for (const inv of inputs.invoices) {
      for (const k of [normalizeDocNo(inv.invoiceNo), normalizeDocNo(inv.externalId)]) if (k !== null) invoiceByKey.set(k, inv.id);
    }

    const lineRows = await tx
      .insert(remittanceLines)
      .values(
        advice.rows.map((row, index) => {
          const invoiceKey = normalizeDocNo(row.referenceInvoiceNumber);
          const invoiceId =
            row.lineType === 'INVOICE' ? (invoiceKey === null ? null : (invoiceByKey.get(invoiceKey) ?? null)) : (invoiceIdByRow.get(index) ?? null);
          return {
            remittanceId: remittance.id,
            lineNo: index + 1,
            invoiceNo: row.referenceInvoiceNumber,
            invoiceId,
            grossCents: row.lineType === 'INVOICE' ? row.lineAmountCents : 0,
            deductionCents: row.lineType !== 'INVOICE' && row.lineAmountCents < 0 ? -row.lineAmountCents : 0,
            netCents: row.lineAmountCents,
            // Only a code the book knows can be a foreign key; the verbatim code is always kept.
            reasonCode: plan.deductions.find((d) => d.rowIndex === index)?.reasonCode ?? null,
            description: row.reasonDescription,
            raw: rawOf(row),
            lineType: row.lineType,
            documentNumber: row.documentNumber,
            sourceReasonCode: row.reasonCode,
            dealNumber: row.dealNumber,
            invoiceDate: row.invoiceDate,
            sourceRowNumber: row.sourceRowNumber,
          };
        }),
      )
      .returning({ id: remittanceLines.id, lineNo: remittanceLines.lineNo });
    const lineIdByIndex = new Map(lineRows.map((l) => [l.lineNo - 1, l.id]));

    // The receipt: the cash that settles AR, applied invoice by invoice.
    let receiptId: string | null = null;
    if (plan.receiptCents > 0) {
      const receiptNo = await nextDocumentNumber(tx, 'receipt');
      const [receipt] = await tx
        .insert(receipts)
        .values({
          receiptNo,
          customerId: customer.id,
          receiptDate: advice.paymentDate,
          method: PAYMENT_METHOD[advice.paymentMethod ?? ''] ?? 'ach',
          reference: advice.paymentNumber,
          amountCents: plan.receiptCents,
          appliedCents: plan.receiptCents - plan.unappliedCents,
          depositAccountId: deposit.id,
          remittanceId: remittance.id,
          memo: `${advice.sourceSystem} remittance ${advice.paymentNumber}`,
          createdBy: ctx.userId,
        })
        .returning({ id: receipts.id });
      receiptId = receipt.id;
    }

    const memo = `${advice.sourceSystem} remittance ${advice.paymentNumber} from ${customer.name}`;
    const posted = await postJournalEntry(
      {
        date: advice.paymentDate,
        memo,
        sourceType: receiptId === null ? 'deduction' : 'receipt',
        sourceId: receiptId ?? remittance.id,
        lines: plan.lines,
      },
      { userId: ctx.userId, tx },
    );

    if (receiptId !== null) {
      const id = receiptId;
      await tx.update(receipts).set({ journalEntryId: posted.entryId }).where(eq(receipts.id, id));
      if (plan.applications.length > 0) {
        await tx.insert(receiptApplications).values(
          plan.applications.map((app) => ({
            receiptId: id,
            invoiceId: app.invoiceId,
            amountCents: app.amountCents,
            discountCents: 0,
            appliedAt: appliedAtFor(advice.paymentDate),
          })),
        );
      }
    }
    const deductedByInvoice = new Map(plan.invoiceDeductions.map((d) => [d.invoiceId, d.amountCents]));
    const touched = new Set([...plan.applications.map((a) => a.invoiceId), ...deductedByInvoice.keys()]);
    for (const invoiceId of touched) {
      const deducted = deductedByInvoice.get(invoiceId) ?? 0;
      if (deducted > 0) {
        await tx
          .update(invoices)
          .set({ deductedCents: sql`${invoices.deductedCents} + ${deducted}` })
          .where(eq(invoices.id, invoiceId));
      }
      const paid = plan.applications.find((a) => a.invoiceId === invoiceId)?.amountCents ?? 0;
      // Moves paid_cents and recomputes status from all three settled amounts.
      await adjustInvoice(tx, invoiceId, { paidCents: paid });
    }

    // The deductions, one per short-pay line.
    const accountIds = await accountIdsByCode(
      tx,
      plan.deductions.map((d) => d.accountCode).filter((c): c is string => c !== null),
    );
    const deductionIds: string[] = [];
    for (const d of plan.deductions) {
      const [row] = await tx
        .insert(deductions)
        .values({
          deductionNo: d.deductionNo,
          customerId: customer.id,
          deductionDate: advice.paymentDate,
          reasonCode: d.reasonCode,
          invoiceId: d.invoiceId,
          invoiceNo: d.invoiceNo,
          promotionId: d.promotionId,
          remittanceId: remittance.id,
          remittanceLineId: lineIdByIndex.get(d.rowIndex) ?? null,
          reference: d.documentNumber,
          description: d.description,
          amountCents: d.amountCents,
          status: d.status,
          treatment: d.treatment,
          journalEntryId: posted.entryId,
          disputeDeadline: d.disputeDeadline,
          sourceReasonCode: d.sourceReasonCode,
          dealNumber: d.dealNumber,
          invoiceDate: d.invoiceDate,
          accountId: deductionAccountId(d, accountIds),
          resolvedAt: d.status === 'validated' ? appliedAtFor(advice.paymentDate) : null,
          resolvedBy: d.status === 'validated' ? ctx.userId : null,
        })
        .returning({ id: deductions.id });
      deductionIds.push(row.id);
    }

    // Promotions: relieve the accrual by what was charged to it; count the whole deduction as actual spend.
    const byPromotion = new Map<string, { charged: number; actual: number }>();
    for (const d of plan.deductions) {
      if (d.promotionId === null) continue;
      const sum = byPromotion.get(d.promotionId) ?? { charged: 0, actual: 0 };
      sum.charged += d.accrualChargedCents;
      sum.actual += d.amountCents;
      byPromotion.set(d.promotionId, sum);
    }
    for (const [promotionId, sum] of byPromotion) {
      await recordPromotionCharge(tx, promotionId, { chargedCents: sum.charged, actualCents: sum.actual });
    }

    // Repayments of earlier disputes.
    for (const recovery of plan.recoveries) {
      if (recovery.deductionId === null) continue;
      const [d] = await tx.select().from(deductions).where(eq(deductions.id, recovery.deductionId)).for('update');
      if (d === undefined) continue;
      const recovered = d.recoveredCents + recovery.amountCents;
      const open = d.amountCents - recovered - d.writtenOffCents;
      await tx
        .update(deductions)
        .set({
          recoveredCents: recovered,
          status: open === 0 && d.writtenOffCents === 0 ? 'recovered' : 'partially_recovered',
          resolutionEntryId: posted.entryId,
          resolvedAt: open === 0 ? appliedAtFor(advice.paymentDate) : d.resolvedAt,
          resolvedBy: open === 0 ? ctx.userId : d.resolvedBy,
        })
        .where(eq(deductions.id, d.id));
    }

    await tx
      .update(remittances)
      .set({ receiptId, journalEntryId: posted.entryId })
      .where(eq(remittances.id, remittance.id));

    return {
      ...base,
      status: 'posted',
      remittanceId: remittance.id,
      entryId: posted.entryId,
      entryNo: posted.entryNo,
      receiptId,
      deductionIds,
      plan,
      issues: plan.issues,
    };
  });
}

function deductionAccountId(d: PlannedDeduction, ids: ReadonlyMap<string, string>): string | null {
  if (d.accountId !== null) return d.accountId;
  return d.accountCode === null ? null : (ids.get(d.accountCode) ?? null);
}

export interface RemittanceFileResult {
  sourceSystem: RemittanceSource | null;
  /** File-level problems; a fatal one means no advice in the file was attempted. */
  issues: Issue[];
  advices: AdviceOutcome[];
}

/**
 * Parses a remittance export and books each payment in it, each in its own
 * transaction so one quarantined payment never holds back the others.
 */
export async function importRemittanceFile(
  file: ParsedFile,
  options: RemittanceImportOptions & { sourceSystem?: RemittanceSource },
  ctx: TradeContext,
): Promise<RemittanceFileResult> {
  const parsed = parseRemittance(file, options.sourceSystem === undefined ? {} : { sourceSystem: options.sourceSystem });
  const issues = [...parsed.issues];
  if (issues.some((i) => i.severity === 'fatal')) return { sourceSystem: parsed.sourceSystem, issues, advices: [] };
  const outcomes: AdviceOutcome[] = [];
  for (const advice of parsed.advices) {
    outcomes.push(await postRemittanceAdvice(advice, options, ctx));
  }
  return { sourceSystem: parsed.sourceSystem, issues, advices: outcomes };
}

/**
 * The remittance posting plan — pure. Given one parsed advice and what the books
 * already know (the customer's invoices, promotions with open accruals, open
 * disputed deductions, the reason-code book), it decides the one balanced entry
 * and every sub-ledger row that goes with it, without touching the database.
 *
 * The entry (docs/formats/distributor-deductions.md §7.2–§7.4):
 *
 *     Dr  1040 Undeposited Funds          the cash, until the bank line matches
 *     Dr  2120 Accrued Trade Spend        valid trade spend a promotion accrued
 *     Dr  45xx Contra revenue             valid trade spend with no accrual left
 *     Dr  1210 Deductions Receivable      disputable claims and unmapped codes
 *         Cr  1200 Accounts Receivable    every invoice at its FULL gross
 *         Cr  1210 Deductions Receivable  repayments of earlier disputes
 *
 * AR is always relieved at gross; a deduction is never netted against revenue.
 *
 * Sub-ledger consistency with the AR aging (src/lib/arap/aging.ts): the aging
 * subtracts from an invoice its receipt applications and the deductions linked
 * to it, and shows an unlinked deduction as a credit on the customer. So the
 * receipt applies to each invoice its gross less its linked deductions; the
 * account-level (unlinked) deductions are then taken out of the cash applied,
 * last invoice first, so AR in the ledger and AR in the aging move by the same
 * amount — the full gross — and the customer nets to zero.
 */

import type { DeductionStatus, DeductionTreatment } from '@/db/schema';
import { type CalendarDate, addDays, daysBetween } from '@/lib/dates';
import type { Issue } from '@/lib/importers/types';
import type { RemittanceAdvice, RemittanceRow } from '@/lib/importers/remittance';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { DraftLine } from '@/lib/ledger/post';
import { formatMoney, sumCents } from '@/lib/money';

import { normalizeDocNo } from './common';
import { type ReasonCodeBook, RECEIVABLE_TREATMENTS, resolveReasonCode } from './reason-codes';

export interface PlanInvoice {
  id: string;
  invoiceNo: string;
  externalId: string | null;
  customerId: string;
  channelId: string | null;
  invoiceDate: CalendarDate;
  status: string;
  /** total − paid − credited − deducted. */
  openCents: number;
}

export interface PlanPromotion {
  id: string;
  name: string;
  /** The deal / authorisation number the distributor quotes. */
  authorizationNo: string;
  /** Σ accrued − relieved − released across the promotion's accruals. */
  remainingAccrualCents: number;
}

export interface PlanOpenDeduction {
  id: string;
  deductionNo: string;
  invoiceNo: string | null;
  openCents: number;
}

export interface PlanContext {
  customerId: string;
  customerChannelId: string | null;
  depositAccountId: string;
  reasonCodes: ReasonCodeBook;
  /** Invoices whose number or external id matches a reference on the advice, of any customer. */
  invoices: readonly PlanInvoice[];
  /** The customer's promotions that carry an authorisation number. */
  promotions: readonly PlanPromotion[];
  /** The customer's deductions still open in Deductions Receivable, for matching repayments. */
  openDeductions: readonly PlanOpenDeduction[];
  /** deduction_no values already taken, so a re-issued document number is suffixed, not collided. */
  existingDeductionNos: ReadonlySet<string>;
}

export interface PlannedDeduction {
  rowIndex: number;
  deductionNo: string;
  /** Namespaced reason code, or null when the distributor's code is unmapped. */
  reasonCode: string | null;
  sourceReasonCode: string | null;
  treatment: DeductionTreatment;
  status: DeductionStatus;
  amountCents: number;
  /** Charged against the promotion's accrual (2120); the rest of the amount hits `accountId`/`accountCode`. */
  accrualChargedCents: number;
  /** The account the deduction sits in (or the contra account for the part beyond the accrual). */
  accountId: string | null;
  accountCode: string | null;
  invoiceId: string | null;
  invoiceNo: string | null;
  invoiceDate: CalendarDate | null;
  promotionId: string | null;
  dealNumber: string | null;
  disputeDeadline: CalendarDate | null;
  description: string | null;
  documentNumber: string | null;
  channelId: string | null;
}

export interface PlannedRecovery {
  rowIndex: number;
  /** Null when no open deduction matched; the credit still goes to 1210, never revenue. */
  deductionId: string | null;
  amountCents: number;
  description: string | null;
}

export interface RemittancePlan {
  lines: DraftLine[];
  /** Cash applied per known invoice. */
  applications: { invoiceId: string; amountCents: number }[];
  /** Deductions linked per known invoice. */
  invoiceDeductions: { invoiceId: string; amountCents: number }[];
  /** Cash that settles AR: Σ applications + unapplied. */
  receiptCents: number;
  /** Cash for invoices the books do not know, left as a customer credit. */
  unappliedCents: number;
  invoicesGrossCents: number;
  deductionsCents: number;
  repaymentsCents: number;
  deductions: PlannedDeduction[];
  recoveries: PlannedRecovery[];
  accrualCharges: { promotionId: string; amountCents: number }[];
  issues: Issue[];
  postable: boolean;
}

/** Deductions referencing invoices older than this route to review rather than auto-book (§6.4). */
export const STALE_INVOICE_DAYS = 365;

function lineMemo(row: RemittanceRow, fallback: string): string {
  const parts = [row.documentNumber ?? row.referenceInvoiceNumber, row.reasonCode, row.reasonDescription].filter(
    (p): p is string => p !== null && p !== '',
  );
  return parts.length > 0 ? parts.join(' · ') : fallback;
}

interface InvoiceSlot {
  rowIndex: number;
  row: RemittanceRow;
  invoice: PlanInvoice | null;
  gross: number;
  linked: number;
  capacity: number;
}

export function planRemittance(advice: RemittanceAdvice, ctx: PlanContext): RemittancePlan {
  const issues: Issue[] = [...advice.issues];
  const fatal = (code: string, message: string, rowIndex?: number): void => {
    issues.push({ severity: 'fatal', code, message, ...(rowIndex === undefined ? {} : { rowIndex }) });
  };
  const warn = (code: string, message: string, rowIndex?: number): void => {
    issues.push({ severity: 'warn', code, message, ...(rowIndex === undefined ? {} : { rowIndex }) });
  };

  if (advice.paymentTotalCents < 0) {
    fatal(
      'advice.negative_net',
      `Payment ${advice.paymentNumber} nets to ${formatMoney(advice.paymentTotalCents)}: the distributor's deductions exceed what it owes. ` +
        'Record the balance owed to the distributor as a bill; it is never booked as negative cash (§6.4).',
    );
  }

  // Invoice lookup by normalised number or external id.
  const invoiceByKey = new Map<string, PlanInvoice>();
  for (const invoice of ctx.invoices) {
    for (const candidate of [invoice.invoiceNo, invoice.externalId]) {
      const k = normalizeDocNo(candidate);
      if (k !== null && !invoiceByKey.has(k)) invoiceByKey.set(k, invoice);
    }
  }
  const findInvoice = (ref: string | null): PlanInvoice | null => {
    const k = normalizeDocNo(ref);
    return k === null ? null : (invoiceByKey.get(k) ?? null);
  };

  // 1. Invoice lines.
  const slots: InvoiceSlot[] = [];
  const slotByInvoice = new Map<string, InvoiceSlot>();
  advice.rows.forEach((row, rowIndex) => {
    if (row.lineType !== 'INVOICE') return;
    if (row.lineAmountCents < 0) {
      fatal('invoice.negative', `Invoice line ${row.referenceInvoiceNumber ?? '(blank)'} is negative; record a credit memo instead.`, rowIndex);
      return;
    }
    const invoice = findInvoice(row.referenceInvoiceNumber ?? row.documentNumber);
    if (invoice === null) {
      warn(
        'invoice.unknown',
        `Invoice ${row.referenceInvoiceNumber ?? '(no number)'} (${formatMoney(row.lineAmountCents)}) is not in the books. ` +
          'Its cash is held as an unapplied credit on the customer until the invoice is found.',
        rowIndex,
      );
    } else {
      if (invoice.customerId !== ctx.customerId) {
        fatal('invoice.other_customer', `Invoice ${invoice.invoiceNo} belongs to another customer.`, rowIndex);
      } else if (invoice.status !== 'open' && invoice.status !== 'partial') {
        fatal(
          'invoice.not_open',
          `Invoice ${invoice.invoiceNo} is ${invoice.status}; this payment may already have been recorded.`,
          rowIndex,
        );
      } else if (row.lineAmountCents > invoice.openCents) {
        fatal(
          'invoice.over_gross',
          `The advice pays invoice ${invoice.invoiceNo} at ${formatMoney(row.lineAmountCents)} gross, but only ${formatMoney(invoice.openCents)} is open.`,
          rowIndex,
        );
      } else if (row.lineAmountCents < invoice.openCents) {
        issues.push({
          severity: 'info',
          code: 'invoice.partial',
          message: `Invoice ${invoice.invoiceNo} is settled for ${formatMoney(row.lineAmountCents)} of ${formatMoney(invoice.openCents)} open.`,
          rowIndex,
        });
      }
      if (invoice.invoiceDate > advice.paymentDate) {
        fatal('invoice.after_payment', `Invoice ${invoice.invoiceNo} is dated after the payment.`, rowIndex);
      }
      if (slotByInvoice.has(invoice.id)) {
        fatal('invoice.duplicate', `Invoice ${invoice.invoiceNo} is listed twice on the advice; its gross would be counted twice (§2.1).`, rowIndex);
        return;
      }
    }
    const slot: InvoiceSlot = { rowIndex, row, invoice, gross: row.lineAmountCents, linked: 0, capacity: 0 };
    slots.push(slot);
    if (invoice !== null) slotByInvoice.set(invoice.id, slot);
  });

  // 2. Deductions and recoveries.
  const remaining = new Map(ctx.promotions.map((p) => [p.id, p.remainingAccrualCents]));
  const promoByDeal = new Map<string, PlanPromotion>();
  for (const promotion of ctx.promotions) {
    const k = normalizeDocNo(promotion.authorizationNo);
    if (k !== null) promoByDeal.set(k, promotion);
  }
  const usedNos = new Set(ctx.existingDeductionNos);
  const openDeductions = ctx.openDeductions.map((d) => ({ ...d }));
  const deductions: PlannedDeduction[] = [];
  const recoveries: PlannedRecovery[] = [];
  const lines: DraftLine[] = [];
  const debitLines: DraftLine[] = [];
  const creditLines: DraftLine[] = [];

  advice.rows.forEach((row, rowIndex) => {
    if (row.lineType === 'INVOICE') return;
    const amount = row.lineAmountCents;
    const refInvoice = findInvoice(row.referenceInvoiceNumber);
    const channelId = refInvoice?.channelId ?? ctx.customerChannelId;

    if (amount === 0) {
      issues.push({
        severity: 'info',
        code: 'line.zero',
        message: `${lineMemo(row, 'A line')} is $0.00; kept on the remittance for its reason code, nothing posts.`,
        rowIndex,
      });
      return;
    }

    if (amount > 0) {
      // Money given back: relieves Deductions Receivable, never revenue (§6.4).
      const resolved = resolveReasonCode(ctx.reasonCodes, advice.sourceSystem, row.reasonCode, row.lineType);
      if (resolved === null || resolved.info.treatment !== 'recovery') {
        warn(
          'recovery.code',
          `${lineMemo(row, 'A positive line')} gives money back but its code is not a recovery code; it is booked as a recovery of Deductions Receivable.`,
          rowIndex,
        );
      }
      const ref = normalizeDocNo(row.referenceInvoiceNumber);
      const candidates = openDeductions.filter((d) => {
        if (d.openCents < amount) return false;
        if (ref === null) return false;
        return normalizeDocNo(d.invoiceNo) === ref || (normalizeDocNo(d.deductionNo) ?? '').includes(ref);
      });
      const exact = candidates.filter((d) => d.openCents === amount);
      const match = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
      if (match === null) {
        warn(
          'recovery.unmatched',
          `${lineMemo(row, 'A repayment')} (${formatMoney(amount)}) matches no single open deduction; it credits Deductions Receivable for the customer and needs matching by hand.`,
          rowIndex,
        );
      } else {
        match.openCents -= amount;
      }
      recoveries.push({ rowIndex, deductionId: match?.id ?? null, amountCents: amount, description: row.reasonDescription });
      creditLines.push({
        accountCode: ACCOUNTS.DEDUCTIONS_RECEIVABLE,
        creditCents: amount,
        customerId: ctx.customerId,
        channelId,
        memo: `Recovery ${lineMemo(row, advice.paymentNumber)}`,
      });
      return;
    }

    // A deduction: money the distributor kept.
    const deductionCents = -amount;
    const resolved = resolveReasonCode(ctx.reasonCodes, advice.sourceSystem, row.reasonCode, row.lineType);
    let info = resolved?.info ?? null;
    if (resolved === null) {
      warn(
        'reason.unmapped',
        `Reason code ${row.reasonCode ?? '(blank)'} on ${lineMemo(row, 'a deduction')} is not mapped. ` +
          `${formatMoney(deductionCents)} is held in Deductions Receivable as unapplied until someone classifies it.`,
        rowIndex,
      );
    } else if (resolved.info.treatment === 'recovery') {
      warn('reason.recovery_on_deduction', `${lineMemo(row, 'A deduction')} carries a recovery code but takes money; held in suspense.`, rowIndex);
      info = null;
    } else if (resolved.via === 'line_type') {
      issues.push({
        severity: 'info',
        code: 'reason.by_line_type',
        message: `${lineMemo(row, 'A line')} was classified by its line type as ${resolved.info.label}.`,
        rowIndex,
      });
    }

    let treatment: DeductionTreatment = info?.treatment ?? 'suspense';
    const invoiceDate = row.invoiceDate ?? refInvoice?.invoiceDate ?? null;
    if (invoiceDate !== null && daysBetween(invoiceDate, advice.paymentDate) > STALE_INVOICE_DAYS && !RECEIVABLE_TREATMENTS.has(treatment)) {
      warn(
        'deduction.stale_invoice',
        `${lineMemo(row, 'A deduction')} references an invoice from ${invoiceDate}, over 12 months before the payment. ` +
          'It is held as a disputable claim rather than booked as trade spend (post-audit claims are often duplicates).',
        rowIndex,
      );
      treatment = 'dispute';
    }

    // Invoice link: only an invoice this advice pays, so ledger AR and the aging stay in step.
    let invoiceId: string | null = null;
    if (refInvoice !== null && slotByInvoice.has(refInvoice.id)) {
      invoiceId = refInvoice.id;
      const slot = slotByInvoice.get(refInvoice.id);
      if (slot) slot.linked += deductionCents;
    } else if (refInvoice !== null) {
      warn(
        'deduction.invoice_not_on_advice',
        `${lineMemo(row, 'A deduction')} references invoice ${refInvoice.invoiceNo}, which this payment does not settle; it is booked against the customer.`,
        rowIndex,
      );
    } else if (row.referenceInvoiceNumber !== null) {
      warn(
        'deduction.invoice_unknown',
        `${lineMemo(row, 'A deduction')} references invoice ${row.referenceInvoiceNumber}, which is not in the books; it is booked against the customer.`,
        rowIndex,
      );
    }

    // Promotion: the deal number on the line, when it is one of the customer's promotions.
    const deal = normalizeDocNo(row.dealNumber);
    const promotion = deal === null ? null : (promoByDeal.get(deal) ?? null);
    let accrualCharged = 0;
    let promotionId: string | null = null;
    const tradeSpend = (treatment === 'accrual' || treatment === 'contra_revenue') && info !== null && info.isTradeSpend;
    if (promotion !== null && tradeSpend) {
      promotionId = promotion.id;
      const left = remaining.get(promotion.id) ?? 0;
      accrualCharged = Math.min(left, deductionCents);
      remaining.set(promotion.id, left - accrualCharged);
    } else if (deal !== null && treatment === 'accrual') {
      issues.push({
        severity: 'info',
        code: 'promotion.not_found',
        message: `Deal ${row.dealNumber ?? ''} on ${lineMemo(row, 'a deduction')} is not a promotion on file; booked straight to contra revenue.`,
        rowIndex,
      });
    }
    if (treatment === 'accrual' || treatment === 'contra_revenue') {
      treatment = accrualCharged > 0 ? 'accrual' : 'contra_revenue';
    }

    const receivable = RECEIVABLE_TREATMENTS.has(treatment);
    const accountCode = receivable ? ACCOUNTS.DEDUCTIONS_RECEIVABLE : (info?.accountCode ?? null);
    const accountId = receivable ? null : (info?.accountId ?? null);
    if (!receivable && accountId === null) {
      fatal('reason.no_account', `Reason code ${info?.code ?? ''} has no default account.`, rowIndex);
      return;
    }

    // Deduction number: the document's own, namespaced by source; never collide.
    const base = row.documentNumber !== null
      ? `${advice.sourceSystem}-${row.documentNumber}`
      : `${advice.sourceSystem}-${advice.paymentNumber}-R${row.sourceRowNumber}`;
    let deductionNo = row.occurrence > 0 ? `${base}#${row.occurrence + 1}` : base;
    if (usedNos.has(deductionNo)) {
      warn(
        'deduction.number_reused',
        `Deduction ${deductionNo} already exists from an earlier payment; this one is numbered with a suffix. It may be a duplicate deduction worth disputing.`,
        rowIndex,
      );
      let n = 2;
      while (usedNos.has(`${base}#${n}`)) n += 1;
      deductionNo = `${base}#${n}`;
    }
    usedNos.add(deductionNo);

    const windowDays = info?.windowDays ?? 0;
    const status: DeductionStatus = receivable ? 'open' : 'validated';
    deductions.push({
      rowIndex,
      deductionNo,
      reasonCode: info?.code ?? null,
      sourceReasonCode: row.reasonCode,
      treatment,
      status,
      amountCents: deductionCents,
      accrualChargedCents: accrualCharged,
      accountId,
      accountCode,
      invoiceId,
      invoiceNo: row.referenceInvoiceNumber,
      invoiceDate,
      promotionId,
      dealNumber: row.dealNumber,
      disputeDeadline: treatment === 'dispute' && windowDays > 0 ? addDays(advice.paymentDate, windowDays) : null,
      description: row.reasonDescription,
      documentNumber: row.documentNumber,
      channelId,
    });

    const memo = `${deductionNo}${row.reasonDescription ? ` ${row.reasonDescription}` : ''}`;
    if (accrualCharged > 0) {
      debitLines.push({
        accountCode: ACCOUNTS.ACCRUED_TRADE_SPEND,
        debitCents: accrualCharged,
        customerId: ctx.customerId,
        channelId,
        memo: `${memo} (charged to accrual)`,
      });
    }
    const rest = deductionCents - accrualCharged;
    if (rest > 0) {
      debitLines.push({
        ...(accountId !== null ? { accountId } : { accountCode: accountCode ?? ACCOUNTS.DEDUCTIONS_RECEIVABLE }),
        debitCents: rest,
        customerId: ctx.customerId,
        channelId,
        memo,
      });
    }
  });

  // 3. Spread the account-level deductions over the cash applied, last invoice first.
  const deductionsCents = sumCents(deductions.map((d) => d.amountCents));
  const repaymentsCents = sumCents(recoveries.map((r) => r.amountCents));
  const invoicesGrossCents = sumCents(slots.map((s) => s.gross));
  let unlinked = sumCents(deductions.filter((d) => d.invoiceId === null).map((d) => d.amountCents));
  for (const slot of slots) {
    slot.capacity = slot.gross - slot.linked;
    if (slot.capacity < 0) {
      fatal(
        'invoice.over_deducted',
        `Deductions against invoice ${slot.invoice?.invoiceNo ?? slot.row.referenceInvoiceNumber ?? ''} exceed its gross on this advice.`,
        slot.rowIndex,
      );
    }
  }
  // Unknown invoices absorb account-level deductions first, so the invoices the books know settle fully.
  const order = [...slots.filter((s) => s.invoice === null), ...slots.filter((s) => s.invoice !== null).reverse()];
  for (const slot of order) {
    if (unlinked === 0) break;
    const take = Math.min(Math.max(slot.capacity, 0), unlinked);
    slot.capacity -= take;
    unlinked -= take;
  }
  if (unlinked > 0) {
    fatal(
      'advice.deductions_exceed_invoices',
      `Deductions on payment ${advice.paymentNumber} exceed the invoices it settles by ${formatMoney(unlinked)}; the AR sub-ledger cannot absorb them. Record this advice by hand.`,
    );
  }

  const applications = slots
    .filter((s) => s.invoice !== null && s.capacity > 0)
    .map((s) => ({ invoiceId: (s.invoice as PlanInvoice).id, amountCents: s.capacity }));
  const invoiceDeductions = slots
    .filter((s) => s.invoice !== null && s.linked > 0)
    .map((s) => ({ invoiceId: (s.invoice as PlanInvoice).id, amountCents: s.linked }));
  const unappliedCents = sumCents(slots.filter((s) => s.invoice === null).map((s) => Math.max(s.capacity, 0)));
  const receiptCents = sumCents(applications.map((a) => a.amountCents)) + unappliedCents;

  // 4. The entry.
  if (advice.paymentTotalCents > 0) {
    lines.push({
      accountId: ctx.depositAccountId,
      debitCents: advice.paymentTotalCents,
      customerId: ctx.customerId,
      channelId: ctx.customerChannelId,
      memo: `${advice.sourceSystem} payment ${advice.paymentNumber}`,
    });
  }
  lines.push(...debitLines);
  for (const slot of slots) {
    lines.push({
      accountCode: ACCOUNTS.AR,
      creditCents: slot.gross,
      customerId: ctx.customerId,
      channelId: slot.invoice?.channelId ?? ctx.customerChannelId,
      memo:
        slot.invoice === null
          ? `Unapplied — invoice ${slot.row.referenceInvoiceNumber ?? '(no number)'} not in the books`
          : `Payment on ${slot.invoice.invoiceNo} at gross`,
    });
  }
  lines.push(...creditLines);

  const debits = sumCents(lines.map((l) => l.debitCents ?? 0));
  const credits = sumCents(lines.map((l) => l.creditCents ?? 0));
  if (debits !== credits) {
    fatal('plan.unbalanced', `The planned entry does not balance: debits ${formatMoney(debits)}, credits ${formatMoney(credits)}.`);
  }
  if (receiptCents + repaymentsCents !== Math.max(advice.paymentTotalCents, 0) && advice.paymentTotalCents >= 0 && unlinked === 0) {
    fatal('plan.cash_mismatch', 'Cash applied to AR plus repayments does not equal the payment.');
  }
  if (lines.length < 2) {
    fatal('plan.empty', `Payment ${advice.paymentNumber} has nothing to post.`);
  }

  const accrualCharges = [...new Set(deductions.map((d) => d.promotionId).filter((id): id is string => id !== null))]
    .map((promotionId) => ({
      promotionId,
      amountCents: sumCents(deductions.filter((d) => d.promotionId === promotionId).map((d) => d.accrualChargedCents)),
    }))
    .filter((c) => c.amountCents > 0);

  return {
    lines,
    applications,
    invoiceDeductions,
    receiptCents,
    unappliedCents,
    invoicesGrossCents,
    deductionsCents,
    repaymentsCents,
    deductions,
    recoveries,
    accrualCharges,
    issues,
    postable: !issues.some((i) => i.severity === 'fatal'),
  };
}

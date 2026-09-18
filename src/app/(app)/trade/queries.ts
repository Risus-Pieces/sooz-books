/**
 * The reads behind the Trade screens: the overview KPIs, the deduction workbench, promotions
 * with their accrual schedules, and remittances — including the split preview of a file
 * before it posts.
 *
 * Nothing here writes. Every entry shown before it posts is built from the same inputs and
 * the same functions the engine posts from: a remittance preview runs the engine's own
 * `loadPlanInputs` and pure `planRemittance`; an accrual schedule is the engine's
 * `accrualSchedule`; a validation follows `validateDeduction`'s routing, line for line.
 */

import { type SQL, and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  type Deduction,
  accounts,
  attachments,
  channels,
  customers,
  deductionReasonCodes,
  deductions,
  journalEntries,
  products,
  promotionProducts,
  promotions,
  remittanceLines,
  remittances,
  tradeAccruals,
} from '@/db/schema';
import { BOOKS_TIME_ZONE, type CalendarDate, daysBetween, today } from '@/lib/dates';
import type { Issue } from '@/lib/importers/types';
import { type RemittanceSource, isPostable, parseRemittance } from '@/lib/importers/remittance';
import type { ParsedFile } from '@/lib/banking/types';
import { ACCOUNTS, CHANNEL_REVENUE_ACCOUNT, type ChannelCode } from '@/lib/ledger/coa';
import type { DraftLine, LedgerDb } from '@/lib/ledger/post';
import { DEFAULT_DISPUTE_WINDOW_DAYS, burnAlert, isInReceivable, openCentsOf, windowBurn } from '@/lib/trade/deductions';
import { AGING_BUCKETS, tradeKpis } from '@/lib/trade/kpis';
import { planRemittance } from '@/lib/trade/plan';
import {
  PROMO_CONTRA_ACCOUNT,
  accrualSchedule,
  accrualWindow,
  allowanceCents,
  promotionPerformanceReport,
  remainingAccrualCents,
} from '@/lib/trade/promotions';
import { type ReasonCodeBook, loadReasonCodes, reasonCodeByKey } from '@/lib/trade/reason-codes';
import { loadPlanInputs } from '@/lib/trade/remittances';

import type {
  AccountLabel,
  AdvicePreviewView,
  BulkValidationView,
  DeductionDetailView,
  DeductionRowView,
  DeductionTab,
  EntryLineView,
  EntryView,
  IssueView,
  Option,
  PromotionDetailView,
  PromotionFormOptions,
  PromotionRowView,
  RemittanceFormOptions,
  RemittancePreviewView,
  RemittanceRowView,
  RemittanceSplit,
  ScheduleMonthView,
  TradeOverviewView,
  ValidationPreview,
} from '@/components/trade/types';
import { PROMO_TYPE_HINT, PROMO_TYPE_LABEL, TREATMENT_LABEL } from '@/components/trade/labels';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function database(): Promise<LedgerDb> {
  return (await import('@/db/client')).db;
}

const STAMP_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOOKS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** A timestamp as the books' calendar day. */
function dayOf(value: Date | null): string | null {
  return value === null ? null : STAMP_DAY.format(value);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

async function labelsByCode(exec: LedgerDb, codes: readonly string[]): Promise<Map<string, AccountLabel>> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();
  const rows = await exec
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(inArray(accounts.code, unique));
  return new Map(rows.map((r) => [r.code, r]));
}

async function labelsById(exec: LedgerDb, ids: readonly string[]): Promise<Map<string, AccountLabel>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await exec
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(inArray(accounts.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

function mustLabel(map: ReadonlyMap<string, AccountLabel>, code: string): AccountLabel {
  const label = map.get(code);
  if (label === undefined) throw new Error(`Account ${code} is missing from the chart of accounts.`);
  return label;
}

/** Postable money accounts a distributor payment or recovery can land in: no rollups, no cards. */
async function depositAccounts(exec: LedgerDb): Promise<AccountLabel[]> {
  const rows = await exec.execute<{ id: string; code: string; name: string }>(sql`
    select a.id, a.code, a.name
      from accounts a
     where a.active
       and not a.is_control
       and coalesce(a.subtype, '') <> 'credit_card'
       and (a.is_bank or a.subtype in ('bank', 'cash', 'undeposited_funds'))
       and not exists (select 1 from accounts c where c.parent_id = a.id)
     order by (a.subtype = 'undeposited_funds') desc, a.code
  `);
  return [...rows].map((r) => ({ id: r.id, code: r.code, name: r.name }));
}

/** Resolves draft lines (by code or id) into lines a person can read. */
async function readableLines(exec: LedgerDb, lines: readonly DraftLine[]): Promise<EntryLineView[]> {
  const byCode = await labelsByCode(exec, lines.flatMap((l) => (l.accountCode === undefined ? [] : [l.accountCode])));
  const byId = await labelsById(exec, lines.flatMap((l) => (l.accountId === undefined ? [] : [l.accountId])));
  return lines.map((line) => {
    const label = line.accountId !== undefined ? byId.get(line.accountId) : line.accountCode !== undefined ? byCode.get(line.accountCode) : undefined;
    return {
      accountCode: label?.code ?? line.accountCode ?? '—',
      accountName: label?.name ?? 'Unknown account',
      debitCents: line.debitCents ?? 0,
      creditCents: line.creditCents ?? 0,
      memo: line.memo ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/** Customers a distributor document can belong to: distributors first, then the rest. */
async function customerOptions(exec: LedgerDb): Promise<Option[]> {
  const rows = await exec
    .select({ id: customers.id, name: customers.name, type: customers.customerType, channel: channels.name })
    .from(customers)
    .leftJoin(channels, eq(channels.id, customers.channelId))
    .where(eq(customers.active, true))
    .orderBy(sql`(${customers.customerType} = 'distributor') desc`, asc(customers.name));
  return rows.map((r) => ({ value: r.id, label: r.name, hint: r.channel ?? r.type }));
}

// ---------------------------------------------------------------------------
// Deductions
// ---------------------------------------------------------------------------

interface DeductionJoinRow {
  deduction: Deduction;
  customerName: string;
  reasonLabel: string | null;
  category: string | null;
  promotionName: string | null;
}

function deductionRow(r: DeductionJoinRow, asOf: CalendarDate): DeductionRowView {
  const d = r.deduction;
  const actionable = isInReceivable(d);
  const burn = actionable ? windowBurn(d.deductionDate, d.disputeDeadline, asOf) : null;
  return {
    id: d.id,
    deductionNo: d.deductionNo,
    customerName: r.customerName,
    deductionDate: d.deductionDate,
    invoiceNo: d.invoiceNo,
    reasonCode: d.reasonCode,
    sourceReasonCode: d.sourceReasonCode,
    reasonLabel: r.reasonLabel,
    category: r.category,
    description: d.description,
    amountCents: d.amountCents,
    openCents: openCentsOf(d),
    recoveredCents: d.recoveredCents,
    writtenOffCents: d.writtenOffCents,
    status: d.status,
    treatment: d.treatment,
    disputeDeadline: d.disputeDeadline,
    daysOutstanding: Math.max(0, daysBetween(d.deductionDate, asOf)),
    daysToDeadline: d.disputeDeadline === null ? null : daysBetween(asOf, d.disputeDeadline),
    burn,
    alert: burnAlert(burn),
    promotionName: r.promotionName,
    actionable,
  };
}

async function deductionJoin(exec: LedgerDb, where: SQL | undefined): Promise<DeductionJoinRow[]> {
  return exec
    .select({
      deduction: deductions,
      customerName: customers.name,
      reasonLabel: deductionReasonCodes.label,
      category: deductionReasonCodes.category,
      promotionName: promotions.name,
    })
    .from(deductions)
    .innerJoin(customers, eq(customers.id, deductions.customerId))
    .leftJoin(deductionReasonCodes, eq(deductionReasonCodes.code, deductions.reasonCode))
    .leftJoin(promotions, eq(promotions.id, deductions.promotionId))
    .where(where)
    .orderBy(asc(deductions.deductionDate), asc(deductions.deductionNo));
}

function tabOf(row: DeductionRowView): DeductionTab {
  if (!row.actionable) return 'resolved';
  return row.status === 'disputed' || (row.status === 'partially_recovered' && row.treatment === 'dispute' && row.disputeDeadline !== null)
    ? 'disputed'
    : 'open';
}

function deadlineOrder(a: DeductionRowView, b: DeductionRowView): number {
  return (a.disputeDeadline ?? '9999-12-31').localeCompare(b.disputeDeadline ?? '9999-12-31') || a.deductionNo.localeCompare(b.deductionNo);
}

export async function deductionWorkbench(tab: DeductionTab): Promise<{ rows: DeductionRowView[]; counts: Record<DeductionTab, number> }> {
  const exec = await database();
  const asOf = today();
  const all = (await deductionJoin(exec, undefined)).map((r) => deductionRow(r, asOf));
  const counts: Record<DeductionTab, number> = { open: 0, disputed: 0, resolved: 0 };
  for (const row of all) counts[tabOf(row)] += 1;
  const rows = all.filter((row) => tabOf(row) === tab);
  rows.sort(tab === 'resolved' ? (a, b) => b.deductionDate.localeCompare(a.deductionDate) : deadlineOrder);
  return { rows, counts };
}

/** The routing `validateDeduction` takes, computed without writing. */
async function planValidation(
  exec: LedgerDb,
  d: Deduction,
  book: ReasonCodeBook,
  overrideCode: string | null,
  date: CalendarDate,
): Promise<ValidationPreview> {
  if (!isInReceivable(d)) {
    return { kind: 'not_actionable', message: `Deduction ${d.deductionNo} is ${d.status.replace('_', ' ')}; nothing is left in Deductions Receivable.` };
  }
  const open = openCentsOf(d);
  let info = d.reasonCode === null ? null : reasonCodeByKey(book, d.reasonCode);
  if (overrideCode !== null) {
    info = reasonCodeByKey(book, overrideCode);
    if (info === null) return { kind: 'needs_classification', message: `Reason code ${overrideCode} is not in the reason-code table.` };
  }
  const [cust] = await exec
    .select({ channelId: customers.channelId, code: channels.code })
    .from(customers)
    .leftJoin(channels, eq(channels.id, customers.channelId))
    .where(eq(customers.id, d.customerId));
  const channelCode = cust?.code ?? null;

  let accountLine: { accountCode?: string; accountId?: string };
  let destination: string;
  let tradeSpend = false;
  if (info === null || info.treatment === 'suspense' || info.treatment === 'recovery') {
    return {
      kind: 'needs_classification',
      message: `This deduction has no usable reason code${d.sourceReasonCode ? ` (the distributor printed "${d.sourceReasonCode}")` : ''}. Choose one to see where it books.`,
    };
  } else if (info.treatment === 'dispute' || info.treatment === 'billing_correction') {
    const salesCode =
      info.treatment === 'billing_correction' && info.accountCode !== null
        ? info.accountCode
        : channelCode !== null && channelCode in CHANNEL_REVENUE_ACCOUNT
          ? CHANNEL_REVENUE_ACCOUNT[channelCode as ChannelCode]
          : ACCOUNTS.SALES_DISTRIBUTOR;
    accountLine = { accountCode: salesCode };
    destination = 'Billing correction to gross sales';
  } else {
    if (info.accountId === null) return { kind: 'needs_classification', message: `Reason code ${info.code} has no default account.` };
    accountLine = { accountId: info.accountId };
    tradeSpend = info.treatment !== 'expense' && info.isTradeSpend;
    destination = tradeSpend ? 'Trade spend' : info.treatment === 'expense' ? 'Expense' : 'Contra revenue';
  }

  let promotionId = d.promotionId;
  if (promotionId === null && d.dealNumber !== null) {
    const [promo] = await exec
      .select({ id: promotions.id })
      .from(promotions)
      .where(and(eq(promotions.customerId, d.customerId), sql`upper(${promotions.authorizationNo}) = ${d.dealNumber.toUpperCase()}`))
      .limit(1);
    if (promo !== undefined) promotionId = promo.id;
  }
  const charged = tradeSpend && promotionId !== null ? Math.min(open, await remainingAccrualCents(exec, promotionId)) : 0;
  const memo = `Validate deduction ${d.deductionNo}`;
  const lines: DraftLine[] = [];
  if (charged > 0) lines.push({ accountCode: ACCOUNTS.ACCRUED_TRADE_SPEND, debitCents: charged, memo: `${memo} (charged to accrual)` });
  if (open - charged > 0) lines.push({ ...accountLine, debitCents: open - charged, memo });
  lines.push({ accountCode: ACCOUNTS.DEDUCTIONS_RECEIVABLE, creditCents: open, memo });
  return {
    kind: 'entry',
    entry: { date, memo, lines: await readableLines(exec, lines) },
    destination: charged > 0 ? `${destination}, charged to the promotion's accrual first` : destination,
    chargedToAccrualCents: charged,
  };
}

export async function validationPreview(deductionId: string, reasonCode: string | null, date: CalendarDate): Promise<ValidationPreview> {
  if (!UUID.test(deductionId)) return { kind: 'not_actionable', message: 'That deduction reference is not valid.' };
  const exec = await database();
  const [d] = await exec.select().from(deductions).where(eq(deductions.id, deductionId));
  if (d === undefined) return { kind: 'not_actionable', message: 'That deduction no longer exists.' };
  return planValidation(exec, d, await loadReasonCodes(exec), reasonCode, date);
}

/** Every selected deduction's validation, combined into the lines the batch will post. */
export async function bulkValidationPreview(ids: readonly string[], date: CalendarDate): Promise<BulkValidationView> {
  const valid = ids.filter((id) => UUID.test(id));
  const exec = await database();
  const rows = valid.length === 0 ? [] : await exec.select().from(deductions).where(inArray(deductions.id, [...valid]));
  const book = await loadReasonCodes(exec);
  const ready: BulkValidationView['ready'] = [];
  const refused: BulkValidationView['refused'] = [];
  const combined = new Map<string, EntryLineView>();
  for (const d of rows.sort((a, b) => a.deductionNo.localeCompare(b.deductionNo))) {
    const plan = await planValidation(exec, d, book, null, date);
    if (plan.kind !== 'entry') {
      refused.push({ id: d.id, deductionNo: d.deductionNo, message: plan.message });
      continue;
    }
    ready.push({ id: d.id, deductionNo: d.deductionNo, destination: plan.destination, amountCents: openCentsOf(d) });
    for (const line of plan.entry.lines) {
      const key = `${line.accountCode}:${line.debitCents > 0 ? 'dr' : 'cr'}`;
      const prior = combined.get(key);
      combined.set(key, {
        ...line,
        memo: null,
        debitCents: (prior?.debitCents ?? 0) + line.debitCents,
        creditCents: (prior?.creditCents ?? 0) + line.creditCents,
      });
    }
  }
  const lines = [...combined.values()].sort((a, b) => Number(a.creditCents > 0) - Number(b.creditCents > 0) || a.accountCode.localeCompare(b.accountCode));
  return {
    entry: lines.length === 0 ? null : { date, memo: `Validate ${ready.length} deduction${ready.length === 1 ? '' : 's'} (one entry each)`, lines },
    ready,
    refused,
  };
}

function rawFields(raw: Record<string, string | null> | null): { label: string; value: string }[] {
  if (raw === null) return [];
  const skip = new Set(['sourceFileHash', 'fingerprint', 'occurrence', 'currency']);
  return Object.entries(raw)
    .filter(([k, v]) => v !== null && v !== '' && !skip.has(k))
    .map(([k, v]) => ({ label: k.replace(/([A-Z])/g, ' $1').replace(/Cents$/, '').trim().toLowerCase(), value: String(v) }));
}

export async function deductionDetail(deductionId: string): Promise<DeductionDetailView | null> {
  if (!UUID.test(deductionId)) return null;
  const exec = await database();
  const [joined] = await deductionJoin(exec, eq(deductions.id, deductionId));
  if (joined === undefined) return null;
  const d = joined.deduction;
  const asOf = today();
  const book = await loadReasonCodes(exec);

  const [remittance] =
    d.remittanceId === null
      ? []
      : await exec
          .select({
            id: remittances.id,
            sourceSystem: remittances.sourceSystem,
            paymentNumber: remittances.paymentNumber,
            paymentDate: remittances.remittanceDate,
            filename: remittances.filename,
            totalCents: remittances.totalCents,
          })
          .from(remittances)
          .where(eq(remittances.id, d.remittanceId));
  const [line] =
    d.remittanceLineId === null
      ? []
      : await exec.select({ raw: remittanceLines.raw }).from(remittanceLines).where(eq(remittanceLines.id, d.remittanceLineId));

  const entryIds = [d.journalEntryId, d.resolutionEntryId].filter((id): id is string => id !== null);
  const entries = await exec
    .select({ id: journalEntries.id, entryNo: journalEntries.entryNo, date: journalEntries.entryDate, memo: journalEntries.memo, sourceType: journalEntries.sourceType })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.status, 'posted'),
        entryIds.length > 0
          ? sql`(${journalEntries.id} in ${entryIds} or (${journalEntries.sourceType} = 'deduction' and ${journalEntries.sourceId} = ${d.id}))`
          : sql`(${journalEntries.sourceType} = 'deduction' and ${journalEntries.sourceId} = ${d.id})`,
      ),
    )
    .orderBy(asc(journalEntries.entryNo));

  const files = await exec
    .select({ id: attachments.id, filename: attachments.filename, uploadedAt: attachments.uploadedAt })
    .from(attachments)
    .where(and(eq(attachments.entityType, 'deduction'), eq(attachments.entityId, d.id)))
    .orderBy(desc(attachments.uploadedAt));

  const info = d.reasonCode === null ? null : reasonCodeByKey(book, d.reasonCode);
  const windowDays = info !== null && info.windowDays > 0 ? info.windowDays : DEFAULT_DISPUTE_WINDOW_DAYS;
  const source = remittance?.sourceSystem ?? d.reasonCode?.split(':')[0] ?? null;
  const reasonOptions: Option[] = [...book.values()]
    .filter((r) => r.treatment !== 'recovery' && r.treatment !== 'suspense' && (r.sourceSystem === 'GEN' || r.sourceSystem === source))
    .sort((a, b) => Number(a.sourceSystem === 'GEN') - Number(b.sourceSystem === 'GEN') || a.code.localeCompare(b.code))
    .map((r) => ({ value: r.code, label: `${r.code} · ${r.label}`, hint: TREATMENT_LABEL[r.treatment] ?? r.treatment }));

  const labels = await labelsByCode(exec, [ACCOUNTS.DEDUCTIONS_RECEIVABLE, ACCOUNTS.UNAUTHORIZED_DEDUCTIONS, ACCOUNTS.UNDEPOSITED_FUNDS]);

  return {
    row: deductionRow(joined, asOf),
    reference: d.reference,
    dealNumber: d.dealNumber,
    invoiceId: d.invoiceId,
    invoiceDate: d.invoiceDate,
    promotionId: d.promotionId,
    customerId: d.customerId,
    remittance: remittance ?? null,
    sourceLine: rawFields(line?.raw ?? null),
    disputeReference: d.disputeReference,
    disputeNotes: d.disputeNotes,
    disputedOn: dayOf(d.disputedAt),
    resolvedOn: dayOf(d.resolvedAt),
    entries: entries.map((e) => ({
      id: e.id,
      entryNo: e.entryNo,
      date: e.date,
      memo: e.memo,
      role: e.id === d.journalEntryId ? 'Arrived on the remittance' : e.id === d.resolutionEntryId ? 'Latest resolution' : 'Resolution',
    })),
    attachments: files.map((f) => ({ id: f.id, filename: f.filename, uploadedOn: dayOf(f.uploadedAt) })),
    windowDays,
    validation: await planValidation(exec, d, book, null, asOf),
    reasonOptions,
    depositOptions: await depositAccounts(exec),
    accounts: {
      receivable: mustLabel(labels, ACCOUNTS.DEDUCTIONS_RECEIVABLE),
      writeOff: mustLabel(labels, ACCOUNTS.UNAUTHORIZED_DEDUCTIONS),
      undeposited: mustLabel(labels, ACCOUNTS.UNDEPOSITED_FUNDS),
    },
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function tradeOverview(userId: string): Promise<TradeOverviewView> {
  const exec = await database();
  const asOf = today();
  const from = `${asOf.slice(0, 4)}-01-01`;
  const kpis = await tradeKpis({ from, to: asOf }, { userId });
  const all = (await deductionJoin(exec, undefined)).map((r) => deductionRow(r, asOf));
  const open = all.filter((r) => r.actionable);
  const [counts] = await exec.execute<{ distributors: number; promotions: number; remittances: number }>(sql`
    select (select count(*) from customers where customer_type = 'distributor' and active)::int as distributors,
           (select count(*) from promotions)::int as promotions,
           (select count(*) from remittances)::int as remittances
  `);
  const accrued = kpis.accrualVariance.reduce((s, v) => s + v.accruedCents, 0);
  const actual = kpis.accrualVariance.reduce((s, v) => s + v.actualCents, 0);
  return {
    from,
    to: asOf,
    asOf: kpis.openReceivable.asOf,
    distributorCount: Number(counts?.distributors ?? 0),
    promotionCount: Number(counts?.promotions ?? 0),
    remittanceCount: Number(counts?.remittances ?? 0),
    grossSalesCents: kpis.totals.grossSalesCents,
    tradeSpendCents: kpis.totals.tradeSpendCents,
    tradeSpendRatio: kpis.totals.tradeSpendRatio,
    grossInvoicedCents: kpis.totals.grossInvoicedCents,
    deductionsCents: kpis.totals.deductionsCents,
    deductionRate: kpis.totals.deductionRate,
    openReceivableCents: kpis.openReceivable.totalCents,
    unappliedCents: kpis.openReceivable.unappliedCents,
    openCount: open.length,
    buckets: AGING_BUCKETS.map((b) => ({ label: b, cents: kpis.openReceivable.buckets[b] })),
    nearDeadline: open.filter((r) => r.alert !== 'none').sort(deadlineOrder),
    accruedCents: accrued,
    actualCents: actual,
    accrualVarianceCents: actual - accrued,
    accrualVarianceRatio: accrued === 0 ? null : Math.round(((actual - accrued) / accrued) * 10_000) / 10_000,
    variances: kpis.accrualVariance
      .map((v) => ({ promotionId: v.promotionId, name: v.name, accruedCents: v.accruedCents, actualCents: v.actualCents, varianceCents: v.varianceCents, varianceRatio: v.varianceRatio }))
      .sort((a, b) => Math.abs(b.varianceCents) - Math.abs(a.varianceCents))
      .slice(0, 6),
    recoveryRate: kpis.disputes.recoveryRate,
    winRate: kpis.disputes.winRate,
    casesClosed: kpis.disputes.casesClosed,
    daysToDeduction: {
      count: kpis.daysToDeduction.count,
      meanDays: kpis.daysToDeduction.meanDays,
      p50Days: kpis.daysToDeduction.p50Days,
      p90Days: kpis.daysToDeduction.p90Days,
    },
  };
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

export async function promotionRows(userId: string): Promise<PromotionRowView[]> {
  const exec = await database();
  const perf = await promotionPerformanceReport({}, { userId });
  if (perf.length === 0) return [];
  const extra = await exec
    .select({
      id: promotions.id,
      shipStartDate: promotions.shipStartDate,
      shipEndDate: promotions.shipEndDate,
      authorizationNo: promotions.authorizationNo,
    })
    .from(promotions)
    .where(inArray(promotions.id, perf.map((p) => p.id)));
  const byId = new Map(extra.map((e) => [e.id, e]));
  return perf.map((p) => ({
    id: p.id,
    name: p.name,
    customerName: p.customerName,
    promoType: p.promoType,
    typeLabel: PROMO_TYPE_LABEL[p.promoType] ?? p.promoType,
    status: p.status,
    startDate: p.startDate,
    endDate: p.endDate,
    shipStartDate: byId.get(p.id)?.shipStartDate ?? null,
    shipEndDate: byId.get(p.id)?.shipEndDate ?? null,
    authorizationNo: byId.get(p.id)?.authorizationNo ?? null,
    plannedCents: p.plannedCents,
    accruedCents: p.accruedCents,
    relievedCents: p.relievedCents,
    releasedCents: p.releasedCents,
    openAccrualCents: p.openAccrualCents,
    deductedCents: p.deductedCents,
    planVarianceCents: p.planVarianceCents,
    accrualVarianceCents: p.accrualVarianceCents,
    accrualVarianceRatio: p.accrualVarianceRatio,
  }));
}

export async function promotionDetail(promotionId: string, userId: string): Promise<PromotionDetailView | null> {
  if (!UUID.test(promotionId)) return null;
  const exec = await database();
  const [promotion] = await exec.select().from(promotions).where(eq(promotions.id, promotionId));
  if (promotion === undefined) return null;
  const [row] = (await promotionRows(userId)).filter((r) => r.id === promotionId);
  if (row === undefined) return null;

  const productLines = await exec
    .select({
      sku: products.sku,
      name: products.name,
      units: promotionProducts.plannedUnits,
      allowance: promotionProducts.allowancePerUnitCents,
    })
    .from(promotionProducts)
    .innerJoin(products, eq(products.id, promotionProducts.productId))
    .where(eq(promotionProducts.promotionId, promotionId))
    .orderBy(asc(products.sku));
  const allowance =
    productLines.length > 0
      ? allowanceCents(productLines.map((l) => ({ plannedUnits: l.units, allowancePerUnitCents: l.allowance })))
      : allowanceCents([{ plannedUnits: promotion.plannedUnits, allowancePerUnitCents: promotion.allowancePerUnitCents }]);
  const fee = Math.max(0, promotion.plannedSpendCents - allowance);

  const posted = await exec
    .select({ year: tradeAccruals.periodYear, month: tradeAccruals.periodMonth, entryId: tradeAccruals.journalEntryId, entryNo: journalEntries.entryNo })
    .from(tradeAccruals)
    .leftJoin(journalEntries, eq(journalEntries.id, tradeAccruals.journalEntryId))
    .where(and(eq(tradeAccruals.promotionId, promotionId), eq(tradeAccruals.basis, 'planned')));
  const postedByMonth = new Map(posted.map((p) => [`${p.year}-${p.month}`, p]));

  const schedule: ScheduleMonthView[] = accrualSchedule(accrualWindow(promotion), allowance, fee).map((m) => {
    const hit = postedByMonth.get(`${m.year}-${m.month}`);
    return {
      periodEnd: m.periodEnd,
      days: m.days,
      allowanceCents: m.allowanceCents,
      feeCents: m.feeCents,
      entryId: hit?.entryId ?? null,
      entryNo: hit?.entryNo ?? null,
    };
  });

  const contraCode = PROMO_CONTRA_ACCOUNT[promotion.promoType];
  const labels = await labelsByCode(exec, [contraCode, ACCOUNTS.DISTRIBUTOR_FEES, ACCOUNTS.ACCRUED_TRADE_SPEND]);
  const contra = mustLabel(labels, contraCode);
  const fees = mustLabel(labels, ACCOUNTS.DISTRIBUTOR_FEES);
  const accrual = mustLabel(labels, ACCOUNTS.ACCRUED_TRADE_SPEND);
  const asOf = today();
  const open = promotion.status === 'planned' || promotion.status === 'active';
  const due = open ? schedule.filter((m) => m.entryId === null && m.periodEnd <= asOf && m.allowanceCents + m.feeCents > 0) : [];
  const duePreview: EntryView[] = due.map((m) => {
    const memo = `Trade accrual ${promotion.name} ${m.periodEnd.slice(0, 7)}`;
    const lines: EntryLineView[] = [];
    if (m.allowanceCents > 0) lines.push({ accountCode: contra.code, accountName: contra.name, debitCents: m.allowanceCents, creditCents: 0, memo: null });
    if (m.feeCents > 0) lines.push({ accountCode: fees.code, accountName: fees.name, debitCents: m.feeCents, creditCents: 0, memo: 'Fixed fees' });
    lines.push({ accountCode: accrual.code, accountName: accrual.name, debitCents: 0, creditCents: m.allowanceCents + m.feeCents, memo: null });
    return { date: m.periodEnd, memo, lines };
  });
  const remaining = await remainingAccrualCents(exec, promotionId);
  const releasePreview: EntryView | null =
    open && remaining > 0
      ? {
          date: asOf,
          memo: `Release trade accrual ${promotion.name} — accrual variance`,
          lines: [
            { accountCode: accrual.code, accountName: accrual.name, debitCents: remaining, creditCents: 0, memo: null },
            { accountCode: contra.code, accountName: contra.name, debitCents: 0, creditCents: remaining, memo: null },
          ],
        }
      : null;

  const linked = (await deductionJoin(exec, eq(deductions.promotionId, promotionId))).map((r) => deductionRow(r, asOf));

  return {
    row,
    notes: promotion.notes,
    contraAccount: contra,
    products: productLines.map((l) => ({
      sku: l.sku,
      name: l.name,
      units: l.units,
      allowancePerUnitCents: l.allowance,
      extendedCents: allowanceCents([{ plannedUnits: l.units, allowancePerUnitCents: l.allowance }]),
    })),
    allowanceCents: allowance,
    fixedFeeCents: fee,
    schedule,
    dueThrough: asOf,
    duePreview,
    releasePreview,
    deductions: linked,
  };
}

export async function promotionFormOptions(): Promise<PromotionFormOptions> {
  const exec = await database();
  const productRows = await exec
    .select({ id: products.id, sku: products.sku, name: products.name, unit: products.unit })
    .from(products)
    .where(eq(products.active, true))
    .orderBy(asc(products.sku));
  const codes = [...new Set(Object.values(PROMO_CONTRA_ACCOUNT)), ACCOUNTS.DISTRIBUTOR_FEES];
  const labels = await labelsByCode(exec, codes);
  const promoTypes = (Object.keys(PROMO_CONTRA_ACCOUNT) as (keyof typeof PROMO_CONTRA_ACCOUNT)[]).map((type) => {
    const account = mustLabel(labels, PROMO_CONTRA_ACCOUNT[type]);
    return { value: type, label: PROMO_TYPE_LABEL[type] ?? type, accountCode: account.code, accountName: account.name, hint: PROMO_TYPE_HINT[type] ?? '' };
  });
  return {
    customers: await customerOptions(exec),
    products: productRows,
    promoTypes,
    feeAccount: mustLabel(labels, ACCOUNTS.DISTRIBUTOR_FEES),
  };
}

// ---------------------------------------------------------------------------
// Remittances
// ---------------------------------------------------------------------------

export async function remittanceRows(): Promise<RemittanceRowView[]> {
  const exec = await database();
  const rows = await exec
    .select({
      id: remittances.id,
      remittanceDate: remittances.remittanceDate,
      sourceSystem: remittances.sourceSystem,
      paymentNumber: remittances.paymentNumber,
      reference: remittances.reference,
      customerName: customers.name,
      totalCents: remittances.totalCents,
      invoicesGrossCents: remittances.invoicesGrossCents,
      deductionsCents: remittances.deductionsCents,
      repaymentsCents: remittances.repaymentsCents,
      warnings: remittances.warnings,
      entryId: remittances.journalEntryId,
      entryNo: journalEntries.entryNo,
      filename: remittances.filename,
      deductionCount: sql<number>`(select count(*) from deductions d where d.remittance_id = ${remittances.id})::int`,
    })
    .from(remittances)
    .innerJoin(customers, eq(customers.id, remittances.customerId))
    .leftJoin(journalEntries, eq(journalEntries.id, remittances.journalEntryId))
    .orderBy(desc(remittances.remittanceDate), desc(remittances.createdAt));
  return rows.map((r) => ({
    id: r.id,
    remittanceDate: r.remittanceDate,
    sourceSystem: r.sourceSystem,
    paymentNumber: r.paymentNumber ?? r.reference,
    customerName: r.customerName,
    totalCents: r.totalCents,
    invoicesGrossCents: r.invoicesGrossCents,
    deductionsCents: r.deductionsCents,
    repaymentsCents: r.repaymentsCents,
    deductionCount: Number(r.deductionCount),
    warningCount: r.warnings.length,
    entryId: r.entryId,
    entryNo: r.entryNo,
    filename: r.filename,
  }));
}

export async function remittanceFormOptions(): Promise<RemittanceFormOptions> {
  const exec = await database();
  const deposits = await depositAccounts(exec);
  return {
    customers: await customerOptions(exec),
    deposits,
    defaultDepositId: deposits.find((d) => d.code === ACCOUNTS.UNDEPOSITED_FUNDS)?.id ?? deposits[0]?.id ?? null,
  };
}

function issueView(issue: Issue): IssueView {
  return { severity: issue.severity, code: issue.code, message: issue.message, remedy: issue.remedy ?? null };
}

/** Debit side against credit side of one payment's entry, by the role each account plays. */
function splitOf(lines: readonly EntryLineView[], depositCode: string, unappliedCents: number): RemittanceSplit {
  const split: RemittanceSplit = {
    cashCents: 0,
    accrualCents: 0,
    contraCents: 0,
    billingCorrectionCents: 0,
    receivableCents: 0,
    arRelievedCents: 0,
    repaymentCents: 0,
    unappliedCents,
  };
  for (const l of lines) {
    if (l.accountCode === depositCode) split.cashCents += l.debitCents - l.creditCents;
    else if (l.accountCode === ACCOUNTS.AR) split.arRelievedCents += l.creditCents - l.debitCents;
    else if (l.accountCode === ACCOUNTS.DEDUCTIONS_RECEIVABLE) {
      split.receivableCents += l.debitCents;
      split.repaymentCents += l.creditCents;
    } else if (l.accountCode === ACCOUNTS.ACCRUED_TRADE_SPEND) split.accrualCents += l.debitCents - l.creditCents;
    else if (l.accountCode.startsWith('40')) split.billingCorrectionCents += l.debitCents - l.creditCents;
    else split.contraCents += l.debitCents - l.creditCents;
  }
  return split;
}

/**
 * Reads a remittance file and plans every payment in it exactly as posting would, with the
 * books as they stand now. Writes nothing.
 */
export async function previewRemittanceFile(
  file: ParsedFile,
  options: { customerId: string; depositAccountId: string; sourceSystem?: RemittanceSource },
): Promise<RemittancePreviewView> {
  const exec = await database();
  const parsed = parseRemittance(file, options.sourceSystem === undefined ? {} : { sourceSystem: options.sourceSystem });
  const [customer] = await exec
    .select({ id: customers.id, name: customers.name, channelId: customers.channelId })
    .from(customers)
    .where(eq(customers.id, options.customerId));
  if (customer === undefined) throw new Error('That customer no longer exists.');
  const [deposit] = [...(await labelsById(exec, [options.depositAccountId])).values()];
  if (deposit === undefined) throw new Error('That deposit account no longer exists.');
  const book = await loadReasonCodes(exec);

  const advices: AdvicePreviewView[] = [];
  const fatal = parsed.issues.some((i) => i.severity === 'fatal');
  for (const advice of fatal ? [] : parsed.advices) {
    const base = {
      paymentKey: advice.paymentKey,
      paymentNumber: advice.paymentNumber,
      paymentDate: advice.paymentDate,
      paymentMethod: advice.paymentMethod,
      regionDc: advice.regionDc,
      totalCents: advice.paymentTotalCents,
      lineCount: advice.rows.length,
    };
    const [existing] = await exec
      .select({ id: remittances.id, entryNo: journalEntries.entryNo })
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
      advices.push({
        ...base,
        status: 'already_imported',
        note: `Already posted${existing.entryNo === null ? '' : ` as JE #${existing.entryNo}`}; it will be skipped.`,
        split: null,
        entry: null,
        deductions: [],
        issues: advice.issues.map(issueView),
      });
      continue;
    }
    if (!isPostable(advice)) {
      advices.push({ ...base, status: 'quarantined', note: null, split: null, entry: null, deductions: [], issues: advice.issues.map(issueView) });
      continue;
    }
    const inputs = await loadPlanInputs(exec, advice, customer.id);
    const plan = planRemittance(advice, {
      customerId: customer.id,
      customerChannelId: customer.channelId,
      depositAccountId: deposit.id,
      reasonCodes: book,
      invoices: inputs.invoices,
      promotions: inputs.promotions,
      openDeductions: inputs.openDeductions,
      existingDeductionNos: inputs.existingNos,
    });
    const lines = plan.postable ? await readableLines(exec, plan.lines) : [];
    advices.push({
      ...base,
      status: plan.postable ? 'ready' : 'quarantined',
      note: null,
      split: plan.postable ? splitOf(lines, deposit.code, plan.unappliedCents) : null,
      entry: plan.postable ? { date: advice.paymentDate, memo: `${advice.sourceSystem} remittance ${advice.paymentNumber} from ${customer.name}`, lines } : null,
      deductions: plan.deductions.map((d) => ({
        deductionNo: d.deductionNo,
        sourceReasonCode: d.sourceReasonCode,
        reasonCode: d.reasonCode,
        reasonLabel: d.reasonCode === null ? null : (book.get(d.reasonCode)?.label ?? null),
        treatment: d.treatment,
        amountCents: d.amountCents,
        accrualChargedCents: d.accrualChargedCents,
        invoiceNo: d.invoiceNo,
        disputeDeadline: d.disputeDeadline,
        description: d.description,
      })),
      issues: plan.issues.map(issueView),
    });
  }
  return {
    filename: file.filename,
    sourceSystem: parsed.sourceSystem,
    customerName: customer.name,
    depositLabel: `${deposit.code} ${deposit.name}`,
    issues: parsed.issues.map(issueView),
    advices,
  };
}

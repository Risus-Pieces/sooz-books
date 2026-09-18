/**
 * The shapes the Trade screens render. Server queries and actions build them from the trade
 * engine (`@/lib/trade`); components only ever see these, never a database row.
 */

export interface TradeActionFailure {
  code: string;
  message: string;
  /** Extra lines a refusal carries, e.g. one per deduction a bulk action could not take. */
  details?: string[];
}

export type TradeActionResult<T> = { ok: true; value: T } | { ok: false; error: TradeActionFailure };

// ---------------------------------------------------------------------------
// Entries shown before they post
// ---------------------------------------------------------------------------

export interface EntryLineView {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
}

export interface EntryView {
  date: string;
  memo: string;
  lines: EntryLineView[];
}

/** The accounts a client-side preview needs by name. */
export interface AccountLabel {
  id: string;
  code: string;
  name: string;
}

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export type DeadlineAlert = "none" | "alert" | "escalate" | "expired";

export interface AgingBucketView {
  label: string;
  cents: number;
}

export interface VarianceRowView {
  promotionId: string;
  name: string;
  accruedCents: number;
  actualCents: number;
  varianceCents: number;
  varianceRatio: number | null;
}

export interface TradeOverviewView {
  from: string;
  to: string;
  asOf: string;
  distributorCount: number;
  promotionCount: number;
  remittanceCount: number;
  grossSalesCents: number;
  tradeSpendCents: number;
  tradeSpendRatio: number | null;
  grossInvoicedCents: number;
  deductionsCents: number;
  deductionRate: number | null;
  openReceivableCents: number;
  unappliedCents: number;
  openCount: number;
  buckets: AgingBucketView[];
  nearDeadline: DeductionRowView[];
  accruedCents: number;
  actualCents: number;
  accrualVarianceCents: number;
  accrualVarianceRatio: number | null;
  variances: VarianceRowView[];
  recoveryRate: number | null;
  winRate: number | null;
  casesClosed: number;
  daysToDeduction: { count: number; meanDays: number | null; p50Days: number | null; p90Days: number | null };
}

// ---------------------------------------------------------------------------
// Deductions
// ---------------------------------------------------------------------------

export const DEDUCTION_TABS = ["open", "disputed", "resolved"] as const;
export type DeductionTab = (typeof DEDUCTION_TABS)[number];

export function isDeductionTab(value: string): value is DeductionTab {
  return (DEDUCTION_TABS as readonly string[]).includes(value);
}

export interface DeductionRowView {
  id: string;
  deductionNo: string;
  customerName: string;
  deductionDate: string;
  invoiceNo: string | null;
  reasonCode: string | null;
  sourceReasonCode: string | null;
  reasonLabel: string | null;
  category: string | null;
  description: string | null;
  amountCents: number;
  openCents: number;
  recoveredCents: number;
  writtenOffCents: number;
  status: string;
  treatment: string;
  disputeDeadline: string | null;
  daysOutstanding: number;
  daysToDeadline: number | null;
  /** Share of the dispute window used, 0–1+; null without a deadline. */
  burn: number | null;
  alert: DeadlineAlert;
  promotionName: string | null;
  /** Still sitting in 1210 with money open: every workbench action applies. */
  actionable: boolean;
}

export interface RawFieldView {
  label: string;
  value: string;
}

export interface LinkedEntryView {
  id: string;
  entryNo: number;
  date: string;
  memo: string | null;
  role: string;
}

export type ValidationPreview =
  | { kind: "entry"; entry: EntryView; destination: string; chargedToAccrualCents: number }
  | { kind: "needs_classification"; message: string }
  | { kind: "not_actionable"; message: string };

export interface DeductionDetailView {
  row: DeductionRowView;
  reference: string | null;
  dealNumber: string | null;
  invoiceId: string | null;
  invoiceDate: string | null;
  promotionId: string | null;
  customerId: string;
  remittance: {
    id: string;
    sourceSystem: string | null;
    paymentNumber: string | null;
    paymentDate: string;
    filename: string | null;
    totalCents: number;
  } | null;
  sourceLine: RawFieldView[];
  disputeReference: string | null;
  disputeNotes: string | null;
  disputedOn: string | null;
  resolvedOn: string | null;
  entries: LinkedEntryView[];
  attachments: { id: string; filename: string; uploadedOn: string | null }[];
  /** The reason code's own window, in days. */
  windowDays: number;
  validation: ValidationPreview;
  reasonOptions: Option[];
  depositOptions: AccountLabel[];
  accounts: { receivable: AccountLabel; writeOff: AccountLabel; undeposited: AccountLabel };
}

export interface BulkValidationView {
  entry: EntryView | null;
  ready: { id: string; deductionNo: string; destination: string; amountCents: number }[];
  refused: { id: string; deductionNo: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

export interface PromotionRowView {
  id: string;
  name: string;
  customerName: string | null;
  promoType: string;
  typeLabel: string;
  status: string;
  startDate: string;
  endDate: string;
  shipStartDate: string | null;
  shipEndDate: string | null;
  authorizationNo: string | null;
  plannedCents: number;
  accruedCents: number;
  relievedCents: number;
  releasedCents: number;
  openAccrualCents: number;
  deductedCents: number;
  planVarianceCents: number;
  accrualVarianceCents: number;
  accrualVarianceRatio: number | null;
}

export interface ScheduleMonthView {
  periodEnd: string;
  days: number;
  allowanceCents: number;
  feeCents: number;
  /** Posted already, with the entry. */
  entryId: string | null;
  entryNo: number | null;
}

export interface PromotionDetailView {
  row: PromotionRowView;
  notes: string | null;
  contraAccount: AccountLabel;
  products: { sku: string; name: string; units: string | null; allowancePerUnitCents: number | null; extendedCents: number }[];
  allowanceCents: number;
  fixedFeeCents: number;
  schedule: ScheduleMonthView[];
  /** Months ended by today and not accrued. */
  dueThrough: string;
  duePreview: EntryView[];
  releasePreview: EntryView | null;
  deductions: DeductionRowView[];
}

export interface PromoTypeOption {
  value: string;
  label: string;
  accountCode: string;
  accountName: string;
  hint: string;
}

export interface PromotionFormOptions {
  customers: Option[];
  products: { id: string; sku: string; name: string; unit: string }[];
  promoTypes: PromoTypeOption[];
  feeAccount: AccountLabel;
}

export interface PlanPreviewView {
  allowanceCents: number;
  feeCents: number;
  totalCents: number;
  months: { periodEnd: string; days: number; allowanceCents: number; feeCents: number }[];
}

export interface PromotionDraft {
  name: string;
  customerId: string;
  promoType: string;
  startDate: string;
  endDate: string;
  shipStartDate: string;
  shipEndDate: string;
  authorizationNo: string;
  /** Used when no product lines are given. */
  plannedUnits: string;
  allowancePerUnit: string;
  fixedFee: string;
  notes: string;
  products: { productId: string; plannedUnits: string; allowancePerUnit: string }[];
}

// ---------------------------------------------------------------------------
// Remittances
// ---------------------------------------------------------------------------

export interface RemittanceRowView {
  id: string;
  remittanceDate: string;
  sourceSystem: string | null;
  paymentNumber: string | null;
  customerName: string;
  totalCents: number;
  invoicesGrossCents: number;
  deductionsCents: number;
  repaymentsCents: number;
  deductionCount: number;
  warningCount: number;
  entryId: string | null;
  entryNo: number | null;
  filename: string | null;
}

export interface IssueView {
  severity: string;
  code: string;
  message: string;
  remedy: string | null;
}

/** How one payment's entry divides, debit side against credit side. */
export interface RemittanceSplit {
  cashCents: number;
  accrualCents: number;
  contraCents: number;
  billingCorrectionCents: number;
  receivableCents: number;
  arRelievedCents: number;
  repaymentCents: number;
  unappliedCents: number;
}

export interface PlannedDeductionView {
  deductionNo: string;
  sourceReasonCode: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  treatment: string;
  amountCents: number;
  accrualChargedCents: number;
  invoiceNo: string | null;
  disputeDeadline: string | null;
  description: string | null;
}

export interface AdvicePreviewView {
  paymentKey: string;
  paymentNumber: string;
  paymentDate: string;
  paymentMethod: string | null;
  regionDc: string | null;
  totalCents: number;
  lineCount: number;
  status: "ready" | "quarantined" | "already_imported";
  note: string | null;
  split: RemittanceSplit | null;
  entry: EntryView | null;
  deductions: PlannedDeductionView[];
  issues: IssueView[];
}

export interface RemittancePreviewView {
  filename: string;
  sourceSystem: string | null;
  customerName: string;
  depositLabel: string;
  issues: IssueView[];
  advices: AdvicePreviewView[];
}

export interface RemittancePostView {
  posted: { paymentNumber: string; entryId: string; entryNo: number; deductions: number }[];
  skipped: { paymentNumber: string; message: string }[];
  quarantined: { paymentNumber: string; reasons: string[] }[];
}

export interface RemittanceFormOptions {
  customers: Option[];
  deposits: AccountLabel[];
  defaultDepositId: string | null;
}

/**
 * The shapes the channel screens render. Plain data, serialisable across the server/client
 * boundary: the pages read them through `@/app/(app)/channels/queries` and the actions
 * return them. Nothing here touches the database.
 */

export type ProviderKey = "square" | "shopify" | "amazon" | "faire";

export const PROVIDER_KEYS: readonly ProviderKey[] = ["square", "shopify", "amazon", "faire"];

export const PROVIDER_NAME: Readonly<Record<ProviderKey, string>> = {
  square: "Square",
  shopify: "Shopify",
  amazon: "Amazon",
  faire: "Faire",
};

export function isProviderKey(value: string): value is ProviderKey {
  return (PROVIDER_KEYS as readonly string[]).includes(value);
}

export interface ActionFailure {
  code: string;
  message: string;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionFailure };

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------

export interface ClearingDepositView {
  id: string;
  date: string;
  amountCents: number;
  description: string;
  posted: boolean;
  payoutImportId: string | null;
}

export interface ClearingSettlementView {
  id: string;
  key: string | null;
  date: string | null;
  netCents: number;
  posted: boolean;
  depositCents: number;
}

export interface ClearingExceptionView {
  severity: "block" | "warn" | "info";
  code: string;
  message: string;
  amountCents: number;
  date: string | null;
}

export interface ChannelCardView {
  provider: ProviderKey;
  accountCode: string;
  accountName: string;
  asOf: string;
  balanceCents: number;
  projectedBalanceCents: number;
  pendingDepositsCents: number;
  settlements: ClearingSettlementView[];
  deposits: ClearingDepositView[];
  unmatchedDepositCount: number;
  unmatchedDepositCents: number;
  unmatchedSettlementCount: number;
  exceptions: ClearingExceptionView[];
  blocking: boolean;
  explanation: string;
  lastSettlement: { id: string; key: string | null; date: string | null; netCents: number; posted: boolean } | null;
  /** True once any settlement or deposit has touched this channel's clearing account. */
  connected: boolean;
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export type DepositState = "matched" | "waiting" | "late" | "stale" | "none";

export interface SettlementRowView {
  id: string;
  provider: ProviderKey;
  key: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  grossCents: number;
  feesCents: number;
  netCents: number;
  reportedCents: number | null;
  linesCents: number;
  lineCount: number;
  depositState: DepositState;
  depositDate: string | null;
  depositCents: number;
  entryId: string | null;
  entryNo: number | null;
  filename: string | null;
  importedAt: string;
}

export interface EntryLineView {
  accountCode: string;
  accountName: string;
  memo: string | null;
  debitCents: number;
  creditCents: number;
}

export interface SettlementLineView {
  lineNo: number;
  lineType: string;
  label: string;
  externalRef: string | null;
  sku: string | null;
  postedDate: string | null;
  amountCents: number;
  jurisdiction: string | null;
  /** The account this line posts (or posted) to; null for facilitator tax, which never posts. */
  accountCode: string | null;
  accountName: string | null;
  facilitator: boolean;
  taxSide: "collected" | "withheld" | null;
  suspense: boolean;
}

export interface SettlementIssueView {
  severity: "fatal" | "error" | "warn" | "info";
  code: string;
  message: string;
  remedy: string | null;
}

export interface DepositCandidateView {
  id: string;
  date: string;
  amountCents: number;
  description: string;
}

export interface SettlementDetailView {
  row: SettlementRowView;
  lines: SettlementLineView[];
  /** The entry the ledger holds (posted) or the entry posting would write (not posted). */
  entry: {
    kind: "posted" | "planned" | "refused";
    date: string | null;
    memo: string;
    lines: EntryLineView[];
    clearingAccountCode: string | null;
    clearingCents: number;
    facilitatorGrossCents: number;
    suspenseCents: number;
    /** Why posting would be refused, when `kind` is "refused". */
    refusal: { code: string; message: string; remedy: string | null } | null;
  };
  /** The settlement's identity: lines add to what the provider reports. */
  identity: { reportedCents: number | null; linesCents: number; differenceCents: number | null; ties: boolean };
  taxLines: { state: string | null; collectedCents: number; facilitatorCents: number; foreignCents: number }[];
  issues: SettlementIssueView[];
  linkedDeposits: DepositCandidateView[];
  candidates: DepositCandidateView[];
  /** A state to post tax lines under when the source names none. */
  defaultTaxState: string | null;
  needsTaxState: boolean;
}

// ---------------------------------------------------------------------------
// Import preview
// ---------------------------------------------------------------------------

export interface IdentityCheckView {
  label: string;
  passed: boolean;
  severity: "fatal" | "warn";
  expectedCents: number;
  actualCents: number;
  differenceCents: number;
  detail: string | null;
}

export interface PreviewSettlementView {
  key: string;
  periodEnd: string;
  grossCents: number;
  feesCents: number | null;
  netCents: number;
  lineCount: number | null;
  outcome: "new" | "already_imported";
  ties: boolean;
  checks: IdentityCheckView[];
  deposit: { status: "matched" | "none" | "partial" | "ambiguous"; detail: string };
}

export interface SettlementPreviewView {
  provider: ProviderKey;
  filename: string;
  rowCount: number;
  ok: boolean;
  settlements: PreviewSettlementView[];
  issues: SettlementIssueView[];
  newCount: number;
  alreadyCount: number;
  netTotalCents: number;
}

export interface SettlementImportView {
  provider: ProviderKey;
  filename: string;
  inserted: number;
  alreadyImported: number;
  depositsLinked: number;
}

// ---------------------------------------------------------------------------
// Sales tax
// ---------------------------------------------------------------------------

export interface LiabilityRowView {
  state: string;
  period: string;
  taxableCents: number;
  taxCents: number;
  facilitatorCents: number;
  owedCents: number;
  unfiledOwedCents: number;
}

export interface LiabilityView {
  rows: LiabilityRowView[];
  totals: { taxCents: number; facilitatorCents: number; owedCents: number; unfiledOwedCents: number };
  ledgerPayableCents: number;
  registerOwedCents: number;
  differenceCents: number;
}

export interface FilingView {
  id: string;
  state: string;
  periodStart: string;
  periodEnd: string;
  grossSalesCents: number;
  taxableCents: number;
  taxDueCents: number;
  taxPaidCents: number;
  filedAt: string | null;
  paidAt: string | null;
  confirmation: string | null;
  entryId: string | null;
  entryNo: number | null;
}

export interface BankOptionView {
  id: string;
  code: string;
  name: string;
}

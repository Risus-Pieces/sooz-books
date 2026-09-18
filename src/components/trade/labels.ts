/**
 * The words the Trade screens use for the engine's enums, written once so a promotion type,
 * a deduction's treatment and its status read the same on every screen.
 */

export const PROMO_TYPE_LABEL: Readonly<Record<string, string>> = {
  off_invoice: "Off-invoice",
  billback: "Billback",
  mcb: "Manufacturer chargeback (MCB)",
  scan_down: "Scan-down",
  tpr: "Temporary price reduction",
  slotting: "Slotting",
  free_fill: "Free fill",
  new_item_allowance: "New item allowance",
  ad_fee: "Ad fee",
  demo: "Demo",
  sampling: "Sampling",
  spoils_allowance: "Spoils allowance",
  freight_allowance: "Freight allowance",
  early_pay_discount: "Early-pay discount",
  other: "Other",
};

export const PROMO_TYPE_HINT: Readonly<Record<string, string>> = {
  off_invoice: "Taken off the invoice price when the distributor buys.",
  billback: "Billed back after the distributor sells through.",
  mcb: "The distributor deducts the promotion from a remittance, usually with an admin fee.",
  scan_down: "Paid per unit the retailer scans during the promotion.",
  tpr: "A shelf price cut paid per unit sold.",
  slotting: "A one-time fee for shelf space.",
  free_fill: "Free product to fill a new shelf, valued at cost to the distributor.",
  new_item_allowance: "An introductory allowance for a new item.",
  ad_fee: "A flyer, circular or ad placement.",
  demo: "An in-store demo.",
  sampling: "Samples handed out in store.",
  spoils_allowance: "A standing allowance for damaged or expired product.",
  freight_allowance: "A per-case freight allowance.",
  early_pay_discount: "The terms discount for paying early.",
  other: "Anything else agreed with the distributor.",
};

export const TREATMENT_LABEL: Readonly<Record<string, string>> = {
  accrual: "Charged to accrual",
  contra_revenue: "Contra revenue",
  dispute: "Disputable",
  suspense: "Unclassified",
  billing_correction: "Billing correction",
  recovery: "Repayment",
  expense: "Expense",
  cogs: "Cost of goods",
  ar_payment: "AR payment",
};

export const DEDUCTION_STATUS_LABEL: Readonly<Record<string, string>> = {
  open: "Open",
  disputed: "Disputed",
  partially_recovered: "Part recovered",
  validated: "Validated",
  recovered: "Recovered",
  written_off: "Written off",
};

export type Tone = "neutral" | "primary" | "positive" | "negative" | "warning" | "info";

export const DEDUCTION_STATUS_TONE: Readonly<Record<string, Tone>> = {
  open: "warning",
  disputed: "info",
  partially_recovered: "info",
  validated: "neutral",
  recovered: "positive",
  written_off: "negative",
};

export const PROMO_STATUS_TONE: Readonly<Record<string, Tone>> = {
  planned: "neutral",
  active: "primary",
  completed: "positive",
  cancelled: "negative",
};

/** "8.5%" from 0.085, or an em dash when there is nothing to divide by. */
export function percent(value: number | null, digits = 1): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 11, 2026", read straight off the YYYY-MM-DD string, never through a Date. */
export function longDate(date: string | null): string {
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "—";
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`;
}

/** "Sep 11". */
export function shortDate(date: string | null): string {
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "—";
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

/** "Sep 2026" from any date in the month. */
export function monthLabel(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

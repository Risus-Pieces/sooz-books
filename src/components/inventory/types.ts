import type { GlyphName } from "@/lib/ui/glyphs";
import type { Tint } from "@/lib/ui/tints";

/**
 * The shapes the inventory screens trade in. Plain, serialisable data: the
 * server reads the books into these, the client renders them and sends back
 * inputs for the actions in `@/app/(app)/inventory/actions`.
 */

export type CostComponentKey =
  | "tolling"
  | "ingredients"
  | "packaging"
  | "freight_in"
  | "duty"
  | "labor"
  | "overhead"
  | "other";

export type StageKey = "raw" | "packaging" | "wip" | "finished" | "in_transit";

export type AdjustmentReasonKey =
  | "count_variance"
  | "spoilage"
  | "damage"
  | "expiry"
  | "samples"
  | "demo"
  | "donation"
  | "theft"
  | "rework"
  | "revaluation"
  | "opening_balance";

export interface InvActionFailure {
  code: string;
  message: string;
  /** Extra lines the failure carries, e.g. the SKUs with no cost or why an import was refused. */
  details?: string[];
}

export type InvActionResult<T> = { ok: true; value: T } | { ok: false; error: InvActionFailure };

/** One line of an entry shown before it posts. Positive cents are debits. */
export interface PreviewLine {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
  /** SKU and channel code, when the line carries those dimensions. */
  sku: string | null;
  channelCode: string | null;
}

export interface EntryPreviewData {
  date: string;
  memo: string;
  lines: PreviewLine[];
}

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
  unit: string;
  /** Unit cost effective today, when the product has one. */
  unitCostCents: number | null;
}

export interface VendorOption {
  id: string;
  name: string;
  isCoMan: boolean;
}

export interface ChannelOption {
  id: string;
  code: string;
  name: string;
}

export const COMPONENT_LABELS: Record<CostComponentKey, string> = {
  tolling: "Tolling",
  ingredients: "Ingredients",
  packaging: "Packaging",
  freight_in: "Freight in",
  duty: "Duty",
  labor: "Labor",
  overhead: "Overhead",
  other: "Other",
};

export const COMPONENT_KEYS: readonly CostComponentKey[] = [
  "tolling",
  "ingredients",
  "packaging",
  "freight_in",
  "duty",
  "labor",
  "overhead",
  "other",
];

/**
 * One colour and one glyph per cost component, the same on every chart, legend and row. Ingredients
 * and packaging use their category's colour (teal, brown) so a run's bar reads like the books.
 */
export const COMPONENT_STYLE: Record<CostComponentKey, { tint: Tint; glyph: GlyphName }> = {
  tolling: { tint: "indigo", glyph: "wrench" },
  ingredients: { tint: "teal", glyph: "leaf" },
  packaging: { tint: "brown", glyph: "cube" },
  freight_in: { tint: "cyan", glyph: "truck" },
  duty: { tint: "gray", glyph: "shield" },
  labor: { tint: "mint", glyph: "people" },
  overhead: { tint: "purple", glyph: "building" },
  other: { tint: "gray", glyph: "ellipsis" },
};

/** One colour and one glyph per stage of inventory. */
export const STAGE_STYLE: Record<StageKey, { tint: Tint; glyph: GlyphName }> = {
  raw: { tint: "teal", glyph: "leaf" },
  packaging: { tint: "brown", glyph: "cube" },
  wip: { tint: "orange", glyph: "hourglass" },
  finished: { tint: "indigo", glyph: "tag" },
  in_transit: { tint: "cyan", glyph: "truck" },
};

export const STAGE_LABELS: Record<StageKey, string> = {
  raw: "Raw ingredients",
  packaging: "Packaging",
  wip: "Work in process",
  finished: "Finished goods",
  in_transit: "In transit",
};

export const STAGE_KEYS: readonly StageKey[] = ["raw", "packaging", "wip", "finished", "in_transit"];

export const REASON_LABELS: Record<AdjustmentReasonKey, string> = {
  spoilage: "Spoilage",
  damage: "Damage",
  expiry: "Expired",
  samples: "Samples",
  demo: "Demo product",
  donation: "Donation",
  theft: "Theft / loss",
  count_variance: "Count variance",
  rework: "Rework",
  revaluation: "Revaluation",
  opening_balance: "Opening balance",
};

/** Giveaways pink, losses red, corrections grey, the opening balance indigo (equity). */
export const REASON_STYLE: Record<AdjustmentReasonKey, { tint: Tint; glyph: GlyphName }> = {
  samples: { tint: "pink", glyph: "tag" },
  demo: { tint: "pink", glyph: "megaphone" },
  donation: { tint: "pink", glyph: "people" },
  spoilage: { tint: "red", glyph: "trash" },
  damage: { tint: "red", glyph: "warning" },
  expiry: { tint: "red", glyph: "clock" },
  theft: { tint: "red", glyph: "lock" },
  count_variance: { tint: "gray", glyph: "list" },
  rework: { tint: "gray", glyph: "refresh" },
  revaluation: { tint: "gray", glyph: "dollar" },
  opening_balance: { tint: "indigo", glyph: "book" },
};

/** The order reasons are offered in: the everyday ones first. */
export const REASON_KEYS: readonly AdjustmentReasonKey[] = [
  "spoilage",
  "samples",
  "demo",
  "damage",
  "expiry",
  "donation",
  "theft",
  "count_variance",
  "rework",
  "revaluation",
  "opening_balance",
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function periodLabel(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? "?"} ${year}`;
}

/** "Sep 18, 2026" from a YYYY-MM-DD string, read off the text and never through a Date. */
export function dayLabel(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1] ?? "?"} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`;
}

export function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Hundredths of a unit for display: 1250 -> "12.5", 120000 -> "1,200". */
export function formatUnits(hundredths: number): string {
  const negative = hundredths < 0;
  const abs = Math.abs(hundredths);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = abs % 100;
  const fraction = frac === 0 ? "" : `.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
  return `${negative ? "−" : ""}${whole}${fraction}`;
}

/* ------------------------------------------------------------ Peasy intake */

export interface PreviewIssue {
  severity: "info" | "warn" | "error" | "fatal";
  message: string;
  /** 1-based data row in the file, when the issue belongs to one. */
  row: number | null;
}

export interface UnknownItemPreview {
  key: string;
  label: string;
  suggestedSku: string;
  suggestedName: string;
}

export interface SnapshotPreviewLine {
  key: string;
  label: string;
  /** What a stage override is keyed by: the item's SKU, else its Peasy id, else its name. */
  overrideKey: string;
  productSku: string | null;
  location: string;
  stage: StageKey;
  quantity: number;
  valueCents: number;
  valueSource: "file" | "product_cost" | "none";
}

export interface SnapshotPreviewData {
  filename: string;
  snapshotDate: string | null;
  totalValueCents: number;
  totalsByStage: Partial<Record<StageKey, number>>;
  lines: SnapshotPreviewLine[];
  unknownItems: UnknownItemPreview[];
  issues: PreviewIssue[];
  blockers: string[];
  /** A snapshot for this date is already imported; committing replaces it. */
  replacesExisting: boolean;
  rows: { data: number; used: number; excluded: number; unreadable: number };
}

export interface ShipmentPreviewLineData {
  key: string;
  label: string;
  productSku: string | null;
  period: string;
  channelCode: string;
  units: number;
  returns: number;
}

export interface ShipmentsPreviewData {
  filename: string;
  lines: ShipmentPreviewLineData[];
  periods: Array<{ key: string; label: string; units: number; hasExisting: boolean; cogsPosted: boolean }>;
  unknownItems: UnknownItemPreview[];
  issues: PreviewIssue[];
  blockers: string[];
  rows: { data: number; used: number; excluded: number; unreadable: number };
}

export interface ProductToCreateInput {
  key: string;
  sku: string;
  name: string;
}

/* ------------------------------------------------------------- adjustments */

export interface AdjustmentFormInput {
  date: string;
  productId: string;
  reason: AdjustmentReasonKey;
  stage: StageKey;
  /** Positive units as typed; `direction` carries the sign. */
  quantity: string;
  direction: "out" | "in";
  /** Optional per-unit cost as typed, in dollars. */
  unitCost: string;
  /** Optional total value as typed, in dollars; beats quantity × unit cost. */
  value: string;
  channelId: string | null;
  memo: string;
}

export interface AdjustmentPreviewData {
  unitCostCents: number;
  /** Signed like the quantity: negative takes value out of inventory. */
  valueCents: number;
  entry: EntryPreviewData;
}

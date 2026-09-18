/**
 * How the ledger screens draw an entry: one glyph and tint per source, and the
 * flow diagram's two ends from an entry's lines. Pure; shared by the journal,
 * the entry page and the entry form.
 */

import type { FlowNode, FlowTarget } from "@/components/charts";
import { categoryForCode } from "@/lib/ui/categories";
import type { GlyphName } from "@/lib/ui/glyphs";
import type { Tint } from "@/lib/ui/tints";

import { sourceLabel } from "./types";

export interface SourceVisual {
  glyph: GlyphName;
  tint: Tint;
  label: string;
}

const SOURCE_VISUALS: Readonly<Record<string, { glyph: GlyphName; tint: Tint }>> = {
  manual: { glyph: "pencil", tint: "gray" },
  bank: { glyph: "bank", tint: "blue" },
  invoice: { glyph: "doc-text", tint: "green" },
  receipt: { glyph: "arrow-in", tint: "green" },
  credit_memo: { glyph: "doc", tint: "orange" },
  bill: { glyph: "doc", tint: "red" },
  bill_payment: { glyph: "arrow-out", tint: "red" },
  vendor_credit: { glyph: "doc", tint: "orange" },
  payout: { glyph: "storefront", tint: "mint" },
  deduction: { glyph: "minus", tint: "cyan" },
  cogs: { glyph: "cube", tint: "teal" },
  inventory: { glyph: "cube", tint: "teal" },
  landed_cost: { glyph: "truck", tint: "cyan" },
  accrual: { glyph: "hourglass", tint: "purple" },
  depreciation: { glyph: "wrench", tint: "gray" },
  payroll: { glyph: "people", tint: "mint" },
  sales_tax: { glyph: "percent", tint: "gray" },
  recurring: { glyph: "refresh", tint: "indigo" },
  reversal: { glyph: "undo", tint: "orange" },
  opening_balance: { glyph: "book", tint: "indigo" },
  qbo_migration: { glyph: "import", tint: "gray" },
};

export function sourceVisual(sourceType: string): SourceVisual {
  const visual = SOURCE_VISUALS[sourceType] ?? { glyph: "doc" as const, tint: "gray" as const };
  return { ...visual, label: sourceLabel(sourceType) };
}

/** What a flow diagram needs to know about one line. */
export interface FlowLine {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
}

/** "Relay — Operating Expenses ••9726" reads as "Operating Expenses ••9726" beside a bank glyph. */
export function shortAccountName(name: string): string {
  const trimmed = name.replace(/^[^—]*—\s*/, "");
  return trimmed === "" ? name : trimmed;
}

function node(line: FlowLine): FlowNode {
  const category = categoryForCode(line.accountCode);
  return { label: shortAccountName(line.accountName), glyph: category.glyph, tint: category.tint };
}

const MAX_TARGETS = 4;

/**
 * The flow diagram for an entry: the credited side is where the money comes from, the debited
 * side where it goes. A credit side of several accounts is drawn as one node naming the count;
 * a debit side past four accounts folds the rest into "N more".
 */
export function entryFlow(lines: readonly FlowLine[]): { from: FlowNode; to: FlowTarget[] } | null {
  const credits = lines.filter((line) => line.creditCents > 0).sort((a, b) => b.creditCents - a.creditCents);
  const debits = lines.filter((line) => line.debitCents > 0).sort((a, b) => b.debitCents - a.debitCents);
  if (credits.length === 0 || debits.length === 0) return null;

  const from: FlowNode =
    credits.length === 1 ? node(credits[0]) : { label: `${credits.length} accounts`, glyph: "split", tint: "gray" };

  const shown = debits.length > MAX_TARGETS ? debits.slice(0, MAX_TARGETS - 1) : debits;
  const to: FlowTarget[] = shown.map((line) => ({ ...node(line), cents: line.debitCents }));
  if (debits.length > shown.length) {
    const rest = debits.slice(shown.length);
    to.push({
      label: `${rest.length} more`,
      glyph: "ellipsis",
      tint: "gray",
      cents: rest.reduce((sum, line) => sum + line.debitCents, 0),
    });
  }
  return { from, to };
}

/** The account a journal row is about: the largest line that is not cash. */
export function leadAccount(lines: readonly FlowLine[]): FlowLine | null {
  const ranked = [...lines].sort(
    (a, b) => Math.max(b.debitCents, b.creditCents) - Math.max(a.debitCents, a.creditCents),
  );
  return ranked.find((line) => categoryForCode(line.accountCode).key !== "cash") ?? ranked[0] ?? null;
}

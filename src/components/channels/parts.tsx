import * as React from "react";

import type { FlowNode, FlowTarget } from "@/components/charts";
import { Glyph } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import { Pill, type PillTone } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import { categoryForCode } from "@/lib/ui/categories";
import type { GlyphName } from "@/lib/ui/glyphs";
import type { Tint } from "@/lib/ui/tints";

import type { DepositState, ProviderKey } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** "Jan 26" — read straight off the YYYY-MM-DD string, never through a Date. */
export function shortDate(date: string | null): string {
  if (date === null || !ISO.test(date)) return "—";
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

/** "Jan 26, 2026". */
export function longDate(date: string | null): string {
  if (date === null || !ISO.test(date)) return "—";
  return `${shortDate(date)}, ${date.slice(0, 4)}`;
}

/** "Jan 26 – Aug 31, 2026", or with both years when they differ. */
export function dateSpan(dates: readonly string[]): string {
  const sorted = dates.filter((d) => ISO.test(d)).sort();
  if (sorted.length === 0) return "";
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === last) return longDate(first);
  return first.slice(0, 4) === last.slice(0, 4) ? `${shortDate(first)} – ${longDate(last)}` : `${longDate(first)} – ${longDate(last)}`;
}

/** "September 2026" from a period's first day. */
export function monthName(period: string): string {
  return `${MONTHS_LONG[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
}

/** "Sep 2026". */
export function monthShortName(period: string): string {
  return `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
}

/**
 * A settlement's reference as a reader can use it: the provider's own key when it is short
 * ("SQ260126"), else the first eight characters of the hash the importer keyed it on.
 */
export function settlementRef(key: string | null): string {
  if (key === null || key === "") return "Settlement";
  return key.length <= 16 ? key : `#${key.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Channel identity
// ---------------------------------------------------------------------------

/** Each channel's badge. The glyph says what kind of seller it is; the tint only tells them apart. */
export const PROVIDER_BADGE: Readonly<Record<ProviderKey, { glyph: GlyphName; tint: Tint }>> = {
  square: { glyph: "credit-card", tint: "gray" },
  shopify: { glyph: "bag", tint: "green" },
  amazon: { glyph: "cube", tint: "orange" },
  faire: { glyph: "storefront", tint: "brown" },
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const DEPOSIT_LABEL: Record<DepositState, string> = {
  matched: "Deposited",
  waiting: "In transit",
  late: "Deposit late",
  stale: "No deposit",
  none: "Nothing due",
};

const DEPOSIT_TONE: Record<DepositState, PillTone> = {
  matched: "green",
  waiting: "blue",
  late: "orange",
  stale: "red",
  none: "neutral",
};

export const DEPOSIT_TINT: Record<DepositState, Tint> = {
  matched: "green",
  waiting: "blue",
  late: "orange",
  stale: "red",
  none: "gray",
};

const DEPOSIT_GLYPH: Record<DepositState, GlyphName> = {
  matched: "check-circle",
  waiting: "clock",
  late: "warning",
  stale: "warning",
  none: "minus",
};

export function DepositPill({ state }: { state: DepositState }) {
  return (
    <Pill tone={DEPOSIT_TONE[state]} glyph={DEPOSIT_GLYPH[state]}>
      {DEPOSIT_LABEL[state]}
    </Pill>
  );
}

export function PostedPill({ entryNo }: { entryNo: number | null }) {
  return entryNo === null ? (
    <Pill tone="orange" glyph="clock">
      Not posted
    </Pill>
  ) : (
    <Pill tone="neutral" glyph="check">
      Posted #{entryNo}
    </Pill>
  );
}

// ---------------------------------------------------------------------------
// Numbers-style tables
// ---------------------------------------------------------------------------

/** A register that scrolls sideways in its own box, so a wide table never widens the page. */
export function Table({ caption, className, children }: { caption: string; className?: string; children: React.ReactNode }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-separate border-spacing-0 text-sm", className)}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function Th({ className, children, align = "left" }: { className?: string; children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head bg-card px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-label2 first:pl-5 last:pr-5 max-sm:first:pl-4 max-sm:last:pr-4",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  className,
  children,
  align = "left",
  colSpan,
}: {
  className?: string;
  children?: React.ReactNode;
  align?: "left" | "right";
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        "px-3 py-2 align-middle first:pl-5 last:pr-5 max-sm:first:pl-4 max-sm:last:pr-4",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// An entry, as a flow and as lines
// ---------------------------------------------------------------------------

export interface FlowLine {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
}

/** A flow-diagram end for an account: its name, with its category's glyph and colour. */
function nodeFor(code: string, name: string): FlowNode {
  const category = categoryForCode(code);
  return { label: name, glyph: category.glyph, tint: category.tint };
}

/**
 * An entry as the flow diagram draws it: the credited account on the left, each debited account
 * on the right with its amount. Lines on the same account are added together. When more than one
 * account is credited, `fallbackFrom` stands for them (their detail is in the lines below).
 */
export function entryFlow(lines: readonly FlowLine[], fallbackFrom: FlowNode): { from: FlowNode; to: FlowTarget[]; creditCount: number } {
  const net = new Map<string, { name: string; cents: number }>();
  for (const line of lines) {
    const current = net.get(line.accountCode) ?? { name: line.accountName, cents: 0 };
    current.cents += line.debitCents - line.creditCents;
    net.set(line.accountCode, current);
  }
  const debit = new Map([...net.entries()].filter(([, v]) => v.cents > 0));
  const credit = new Map([...net.entries()].filter(([, v]) => v.cents < 0).map(([k, v]) => [k, { name: v.name, cents: -v.cents }] as const));
  const to = [...debit.entries()]
    .sort((a, b) => b[1].cents - a[1].cents)
    .map(([code, v]) => ({ ...nodeFor(code, v.name), cents: v.cents }));
  const credits = [...credit.entries()];
  const from = credits.length === 1 ? nodeFor(credits[0][0], credits[0][1].name) : fallbackFrom;
  return { from, to, creditCount: credits.length };
}

/**
 * An entry's lines, Numbers-style: a category dot, the account, and the amount in the debit or
 * credit column, closed with a double rule under the totals.
 */
export function EntryLines({
  lines,
  caption,
  highlightCode,
  className,
}: {
  lines: readonly (FlowLine & { memo?: string | null })[];
  caption: string;
  /** The line the reader should find first (the clearing account). */
  highlightCode?: string | null;
  className?: string;
}) {
  const debit = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credit = lines.reduce((sum, l) => sum + l.creditCents, 0);
  return (
    <Table caption={caption} className={cn("min-w-[26rem]", className)}>
      <thead>
        <tr>
          <Th>Account</Th>
          <Th align="right" className="w-28">
            Debit
          </Th>
          <Th align="right" className="rule-gutter w-28">
            Credit
          </Th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line, index) => (
          <tr key={`${line.accountCode}-${index}`} className={cn(line.accountCode === highlightCode && "bg-tint-blue/6")}>
            <Td className={cn("rule-row", line.creditCents > 0 && "pl-8 max-sm:pl-7")}>
              <span className="flex min-w-0 items-center gap-2">
                <Dot tint={categoryForCode(line.accountCode).tint} size={7} />
                <span className="num shrink-0 text-xs text-label2">{line.accountCode}</span>
                <span className="min-w-0 truncate">{line.accountName}</span>
              </span>
              {line.memo ? <span className="mt-0.5 block truncate pl-[15px] text-xs text-label2">{line.memo}</span> : null}
            </Td>
            <Td align="right" className="rule-row">
              {line.debitCents > 0 ? <Money cents={line.debitCents} plain /> : null}
            </Td>
            <Td align="right" className="rule-row rule-gutter">
              {line.creditCents > 0 ? <Money cents={line.creditCents} plain /> : null}
            </Td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <Td className="text-xs font-semibold text-label2">
            {debit === credit ? "Balanced" : <span className="text-ink-red">Out of balance</span>}
          </Td>
          <Td align="right" className="rule-subtotal rule-total">
            <Money cents={debit} plain />
          </Td>
          <Td align="right" className="rule-subtotal rule-total rule-gutter">
            <Money cents={credit} plain />
          </Td>
        </tr>
      </tfoot>
    </Table>
  );
}

/** A disclosure for detail most readers skip: the verbatim lines under a summary graphic. */
export function Disclosure({ summary, children, className }: { summary: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <details className={cn("group/disclosure", className)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-5 text-sm font-medium text-ink-blue outline-none focus-ring-inset select-none hover:opacity-80 focus-visible:underline max-sm:px-4 [&::-webkit-details-marker]:hidden">
        <Glyph name="chevron-right" size={12} weight={2.4} className="transition-transform duration-150 group-open/disclosure:rotate-90" />
        {summary}
      </summary>
      {children}
    </details>
  );
}

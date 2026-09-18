import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

import type { DepositState } from "./types";

export { Figure, Td, Th } from "@/components/banking/parts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jan 26" — read straight off the YYYY-MM-DD string, never through a Date. */
export function shortDate(date: string | null): string {
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "—";
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

/** "Jan 26, 2026". */
export function longDate(date: string | null): string {
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "—";
  return `${shortDate(date)}, ${date.slice(0, 4)}`;
}

/** "Jan 26 – Aug 31, 2026", or with both years when they differ. */
export function dateSpan(dates: readonly string[]): string {
  const sorted = dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (sorted.length === 0) return "";
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === last) return longDate(first);
  return first.slice(0, 4) === last.slice(0, 4) ? `${shortDate(first)} – ${longDate(last)}` : `${longDate(first)} – ${longDate(last)}`;
}

/** "September 2026" from a period's first day. */
export function monthName(period: string): string {
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
}

const DEPOSIT_LABEL: Record<DepositState, string> = {
  matched: "Deposited",
  waiting: "In transit",
  late: "Deposit late",
  stale: "No deposit",
  none: "Nothing to deposit",
};

const DEPOSIT_TONE: Record<DepositState, "positive" | "info" | "warning" | "negative" | "neutral"> = {
  matched: "positive",
  waiting: "info",
  late: "warning",
  stale: "negative",
  none: "neutral",
};

export function DepositBadge({ state }: { state: DepositState }) {
  return (
    <Badge tone={DEPOSIT_TONE[state]} size="sm">
      {DEPOSIT_LABEL[state]}
    </Badge>
  );
}

export function PostedBadge({ entryNo }: { entryNo: number | null }) {
  return entryNo === null ? (
    <Badge tone="warning" size="sm">
      Not posted
    </Badge>
  ) : (
    <Badge tone="neutral" size="sm">
      Posted #{entryNo}
    </Badge>
  );
}

/** A one-line notice under a card header: amber for something to act on, plain for context. */
export function Notice({
  tone = "warning",
  icon,
  children,
  className,
}: {
  tone?: "warning" | "negative" | "info" | "plain";
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-2 border-b border-border px-4 py-2 text-xs",
        tone === "warning" && "bg-warning/8 text-warning",
        tone === "negative" && "bg-negative/8 text-negative",
        tone === "info" && "bg-info/8 text-info",
        tone === "plain" && "text-muted-foreground",
        className,
      )}
    >
      {icon === undefined ? null : <span className="mt-0.5 shrink-0 [&_svg]:size-3.5">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

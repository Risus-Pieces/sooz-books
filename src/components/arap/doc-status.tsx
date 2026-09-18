import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Pill, type PillTone } from "@/components/ui/pill";
import { SegmentedNav } from "@/components/ui/segmented-control";
import { cn } from "@/lib/cn";
import type { Tint } from "@/lib/ui/tints";

import type { DocStatus } from "./types";

const LABEL: Record<DocStatus, string> = {
  draft: "Draft",
  open: "Open",
  partial: "Part paid",
  paid: "Paid",
  void: "Void",
};

const TONE: Record<DocStatus, "neutral" | "primary" | "positive" | "negative" | "warning" | "info" | "outline"> = {
  draft: "warning",
  open: "info",
  partial: "info",
  paid: "positive",
  void: "neutral",
};

/** A document's state, with "overdue" taking precedence while money is still owed. */
export function DocStatusBadge({
  status,
  daysOverdue = 0,
  size,
  className,
}: {
  status: DocStatus;
  daysOverdue?: number;
  size?: "sm" | "md";
  className?: string;
}) {
  if ((status === "open" || status === "partial") && daysOverdue > 0) {
    return (
      <Badge tone="negative" size={size} className={className}>
        {daysOverdue}d late
      </Badge>
    );
  }
  return (
    <Badge tone={TONE[status]} size={size} className={className}>
      {LABEL[status]}
    </Badge>
  );
}

const PILL: Record<DocStatus, { tone: PillTone; glyph: "pencil" | "clock" | "check-circle" | "exclude" }> = {
  draft: { tone: "orange", glyph: "pencil" },
  open: { tone: "blue", glyph: "clock" },
  partial: { tone: "blue", glyph: "clock" },
  paid: { tone: "green", glyph: "check-circle" },
  void: { tone: "neutral", glyph: "exclude" },
};

/** The state as a capsule at the head of a detail pane. */
export function DocStatusPill({ status, daysOverdue = 0 }: { status: DocStatus; daysOverdue?: number }) {
  if ((status === "open" || status === "partial") && daysOverdue > 0) {
    return (
      <Pill tone="red" glyph="flag">
        {daysOverdue} days late
      </Pill>
    );
  }
  return (
    <Pill tone={PILL[status].tone} glyph={PILL[status].glyph}>
      {LABEL[status]}
    </Pill>
  );
}

/** The one-word state of a document, for a list row's quiet line. */
export function docStatusLabel(status: DocStatus, daysOverdue = 0): string {
  if ((status === "open" || status === "partial") && daysOverdue > 0) return `${daysOverdue}d late`;
  return LABEL[status];
}

/** The state as a colour: a dot in a list row. */
export function docStatusTint(status: DocStatus, daysOverdue = 0): Tint | "quiet" {
  if ((status === "open" || status === "partial") && daysOverdue > 0) return "red";
  if (status === "draft") return "orange";
  if (status === "paid") return "green";
  if (status === "void") return "quiet";
  return "blue";
}

export interface FilterTab {
  key: string;
  label: string;
  count?: number;
  href: string;
  active: boolean;
}

/** Status filters as a segmented control. Plain links: the filter lives in the URL. */
export function FilterTabs({ tabs, label, className }: { tabs: readonly FilterTab[]; label: string; className?: string }) {
  const current = tabs.find((t) => t.active)?.key ?? tabs[0]?.key ?? "";
  return (
    <div className={cn("-mx-1 overflow-x-auto px-1 pb-0.5", className)}>
      <SegmentedNav
        aria-label={label}
        current={current}
        className="min-w-max"
        items={tabs.map((tab) => ({
          value: tab.key,
          href: tab.href,
          label: tab.count === undefined || tab.count === 0 || tab.key === "all" ? tab.label : `${tab.label} ${tab.count}`,
        }))}
      />
    </div>
  );
}

/** A labelled fact in a document header. */
export function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <dt className="text-xs font-medium text-label2">{label}</dt>
      <dd className="min-w-0 text-sm font-medium text-label">{children}</dd>
    </div>
  );
}

/** Numbers-style header cell: quiet, sentence case, a hairline under it. */
export function Th({
  children,
  align = "left",
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head bg-card px-3 py-2 align-bottom text-xs font-semibold whitespace-nowrap text-label2 first:pl-5 last:pr-5 max-sm:first:pl-4 max-sm:last:pr-4",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className,
  colSpan,
}: {
  children?: React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        "rule-row px-3 py-2 align-middle first:pl-5 last:pr-5 max-sm:first:pl-4 max-sm:last:pr-4",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** A Numbers-style table on a card: scrolls sideways on a phone, hairline rows, no zebra. */
export function NumbersTable({
  caption,
  minWidth,
  head,
  children,
  foot,
  className,
}: {
  caption: string;
  /** e.g. "min-w-[40rem]" — below it the table scrolls sideways. */
  minWidth?: string;
  head: React.ReactNode;
  children: React.ReactNode;
  foot?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative overflow-x-auto", className)}>
      <table className={cn("w-full border-separate border-spacing-0 text-sm", minWidth)}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
        {foot ? <tfoot>{foot}</tfoot> : null}
      </table>
    </div>
  );
}

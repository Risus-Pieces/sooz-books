import * as React from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

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
}: {
  status: DocStatus;
  daysOverdue?: number;
  size?: "sm" | "md";
}) {
  if ((status === "open" || status === "partial") && daysOverdue > 0) {
    return (
      <Badge tone="negative" size={size}>
        {daysOverdue}d overdue
      </Badge>
    );
  }
  return (
    <Badge tone={TONE[status]} size={size}>
      {LABEL[status]}
    </Badge>
  );
}

export interface FilterTab {
  key: string;
  label: string;
  count?: number;
  href: string;
  active: boolean;
}

/** Status filters as index tabs on the header rule. Plain links: the filter lives in the URL. */
export function FilterTabs({ tabs, label }: { tabs: readonly FilterTab[]; label: string }) {
  return (
    <nav aria-label={label} className="flex items-end gap-4 overflow-x-auto rule-head">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.active ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex shrink-0 items-baseline gap-1.5 border-b-2 px-0.5 pb-1.5 text-sm font-medium whitespace-nowrap transition-colors",
            tab.active
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
          {tab.count === undefined ? null : (
            <span className="num text-2xs text-muted-foreground">{tab.count}</span>
          )}
        </Link>
      ))}
    </nav>
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
      <dt className="eyebrow">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

/** Shared header cell for the registers in this module. */
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
        "rule-head bg-surface-sunken px-3 py-1.5 align-bottom text-2xs font-semibold tracking-wider whitespace-nowrap text-muted-foreground uppercase",
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
        "rule-row px-3 py-1.5 align-middle",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

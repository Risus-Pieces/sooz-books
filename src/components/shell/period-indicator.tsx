import * as React from "react";
import Link from "next/link";
import { Lock } from "lucide-react";

import { cn } from "@/lib/cn";

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export interface PeriodIndicatorProps {
  year: number;
  /** 1–12. Built from the period row, never from a Date, so no zone can shift it. */
  month: number;
  status: "open" | "closed";
  /** Where the period opens — usually /close. Omit to render it as plain text. */
  href?: string;
  className?: string;
}

/**
 * The working period, stamped at the top of every page the way a date stamp sits at the head of a
 * ledger sheet. A closed period is the one piece of chrome that must never be missed, so it carries
 * a lock rather than only a word.
 */
export function PeriodIndicator({ year, month, status, href, className }: PeriodIndicatorProps) {
  const closed = status === "closed";
  const label = `${MONTH_ABBR[month - 1] ?? "—"} ${year}`;

  const body = (
    <>
      <span className="eyebrow hidden sm:inline">Period</span>
      <span className="num text-sm font-semibold tracking-tight whitespace-nowrap text-foreground">{label}</span>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-xs border px-1.5 py-px text-2xs font-semibold tracking-wide uppercase",
          closed
            ? "border-border-strong bg-muted text-muted-foreground"
            : "border-info/35 bg-info/10 text-info",
        )}
      >
        {closed ? <Lock className="size-2.5" aria-hidden /> : null}
        {closed ? "Closed" : "Open"}
      </span>
    </>
  );

  const shell = cn("flex items-center gap-2", className);

  if (!href) {
    return (
      <div data-slot="period-indicator" className={shell}>
        {body}
      </div>
    );
  }

  return (
    <Link
      data-slot="period-indicator"
      href={href}
      className={cn(shell, "-mx-1.5 rounded-sm px-1.5 py-1 transition-colors hover:bg-muted max-sm:min-h-10")}
    >
      {body}
    </Link>
  );
}

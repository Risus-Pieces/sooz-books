import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";
import { Glyph } from "@/components/ui/glyph";
import { monthShort } from "@/lib/ui/format";

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
 * The working period: "Sep 2026 · Open". A closed period carries a lock, the one piece of chrome
 * that must never be missed.
 */
export function PeriodIndicator({ year, month, status, href, className }: PeriodIndicatorProps) {
  const closed = status === "closed";
  const body = (
    <>
      {closed ? <Glyph name="lock" size={12} className="text-label2" /> : null}
      <span className="font-medium whitespace-nowrap">
        {monthShort(month)} {year}
      </span>
      <span aria-hidden className="size-[3px] rounded-full bg-label3" />
      <span className={cn("font-medium", closed ? "text-label2" : "text-ink-green")}>{closed ? "Closed" : "Open"}</span>
    </>
  );
  const shell = cn("inline-flex items-center gap-1.5 text-xs text-label2", className);
  if (!href) {
    return (
      <span data-slot="period-indicator" className={shell}>
        {body}
      </span>
    );
  }
  return (
    <Link data-slot="period-indicator" href={href} className={cn(shell, "rounded-[6px] hover:text-label")}>
      {body}
    </Link>
  );
}

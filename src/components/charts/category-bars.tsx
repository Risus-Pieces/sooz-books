import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";
import { Dot } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import type { Tint } from "@/lib/ui/tints";

export interface CategoryBarRow {
  key: string;
  label: string;
  tint: Tint;
  /** Magnitude in cents, ≥ 0. */
  cents: number;
  /** A count shown small after the label (transactions, lines). */
  count?: number;
  href?: string;
}

/**
 * A ranked list of categories: dot, name, count, amount, and a thin bar in the category's colour
 * sized against the largest. The list is the chart; screen readers read it as a list.
 */
export function CategoryBars({ rows, size = "md", className }: { rows: CategoryBarRow[]; size?: "md" | "lg"; className?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.cents));
  return (
    <ul className={cn("flex flex-col", className)}>
      {rows.map((row, i) => {
        const pct = Math.max(0.6, Math.round((row.cents / max) * 1000) / 10);
        const inner = (
          <>
            <span className="flex items-center gap-2">
              <Dot tint={row.tint} />
              <span className={cn("min-w-0 truncate font-medium", size === "lg" && "text-lg")}>{row.label}</span>
              {row.count !== undefined ? (
                <span className="num text-2xs font-semibold text-label2">
                  <span className="sr-only">(</span>
                  {row.count}
                  <span className="sr-only">)</span>
                </span>
              ) : null}
              <Money cents={row.cents} currency plain className={cn("ml-auto font-semibold", size === "lg" && "text-lg")} />
            </span>
            <span aria-hidden className="mt-1.5 ml-4 block h-1 rounded-[2px] bg-fill2">
              <span className="block h-full min-w-[3px] rounded-[2px]" style={{ width: `${pct}%`, background: `var(--${row.tint})` }} />
            </span>
          </>
        );
        return (
          <li key={row.key} className={cn(size === "lg" ? "py-[9px]" : "py-1.5", i > 0 && "hairline-t")}>
            {row.href ? (
              <Link href={row.href} className="block rounded-[6px] outline-none focus-ring hover:opacity-80">
                {inner}
              </Link>
            ) : (
              inner
            )}
          </li>
        );
      })}
    </ul>
  );
}

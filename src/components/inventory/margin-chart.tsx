import * as React from "react";

import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";
import { formatBasisPoints } from "@/lib/reports/types";

export interface MarginPoint {
  label: string;
  netSalesCents: number;
  grossMarginCents: number;
  grossMarginBps: number;
}

/**
 * Gross margin by row, largest sellers first: each row's net sales as a bar on one scale, split
 * into what it kept (green, the margin) and what the goods cost (grey, COGS). A row that lost money
 * draws its margin in red. The margin percentage sits at the end of the row.
 */
export function MarginChart({ data }: { data: readonly MarginPoint[] }) {
  const max = Math.max(1, ...data.map((p) => Math.abs(p.netSalesCents)));
  return (
    <ul className="flex flex-col">
      {data.map((p, i) => {
        const sales = Math.max(0, p.netSalesCents);
        const cogs = Math.max(0, p.netSalesCents - p.grossMarginCents);
        const kept = Math.max(0, p.grossMarginCents);
        const loss = p.grossMarginCents < 0;
        const width = Math.max(1.5, (Math.max(sales, cogs) / max) * 100);
        return (
          <li
            key={p.label}
            className={cn("grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-2 max-sm:grid-cols-[minmax(0,1fr)_auto]", i > 0 && "hairline-t")}
          >
            <span className="truncate text-sm font-medium" title={p.label}>
              {p.label}
            </span>
            <span
              role="img"
              aria-label={`${p.label}: net sales ${dollars(p.netSalesCents)}, gross margin ${dollars(p.grossMarginCents)}`}
              className="block h-2.5 max-sm:order-last max-sm:col-span-2"
            >
              <span className="flex h-full gap-[2px]" style={{ width: `${width}%` }}>
                {kept > 0 ? <i className="block h-full min-w-[3px] rounded-l-full bg-tint-green" style={{ flex: `${kept} 1 0%` }} /> : null}
                {cogs > 0 ? (
                  <i
                    className={cn("block h-full min-w-[3px] rounded-r-full", loss ? "rounded-l-full bg-tint-red" : "bg-label3", kept === 0 && "rounded-l-full")}
                    style={{ flex: `${cogs} 1 0%` }}
                  />
                ) : kept > 0 ? null : (
                  <i className="block h-full w-full rounded-full bg-fill2" />
                )}
              </span>
            </span>
            <span className="flex items-baseline gap-2 text-right">
              <Money cents={p.grossMarginCents} currency plain className={cn("text-sm font-semibold", loss && "text-ink-red")} />
              <span className={cn("num w-14 text-xs font-medium", loss ? "text-ink-red" : "text-label2")}>
                {p.netSalesCents === 0 ? "—" : formatBasisPoints(p.grossMarginBps)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

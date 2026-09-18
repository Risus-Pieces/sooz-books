import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";

import { monthLabel } from "./labels";
import type { PromotionRowView } from "./types";

/** Days since 1970-01-01 for a YYYY-MM-DD string, with integer arithmetic and no Date. */
function dayNumber(date: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function nextMonth(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

const BAR: Record<string, string> = {
  planned: "border-border-strong bg-muted",
  active: "border-primary/60 bg-primary/20",
  completed: "border-positive/50 bg-positive/15",
  cancelled: "border-negative/40 bg-negative/10",
};

/**
 * Promotions laid on a month grid: the solid bar is the performance window, the thin rule under
 * it the ship window the accrual is spread over, and the vertical line is today. Scrolls sideways
 * inside its own box on a narrow screen.
 */
export function PromotionCalendar({ rows, today }: { rows: PromotionRowView[]; today: string }) {
  const starts = rows.map((r) => (r.shipStartDate !== null && r.shipStartDate < r.startDate ? r.shipStartDate : r.startDate));
  const ends = rows.map((r) => (r.shipEndDate !== null && r.shipEndDate > r.endDate ? r.shipEndDate : r.endDate));
  let from = firstOfMonth([...starts, today].sort()[0]);
  const lastEnd = [...ends, today].sort().at(-1) ?? today;
  const months: string[] = [];
  while (from <= lastEnd && months.length < 36) {
    months.push(from);
    from = nextMonth(from);
  }
  const origin = dayNumber(months[0]);
  const span = dayNumber(from) - origin;
  const pct = (date: string) => ((dayNumber(date) - origin) / span) * 100;
  const width = (a: string, b: string) => Math.max(0.6, ((dayNumber(b) - dayNumber(a) + 1) / span) * 100);
  const todayAt = pct(today);
  const columns = `11rem ${months.map((m, i) => `${dayNumber(months[i + 1] ?? from) - dayNumber(m)}fr`).join(" ")}`;

  return (
    <div className="w-full overflow-x-auto">
      <div className="relative" style={{ minWidth: `${Math.max(40, months.length * 5.5)}rem` }}>
        <div className="grid border-b border-border-strong bg-surface-sunken" style={{ gridTemplateColumns: columns }}>
          <div className="px-3 py-1.5 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Promotion</div>
          {months.map((m) => (
            <div key={m} className="border-l border-border px-2 py-1.5 text-2xs font-semibold tracking-wider whitespace-nowrap text-muted-foreground uppercase">
              {monthLabel(m)}
            </div>
          ))}
        </div>
        <ul>
          {rows.map((r) => (
            <li key={r.id} className="grid rule-row" style={{ gridTemplateColumns: `11rem minmax(0, 1fr)` }}>
              <div className="min-w-0 px-3 py-2">
                <Link href={`/trade/promotions/${r.id}`} className="block truncate text-sm text-primary hover:underline">
                  {r.name}
                </Link>
                <span className="block truncate text-2xs text-muted-foreground">
                  {r.customerName ?? "No customer"} · {r.typeLabel}
                </span>
              </div>
              <div className="relative">
                {months.slice(1).map((m) => (
                  <span key={m} aria-hidden className="absolute inset-y-0 w-px bg-border/70" style={{ left: `${pct(m)}%` }} />
                ))}
                <div
                  className={cn("absolute top-2 h-4 rounded-xs border", BAR[r.status] ?? BAR.planned)}
                  style={{ left: `${pct(r.startDate)}%`, width: `${width(r.startDate, r.endDate)}%` }}
                  title={`${r.startDate} → ${r.endDate}`}
                />
                {r.shipStartDate !== null && r.shipEndDate !== null ? (
                  <div
                    className="absolute top-7 h-0.5 rounded-full bg-foreground/35"
                    style={{ left: `${pct(r.shipStartDate)}%`, width: `${width(r.shipStartDate, r.shipEndDate)}%` }}
                    title={`Ships ${r.shipStartDate} → ${r.shipEndDate}`}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        <div aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-primary" style={{ left: `calc(11rem + (100% - 11rem) * ${todayAt / 100})` }} />
      </div>
    </div>
  );
}

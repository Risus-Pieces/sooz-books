import * as React from "react";
import Link from "next/link";

import { dayNumber, shortDate } from "@/lib/ui/format";
import type { Tint } from "@/lib/ui/tints";

import type { PromotionRowView } from "./types";

const MONTHS = [
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

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function nextMonth(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export const PROMO_TINT: Record<string, Tint> = {
  planned: "gray",
  active: "cyan",
  completed: "green",
  cancelled: "red",
};

/**
 * Promotions on a month grid, Calendar-style: the capsule is the performance window, the thin
 * line under it the ship window the accrual is spread over, and the blue rule is today. Scrolls
 * sideways in its own box on a narrow screen.
 */
export function PromotionCalendar({
  rows,
  today,
}: {
  rows: PromotionRowView[];
  today: string;
}) {
  const starts = rows.map((r) =>
    r.shipStartDate !== null && r.shipStartDate < r.startDate
      ? r.shipStartDate
      : r.startDate,
  );
  const ends = rows.map((r) =>
    r.shipEndDate !== null && r.shipEndDate > r.endDate
      ? r.shipEndDate
      : r.endDate,
  );
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
  const width = (a: string, b: string) =>
    Math.max(0.8, ((dayNumber(b) - dayNumber(a) + 1) / span) * 100);
  const todayAt = pct(today);

  return (
    <div className="w-full overflow-x-auto">
      <div
        className="relative px-5 pb-3 max-sm:px-4"
        style={{ minWidth: `${Math.max(34, months.length * 5)}rem` }}
      >
        <div className="relative h-6 hairline-b">
          {months.map((m) => (
            <span
              key={m}
              className="absolute top-1 pl-1.5 text-2xs font-semibold text-label2"
              style={{ left: `${pct(m)}%` }}
            >
              {MONTHS[Number(m.slice(5, 7)) - 1]}
              {m.slice(5, 7) === "01" || m === months[0] ? (
                <span className="font-medium"> {m.slice(0, 4)}</span>
              ) : null}
            </span>
          ))}
        </div>
        <div className="relative">
          <div aria-hidden className="pointer-events-none absolute inset-0">
            {months.slice(1).map((m) => (
              <span
                key={m}
                className="absolute inset-y-0 w-px bg-sep"
                style={{ left: `${pct(m)}%` }}
              />
            ))}
            <span
              className="absolute inset-y-0 z-[1] w-0.5 rounded-full bg-tint-blue"
              style={{ left: `${todayAt}%` }}
            />
          </div>
          <ul className="relative">
            {rows.map((r) => {
              const tint = PROMO_TINT[r.status] ?? "gray";
              return (
                <li key={r.id} className="relative h-[52px]">
                  <Link
                    href={`/trade/promotions/${r.id}`}
                    className="absolute top-2.5 flex h-7 min-w-0 items-center overflow-hidden rounded-[7px] border-l-[3px] pr-2 pl-1.5 text-xs font-semibold whitespace-nowrap text-label outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-tint-blue"
                    style={{
                      left: `${pct(r.startDate)}%`,
                      width: `${width(r.startDate, r.endDate)}%`,
                      background: `color-mix(in srgb, var(--${tint}) 22%, var(--card))`,
                      borderLeftColor: `var(--${tint})`,
                    }}
                    title={`${r.name} · ${shortDate(r.startDate)} – ${shortDate(r.endDate)}`}
                  >
                    <span className="truncate">{r.name}</span>
                  </Link>
                  {r.shipStartDate !== null && r.shipEndDate !== null ? (
                    <span
                      aria-hidden
                      className="absolute top-[42px] h-[3px] rounded-full opacity-60"
                      style={{
                        left: `${pct(r.shipStartDate)}%`,
                        width: `${width(r.shipStartDate, r.shipEndDate)}%`,
                        background: `var(--${tint === "gray" ? "gray" : tint})`,
                      }}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

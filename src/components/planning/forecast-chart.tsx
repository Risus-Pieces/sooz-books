import * as React from "react";

import { axisMoney, dayNumber, dollars, shortDate } from "@/lib/ui/format";
import { evenTicks, linear, round1 } from "@/lib/ui/scale";

export interface ForecastWeekPoint {
  /** 'YYYY-MM-DD': the Sunday the week closes. */
  weekEnd: string;
  closingCents: number;
}

export interface ForecastLineProps {
  /** Today, 'YYYY-MM-DD': where the line starts. */
  asOf: string;
  /** Cash today. */
  cashCents: number;
  /** The thirteen weeks, oldest first. */
  weeks: readonly ForecastWeekPoint[];
  /** The date cash runs out at the trailing burn; draws the dotted burn line down to $0. */
  cashOutDate: string | null;
  /** viewBox width: 720 on a desktop card, 342 on a phone. */
  width?: number;
  height?: number;
  compact?: boolean;
  title?: string;
}

const axisText = { fontSize: 10.5, fontWeight: 500, fill: "var(--label2)", fontFamily: "inherit" } as const;
const gridLine = { stroke: "var(--sep)", strokeWidth: 0.6 } as const;
const zeroLine = { stroke: "var(--label3)", strokeWidth: 0.8 } as const;

/**
 * The thirteen-week forecast in the cash line's language: today's balance carried forward week by
 * week by what is known (open invoices, open bills, expected movements) as a solid line over a soft
 * fill, and beside it the trailing burn as a dotted orange line down to $0 on the cash-out date —
 * what happens if nothing new comes in. A week that closes below zero draws its point in red.
 */
export function ForecastLine({
  asOf,
  cashCents,
  weeks,
  cashOutDate,
  width = 720,
  height = 210,
  compact = false,
  title = "Cash forecast, thirteen weeks",
}: ForecastLineProps) {
  if (weeks.length === 0) return null;
  const id = `fcl-${width}-${height}-${weeks.length}`;
  const points = [{ date: asOf, cents: cashCents }, ...weeks.map((w) => ({ date: w.weekEnd, cents: w.closingCents }))];
  const d0 = dayNumber(asOf);
  const dEnd = dayNumber(weeks[weeks.length - 1].weekEnd);

  // The burn line: straight from today's cash to $0 on the cash-out date, cut at the horizon.
  const dOut = cashOutDate ? dayNumber(cashOutDate) : null;
  const burnEnd =
    dOut === null || cashCents <= 0
      ? null
      : dOut <= dEnd
        ? { day: Math.max(dOut, d0 + 1), cents: 0 }
        : { day: dEnd, cents: Math.round(cashCents * (1 - (dEnd - d0) / Math.max(dOut - d0, 1))) };

  const padTop = 30;
  const padBottom = 22;
  const labelGutter = compact ? 38 : 50;
  const x0 = compact ? 12 : 22;
  const x1 = width - labelGutter - (compact ? 8 : 16);
  const y0 = height - padBottom;

  const all = points.map((p) => p.cents);
  const ticks = evenTicks(Math.min(0, ...all), Math.max(0, ...all), compact ? 3 : 4);
  const y = linear(ticks.min, ticks.max, y0, padTop);
  const x = linear(d0, Math.max(dEnd, d0 + 1), x0, x1);

  const xy = points.map((p) => ({ x: round1(x(dayNumber(p.date))), y: round1(y(p.cents)), p }));
  const line = xy.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x} ${pt.y}`).join("");
  const base = round1(y(Math.max(0, ticks.min)));
  const area = `${line}L${xy[xy.length - 1].x} ${base}L${xy[0].x} ${base}z`;
  const today = xy[0];
  const burn = burnEnd ? { x: round1(x(burnEnd.day)), y: round1(y(burnEnd.cents)) } : null;

  // Week labels: every other week on a desktop, every fourth on a phone, never on top of today.
  const every = compact ? 4 : 2;
  // …and never under the cash-out pill.
  const pillX = burnEnd && burnEnd.cents === 0 && cashOutDate ? x(burnEnd.day) : null;
  const labelled = xy
    .slice(1)
    .filter((_, i) => (i + 1) % every === 0)
    .filter((pt) => pillX === null || Math.abs(pt.x - pillX) > 44);

  const desc = [
    `Today: ${dollars(cashCents)}`,
    ...weeks.map((w) => `Week to ${shortDate(w.weekEnd)}: ${dollars(w.closingCents)}`),
    cashOutDate ? `At the trailing burn, cash reaches $0 on ${shortDate(cashOutDate)}.` : "",
  ]
    .filter(Boolean)
    .join("; ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={`${id}-t ${id}-d`}
      className="block h-auto w-full overflow-visible"
    >
      <title id={`${id}-t`}>{title}</title>
      <desc id={`${id}-d`}>{desc}</desc>
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--blue)" stopOpacity=".22" />
          <stop offset="1" stopColor="var(--blue)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {ticks.values.map((v) => (
        <g key={v}>
          <line x1={4} x2={width - labelGutter + 2} y1={round1(y(v))} y2={round1(y(v))} {...(v === 0 ? zeroLine : gridLine)} />
          <text x={width - labelGutter + 8} y={round1(y(v)) + 3.5} {...axisText}>
            {axisMoney(v, ticks.step)}
          </text>
        </g>
      ))}

      {labelled.map((pt) => (
        <text key={pt.p.date} x={pt.x} y={height - 5} textAnchor="middle" {...axisText}>
          {shortDate(pt.p.date)}
        </text>
      ))}

      <path d={area} fill={`url(#${id}-fill)`} />
      {burn ? (
        <>
          <path
            d={`M${today.x} ${today.y}L${burn.x} ${burn.y}`}
            stroke="var(--orange)"
            strokeWidth={2}
            strokeDasharray="3 4"
            strokeLinecap="round"
            fill="none"
          />
          {burnEnd && burnEnd.cents === 0 && cashOutDate ? (
            <>
              <circle cx={burn.x} cy={burn.y} r={4.5} fill="var(--orange)" stroke="var(--card)" strokeWidth={2} />
              <g transform={`translate(${burn.x} ${round1(Math.min(burn.y + 22, y0 - 4))})`}>
                <rect x={-27} y={-11} width={54} height={20} rx={10} fill="var(--card)" stroke="var(--sep)" strokeWidth={0.6} />
                <text y={3.6} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="var(--ink-orange)" fontFamily="inherit">
                  {shortDate(cashOutDate)}
                </text>
              </g>
            </>
          ) : null}
        </>
      ) : null}
      <path d={line} fill="none" stroke="var(--blue)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
      {xy.slice(1).map((pt) =>
        pt.p.cents < 0 ? <circle key={pt.p.date} cx={pt.x} cy={pt.y} r={3.2} fill="var(--red)" stroke="var(--card)" strokeWidth={1.5} /> : null,
      )}

      <circle cx={today.x} cy={today.y} r={5} fill="var(--blue)" stroke="var(--card)" strokeWidth={2.5} />
      <g transform={`translate(${today.x + 22} ${round1(Math.max(12, today.y - 20))})`}>
        <rect x={-24} y={-11} width={48} height={20} rx={10} fill="var(--card)" stroke="var(--sep)" strokeWidth={0.6} />
        <text y={3.6} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="var(--ink-blue)" fontFamily="inherit">
          Today
        </text>
      </g>
    </svg>
  );
}

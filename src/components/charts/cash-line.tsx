import * as React from "react";

import { axisMoney, dayNumber, dollars, monthShort, shortDate } from "@/lib/ui/format";
import { evenTicks, linear, round1 } from "@/lib/ui/scale";

import { axisText, chartId, gridLine, zeroLine } from "./chart-text";

export interface CashPoint {
  /** 'YYYY-MM-DD': a month end, or today for the last point. */
  date: string;
  cents: number;
}

export interface CashLineProps {
  /** Balance over time, oldest first. The last point is today. */
  points: CashPoint[];
  /** The date cash runs out at the trailing burn; draws the dotted projection down to $0. */
  cashOutDate?: string | null;
  /** viewBox width: 720 on a desktop card, 342 on a phone. */
  width?: number;
  height?: number;
  /** Phone drawing: every other month labelled. */
  compact?: boolean;
  /** The chart's name for assistive technology. */
  title?: string;
}

/**
 * The signature graphic: cash over time, the past solid over a soft fill, a "Today" marker, and a
 * dotted projection at the trailing burn down to $0 on the cash-out date.
 */
export function CashLine({
  points,
  cashOutDate,
  width = 720,
  height = 196,
  compact = false,
  title = "Cash over time",
}: CashLineProps) {
  if (points.length === 0) return null;
  const id = chartId("cash", width, height, points.length);
  const last = points[points.length - 1];
  const projecting = Boolean(cashOutDate) && last.cents > 0;

  const padTop = 30;
  const padBottom = 22;
  const labelGutter = compact ? 34 : 44;
  const x0 = compact ? 15 : 26;
  const x1 = width - labelGutter - (compact ? 10 : 20);
  const y0 = height - padBottom;

  const ticks = evenTicks(Math.min(0, ...points.map((p) => p.cents)), Math.max(...points.map((p) => p.cents)), 3);
  const y = linear(ticks.min, ticks.max, y0, padTop);

  const d0 = dayNumber(points[0].date);
  const dEnd = projecting && cashOutDate ? Math.max(dayNumber(cashOutDate), dayNumber(last.date) + 1) : dayNumber(last.date);
  const x = linear(d0, Math.max(dEnd, d0 + 1), x0, x1);

  const xy = points.map((p) => ({ x: round1(x(dayNumber(p.date))), y: round1(y(p.cents)), p }));
  const line = xy.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x} ${pt.y}`).join("");
  const base = round1(y(Math.max(0, ticks.min)));
  const area = `${line}L${xy[xy.length - 1].x} ${base}L${xy[0].x} ${base}z`;
  const today = xy[xy.length - 1];
  const out = projecting && cashOutDate ? { x: round1(x(dayNumber(cashOutDate))), y: round1(y(0)) } : null;

  // Month labels under the month-end points; the last point is "Today" and is labelled above.
  const labelled = xy.slice(0, -1).filter((_, i) => !compact || i % 2 === 0);
  const dropNearOut = (px: number) => !out || Math.abs(px - out.x) > (compact ? 22 : 34);

  const desc = [
    ...points.map((p, i) => `${i === points.length - 1 ? "Today" : shortDate(p.date)}: ${dollars(p.cents)}`),
    projecting && cashOutDate ? `At the trailing burn, cash reaches $0 on ${shortDate(cashOutDate)}.` : "",
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
          <line x1={6} x2={width - labelGutter + 2} y1={round1(y(v))} y2={round1(y(v))} {...(v === 0 ? zeroLine : gridLine)} />
          <text x={width - labelGutter + 8} y={round1(y(v)) + 3.5} {...axisText}>
            {axisMoney(v, ticks.step)}
          </text>
        </g>
      ))}

      {labelled
        .filter((pt) => dropNearOut(pt.x) && Math.abs(pt.x - today.x) > (compact ? 18 : 24))
        .map((pt) => {
          const month = Number(pt.p.date.slice(5, 7));
          return (
            <text key={pt.p.date} x={pt.x} y={height - 5} textAnchor="middle" {...axisText}>
              {monthShort(month)}
            </text>
          );
        })}
      {!out ? (
        <text x={today.x} y={height - 5} textAnchor="middle" {...axisText}>
          {monthShort(Number(today.p.date.slice(5, 7)))}
        </text>
      ) : null}

      <path d={area} fill={`url(#${id}-fill)`} />
      <path d={line} fill="none" stroke="var(--blue)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />

      {out ? (
        <>
          <path
            d={`M${today.x} ${today.y}L${out.x} ${out.y}`}
            stroke="var(--orange)"
            strokeWidth={2.2}
            strokeDasharray="3 4"
            strokeLinecap="round"
            fill="none"
          />
          <circle cx={out.x} cy={out.y} r={4.5} fill="var(--orange)" stroke="var(--card)" strokeWidth={2} />
          <text x={out.x} y={height - 5} textAnchor="middle" {...axisText} fontWeight={700} fill="var(--ink-orange)">
            {cashOutDate ? shortDate(cashOutDate) : ""}
          </text>
        </>
      ) : null}

      <circle cx={today.x} cy={today.y} r={5} fill="var(--blue)" stroke="var(--card)" strokeWidth={2.5} />
      <g transform={`translate(${today.x} ${round1(Math.max(12, today.y - 22))})`}>
        <rect x={-24} y={-11} width={48} height={20} rx={10} fill="var(--card)" stroke="var(--sep)" strokeWidth={0.6} />
        <text y={3.6} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="var(--ink-blue)" fontFamily="inherit">
          Today
        </text>
      </g>
    </svg>
  );
}

import * as React from "react";

import { axisMoney, dollars } from "@/lib/ui/format";
import { divergingTicks, linear, round1 } from "@/lib/ui/scale";
import type { Tint } from "@/lib/ui/tints";

import { axisText, gridLine, zeroLine } from "./chart-text";

export interface DivergingSeries {
  key: string;
  label: string;
  tint: Tint;
}

export interface DivergingColumn {
  /** Axis label: "Jan" (or "J" when compact). */
  label: string;
  /** Spoken label: "January 2026". */
  name: string;
  /** Money in, stacked upward, by series key. Cents ≥ 0. */
  up: Record<string, number>;
  /** Money out, stacked downward, by series key. Cents ≥ 0. */
  down: Record<string, number>;
}

export interface DivergingBarsProps {
  columns: DivergingColumn[];
  upSeries: DivergingSeries[];
  downSeries: DivergingSeries[];
  /** viewBox width: 720 desktop, 342 phone. The height follows the data. */
  width?: number;
  compact?: boolean;
  title?: string;
  /** Height of one tick step in viewBox units. Defaults to 56 (30 compact). */
  stepHeight?: number;
}

/**
 * Money in above the line, money out below, by month. The axis always shows $0 and even steps the
 * same distance up and down, and the chart is only as tall as the data needs.
 */
export function DivergingBars({ columns, upSeries, downSeries, width = 720, compact = false, title = "In and out by month", stepHeight }: DivergingBarsProps) {
  const sum = (r: Record<string, number>) => Object.values(r).reduce((s, v) => s + Math.max(0, v), 0);
  const maxUp = Math.max(0, ...columns.map((c) => sum(c.up)));
  const maxDown = Math.max(0, ...columns.map((c) => sum(c.down)));
  const ticks = divergingTicks(maxUp, maxDown, compact ? 4 : 6);
  const steps = Math.max(1, Math.round((ticks.max - ticks.min) / ticks.step));

  // Each step gets the same height; a small range makes a short chart.
  const stepH = stepHeight ?? (compact ? 30 : 56);
  const padTop = 10;
  const plotH = steps * stepH;
  const height = padTop + plotH + 26;
  const gutter = compact ? 30 : 40;
  const plotW = width - gutter - 4;
  const y = linear(ticks.min, ticks.max, padTop + plotH, padTop);
  const zeroY = round1(y(0));
  const band = plotW / Math.max(columns.length, 1);
  const bw = compact ? 16 : 24;
  const r = 4;

  const describe = columns
    .map((c) => {
      const inn = upSeries.filter((s) => (c.up[s.key] ?? 0) > 0).map((s) => `${s.label} ${dollars(c.up[s.key])}`);
      const outt = downSeries.filter((s) => (c.down[s.key] ?? 0) > 0).map((s) => `${s.label} ${dollars(c.down[s.key])}`);
      return `${c.name}: in ${inn.length ? inn.join(", ") : "none"}; out ${outt.length ? outt.join(", ") : "none"}`;
    })
    .join(". ");

  const bar = (x: number, from: number, to: number, roundEnd: "top" | "bottom" | "none", fill: string, opacity?: number, key?: string) => {
    const top = Math.min(from, to);
    const h = Math.abs(to - from);
    if (h < 0.4) return null;
    const rr = roundEnd === "none" ? 0 : Math.min(r, h, bw / 2);
    const x2 = x + bw;
    const d =
      roundEnd === "top"
        ? `M${x} ${top + h}V${top + rr}Q${x} ${top} ${x + rr} ${top}H${x2 - rr}Q${x2} ${top} ${x2} ${top + rr}V${top + h}z`
        : roundEnd === "bottom"
          ? `M${x} ${top}V${top + h - rr}Q${x} ${top + h} ${x + rr} ${top + h}H${x2 - rr}Q${x2} ${top + h} ${x2} ${top + h - rr}V${top}z`
          : `M${x} ${top}H${x2}V${top + h}H${x}z`;
    return <path key={key} d={d} fill={fill} opacity={opacity} />;
  };

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} className="block h-auto w-full overflow-visible">
      <desc>{describe}</desc>
      {ticks.values.map((v) => (
        <g key={v}>
          <line x1={4} x2={plotW + 4} y1={round1(y(v))} y2={round1(y(v))} {...(v === 0 ? zeroLine : gridLine)} />
          <text x={plotW + 8} y={round1(y(v)) + 3.5} {...axisText} fontWeight={v === 0 ? 600 : 500}>
            {axisMoney(v, ticks.step)}
          </text>
        </g>
      ))}
      {columns.map((c, i) => {
        const x = round1(4 + band * i + (band - bw) / 2);
        const ups = upSeries.filter((s) => (c.up[s.key] ?? 0) > 0);
        const downs = downSeries.filter((s) => (c.down[s.key] ?? 0) > 0);
        let acc = 0;
        const upBars = ups.map((s, k) => {
          const from = y(acc);
          acc += c.up[s.key];
          return bar(x, round1(from) - 0.8, round1(y(acc)), k === ups.length - 1 ? "top" : "none", `var(--${s.tint})`, undefined, `u-${s.key}`);
        });
        let dacc = 0;
        const downBars = downs.map((s, k) => {
          const from = y(-dacc);
          dacc += c.down[s.key];
          return bar(x, round1(from) + 0.8, round1(y(-dacc)), k === downs.length - 1 ? "bottom" : "none", `var(--${s.tint})`, 0.82, `d-${s.key}`);
        });
        return (
          <g key={c.name}>
            {upBars}
            {downBars}
            <text x={round1(x + bw / 2)} y={height - 6} textAnchor="middle" {...axisText}>
              {c.label}
            </text>
          </g>
        );
      })}
      <line x1={4} x2={plotW + 4} y1={zeroY} y2={zeroY} {...zeroLine} />
    </svg>
  );
}

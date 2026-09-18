import * as React from "react";

import type { Tint } from "@/lib/ui/tints";

export interface SparkbarsProps {
  /** One value per period (cents or counts), oldest first. Zero draws a quiet dash. */
  values: number[];
  tint: Tint;
  /** viewBox size: 232×30 on a desktop tile, 130×26 on a phone. */
  width?: number;
  height?: number;
  /** When given, the bars are announced with this name and their values. */
  label?: string;
  /** Formats a value for the announcement. */
  format?: (value: number) => string;
}

/** Tiny bars under a KPI: the shape of the months, no axis. */
export function Sparkbars({ values, tint, width = 232, height = 30, label, format }: SparkbarsProps) {
  const n = Math.max(values.length, 1);
  const gap = 3;
  const bw = (width - gap * (n - 1)) / n;
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);
  const r = Math.min(4, bw / 2);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="block h-auto w-full"
      role={label ? "img" : undefined}
      aria-label={label ? `${label}: ${values.map((v) => (format ? format(v) : String(v))).join(", ")}` : undefined}
      aria-hidden={label ? undefined : true}
    >
      {values.map((v, i) => {
        const x = Math.round(i * (bw + gap) * 10) / 10;
        const w = Math.round(bw * 10) / 10;
        if (v === 0) {
          return <rect key={i} x={x} y={height - 2.5} width={w} height={2.5} rx={1.25} fill="var(--fill)" />;
        }
        const h = Math.max(2.5, Math.round((Math.abs(v) / max) * height * 10) / 10);
        const top = height - h;
        const rr = Math.min(r, h / 2);
        const d = `M${x} ${height}V${top + rr}Q${x} ${top} ${x + rr} ${top}H${x + w - rr}Q${x + w} ${top} ${x + w} ${top + rr}V${height}z`;
        return <path key={i} d={d} fill={`var(--${tint})`} />;
      })}
    </svg>
  );
}

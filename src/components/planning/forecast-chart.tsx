"use client";

import * as React from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCents } from "@/components/ui/money";

export interface ForecastChartPoint {
  /** "Sep 22" — the Monday the week starts. */
  label: string;
  closingCents: number;
  netCents: number;
}

/** Whole-dollar tick labels: the axis is a scale, the table carries the cents. */
function tick(cents: number): string {
  const dollars = Math.round(cents / 100);
  const abs = Math.abs(dollars);
  const text = abs >= 10_000 ? `${Math.round(abs / 1000)}k` : abs.toLocaleString("en-US");
  return `${dollars < 0 ? "−" : ""}$${text}`;
}

/**
 * Closing cash each week as a line, with the week's net movement as bars under
 * it. A week that closes below zero draws its point in the negative colour.
 * The domain always includes zero and never shrinks below a few dollars, so a
 * flat forecast reads as flat rather than as a magnified wobble.
 */
export function ForecastChart({ data }: { data: readonly ForecastChartPoint[] }) {
  const points = React.useMemo(() => [...data], [data]);
  const values = points.flatMap((p) => [p.closingCents, p.netCents, 0]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Round the axis out to a whole 1-2-5 step of dollars, never less than $100 a step.
  const span = Math.max(max - min, 40_000);
  let step = 10_000;
  for (const candidate of [1, 2, 5].flatMap((m) => [2, 3, 4, 5, 6, 7, 8].map((e) => m * 10 ** e)).sort((a, b) => a - b)) {
    step = candidate;
    if (span / candidate <= 5) break;
  }
  const domain: [number, number] = [Math.floor(min / step) * step, Math.ceil(max / step) * step + (max % step === 0 ? step : 0)];
  const ticks = Array.from({ length: Math.round((domain[1] - domain[0]) / step) + 1 }, (_, i) => domain[0] + i * step);

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: "var(--border-strong)" }}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            interval="preserveStartEnd"
            minTickGap={8}
          />
          <YAxis
            domain={domain}
            tickLine={false}
            axisLine={false}
            width={56}
            ticks={ticks}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickFormatter={tick}
          />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            contentStyle={{
              background: "var(--surface-raised)",
              border: "1px solid var(--border-strong)",
              borderRadius: 4,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--muted-foreground)" }}
            formatter={(value, name) => [
              formatCents(Number(value), { currency: true }),
              name === "closingCents" ? "Closing cash" : "Net for the week",
            ]}
            labelFormatter={(label) => `Week of ${String(label)}`}
          />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          <Bar dataKey="netCents" barSize={14} radius={[2, 2, 0, 0]} isAnimationActive={false}>
            {points.map((p) => (
              <Cell key={p.label} fill={p.netCents < 0 ? "var(--negative)" : "var(--positive)"} fillOpacity={0.35} />
            ))}
          </Bar>
          <Line
            type="linear"
            dataKey="closingCents"
            stroke="var(--primary)"
            strokeWidth={2}
            isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; index?: number; payload?: ForecastChartPoint }) => (
              <circle
                key={props.index}
                cx={props.cx}
                cy={props.cy}
                r={2.5}
                fill={props.payload !== undefined && props.payload.closingCents < 0 ? "var(--negative)" : "var(--primary)"}
                stroke="none"
              />
            )}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

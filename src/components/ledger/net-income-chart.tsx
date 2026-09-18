"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCents } from "@/components/ui/money";

export interface NetIncomePoint {
  /** Short month label, e.g. "Sep". */
  label: string;
  netCents: number;
}

/**
 * Net income by month. Months in the red are drawn in the negative colour, so
 * the shape of the year reads before any number does. The bars are plotted in
 * integer cents so no value ever passes through a dollar float.
 */
export function NetIncomeChart({ data }: { data: readonly NetIncomePoint[] }) {
  const points = React.useMemo(() => [...data], [data]);

  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: "var(--border-strong)" }}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={62}
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            // Whole-dollar ticks drop ".00"; a tick that is not a whole dollar keeps its cents
            // rather than being truncated to a figure the bar does not reach.
            tickFormatter={(cents: number) => formatCents(cents).replace(/\.00$/, "")}
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
            formatter={(value) => [formatCents(Number(value), { currency: true }), "Net income"]}
          />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          <Bar dataKey="netCents" radius={[2, 2, 0, 0]} isAnimationActive={false}>
            {points.map((point) => (
              <Cell
                key={point.label}
                fill={point.netCents < 0 ? "var(--negative)" : "var(--primary)"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

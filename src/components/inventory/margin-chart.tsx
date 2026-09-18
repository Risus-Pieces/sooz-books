"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatCents } from "@/components/ui/money";
import { formatBasisPoints } from "@/lib/reports/types";

export interface MarginPoint {
  label: string;
  netSalesCents: number;
  grossMarginCents: number;
  grossMarginBps: number;
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: MarginPoint }>;
}

function Tip({ active, payload }: TipProps) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="rounded-sm border border-border-strong bg-surface-raised px-2.5 py-1.5 text-xs shadow-overlay">
      <p className="mb-1 font-semibold text-foreground">{point.label}</p>
      <p className="flex justify-between gap-4 text-muted-foreground">
        Net sales <span className="num text-foreground">{formatCents(point.netSalesCents, { currency: true })}</span>
      </p>
      <p className="flex justify-between gap-4 text-muted-foreground">
        Gross margin <span className="num text-foreground">{formatCents(point.grossMarginCents, { currency: true })}</span>
      </p>
      <p className="flex justify-between gap-4 text-muted-foreground">
        GM % <span className="num text-foreground">{formatBasisPoints(point.grossMarginBps)}</span>
      </p>
    </div>
  );
}

/**
 * Gross margin dollars by row, largest sellers first, as horizontal bars so long
 * SKU and channel names stay legible on a phone. One series, so no legend: a
 * bar in the negative colour is a row that lost money on every sale.
 */
export function MarginChart({ data }: { data: readonly MarginPoint[] }) {
  const points = React.useMemo(() => [...data], [data]);
  const height = Math.max(120, points.length * 30 + 36);

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }} barCategoryGap={8}>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" horizontal={false} />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={{ stroke: "var(--border-strong)" }}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={(cents: number) => formatCents(cents).replace(/\.00$/, "")}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={132}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={(label: string) => (label.length > 20 ? `${label.slice(0, 19)}…` : label)}
          />
          <Tooltip cursor={{ fill: "var(--muted)" }} content={<Tip />} />
          <ReferenceLine x={0} stroke="var(--border-strong)" />
          <Bar dataKey="grossMarginCents" radius={[0, 3, 3, 0]} maxBarSize={18} isAnimationActive={false}>
            {points.map((point) => (
              <Cell key={point.label} fill={point.grossMarginCents < 0 ? "var(--negative)" : "var(--primary)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

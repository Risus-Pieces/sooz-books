import * as React from "react";

import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";
import { tintVar, type Tint } from "@/lib/ui/tints";

export interface StackSegment {
  key: string;
  label: string;
  /** Cents, ≥ 0. */
  cents: number;
  tint: Tint;
  /** Hatched: money on its way but not yet on the books (a bank line still in review). */
  pending?: boolean;
}

/**
 * One horizontal stacked bar, sized against a shared scale so several bars compare at a glance
 * (the ledger against the count, one run against another). Each segment keeps its category colour;
 * a pending segment is hatched. The numbers are in the label for assistive technology; the caller
 * draws the legend.
 */
export function StackBar({
  segments,
  scale,
  label,
  height = 10,
  className,
}: {
  segments: readonly StackSegment[];
  /** The cents a full-width bar stands for. Defaults to this bar's own total. */
  scale?: number;
  /** Spoken name, e.g. "Ledger". The segments are appended. */
  label: string;
  height?: number;
  className?: string;
}) {
  const visible = segments.filter((s) => s.cents > 0);
  const total = visible.reduce((s, x) => s + x.cents, 0);
  const full = Math.max(scale ?? total, total, 1);
  const width = Math.round((total / full) * 10000) / 100;
  const spoken = `${label}: ${visible.length === 0 ? "nothing" : visible.map((s) => `${s.label} ${dollars(s.cents)}${s.pending ? " pending" : ""}`).join(", ")}`;

  return (
    <div role="img" aria-label={spoken} className={cn("w-full rounded-full bg-fill2", className)} style={{ height }}>
      {visible.length > 0 ? (
        <div className="flex h-full gap-[2px]" style={{ width: `${Math.max(width, 1.5)}%` }}>
          {visible.map((s) => (
            <i
              key={s.key}
              className="block h-full min-w-[3px] first:rounded-l-full last:rounded-r-full"
              style={{
                flex: `${s.cents} 1 0%`,
                background: s.pending
                  ? `repeating-linear-gradient(135deg, ${tintVar(s.tint)} 0 3px, color-mix(in srgb, ${tintVar(s.tint)} 35%, transparent) 3px 6px)`
                  : tintVar(s.tint),
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

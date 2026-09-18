import * as React from "react";

import { cn } from "@/lib/cn";
import type { Tint } from "@/lib/ui/tints";

export interface SplitSegment {
  label: string;
  /** Any non-negative measure; segments are sized by their share of the total. */
  value: number;
  tint: Tint;
  /** Dims the segment, e.g. money out beside money in. */
  muted?: boolean;
}

/**
 * A single 8px bar split into shares: ingredients vs packaging, money in vs out. The caller shows
 * the legend; this carries the numbers for assistive technology in its label.
 */
export function SplitBar({
  segments,
  label,
  className,
}: {
  segments: SplitSegment[];
  /** Spoken summary, e.g. "Ingredients $3,265.48, packaging $432.14". */
  label: string;
  className?: string;
}) {
  const visible = segments.filter((s) => s.value > 0);
  return (
    <div role="img" aria-label={label} className={cn("flex h-2 gap-0.5", className)}>
      {visible.map((s) => (
        <i
          key={s.label}
          className={cn("block h-full min-w-1 rounded-[4px]", s.muted && "opacity-[0.82]")}
          style={{ flex: `${s.value} 1 0%`, background: `var(--${s.tint})` }}
        />
      ))}
    </div>
  );
}

import * as React from "react";

import { cn } from "@/lib/cn";
import type { Tint } from "@/lib/ui/tints";

export interface RunwayRingProps {
  /** Whole days of cash at the trailing burn; null when the business is not burning cash. */
  days: number | null;
  /** The number of days a full ring stands for. */
  fullDays?: number;
  /** Pixel size: 172 on a desktop card, 96 in a phone widget. */
  size?: number;
  className?: string;
}

/** Green with room, orange inside a month, red inside a week. */
export function runwayTint(days: number | null): Tint {
  if (days === null) return "green";
  if (days <= 7) return "red";
  if (days <= 30) return "orange";
  return "green";
}

/** Days of cash as a ring: it shortens as the runway falls and its colour moves green → orange → red. */
export function RunwayRing({ days, fullDays = 30, size = 172, className }: RunwayRingProps) {
  const stroke = size >= 140 ? 15 : 10;
  const r = size / 2 - stroke / 2 - 1;
  const circumference = 2 * Math.PI * r;
  const fraction = days === null ? 1 : Math.max(0, Math.min(1, days / fullDays));
  const dash = Math.round(circumference * fraction * 10) / 10;
  const tint = runwayTint(days);
  const big = size >= 140;

  return (
    <div
      role="img"
      aria-label={days === null ? "Runway: not burning cash" : `Runway: ${days} ${days === 1 ? "day" : "days"} of cash`}
      className={cn("relative grid place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill)" strokeWidth={stroke} />
        {fraction > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={`var(--${tint})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${Math.round(circumference * 10) / 10}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </svg>
      <div aria-hidden className="absolute inset-0 grid place-content-center text-center">
        <span
          className={cn(
            "num leading-none font-bold",
            big ? "text-[3rem] tracking-[-0.035em]" : "text-[1.875rem] tracking-[-0.03em]",
          )}
        >
          {days === null ? "∞" : days}
        </span>
        <span className={cn("mt-0.5 font-medium text-label2", big ? "text-sm" : "text-2xs")}>days</span>
      </div>
    </div>
  );
}

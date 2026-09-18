import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { cn } from "@/lib/cn";

export type StatTone = "positive" | "negative" | "neutral";

export interface StatTileProps extends Omit<React.ComponentPropsWithRef<"div">, "children"> {
  label: string;
  /** Usually a <Money/>. Anything passed here is set in the figure face. */
  value: React.ReactNode;
  /** The change against the comparison period. */
  delta?: React.ReactNode;
  deltaTone?: StatTone;
  deltaDirection?: "up" | "down" | "flat";
  /** What the delta is measured against, e.g. "vs. Aug". */
  deltaLabel?: string;
  hint?: string;
  /** A small chart laid under the number. Kept as a slot — this file fetches nothing. */
  sparkline?: React.ReactNode;
  footer?: React.ReactNode;
}

const toneClass: Record<StatTone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-muted-foreground",
};

export function StatTile({
  label,
  value,
  delta,
  deltaTone = "neutral",
  deltaDirection,
  deltaLabel,
  hint,
  sparkline,
  footer,
  className,
  ...props
}: StatTileProps) {
  const DirectionIcon =
    deltaDirection === "up" ? ArrowUpRight : deltaDirection === "down" ? ArrowDownRight : Minus;

  return (
    <div
      data-slot="stat-tile"
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-3 shadow-raised",
        className,
      )}
      {...props}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="eyebrow truncate">{label}</p>
        {hint ? <span className="text-2xs text-muted-foreground">{hint}</span> : null}
      </div>

      <p className="num text-2xl leading-none font-semibold tracking-tight text-foreground">{value}</p>

      {delta !== undefined || deltaLabel ? (
        <p className="flex items-center gap-1 text-xs">
          {delta !== undefined ? (
            <span className={cn("inline-flex items-center gap-0.5 font-medium", toneClass[deltaTone])}>
              {deltaDirection ? <DirectionIcon className="size-3" aria-hidden /> : null}
              <span className="num">{delta}</span>
            </span>
          ) : null}
          {deltaLabel ? <span className="text-muted-foreground">{deltaLabel}</span> : null}
        </p>
      ) : null}

      {sparkline ? <div className="mt-auto h-10 w-full pt-1">{sparkline}</div> : null}
      {footer ? <div className="rule-subtotal pt-2 text-xs text-muted-foreground">{footer}</div> : null}
    </div>
  );
}

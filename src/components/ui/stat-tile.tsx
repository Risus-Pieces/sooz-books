import * as React from "react";

import { cn } from "@/lib/cn";

import { Glyph } from "./glyph";

export type StatTone = "positive" | "negative" | "neutral";

export interface StatTileProps extends Omit<React.ComponentPropsWithRef<"div">, "children"> {
  label: string;
  /** Usually a <Money/>. Set large and bold in tabular figures. */
  value: React.ReactNode;
  /** The change against the comparison period. */
  delta?: React.ReactNode;
  deltaTone?: StatTone;
  deltaDirection?: "up" | "down" | "flat";
  /** What the delta is measured against, e.g. "vs. Aug". */
  deltaLabel?: string;
  /** A one- or two-word tag shown at the right of the label row. */
  hint?: string;
  /** Leading badge for the label row, usually an <IconBadge/>. */
  badge?: React.ReactNode;
  /** A small chart laid under the number — a <Sparkbars/> or a split bar. */
  sparkline?: React.ReactNode;
  footer?: React.ReactNode;
}

const toneClass: Record<StatTone, string> = {
  positive: "text-ink-green",
  negative: "text-ink-red",
  neutral: "text-label2",
};

/** The mockup's KPI tile: badge and label, a big figure, a small graphic. */
export function StatTile({
  label,
  value,
  delta,
  deltaTone = "neutral",
  deltaDirection,
  deltaLabel,
  hint,
  badge,
  sparkline,
  footer,
  className,
  ...props
}: StatTileProps) {
  const glyph = deltaDirection === "up" ? "arrow-out" : deltaDirection === "down" ? "arrow-in" : "minus";

  return (
    <div
      data-slot="stat-tile"
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-2xl bg-card px-[18px] py-4 text-label shadow-card max-sm:rounded-[22px] max-sm:p-3.5",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-label2">
        {badge}
        <span className={cn("truncate", badge ? "text-label" : undefined)}>{label}</span>
        {hint ? (
          <span className="ml-auto shrink-0 rounded-[6px] bg-fill2 px-[7px] py-0.5 text-2xs font-semibold text-label2">
            {hint}
          </span>
        ) : null}
      </div>

      <div className="num text-3xl leading-[1.1] font-bold tracking-[-0.028em] text-label max-sm:text-2xl">{value}</div>

      {delta !== undefined || deltaLabel ? (
        <p className="flex items-center gap-1 text-xs">
          {delta !== undefined ? (
            <span className={cn("inline-flex items-center gap-0.5 font-semibold", toneClass[deltaTone])}>
              {deltaDirection ? <Glyph name={glyph} size={12} weight={2.2} /> : null}
              <span className="num">{delta}</span>
            </span>
          ) : null}
          {deltaLabel ? <span className="text-label2">{deltaLabel}</span> : null}
        </p>
      ) : null}

      {sparkline ? <div className="mt-auto w-full pt-1">{sparkline}</div> : null}
      {footer ? <div className="text-xs text-label2">{footer}</div> : null}
    </div>
  );
}

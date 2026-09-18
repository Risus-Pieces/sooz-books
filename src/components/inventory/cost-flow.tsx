import * as React from "react";
import Link from "next/link";

import { Glyph } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import type { GlyphName } from "@/lib/ui/glyphs";
import type { Tint } from "@/lib/ui/tints";

export type FlowState = "done" | "current" | "waiting";

export interface FlowStation {
  key: string;
  title: string;
  glyph: GlyphName;
  tint: Tint;
  /** Where the cost sits at this station, e.g. "1320 · 1330". */
  accounts: string;
  /** The value the ledger carries here; null when the station holds no balance (production). */
  cents: number | null;
  /** Replaces the figure: "2 open", "Nothing shipped". */
  figure?: React.ReactNode;
  /** One short line under the figure: "+$3,849 in review". */
  caption?: React.ReactNode;
  state: FlowState;
  href?: string;
}

/**
 * Where the cost of a can is right now: materials → production → finished goods → COGS. The cost
 * moves one way, so the stations read left to right (top to bottom on a phone), and the first one
 * with work outstanding carries the accent ring: that is the next thing to do.
 */
export function CostFlow({ stations }: { stations: readonly FlowStation[] }) {
  return (
    <ol className="grid gap-3 max-md:gap-2 md:grid-cols-4 md:gap-5">
      {stations.map((station, index) => {
        const body = (
          <>
            <div className="flex items-center gap-2">
              <IconBadge glyph={station.glyph} tint={station.tint} />
              <h3 className="min-w-0 flex-1 truncate text-sm font-semibold max-md:text-lg max-md:font-medium">{station.title}</h3>
              <span className="num shrink-0 text-2xs font-medium text-label2">{station.accounts}</span>
            </div>
            <div
              data-slot="station-value"
              className="mt-2.5 text-2xl leading-tight font-bold tracking-[-0.022em] max-md:mt-1.5 max-md:text-xl"
            >
              {station.figure !== undefined ? (
                station.figure
              ) : station.cents === null ? (
                "—"
              ) : (
                <Money cents={station.cents} currency plain />
              )}
            </div>
            {station.caption ? <p className="mt-0.5 truncate text-xs font-medium text-label2">{station.caption}</p> : null}
          </>
        );
        const classes = cn(
          "relative flex h-full min-w-0 flex-col rounded-2xl bg-card px-4 py-3.5 shadow-card transition-shadow max-sm:rounded-[22px]",
          station.state === "current" && "ring-2 ring-tint-blue",
          station.state === "waiting" && "[&_[data-slot=station-value]]:text-label2",
          station.href && station.state !== "current" && "hover:shadow-glass",
        );
        return (
          <li key={station.key} className="relative min-w-0">
            {station.href ? (
              <Link href={station.href} aria-current={station.state === "current" ? "step" : undefined} className={classes}>
                {body}
              </Link>
            ) : (
              <div aria-current={station.state === "current" ? "step" : undefined} className={classes}>
                {body}
              </div>
            )}
            {index < stations.length - 1 ? (
              <span
                aria-hidden
                className="absolute top-1/2 -right-[17px] z-10 hidden size-3.5 -translate-y-1/2 place-items-center text-label3 md:grid"
              >
                <Glyph name="chevron-right" size={13} weight={2.4} />
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

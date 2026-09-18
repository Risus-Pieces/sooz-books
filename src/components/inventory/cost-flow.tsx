import * as React from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";

import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

export type FlowState = "done" | "current" | "waiting";

export interface FlowStation {
  key: string;
  /** Where the cost sits at this station, e.g. "1320 · 1330". */
  accounts: string;
  title: string;
  /** The value the ledger carries here; null when the station holds no balance (production). */
  cents: number | null;
  figure?: React.ReactNode;
  state: FlowState;
  note: React.ReactNode;
  action?: { label: string; href: string };
}

/**
 * Where the cost of a can is right now.
 *
 * Inventory cost moves one way through a co-packed brand's books: materials
 * bought into 1320 and 1330, consumed by a production run, struck into Finished
 * Goods at a unit cost, and relieved to COGS as units ship. The stations are a
 * real sequence, so they read left to right, and the first station with work
 * outstanding carries the accent: that is the next thing to do.
 */
export function CostFlow({ stations }: { stations: readonly FlowStation[] }) {
  return (
    <ol className="grid gap-0 rounded-md border border-border bg-surface shadow-raised md:grid-cols-4">
      {stations.map((station, index) => (
        <li
          key={station.key}
          className={cn(
            "relative flex min-w-0 flex-col gap-2 p-4",
            index > 0 && "border-t border-border md:border-t-0 md:border-l",
            station.state === "current" && "bg-primary/[0.035]",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute inset-x-0 top-0 h-[3px] md:rounded-none",
              station.state === "current" ? "bg-primary" : station.state === "done" ? "bg-border-strong" : "bg-transparent",
              index === 0 && "md:rounded-tl-md",
              index === stations.length - 1 && "md:rounded-tr-md",
            )}
          />
          <div className="flex items-baseline justify-between gap-2">
            <p className="eyebrow flex items-baseline gap-1.5">
              <span className="num text-muted-foreground/80">{index + 1}</span>
              {station.title}
            </p>
            <span className="num text-2xs text-muted-foreground">{station.accounts}</span>
          </div>
          {station.figure !== undefined ? (
            <div className="flex min-h-5 items-end text-base leading-5 font-semibold tracking-tight text-foreground">
              {station.figure}
            </div>
          ) : (
            <div className="num min-h-5 text-xl leading-5 font-semibold tracking-tight text-foreground">
              {station.cents === null ? "—" : <Money cents={station.cents} currency plain />}
            </div>
          )}
          <div className="text-xs leading-relaxed text-muted-foreground">{station.note}</div>
          {station.action ? (
            <Link
              href={station.action.href}
              className={cn(
                "mt-auto inline-flex items-center gap-1 pt-1 text-xs font-medium hover:underline",
                station.state === "current" ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {station.action.label}
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          ) : null}
          {index < stations.length - 1 ? (
            <>
              <span
                aria-hidden
                className="absolute top-1/2 -right-2.5 z-10 hidden size-5 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground md:flex"
              >
                <ArrowRight className="size-3" />
              </span>
              <span
                aria-hidden
                className="absolute -bottom-2.5 left-4 z-10 flex size-5 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground md:hidden"
              >
                <ChevronDown className="size-3" />
              </span>
            </>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

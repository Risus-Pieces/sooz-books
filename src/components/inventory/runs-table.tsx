import * as React from "react";
import Link from "next/link";

import { Glyph } from "@/components/ui/glyph";
import { IconBadge, LegendItem } from "@/components/ui/icon-badge";
import { InsetGroup } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import { monthLong, shortDate } from "@/lib/ui/format";
import type { Tint } from "@/lib/ui/tints";

import { StackBar } from "./stack-bar";
import { COMPONENT_KEYS, COMPONENT_LABELS, COMPONENT_STYLE, formatUnits, type CostComponentKey } from "./types";

export interface RunsTableRow {
  id: string;
  runNo: string;
  sku: string;
  productName: string;
  runDate: string;
  status: "open" | "costed" | "closed";
  goodUnits: number;
  landedCostCents: number;
  unitCostCents: number | null;
  coManName: string | null;
  /** Landed cost by component. */
  components: Partial<Record<CostComponentKey, number>>;
}

const STATUS: Record<RunsTableRow["status"], { label: string; tint: Tint; pill: "blue" | "green" | "neutral" }> = {
  open: { label: "Open", tint: "orange", pill: "blue" },
  costed: { label: "Costed", tint: "green", pill: "green" },
  closed: { label: "Closed", tint: "gray", pill: "neutral" },
};

export function RunStatusBadge({ status }: { status: RunsTableRow["status"] }) {
  const s = STATUS[status];
  return (
    <Pill tone={s.pill} glyph={status === "open" ? "hourglass" : status === "costed" ? "check" : "lock"}>
      {s.label}
    </Pill>
  );
}

/** The components any of these runs carry, in the chart of cost's order. */
export function usedComponents(rows: ReadonlyArray<{ components: Partial<Record<CostComponentKey, number>> }>): CostComponentKey[] {
  return COMPONENT_KEYS.filter((k) => rows.some((r) => (r.components[k] ?? 0) !== 0));
}

/**
 * Every run, newest first, grouped by month: the run and its product, and its landed cost as a
 * stacked bar by component on one scale, so the runs compare at a glance. A row opens the run.
 */
export function RunsTable({ rows }: { rows: readonly RunsTableRow[] }) {
  const scale = Math.max(1, ...rows.map((r) => r.landedCostCents));
  const months = new Map<string, RunsTableRow[]>();
  for (const r of rows) {
    const key = r.runDate.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), r]);
  }

  return (
    <div className="flex flex-col">
      {[...months.entries()].map(([key, list]) => (
        <InsetGroup key={key} header={`${monthLong(Number(key.slice(5, 7)))} ${key.slice(0, 4)}`} separatorInset={56}>
          {list.map((r) => (
            <RunRow key={r.id} run={r} scale={scale} />
          ))}
        </InsetGroup>
      ))}
    </div>
  );
}

function RunRow({ run, scale }: { run: RunsTableRow; scale: number }) {
  const status = STATUS[run.status];
  return (
    <Link
      href={`/inventory/production/${run.id}`}
      className={cn(
        "relative flex items-center gap-3 px-4 py-3 outline-none focus-ring-inset transition-colors hover:bg-fill2 focus-visible:bg-fill2",
        "before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[var(--sep-inset)] before:border-t-[0.5px] before:border-sep first:before:hidden",
      )}
    >
      <IconBadge glyph="wrench" tint={status.tint} size="xl" />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-baseline gap-2">
          <span className="num shrink-0 text-sm font-semibold max-sm:text-lg">{run.runNo}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-label2 max-sm:text-base">{run.productName}</span>
          <Money cents={run.landedCostCents} currency plain className="shrink-0 text-sm font-semibold max-sm:text-lg" />
        </span>
        <StackBar
          label={`${run.runNo} landed cost`}
          scale={scale}
          height={8}
          segments={COMPONENT_KEYS.map((k) => ({
            key: k,
            label: COMPONENT_LABELS[k],
            cents: run.components[k] ?? 0,
            tint: COMPONENT_STYLE[k].tint,
          }))}
        />
        <span className="flex items-center gap-1.5 text-xs text-label2 max-sm:text-sm">
          <span className="num">{shortDate(run.runDate)}</span>
          {run.coManName ? (
            <>
              <span aria-hidden className="size-[3px] rounded-full bg-label3" />
              <span className="truncate">{run.coManName}</span>
            </>
          ) : null}
          <span aria-hidden className="size-[3px] rounded-full bg-label3" />
          <span className={cn("font-medium", run.status === "costed" && "text-ink-green")}>{status.label}</span>
          <span className="ml-auto shrink-0 whitespace-nowrap">
            {run.goodUnits > 0 ? <span className="num">{formatUnits(run.goodUnits)} units</span> : null}
            {run.unitCostCents !== null ? (
              <>
                {run.goodUnits > 0 ? " · " : null}
                <Money cents={run.unitCostCents} currency plain className="font-semibold text-label" />
                /unit
              </>
            ) : null}
          </span>
        </span>
      </span>
      <Glyph name="chevron-right" size={12} weight={2.4} className="shrink-0 text-label3" />
    </Link>
  );
}

/** The legend for the runs' bars, with each component's total across the runs shown. */
export function ComponentLegend({ totals }: { totals: Partial<Record<CostComponentKey, number>> }) {
  const keys = COMPONENT_KEYS.filter((k) => (totals[k] ?? 0) !== 0);
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
      {keys.map((k) => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <LegendItem tint={COMPONENT_STYLE[k].tint}>{COMPONENT_LABELS[k]}</LegendItem>
          <Money cents={totals[k] ?? 0} currency plain whole className="text-xs font-semibold" />
        </li>
      ))}
    </ul>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";

import { Checkbox } from "@/components/ui/checkbox";
import { Glyph } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import { DEDUCTION_STATUS_LABEL, TREATMENT_LABEL, shortDate } from "./labels";
import { DeadlineMeter, STATUS_TINT } from "./parts";
import type { DeductionRowView } from "./types";

export interface DeductionTableProps {
  rows: DeductionRowView[];
  /** Show the dispute window. Off for resolved deductions. */
  deadlines?: boolean;
  /** The empty line, six words at most. */
  empty: string;
  selected?: ReadonlySet<string>;
  onSelectedChange?: (next: Set<string>) => void;
  className?: string;
}

/**
 * The deduction register as inset rows: the claim and what it is for, the open amount, and how
 * much of its dispute window is gone. A checkbox selects a row for the bulk actions; the row itself
 * opens the deduction with its evidence and the entry each action would post.
 */
export function DeductionTable({ rows, deadlines = true, empty, selected, onSelectedChange, className }: DeductionTableProps) {
  const selectable = selected !== undefined && onSelectedChange !== undefined;
  const selectableRows = rows.filter((r) => r.actionable);
  const allSelected = selectable && selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.id));
  const someSelected = selectable && selectableRows.some((r) => selected.has(r.id));

  if (rows.length === 0) {
    return <p className={cn("px-4 py-8 text-center text-sm text-label2", className)}>{empty}</p>;
  }

  return (
    <div className={cn("flex flex-col", className)}>
      {selectable && selectableRows.length > 0 ? (
        <label className="flex min-h-10 cursor-pointer items-center gap-3 hairline-b px-4 text-xs font-semibold text-label2 max-sm:min-h-11">
          <Checkbox
            aria-label="Select every open deduction"
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={(value) => onSelectedChange(value === true ? new Set(selectableRows.map((r) => r.id)) : new Set())}
          />
          All
        </label>
      ) : null}
      <ul className="flex flex-col">
        {rows.map((row, index) => {
          const checked = selectable && selected.has(row.id);
          const reason = row.reasonLabel ?? (row.sourceReasonCode ? `Unmapped “${row.sourceReasonCode}”` : "No reason code");
          return (
            <li
              key={row.id}
              className={cn(
                "relative flex items-center transition-colors",
                index > 0 && "before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-sep",
                checked && "bg-tint-blue/8",
              )}
            >
              {selectable ? (
                <span className="flex w-11 shrink-0 items-center justify-center self-stretch pl-1">
                  <Checkbox
                    aria-label={`Select ${row.deductionNo}`}
                    disabled={!row.actionable}
                    checked={checked}
                    onCheckedChange={(value) => {
                      const next = new Set(selected);
                      if (value === true) next.add(row.id);
                      else next.delete(row.id);
                      onSelectedChange(next);
                    }}
                  />
                </span>
              ) : null}
              <Link
                href={`/trade/deductions/${row.id}`}
                className={cn(
                  "flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 pr-4 outline-none focus-ring-inset hover:bg-fill2 focus-visible:bg-fill2",
                  selectable ? "pl-1" : "pl-4",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="num min-w-0 truncate text-sm font-semibold max-sm:text-lg max-sm:font-medium">{row.deductionNo}</span>
                  </span>
                  <span className="mt-[3px] flex min-w-0 items-center gap-1.5 text-xs text-label2 max-sm:text-sm">
                    <Dot tint={STATUS_TINT[row.status] ?? "gray"} size={7} />
                    <span className="truncate">
                      {reason}
                      <span className="max-sm:hidden"> · {TREATMENT_LABEL[row.treatment] ?? row.treatment}</span>
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <Money cents={row.actionable ? row.openCents : row.amountCents} currency plain className="text-sm font-semibold max-sm:text-lg" />
                  {deadlines && row.actionable ? (
                    <DeadlineMeter deadline={row.disputeDeadline} daysToDeadline={row.daysToDeadline} burn={row.burn} alert={row.alert} />
                  ) : (
                    <span className="text-xs text-label2">
                      {row.actionable ? shortDate(row.deductionDate) : (DEDUCTION_STATUS_LABEL[row.status] ?? row.status)}
                    </span>
                  )}
                </span>
                <Glyph name="chevron-right" size={12} weight={2.4} className="shrink-0 text-label3" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

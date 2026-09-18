"use client";

import * as React from "react";
import Link from "next/link";

import { Checkbox } from "@/components/ui/checkbox";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import { shortDate } from "./labels";
import { DeadlineMeter, DeductionStatusBadge, Table, TableScroll, Td, Th, TreatmentBadge } from "./parts";
import type { DeductionRowView } from "./types";

export interface DeductionTableProps {
  rows: DeductionRowView[];
  /** Fewer columns, for the overview. */
  compact?: boolean;
  /** Show the dispute window column. Off for resolved deductions. */
  deadlines?: boolean;
  empty: string;
  selected?: ReadonlySet<string>;
  onSelectedChange?: (next: Set<string>) => void;
}

/**
 * The deduction register: the claim, what it is for, what is still open and how much of its
 * dispute window is gone. Selecting rows is for the bulk actions above it; opening one shows
 * its evidence and the entry each action would post.
 */
export function DeductionTable({ rows, compact = false, deadlines = true, empty, selected, onSelectedChange }: DeductionTableProps) {
  const selectable = selected !== undefined && onSelectedChange !== undefined;
  const selectableRows = rows.filter((r) => r.actionable);
  const allSelected = selectable && selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.id));
  const someSelected = selectable && selectableRows.some((r) => selected.has(r.id));
  const openTotal = rows.reduce((s, r) => s + r.openCents, 0);
  const amountTotal = rows.reduce((s, r) => s + r.amountCents, 0);

  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">{empty}</p>;
  }

  return (
    <TableScroll>
      <Table caption="Deductions" className={compact ? "min-w-[44rem]" : "min-w-[60rem]"}>
        <thead>
          <tr>
            {selectable ? (
              <Th className="w-8 pr-0">
                <Checkbox
                  aria-label="Select every open deduction"
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={(value) => onSelectedChange(value === true ? new Set(selectableRows.map((r) => r.id)) : new Set())}
                />
              </Th>
            ) : null}
            <Th>Deduction</Th>
            <Th>Customer</Th>
            <Th>Taken</Th>
            {compact ? null : <Th>Invoice</Th>}
            <Th>Reason</Th>
            {compact ? null : (
              <Th align="right" className="w-28">
                Amount
              </Th>
            )}
            <Th align="right" className="w-28">
              Open
            </Th>
            {deadlines ? <Th className="w-36">Dispute by</Th> : null}
            <Th className="w-28">Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const checked = selectable && selected.has(row.id);
            return (
              <tr key={row.id} className={cn("rule-row", checked ? "bg-primary/6" : "hover:bg-muted/60")}>
                {selectable ? (
                  <Td className="w-8 pr-0">
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
                  </Td>
                ) : null}
                <Td className="min-w-40">
                  <Link href={`/trade/deductions/${row.id}`} className="num text-primary hover:underline">
                    {row.deductionNo}
                  </Link>
                  {row.description ? <span className="block max-w-72 truncate text-2xs text-muted-foreground">{row.description}</span> : null}
                </Td>
                <Td className="max-w-44 truncate">{row.customerName}</Td>
                <Td className="num text-xs whitespace-nowrap text-muted-foreground">{shortDate(row.deductionDate)}</Td>
                {compact ? null : <Td className="num text-xs whitespace-nowrap">{row.invoiceNo ?? "—"}</Td>}
                <Td className="min-w-40">
                  <span className="flex flex-col items-start gap-0.5">
                    <span className="text-xs text-foreground">
                      {row.reasonLabel ?? (row.sourceReasonCode ? `Unmapped “${row.sourceReasonCode}”` : "No reason code")}
                    </span>
                    <TreatmentBadge treatment={row.treatment} />
                  </span>
                </Td>
                {compact ? null : (
                  <Td align="right">
                    <Money cents={row.amountCents} plain />
                  </Td>
                )}
                <Td align="right">
                  <Money cents={row.openCents} plain zeroDash />
                </Td>
                {deadlines ? (
                  <Td>
                    {row.actionable ? (
                      <DeadlineMeter deadline={row.disputeDeadline} daysToDeadline={row.daysToDeadline} burn={row.burn} alert={row.alert} />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </Td>
                ) : null}
                <Td>
                  <DeductionStatusBadge status={row.status} />
                </Td>
              </tr>
            );
          })}
          <tr>
            <Td className="rule-subtotal text-xs font-semibold text-muted-foreground" colSpan={(selectable ? 1 : 0) + (compact ? 4 : 5)}>
              {rows.length} {rows.length === 1 ? "deduction" : "deductions"}
            </Td>
            {compact ? null : (
              <Td align="right" className="rule-subtotal rule-total font-semibold">
                <Money cents={amountTotal} plain />
              </Td>
            )}
            <Td align="right" className="rule-subtotal rule-total font-semibold">
              <Money cents={openTotal} plain />
            </Td>
            <Td className="rule-subtotal" colSpan={deadlines ? 2 : 1} />
          </tr>
        </tbody>
      </Table>
    </TableScroll>
  );
}

import * as React from "react";
import { TriangleAlert } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";
import type { Report } from "@/lib/reports/types";

import { ReportRowView } from "./report-row";

export interface ReportMatrixProps {
  report: Report;
  /** A shorter row, for a register that runs to hundreds of lines. */
  dense?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}

/**
 * The one table every statement is drawn with.
 *
 * It knows nothing about profit, balance or basis — it renders columns and rows.
 * That is deliberate: a report is a data structure here, and anything that can
 * produce `{ columns, rows, meta }` gets this presentation, its rules, its
 * sticky account column and its drill-downs for free.
 */
export function ReportMatrix({
  report,
  dense,
  emptyTitle = "Nothing posted in this range",
  emptyDescription = "Widen the dates or switch the basis. Bank lines reach the ledger once they are approved in the review queue.",
  className,
}: ReportMatrixProps) {
  const { columns, rows, meta } = report;

  // The accountant's double rule closes the statement, so only the last total
  // carries it.
  const lastTotal = rows.reduce(
    (found, row, index) => (row.style === "total" ? index : found),
    -1,
  );

  const hasFigures = rows.some((row) => row.style !== "section" && row.style !== "spacer");
  // A statement can be all structure — headings and zero totals — with no account behind it.
  const hasDetail = rows.some((row) => row.style === "detail");

  return (
    <div className={cn("flex flex-col", className)}>
      {meta.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-b border-border bg-warning/8 px-4 py-2.5">
          {meta.warnings.map((warning) => (
            <li key={warning} className="flex gap-2 text-xs text-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <span className="leading-relaxed">{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {hasFigures ? (
        // The table scrolls inside its own box rather than with the page: that is
        // what keeps the column heads and the account column in place while a
        // hundred-line register moves under them.
        <div className="relative w-full overflow-auto max-h-[max(20rem,calc(100dvh-17rem))]">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">
              {meta.title}, {meta.subtitle}, {meta.basis} basis
            </caption>
            <thead className="sticky top-0 z-20">
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-30 rule-head bg-surface px-2 py-2 text-left align-bottom"
                >
                  <span className="eyebrow">Account</span>
                </th>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      "rule-head bg-surface px-3 py-2 align-bottom whitespace-nowrap",
                      column.kind === "text" || column.kind === "date"
                        ? "text-left"
                        : "text-right",
                      column.emphasis && "bg-muted/35",
                      (column.group === "compare" || column.group === "variance") && "rule-gutter",
                    )}
                  >
                    <span
                      className={cn(
                        "eyebrow block",
                        column.emphasis && "text-foreground",
                      )}
                    >
                      {column.label}
                    </span>
                    {column.sublabel ? (
                      <span className="block text-2xs font-normal normal-case text-muted-foreground max-sm:min-w-[6.5rem] max-sm:whitespace-normal">
                        {column.sublabel}
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <ReportRowView
                  key={row.id}
                  row={row}
                  columns={columns}
                  basis={meta.basis}
                  grandTotal={index === lastTotal}
                  dense={dense}
                />
              ))}
            </tbody>
          </table>
          {hasDetail ? null : (
            <p className="sticky left-0 max-w-[calc(100vw-2.125rem)] px-4 py-3 text-xs text-muted-foreground">
              {emptyTitle}. {emptyDescription}
            </p>
          )}
        </div>
      ) : (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      )}
    </div>
  );
}

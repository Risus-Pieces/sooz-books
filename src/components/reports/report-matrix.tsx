import * as React from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { cn } from "@/lib/cn";
import type { Report } from "@/lib/reports/types";

import { ReportRowView } from "./report-row";
import { ReportScroller } from "./report-scroller";

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
  emptyTitle = "Nothing posted",
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
        <ul className="flex flex-col gap-1 hairline-b bg-[color-mix(in_srgb,var(--orange)_9%,var(--card))] px-5 py-2.5">
          {meta.warnings.map((warning) => (
            <li key={warning} className="flex gap-2 text-xs text-label">
              <Glyph name="warning" size={13} className="mt-0.5 shrink-0 text-ink-orange" />
              <span className="leading-relaxed">{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {hasFigures ? (
        // The page scrolls, not the table: the column heads stick under the toolbar. Only a
        // table wider than the card scrolls sideways, keeping the account column in place.
        <ReportScroller>
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">
              {meta.title}, {meta.subtitle}, {meta.basis} basis
            </caption>
            <thead className="sticky top-0 z-20 md:in-data-fit:top-[60px]">
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-30 rule-head bg-card py-2 pr-4 pl-5 text-left align-bottom text-xs font-semibold text-label2"
                >
                  Account
                </th>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      "rule-head bg-card px-3 py-2 align-bottom whitespace-nowrap last:pr-5",
                      column.kind === "text" || column.kind === "date"
                        ? "text-left"
                        : "text-right",
                      (column.group === "compare" || column.group === "variance") && "rule-gutter",
                    )}
                  >
                    <span
                      className={cn(
                        "block text-xs font-semibold",
                        column.emphasis ? "text-label" : "text-label2",
                      )}
                    >
                      {column.label}
                    </span>
                    {column.sublabel ? (
                      <span className="block text-2xs font-normal text-label2 max-sm:hidden">
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
            <p className="sticky left-0 flex max-w-[calc(100vw-2.125rem)] items-center gap-2 px-5 py-4 text-sm font-medium text-label2">
              <Glyph name="doc" size={16} />
              {emptyTitle}
            </p>
          )}
        </ReportScroller>
      ) : (
        <EmptyState glyph="chart" title={emptyTitle} description={emptyDescription} />
      )}
    </div>
  );
}

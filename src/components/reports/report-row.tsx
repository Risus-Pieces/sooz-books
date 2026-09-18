import * as React from "react";

import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import {
  type AccountingBasis,
  type ColumnDef,
  type ReportRow as ReportRowModel,
  cellIsBlank,
  cellIsPercent,
  formatBasisPoints,
} from "@/lib/reports/types";

import { DrilldownLink } from "./drilldown-link";

const EM_DASH = "—";

/** Styles that name a block rather than state a figure. */
const HEADER_STYLES: ReadonlySet<ReportRowModel["style"]> = new Set([
  "section",
  "group",
  "spacer",
]);

/** The rule above a row. Weight carries meaning: see the `rule-*` utilities. */
const RULE: Partial<Record<ReportRowModel["style"], string>> = {
  subtotal: "rule-subtotal",
  total: "rule-subtotal",
  error: "rule-subtotal",
};

const LABEL: Record<ReportRowModel["style"], string> = {
  section: "eyebrow text-foreground",
  group: "font-medium text-foreground",
  detail: "text-foreground",
  subtotal: "font-medium text-foreground",
  total: "text-2xs font-semibold tracking-[0.1em] uppercase text-foreground",
  ratio: "text-xs text-muted-foreground",
  spacer: "",
  note: "text-xs text-muted-foreground",
  error: "text-2xs font-semibold tracking-[0.1em] uppercase text-negative",
};

const FIGURE: Record<ReportRowModel["style"], string> = {
  section: "",
  group: "",
  detail: "",
  subtotal: "font-medium",
  total: "font-semibold",
  ratio: "text-xs text-muted-foreground",
  spacer: "",
  note: "text-xs text-muted-foreground",
  error: "font-semibold text-negative",
};

export interface ReportRowProps {
  row: ReportRowModel;
  columns: readonly ColumnDef[];
  basis: AccountingBasis;
  /** Draws the accountant's double rule under this row: nothing is added below it. */
  grandTotal?: boolean;
  dense?: boolean;
}

/**
 * One line of a statement.
 *
 * Figures that were never measured — a percentage of a percentage, a balance
 * column on a movement total — are left blank rather than printed as zero,
 * because a zero on a ledger page is a statement of fact.
 */
export function ReportRowView({ row, columns, basis, grandTotal, dense }: ReportRowProps) {
  if (row.style === "spacer") {
    return (
      <tr className="h-2">
        <td colSpan={columns.length + 1} />
      </tr>
    );
  }

  const padding = dense ? "py-0.5" : "py-1";
  const isHeader = HEADER_STYLES.has(row.style);
  const rule = cn(RULE[row.style], grandTotal && "rule-total");
  const tinted = row.style === "section" ? "bg-surface-sunken/60" : "bg-surface";

  const label = (
    <span className={LABEL[row.style]}>
      {row.code ? <span className="num mr-2 text-2xs text-muted-foreground">{row.code}</span> : null}
      {row.label}
    </span>
  );

  return (
    <tr
      className={cn(
        row.style === "section" && "bg-surface-sunken/60",
        row.style === "error" && "bg-negative/10",
        !isHeader && row.style !== "error" && "hover:bg-muted/50",
      )}
    >
      <th
        scope="row"
        style={{ paddingLeft: `${8 + row.level * 14}px` }}
        className={cn(
          "sticky left-0 z-10 max-w-[30rem] truncate pr-4 text-left font-normal",
          padding,
          tinted,
          row.style === "error" && "bg-negative/10",
          row.style === "section" && "pt-3",
          rule,
        )}
      >
        {row.drilldown?.accountId !== undefined ? (
          <DrilldownLink
            accountId={row.drilldown.accountId}
            from={row.drilldown.from}
            to={row.drilldown.to}
            basis={basis}
            channelId={row.drilldown.channelId}
          >
            {label}
          </DrilldownLink>
        ) : (
          label
        )}
        {row.note ? (
          <span className="ml-2 text-2xs text-muted-foreground italic">{row.note}</span>
        ) : null}
      </th>

      {columns.map((column, index) => (
        <td
          key={column.key}
          className={cn(
            "px-3 whitespace-nowrap",
            padding,
            column.kind === "text" || column.kind === "date" ? "text-left" : "text-right",
            column.emphasis && "bg-muted/35",
            column.group === "compare" && "rule-gutter",
            column.group === "variance" && "rule-gutter",
            FIGURE[row.style],
            rule,
          )}
        >
          <Cell row={row} column={column} index={index} />
        </td>
      ))}
    </tr>
  );
}

function Cell({ row, column, index }: { row: ReportRowModel; column: ColumnDef; index: number }) {
  if (column.kind === "text" || column.kind === "date") {
    const text = row.cells?.[index] ?? "";
    if (text === "") return null;
    return (
      <span
        className={cn(
          "block max-w-[22rem] truncate",
          (column.kind === "date" || column.key === "entry") && "num",
        )}
        title={text.length > 40 ? text : undefined}
      >
        {text}
      </span>
    );
  }

  if (HEADER_STYLES.has(row.style) || cellIsBlank(row, index)) return null;

  const value = row.values[index] ?? 0;

  if (cellIsPercent(column, row)) {
    if (value === 0) return <span className="num text-muted-foreground">{EM_DASH}</span>;
    return (
      <span className={cn("num", value < 0 && "text-negative")}>
        {formatBasisPoints(value, { sign: column.kind === "variance_pct" })}
      </span>
    );
  }

  return <Money cents={value} parens zeroDash signed={column.kind === "variance"} />;
}

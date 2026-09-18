import * as React from "react";

import { Dot } from "@/components/ui/icon-badge";
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
import { categoryForCode } from "@/lib/ui/categories";

import { sourceLabel } from "@/components/ledger/types";

import { DrilldownLink } from "./drilldown-link";

const EM_DASH = "—";

/** Styles that name a block rather than state a figure. */
const HEADER_STYLES: ReadonlySet<ReportRowModel["style"]> = new Set([
  "section",
  "group",
  "spacer",
]);

/**
 * Statements shout their totals in capitals ("TOTAL ASSETS"); on screen a total is bold, not loud.
 * The part before an em dash is set in sentence case; anything after it is left as written.
 */
export function displayLabel(label: string): string {
  const [head, ...rest] = label.split(" — ");
  if (!/[A-Z]/.test(head) || head !== head.toUpperCase()) return label;
  const sentence = head.charAt(0) + head.slice(1).toLowerCase();
  return [sentence, ...rest].join(" — ");
}

/** The rule above a row. Weight carries meaning: see the `rule-*` utilities. */
const RULE: Partial<Record<ReportRowModel["style"], string>> = {
  subtotal: "rule-subtotal",
  total: "rule-subtotal",
  error: "rule-subtotal",
};

const LABEL: Record<ReportRowModel["style"], string> = {
  section: "font-semibold text-label",
  group: "font-semibold text-label",
  detail: "text-label",
  subtotal: "font-semibold text-label",
  total: "font-bold text-label",
  ratio: "text-xs text-label2",
  spacer: "",
  note: "text-xs text-label2",
  error: "font-bold text-ink-red",
};

const FIGURE: Record<ReportRowModel["style"], string> = {
  section: "",
  group: "",
  detail: "",
  subtotal: "font-semibold",
  total: "font-bold",
  ratio: "text-xs text-label2",
  spacer: "",
  note: "text-xs text-label2",
  error: "font-bold text-ink-red",
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
 * One line of a statement, Numbers-style: hairlines, indentation instead of borders, bold totals,
 * right-aligned tabular figures, and each account's category colour as a dot.
 *
 * Figures that were never measured — a percentage of a percentage, a balance
 * column on a movement total — are left blank rather than printed as zero,
 * because a zero on a ledger page is a statement of fact.
 */
export function ReportRowView({ row, columns, basis, grandTotal, dense }: ReportRowProps) {
  if (row.style === "spacer") {
    return (
      <tr aria-hidden className="h-2.5">
        <td colSpan={columns.length + 1} />
      </tr>
    );
  }

  const padding = dense ? "py-[5px]" : "py-[7px]";
  const isHeader = HEADER_STYLES.has(row.style);
  const rule = cn(RULE[row.style], grandTotal && "rule-total");
  const rowRule = row.style === "detail" || row.style === "ratio" || row.style === "note" ? "rule-row" : undefined;
  // The sticky label cell must be opaque so figures scrolling under it stay hidden.
  const surface = row.style === "error" ? "bg-[color-mix(in_srgb,var(--red)_9%,var(--card))]" : "bg-card";
  const named = row.label !== "";
  const category = row.style === "detail" && row.code && named ? categoryForCode(row.code) : null;

  const label = (
    <span className={cn("inline-flex min-w-0 items-center gap-2", LABEL[row.style])}>
      {category ? <Dot tint={category.tint} size={7} /> : null}
      <span className="truncate max-sm:whitespace-normal">{displayLabel(row.label)}</span>
      {row.code && named ? <span className="num shrink-0 text-xs font-normal text-label2 max-sm:hidden">{row.code}</span> : null}
    </span>
  );

  return (
    <tr className={cn("group/row", !isHeader && row.style !== "error" && "hover:[&>*]:bg-[color-mix(in_srgb,var(--fill2)_60%,var(--card))]")}>
      <th
        scope="row"
        style={{ paddingLeft: `${20 + row.level * 18}px` }}
        className={cn(
          // On a phone the label wraps inside a narrower column, so the figures are on screen
          // without scrolling; from `sm` up it keeps to one truncated line.
          "sticky left-0 z-10 max-w-[30rem] truncate pr-4 text-left text-sm font-normal max-sm:max-w-[11rem] max-sm:min-w-[8.5rem] max-sm:whitespace-normal",
          padding,
          surface,
          row.style === "section" && "pt-4",
          rule,
          rowRule,
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
          <span className="ml-2 text-xs text-label2 max-sm:ml-0 max-sm:block">{row.note}</span>
        ) : null}
      </th>

      {columns.map((column, index) => (
        <td
          key={column.key}
          className={cn(
            "px-3 text-sm whitespace-nowrap last:pr-5",
            padding,
            surface,
            column.kind === "text" || column.kind === "date" ? "text-left" : "text-right",
            column.emphasis && columns.length > 1 && "bg-[color-mix(in_srgb,var(--fill2)_45%,var(--card))]",
            (column.group === "compare" || column.group === "variance") && "rule-gutter",
            FIGURE[row.style],
            rule,
            rowRule,
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
    const raw = row.cells?.[index] ?? "";
    if (raw === "") return null;
    const text = column.key === "source" ? sourceLabel(raw) : raw;
    return (
      <span
        className={cn(
          "block truncate",
          column.key === "memo" ? "max-w-[15rem]" : column.key === "counter" ? "max-w-[12rem]" : "max-w-[22rem]",
          (column.kind === "date" || column.key === "entry") && "num",
          column.key !== "date" && column.key !== "entry" && "text-label2",
        )}
        title={text.length > 24 ? text : undefined}
      >
        {text}
      </span>
    );
  }

  if (HEADER_STYLES.has(row.style) || cellIsBlank(row, index)) return null;

  const value = row.values[index] ?? 0;

  if (cellIsPercent(column, row)) {
    if (value === 0) return <span className="num text-label2">{EM_DASH}</span>;
    return (
      <span className={cn("num", value < 0 && "text-ink-red")}>
        {formatBasisPoints(value, { sign: column.kind === "variance_pct" })}
      </span>
    );
  }

  if (value === 0) return <span className="num text-label2">{EM_DASH}</span>;
  return <Money cents={value} parens signed={column.kind === "variance"} />;
}

"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import {
  columnVisibilityFeature,
  createSortedRowModel,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnVisibilityState,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";

import { cn } from "@/lib/cn";

export interface DataTableColumnMeta {
  /** Numbers go right, everything else stays left. */
  align?: "left" | "center" | "right";
  /** Draws the ledger gutter rule on this column's leading edge — use it between debit and credit. */
  gutter?: boolean;
  /** A unit note set under the header label, e.g. "USD" or "cases". */
  unit?: string;
  width?: string;
  headClassName?: string;
  cellClassName?: string;
}

const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
  columnMeta: {} as DataTableColumnMeta,
});

export type DataTableFeatures = typeof dataTableFeatures;
export type DataTableColumn<TData extends RowData> = ColumnDef<DataTableFeatures, TData>;
export type { ColumnVisibilityState, SortingState };

export interface DataTableProps<TData extends RowData> {
  columns: Array<DataTableColumn<TData>>;
  data: TData[];
  getRowId?: (row: TData, index: number) => string;
  defaultSorting?: SortingState;
  defaultColumnVisibility?: ColumnVisibilityState;
  onRowClick?: (row: TData) => void;
  isRowActive?: (row: TData) => boolean;
  /** Keeps the column heads visible while a long register scrolls under them. */
  stickyHeader?: boolean;
  /** A shorter row for registers that run to hundreds of lines. */
  dense?: boolean;
  emptyState?: React.ReactNode;
  /** A totals row rendered under the double rule. Prefer per-column `footer` for aligned totals. */
  totals?: React.ReactNode;
  caption?: string;
  className?: string;
  tableClassName?: string;
}

function alignClass(align: DataTableColumnMeta["align"]): string {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  defaultSorting,
  defaultColumnVisibility,
  onRowClick,
  isRowActive,
  stickyHeader = true,
  dense = false,
  emptyState,
  totals,
  caption,
  className,
  tableClassName,
}: DataTableProps<TData>) {
  const table = useTable<DataTableFeatures, TData>({
    features: dataTableFeatures,
    columns,
    data,
    getRowId,
    initialState: {
      ...(defaultSorting ? { sorting: defaultSorting } : null),
      ...(defaultColumnVisibility ? { columnVisibility: defaultColumnVisibility } : null),
    },
  });

  const rows = table.getRowModel().rows;
  const hasColumnFooters = columns.some((column) => column.footer !== undefined);
  const cellPadding = dense ? "px-3 py-1" : "px-3 py-1.5";

  return (
    <div className={cn("relative w-full overflow-auto", className)}>
      <table className={cn("w-full border-separate border-spacing-0 text-sm", tableClassName)}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className={cn(stickyHeader && "sticky top-0 z-10")}>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const meta = header.column.columnDef.meta;
                const canSort = header.column.getCanSort();
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    colSpan={header.colSpan}
                    scope="col"
                    style={meta?.width ? { width: meta.width } : undefined}
                    aria-sort={
                      !canSort ? undefined : sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                    }
                    className={cn(
                      "rule-head bg-surface-sunken px-3 py-1.5 align-bottom text-2xs font-semibold tracking-wider text-muted-foreground uppercase",
                      alignClass(meta?.align),
                      meta?.gutter && "rule-gutter",
                      meta?.headClassName,
                    )}
                  >
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-xs tracking-wider uppercase transition-colors hover:text-foreground",
                          meta?.align === "right" && "flex-row-reverse",
                          sorted && "text-foreground",
                        )}
                      >
                        <table.FlexRender header={header} />
                        {sorted === "asc" ? (
                          <ArrowUp className="size-3" />
                        ) : sorted === "desc" ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-35" />
                        )}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                    {meta?.unit ? (
                      <span className="block text-[0.5625rem] font-normal tracking-normal normal-case opacity-70">
                        {meta.unit}
                      </span>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>

        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={table.getAllLeafColumns().length} className="p-0">
                {emptyState ?? (
                  <p className="px-3 py-10 text-center text-xs text-muted-foreground">Nothing to show yet.</p>
                )}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const active = isRowActive?.(row.original) ?? false;
              const clickable = Boolean(onRowClick);
              return (
                <tr
                  key={row.id}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onRowClick?.(row.original) : undefined}
                  onKeyDown={
                    clickable
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onRowClick?.(row.original);
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    "group",
                    clickable && "cursor-pointer outline-none",
                    active ? "bg-primary/8" : clickable && "hover:bg-muted/70 focus-visible:bg-muted/70",
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta;
                    return (
                      <td
                        key={cell.id}
                        className={cn(
                          "rule-row align-middle",
                          cellPadding,
                          alignClass(meta?.align),
                          meta?.gutter && "rule-gutter",
                          meta?.cellClassName,
                        )}
                      >
                        <table.FlexRender cell={cell} />
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>

        {hasColumnFooters || totals ? (
          <tfoot className="bg-surface">
            {hasColumnFooters
              ? table.getFooterGroups().map((footerGroup) => (
                  <tr key={footerGroup.id}>
                    {footerGroup.headers.map((footer) => {
                      const meta = footer.column.columnDef.meta;
                      return (
                        <td
                          key={footer.id}
                          colSpan={footer.colSpan}
                          className={cn(
                            "rule-subtotal rule-total px-3 py-1.5 text-sm font-semibold",
                            alignClass(meta?.align),
                            meta?.gutter && "rule-gutter",
                            meta?.cellClassName,
                          )}
                        >
                          {footer.isPlaceholder ? null : <table.FlexRender footer={footer} />}
                        </td>
                      );
                    })}
                  </tr>
                ))
              : null}
            {totals ? (
              <tr>
                <td
                  colSpan={table.getAllLeafColumns().length}
                  className={cn("px-3 py-1.5 text-sm font-semibold", !hasColumnFooters && "rule-subtotal rule-total")}
                >
                  {totals}
                </td>
              </tr>
            ) : null}
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

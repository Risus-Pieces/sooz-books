import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * The document forms' line grid, drawn like a Numbers table: a quiet grey header row, hairline
 * cells, and fields that sit flush in their cells with no bezel of their own — the focused cell
 * takes the blue ring, as a spreadsheet selects a cell.
 */

/** A field that fills its grid cell: no bezel, no radius, a blue ring when focused. */
export const cellField =
  "h-10 w-full rounded-none border-0 bg-transparent px-2.5 text-sm shadow-none outline-none placeholder:text-label3 focus-visible:shadow-[inset_0_0_0_2px_var(--blue)] data-[state=open]:shadow-[inset_0_0_0_2px_var(--blue)] aria-[invalid=true]:shadow-[inset_0_0_0_1.5px_var(--red)] disabled:opacity-50 max-sm:h-11 " +
  // In a stacked (phone) grid each field is a bezelled control on the line's card.
  "max-md:in-data-stack:h-11 max-md:in-data-stack:rounded-[8px] max-md:in-data-stack:bg-card max-md:in-data-stack:shadow-ctl max-md:in-data-stack:focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--blue)_45%,transparent),0_0_0_0.5px_var(--blue)]";

/**
 * A line of a stacked grid: below `md` the row becomes an inset card whose cells flow on a
 * six-column grid (give each cell its span with `max-md:col-span-*`).
 */
export const stackRow =
  "max-md:mb-2.5 max-md:grid max-md:grid-cols-6 max-md:gap-x-2 max-md:gap-y-2.5 max-md:rounded-[14px] max-md:bg-inset max-md:p-3";

export function GridTh({
  className,
  align = "left",
  children,
}: {
  className?: string;
  align?: "left" | "right" | "center";
  children?: React.ReactNode;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "border-r-[0.5px] border-b-[0.5px] border-sep bg-inset px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-label2 last:border-r-0",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function GridTd({
  className,
  label,
  children,
}: {
  className?: string;
  /** The column's name, shown over the field when the grid is stacked on a phone. */
  label?: string;
  children?: React.ReactNode;
}) {
  return (
    <td
      className={cn(
        "h-10 border-r-[0.5px] border-b-[0.5px] border-sep p-0 align-middle last:border-r-0 max-sm:h-11",
        "max-md:in-data-stack:block max-md:in-data-stack:h-auto max-sm:in-data-stack:h-auto max-md:in-data-stack:min-w-0 max-md:in-data-stack:border-0 max-md:in-data-stack:bg-transparent",
        className,
      )}
    >
      {label ? (
        <span aria-hidden className="mb-1 hidden text-2xs font-medium text-label2 max-md:in-data-stack:block">
          {label}
        </span>
      ) : null}
      {children}
    </td>
  );
}

/** The row number cell: grey, like a spreadsheet's row header. */
export function GridRowNo({ n }: { n: number }) {
  return (
    <td className="w-9 border-r-[0.5px] border-b-[0.5px] border-sep bg-inset px-2 text-right align-middle text-xs font-medium text-label2 tabular-nums max-md:in-data-stack:hidden">
      {n}
    </td>
  );
}

/** A computed (read-only) cell: right-aligned figure in the cell's padding. */
export function GridFigure({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-10 items-center justify-end px-2.5 text-sm font-medium max-sm:h-11 max-md:in-data-stack:h-11", className)}>
      {children}
    </div>
  );
}

/**
 * The grid's frame: a card with the table scrolling sideways on a phone. With `stack`, below `md`
 * the grid drops its columns instead and each line becomes a card (rows use `stackRow`), the way
 * the journal entry's lines do.
 */
export function Grid({
  caption,
  minWidth,
  head,
  children,
  after,
  stack = false,
}: {
  caption: string;
  minWidth: string;
  head: React.ReactNode;
  children: React.ReactNode;
  /** Under the table, inside the frame: the "Add line" row. */
  after?: React.ReactNode;
  stack?: boolean;
}) {
  return (
    <div
      data-stack={stack ? "" : undefined}
      className={cn(
        "overflow-hidden rounded-[12px] shadow-[inset_0_0_0_0.5px_var(--sep-strong)]",
        stack && "max-md:overflow-visible max-md:rounded-none max-md:shadow-none",
      )}
    >
      <div className={cn("relative overflow-x-auto", stack && "max-md:overflow-visible")}>
        <table className={cn("w-full border-separate border-spacing-0 text-sm", minWidth, stack && "max-md:block max-md:min-w-0")}>
          <caption className="sr-only">{caption}</caption>
          <thead className={stack ? "max-md:sr-only" : undefined}>
            <tr>{head}</tr>
          </thead>
          <tbody className={stack ? "max-md:block" : undefined}>{children}</tbody>
        </table>
      </div>
      {after}
    </div>
  );
}

/** A form section: a small headline and a card. */
export function FormSection({
  title,
  accessory,
  className,
  children,
}: {
  title?: React.ReactNode;
  accessory?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("min-w-0", className)}>
      {title || accessory ? (
        <div className="flex items-center gap-2 px-4 pt-2 pb-1.5 max-sm:pt-4">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-label2">{title}</h2>
          {accessory}
        </div>
      ) : null}
      <div className="rounded-2xl bg-card p-4 shadow-card max-sm:rounded-[22px] max-sm:p-3">{children}</div>
    </section>
  );
}

/** A totals block: label left, figure right, a rule over the total. */
export function Totals({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dl className={cn("flex flex-col gap-1.5 text-sm", className)}>{children}</dl>;
}

export function TotalRow({
  label,
  children,
  strong,
  htmlFor,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  strong?: boolean;
  htmlFor?: string;
}) {
  return (
    <div className={cn("flex min-h-7 items-center justify-between gap-6", strong && "mt-1 hairline-t pt-2")}>
      <dt className={cn(strong ? "font-semibold" : "text-label2")}>{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}</dt>
      <dd className={cn("text-right", strong && "text-lg font-bold")}>{children}</dd>
    </div>
  );
}

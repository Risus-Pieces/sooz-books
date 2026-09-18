import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";

import { Glyph } from "./glyph";

export interface InsetGroupProps extends Omit<React.ComponentPropsWithRef<"section">, "title"> {
  /** A month, a category: the quiet heading above the group. */
  header?: React.ReactNode;
  /** Trailing control on the header line (a "See all" link, an ⓘ). */
  headerAccessory?: React.ReactNode;
  /** A short footnote under the group. Rarely needed. */
  footer?: React.ReactNode;
  /**
   * `inset` — rows on a rounded card (lists and forms). `plain` — rows straight on the pane, with
   * rounded selection (a master list beside a detail pane).
   */
  variant?: "inset" | "plain";
  /** Where the separators start, in px: 16 for plain rows, 57 after a 36px monogram, 34 after a dot. */
  separatorInset?: number;
}

type InsetStyle = React.CSSProperties & { "--sep-inset": string };

/**
 * Inset grouped rows, iOS Settings-style: a header, rows separated by hairlines that start after the
 * leading glyph, and no zebra. Children are <ListRow/>s or <GroupRow/>s.
 */
export function InsetGroup({
  header,
  headerAccessory,
  footer,
  variant = "inset",
  separatorInset = 16,
  className,
  style,
  children,
  ...props
}: InsetGroupProps) {
  return (
    <section
      data-slot="inset-group"
      className={cn("min-w-0", className)}
      style={{ ...style, "--sep-inset": `${separatorInset}px` } as InsetStyle}
      {...props}
    >
      {header || headerAccessory ? (
        <div
          className={cn(
            "flex items-center gap-2",
            variant === "inset" ? "px-4 pt-5 pb-1.5" : "px-2.5 pt-3 pb-1",
          )}
        >
          <h3
            className={cn(
              "min-w-0 flex-1 truncate font-semibold text-label2",
              variant === "inset" ? "text-sm" : "text-2xs",
            )}
          >
            {header}
          </h3>
          {headerAccessory}
        </div>
      ) : null}
      <div
        data-variant={variant}
        className={cn(
          "group/inset flex flex-col",
          variant === "inset" && "overflow-hidden rounded-[14px] bg-card shadow-card",
        )}
      >
        {children}
      </div>
      {footer ? <p className="px-4 pt-1.5 text-xs text-label2">{footer}</p> : null}
    </section>
  );
}

const separator =
  "relative before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[var(--sep-inset,16px)] before:border-t-[0.5px] before:border-sep first:before:hidden";

export interface ListRowProps {
  /** A <Monogram/>, <IconBadge/> or <Dot/>. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  /** One secondary line: a category dot and name, a memo. */
  subtitle?: React.ReactNode;
  /** The amount, in tabular figures (a <Money/>). */
  trailing?: React.ReactNode;
  /** A quiet date or count under the trailing amount. */
  detail?: React.ReactNode;
  /** Adds a disclosure chevron (a row that pushes a page). */
  chevron?: boolean;
  href?: string;
  onClick?: () => void;
  /** The row shown in the detail pane. */
  selected?: boolean;
  className?: string;
  /** Forwarded to the row element: data-*, aria-*, id. */
  rowProps?: React.HTMLAttributes<HTMLElement> & Record<`data-${string}`, string | undefined>;
}

/**
 * A list row: leading glyph or monogram, a title with one secondary line, a trailing amount with a
 * quiet date, and optionally a chevron. A link with `href`, a button with `onClick`.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  detail,
  chevron,
  href,
  onClick,
  selected,
  className,
  rowProps,
}: ListRowProps) {
  const classes = cn(
    "group/row flex w-full min-h-11 items-center gap-[11px] px-4 py-[9px] text-left outline-none transition-colors duration-150",
    "group-data-[variant=plain]/inset:rounded-[10px] group-data-[variant=plain]/inset:px-2.5",
    separator,
    (href || onClick) && !selected && "hover:bg-fill2 focus-visible:bg-fill2 focus-ring-inset",
    selected &&
      "bg-accent-fill text-white focus-ring-white before:hidden [&+*]:before:hidden [&_[data-slot=monogram]]:bg-white/22 [&_[data-slot=dot]]:shadow-[0_0_0_1.5px_#fff]",
    className,
  );
  const quiet = selected ? "text-white/90" : "text-label2";
  const body = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold max-sm:text-lg max-sm:font-medium">{title}</span>
          {trailing ? (
            <span className={cn("shrink-0 text-sm font-semibold max-sm:text-lg", selected && "[&_*]:!text-white")}>{trailing}</span>
          ) : null}
        </span>
        {subtitle || detail ? (
          <span className={cn("mt-[3px] flex items-center gap-1.5 text-xs max-sm:text-sm", quiet)}>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{subtitle}</span>
            {detail ? <span className="ml-auto shrink-0 whitespace-nowrap">{detail}</span> : null}
          </span>
        ) : null}
      </span>
      {chevron ? <Glyph name="chevron-right" size={12} weight={2.4} className={selected ? "text-white/80" : "text-label3"} /> : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} aria-current={selected ? "true" : undefined} className={classes} {...rowProps}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={selected} className={classes} {...rowProps}>
        {body}
      </button>
    );
  }
  return (
    <div className={classes} {...rowProps}>
      {body}
    </div>
  );
}

export interface GroupRowProps {
  /** One or two words. */
  label: React.ReactNode;
  /** The value or the control: text, a <PopUpButton/>, a toggle, a meter. */
  children?: React.ReactNode;
  /** Makes the whole row a link with a chevron ("Same account · 47 more"). */
  href?: string;
  /** Associates the label with a form control. */
  htmlFor?: string;
  className?: string;
}

/**
 * A form or detail row, System Settings style: the label on the left, the value or control on the
 * right, 46px tall.
 */
export function GroupRow({ label, children, href, htmlFor, className }: GroupRowProps) {
  const classes = cn(
    "flex min-h-[46px] items-center gap-3 px-4 py-2 max-sm:min-h-11",
    separator,
    href && "outline-none focus-ring-inset transition-colors hover:bg-fill2 focus-visible:bg-fill2",
    className,
  );
  const labelNode = htmlFor ? (
    <label htmlFor={htmlFor} className="flex-1 text-sm font-medium max-sm:text-lg max-sm:font-normal">
      {label}
    </label>
  ) : (
    <span className="flex-1 text-sm font-medium max-sm:text-lg max-sm:font-normal">{label}</span>
  );
  const value = <span className="flex min-w-0 items-center justify-end gap-2.5 text-sm font-medium text-label2 max-sm:text-lg">{children}</span>;

  if (href) {
    return (
      <Link href={href} className={classes}>
        {labelNode}
        {value}
        <Glyph name="chevron-right" size={12} weight={2.4} className="text-label3" />
      </Link>
    );
  }
  return (
    <div className={classes}>
      {labelNode}
      {value}
    </div>
  );
}

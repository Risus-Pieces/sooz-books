import * as React from "react";

import { cn } from "@/lib/cn";

/** U+2212. A real minus sign is the same advance width as a digit in a tabular face. */
const MINUS = "−";
const EM_DASH = "—";

const groupInteger = new Intl.NumberFormat("en-US", {
  useGrouping: true,
  maximumFractionDigits: 0,
});

export interface MoneyFormatOptions {
  /** Render negatives as (1,234.56), the convention in printed statements. */
  parens?: boolean;
  /** Prefix a dollar sign. Off by default: in a column the header carries the unit. */
  currency?: boolean;
  /** Always show an explicit sign, including + on positives. For variances and deltas. */
  signed?: boolean;
  /** Render an exact zero as an em dash, as a ledger leaves an empty cell ruled but blank. */
  zeroDash?: boolean;
  /** Round to whole dollars and drop the cents — for captions and legends, never for a ledger figure. */
  whole?: boolean;
}

/**
 * Formats integer cents without ever touching a float: the dollars and the remainder are split
 * with integer arithmetic and reassembled as text.
 */
export function formatCents(cents: number, options: MoneyFormatOptions = {}): string {
  const { parens = false, currency = false, signed = false, zeroDash = false, whole = false } = options;
  const value = Math.round(cents);

  if (value === 0 && zeroDash) return EM_DASH;

  const negative = value < 0;
  const abs = Math.abs(value);
  const dollars = groupInteger.format(whole ? Math.floor((abs + 50) / 100) : Math.floor(abs / 100));
  const remainder = String(abs % 100).padStart(2, "0");
  const body = `${currency ? "$" : ""}${dollars}${whole ? "" : `.${remainder}`}`;

  if (negative) return parens ? `(${body})` : `${MINUS}${body}`;
  return signed ? `+${body}` : body;
}

export interface MoneyProps extends Omit<React.ComponentPropsWithRef<"span">, "children">, MoneyFormatOptions {
  cents: number;
  /** Colour gains as well as losses. Off by default — in the black means plain ink. */
  colorPositive?: boolean;
  /** Leave the value in the foreground colour whatever its sign. */
  plain?: boolean;
}

export function Money({
  cents,
  parens,
  currency,
  signed,
  zeroDash,
  whole,
  colorPositive,
  plain,
  className,
  ...props
}: MoneyProps) {
  const value = Math.round(cents);
  const text = formatCents(value, { parens, currency, signed, zeroDash, whole });
  const tone = plain
    ? undefined
    : value < 0
      ? "text-ink-red"
      : colorPositive && value > 0
        ? "text-ink-green"
        : undefined;

  return (
    <span
      data-slot="money"
      className={cn("num tabular-nums whitespace-nowrap", tone, className)}
      aria-label={parens && value < 0 ? `negative ${formatCents(-value, { currency })}` : undefined}
      {...props}
    >
      {text}
    </span>
  );
}

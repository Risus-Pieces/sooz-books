"use client";

import * as React from "react";

import { Input, type InputProps } from "@/components/ui/input";
import { formatCents } from "@/components/ui/money";

import { readMoney } from "./math";

export interface MoneyInputProps extends Omit<InputProps, "value" | "onChange"> {
  value: string;
  onValueChange: (text: string) => void;
  allowNegative?: boolean;
}

/**
 * An amount field. It keeps what was typed while it has focus and shows what
 * will be stored once it loses it, so `1234.5` reads back as `1,234.50`
 * without fighting the keystrokes. Unreadable text is left alone and marked.
 */
export function MoneyInput({ value, onValueChange, allowNegative, invalid, onBlur, ...props }: MoneyInputProps) {
  const parsed = readMoney(value, { allowNegative });
  return (
    <Input
      numeric
      inputMode="decimal"
      autoComplete="off"
      placeholder="0.00"
      value={value}
      invalid={invalid || parsed.error !== null}
      onChange={(event) => onValueChange(event.target.value)}
      onBlur={(event) => {
        if (parsed.error === null && parsed.cents !== null) {
          const formatted = formatCents(parsed.cents);
          if (formatted !== value) onValueChange(formatted);
        }
        onBlur?.(event);
      }}
      {...props}
    />
  );
}

/** Cents from a money field: 0 for blank or unreadable. */
export function centsOf(text: string): number {
  return readMoney(text, { allowNegative: true }).cents ?? 0;
}

/** Text for a money field from cents: blank for zero. */
export function textOf(cents: number | null | undefined): string {
  return cents === null || cents === undefined || cents === 0 ? "" : formatCents(cents);
}

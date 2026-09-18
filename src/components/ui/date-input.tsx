import * as React from "react";

import { cn } from "@/lib/cn";
import { inputBase } from "@/components/ui/input";

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE_PATTERN.test(value);
}

/** Today as a calendar date in the viewer's own locale, with no UTC round-trip. */
export function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export interface DateInputProps
  extends Omit<React.ComponentPropsWithRef<"input">, "value" | "defaultValue" | "type"> {
  /** A calendar date as 'YYYY-MM-DD'. Never a Date — accounting dates carry no time zone. */
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  invalid?: boolean;
}

/**
 * A native date control rather than a calendar popover: a bookkeeper enters hundreds of these a
 * day from the keyboard, and the native field already speaks 'YYYY-MM-DD' with no parsing layer.
 */
export function DateInput({
  className,
  value,
  onValueChange,
  onChange,
  invalid,
  ...props
}: DateInputProps) {
  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange?.(event);
      onValueChange?.(event.target.value);
    },
    [onChange, onValueChange],
  );

  return (
    <input
      type="date"
      data-slot="date-input"
      value={value ?? undefined}
      onChange={handleChange}
      aria-invalid={invalid || undefined}
      className={cn(
        inputBase,
        "num w-[9.5rem] tracking-normal",
        invalid && "border-negative focus-visible:border-negative",
        className,
      )}
      {...props}
    />
  );
}

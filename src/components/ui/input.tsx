import * as React from "react";

import { cn } from "@/lib/cn";

export const inputBase =
  "h-8 w-full rounded-sm max-sm:h-10 max-sm:text-lg border border-border-strong bg-surface-raised px-2.5 text-sm text-foreground shadow-none transition-colors placeholder:text-muted-foreground/80 focus-visible:border-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";

export interface InputProps extends React.ComponentPropsWithRef<"input"> {
  /** Right-aligns and sets the value in tabular figures — use for money, quantities and codes. */
  numeric?: boolean;
  invalid?: boolean;
}

export function Input({ className, numeric, invalid, ...props }: InputProps) {
  return (
    <input
      data-slot="input"
      aria-invalid={invalid || undefined}
      className={cn(
        inputBase,
        numeric && "num text-right tracking-normal",
        invalid && "border-negative focus-visible:border-negative",
        className,
      )}
      {...props}
    />
  );
}

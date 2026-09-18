import * as React from "react";

import { cn } from "@/lib/cn";

import { fieldBase, fieldInvalid } from "./menu-styles";

/** The text-field bezel, exported for controls that are not an <Input/> but should look like one. */
export const inputBase = fieldBase;

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
      className={cn(inputBase, numeric && "num text-right", invalid && fieldInvalid, className)}
      {...props}
    />
  );
}

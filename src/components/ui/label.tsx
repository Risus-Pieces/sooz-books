"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/lib/cn";

export interface LabelProps extends React.ComponentPropsWithRef<typeof LabelPrimitive.Root> {
  required?: boolean;
  /** A few words at most. Anything longer belongs in an <InfoButton/>. */
  hint?: string;
}

/** A form label in the System Settings voice: sentence case, medium weight, never shouting. */
export function Label({ className, children, required, hint, ...props }: LabelProps) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn("flex items-baseline gap-1.5 text-sm font-medium text-label select-none", className)}
      {...props}
    >
      {children}
      {required ? (
        <span aria-hidden className="text-ink-red">
          *
        </span>
      ) : null}
      {hint ? <span className="text-xs font-normal text-label2">{hint}</span> : null}
    </LabelPrimitive.Root>
  );
}

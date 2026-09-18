"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/lib/cn";

export interface LabelProps extends React.ComponentPropsWithRef<typeof LabelPrimitive.Root> {
  required?: boolean;
  hint?: string;
}

export function Label({ className, children, required, hint, ...props }: LabelProps) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-baseline gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase select-none",
        className,
      )}
      {...props}
    >
      {children}
      {required ? (
        <span aria-hidden className="text-negative normal-case">
          *
        </span>
      ) : null}
      {hint ? (
        <span className="text-2xs font-normal tracking-normal normal-case opacity-80">{hint}</span>
      ) : null}
    </LabelPrimitive.Root>
  );
}

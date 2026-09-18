"use client";

import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

import { cn } from "@/lib/cn";

export interface SeparatorProps
  extends React.ComponentPropsWithRef<typeof SeparatorPrimitive.Root> {
  /** `total` draws the accountant's double rule used to close a grand total. */
  weight?: "hairline" | "rule" | "total";
}

export function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  weight = "hairline",
  ...props
}: SeparatorProps) {
  const horizontal = orientation === "horizontal";
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      orientation={orientation}
      decorative={decorative}
      className={cn(
        "shrink-0",
        horizontal ? "h-px w-full" : "h-full w-px self-stretch",
        weight === "hairline" && "bg-border",
        weight === "rule" && "bg-border-strong",
        weight === "total" && horizontal && "h-[3px] border-0 border-b-[3px] border-double border-border-strong bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

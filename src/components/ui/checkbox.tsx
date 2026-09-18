"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";

import { cn } from "@/lib/cn";

import { Glyph } from "./glyph";

export function Checkbox({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative size-4 shrink-0 rounded-[4px] bg-ctl text-white shadow-ctl transition-colors",
        "max-sm:after:absolute max-sm:after:-inset-3.5 max-sm:after:content-['']",
        "data-[state=checked]:bg-accent-fill data-[state=checked]:shadow-none data-[state=indeterminate]:bg-accent-fill data-[state=indeterminate]:shadow-none disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        <Glyph name={props.checked === "indeterminate" ? "minus" : "check"} size={12} weight={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

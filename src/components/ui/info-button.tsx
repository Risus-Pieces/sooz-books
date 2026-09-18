"use client";

import * as React from "react";

import { cn } from "@/lib/cn";

import { Glyph } from "./glyph";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface InfoButtonProps {
  /** What the ⓘ explains, for the button's accessible name: "About runway". */
  label: string;
  /** The explanation. This is the home of every sentence the screen itself does not show. */
  children: React.ReactNode;
  /** Optional heading inside the popover. */
  title?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}

/**
 * ⓘ — opens a popover with the explanation. Screens show one or two words per label; anything a
 * reader might want to know beyond that lives here.
 */
export function InfoButton({ label, children, title, side = "bottom", align = "end", className }: InfoButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className={cn(
          "relative grid size-[22px] shrink-0 place-items-center rounded-full text-label3 transition-colors outline-none focus-ring hover:text-label2 data-[state=open]:text-ink-blue",
          "max-sm:after:absolute max-sm:after:-inset-[11px] max-sm:after:content-['']",
          className,
        )}
      >
        <Glyph name="info" size={17} />
      </PopoverTrigger>
      <PopoverContent side={side} align={align} className="px-3.5 py-3 text-sm leading-[1.45]">
        {title ? <p className="mb-1 font-semibold">{title}</p> : null}
        <div className="text-label [&_p+p]:mt-2">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

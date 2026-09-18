"use client";

import * as React from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface FilterDisclosureProps {
  children: React.ReactNode;
  /** What the filters are set to now, shown beside the button while they are folded away. */
  summary?: React.ReactNode;
  /** Classes for the element that wraps the controls — its layout on every screen size. */
  contentClassName?: string;
  /** Classes for the phone-only row that holds the Filters button. */
  triggerClassName?: string;
  className?: string;
}

/**
 * Filters that fold behind a "Filters" button on a phone and stay open from the `sm`
 * breakpoint up. On a narrow screen a toolbar of dates and selects would otherwise fill the
 * whole first screen before a single figure shows.
 *
 * Folding only hides the controls: they stay mounted, so a form they belong to still submits
 * every value.
 */
export function FilterDisclosure({
  children,
  summary,
  contentClassName,
  triggerClassName,
  className,
}: FilterDisclosureProps) {
  const [open, setOpen] = React.useState(false);
  const contentId = React.useId();

  return (
    <div data-slot="filter-disclosure" className={cn("flex flex-col", className)}>
      <div className={cn("flex min-w-0 items-center gap-3 sm:hidden", triggerClassName)}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((current) => !current)}
        >
          <SlidersHorizontal aria-hidden />
          Filters
          <ChevronDown aria-hidden className={cn("transition-transform", open && "rotate-180")} />
        </Button>
        {summary ? <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span> : null}
      </div>
      <div id={contentId} className={cn(contentClassName, !open && "max-sm:hidden", open && "max-sm:mt-3")}>
        {children}
      </div>
    </div>
  );
}

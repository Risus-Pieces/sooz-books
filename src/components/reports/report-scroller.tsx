"use client";

import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * The box a statement's table sits in. The page scrolls, never this box, so there is one scroller
 * and the column heads stick under the toolbar. Only a table genuinely wider than the card (a
 * twelve-month P&L on a narrow window) scrolls sideways here, and while it does the heads scroll
 * with it: a box that scrolls in one axis scrolls in both, so it would otherwise trap sticky heads.
 */
export function ReportScroller({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  // Server render assumes overflow, so a wide table is never clipped before hydration.
  const [wide, setWide] = React.useState(true);

  React.useLayoutEffect(() => {
    const box = ref.current;
    const table = box?.querySelector("table");
    if (!box || !table) return;
    const measure = () => setWide(table.scrollWidth > box.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(table);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-fit={wide ? undefined : ""}
      className={cn("relative w-full", wide ? "overflow-x-auto" : "overflow-x-clip", className)}
    >
      {children}
    </div>
  );
}

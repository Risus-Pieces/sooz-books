import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";

export interface LinkTab {
  href: string;
  label: string;
  count?: number;
  active: boolean;
}

/**
 * Index tabs that are links, so a tab is a URL that can be bookmarked and the server reads
 * only what the tab shows. Same look as the design system's Radix tabs.
 */
export function LinkTabs({ tabs, label }: { tabs: readonly LinkTab[]; label: string }) {
  return (
    <nav aria-label={label} className="rule-head flex items-end gap-4 overflow-x-auto">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex shrink-0 items-baseline gap-1.5 border-b-2 px-0.5 pb-1.5 max-sm:pt-3 text-sm font-medium whitespace-nowrap transition-colors",
            tab.active
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
          {tab.count === undefined ? null : (
            <span className={cn("num text-xs", tab.active ? "text-primary" : "text-muted-foreground")}>{tab.count}</span>
          )}
        </Link>
      ))}
    </nav>
  );
}

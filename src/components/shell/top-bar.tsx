"use client";

import * as React from "react";
import { PanelLeft } from "lucide-react";

import { cn } from "@/lib/cn";
import { GlobalSearch, type SearchTarget } from "@/components/shell/global-search";
import { ThemeToggle } from "@/components/shell/theme-toggle";

export interface TopBarProps {
  /** The working period. Pass a <PeriodIndicator/>; the shell itself fetches nothing. */
  period?: React.ReactNode;
  /** The account menu, supplied by whoever knows who is signed in. */
  user?: React.ReactNode;
  /** Controls that belong to the whole workspace rather than to one page. */
  actions?: React.ReactNode;
  searchTargets?: SearchTarget[];
  /** Opens the navigation drawer below 1024px, where the rail is not on screen. */
  onOpenNav?: () => void;
  className?: string;
}

export function TopBar({
  period,
  user,
  actions,
  searchTargets,
  onOpenNav,
  className,
}: TopBarProps) {
  return (
    <header
      data-slot="top-bar"
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 lg:px-4",
        className,
      )}
    >
      {onOpenNav ? (
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open navigation"
          className="-ml-1 grid size-8 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        >
          <PanelLeft className="size-4" />
        </button>
      ) : null}

      <div className="min-w-0 flex-1">{period}</div>

      <div className="flex shrink-0 items-center gap-1.5">
        {actions}
        <GlobalSearch targets={searchTargets} />
        <ThemeToggle />
        {user ? (
          <>
            <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
            {user}
          </>
        ) : null}
      </div>
    </header>
  );
}

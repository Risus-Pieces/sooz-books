"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/lib/cn";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NAV_COLLAPSE_COOKIE } from "@/components/shell/nav";
import { SideNav } from "@/components/shell/side-nav";
import { TopBar } from "@/components/shell/top-bar";
import type { SearchTarget } from "@/components/shell/global-search";

export interface AppShellProps {
  children: React.ReactNode;
  /** Read from the rail cookie on the server, so the first paint is already the right width. */
  defaultCollapsed?: boolean;
  period?: React.ReactNode;
  user?: React.ReactNode;
  actions?: React.ReactNode;
  searchTargets?: SearchTarget[];
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function AppShell({
  children,
  defaultCollapsed = false,
  period,
  user,
  actions,
  searchTargets,
}: AppShellProps) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((current) => !current);
  }, []);

  React.useEffect(() => {
    document.cookie = `${NAV_COLLAPSE_COOKIE}=${collapsed ? "1" : "0"}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
  }, [collapsed]);

  // Widening past the rail breakpoint leaves the drawer stranded over the layout.
  React.useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (media.matches) setDrawerOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={500}>
      <div className="flex h-dvh overflow-hidden bg-background">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:border focus:border-border-strong focus:bg-surface-raised focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium"
        >
          Skip to content
        </a>

        <aside
          className={cn(
            "hidden shrink-0 transition-[width] duration-150 ease-out lg:block",
            collapsed ? "w-13" : "w-56",
          )}
        >
          <SideNav collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        </aside>

        <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-foreground/40 data-[state=open]:anim-fade-in data-[state=closed]:anim-fade-out lg:hidden" />
            <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-60 outline-none data-[state=open]:anim-sheet-in data-[state=closed]:anim-sheet-out lg:hidden">
              <DialogPrimitive.Title className="sr-only">Sections</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                Move between the registers, reports and settings.
              </DialogPrimitive.Description>
              <SideNav variant="drawer" onNavigate={() => setDrawerOpen(false)} />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            period={period}
            user={user}
            actions={actions}
            searchTargets={searchTargets}
            onOpenNav={() => setDrawerOpen(true)}
          />
          <main id="main" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[104rem] px-4 py-5 lg:px-6 lg:py-6">{children}</div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

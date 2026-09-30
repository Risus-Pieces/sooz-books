"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/lib/cn";
import { TooltipProvider } from "@/components/ui/tooltip";

import { GlobalSearch, type SearchTarget } from "./global-search";
import { MoreSheet } from "./more-sheet";
import { ReceiptAssistant } from "@/components/receipts/assistant";
import { NAV_COLLAPSE_COOKIE } from "./nav";
import { ShellProvider, type ShellAccount, type ShellPeriod, type ShellState } from "./shell-context";
import { SideNav } from "./side-nav";
import { TabBar } from "./tab-bar";

export interface AppShellProps {
  children: React.ReactNode;
  /** Read from the sidebar cookie on the server, so the first paint is already right. */
  defaultCollapsed?: boolean;
  reviewCount?: number;
  account?: ShellAccount | null;
  period?: ShellPeriod | null;
  searchTargets?: SearchTarget[];
  /** Whether to offer the receipt assistant. Decided on the server from the person's role. */
  canUseAssistant?: boolean;
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * The window. Desktop (≥1024px): the floating translucent sidebar beside the page, which can be
 * hidden. Tablet (768–1023px): the sidebar opens over the page from the toolbar's sidebar button.
 * Phone (<768px): no sidebar; a floating tab bar with a More sheet.
 *
 * The document scrolls, not an inner box, so mobile Safari's bars, pull-to-refresh and full-page
 * screenshots all behave natively. Each page draws its own <PageToolbar/>, which sticks to the top.
 */
export function AppShell({
  children,
  defaultCollapsed = false,
  reviewCount = 0,
  account = null,
  period = null,
  searchTargets,
  canUseAssistant = false,
}: AppShellProps) {
  const [sidebarHidden, setSidebarHidden] = React.useState(defaultCollapsed);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [assistantOpen, setAssistantOpen] = React.useState(false);

  const toggleSidebar = React.useCallback(() => {
    setSidebarHidden((hidden) => {
      const next = !hidden;
      document.cookie = `${NAV_COLLAPSE_COOKIE}=${next ? "1" : "0"}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
      return next;
    });
  }, []);

  // Widening past the sidebar breakpoint leaves the drawer stranded over the layout.
  React.useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (media.matches) setDrawerOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const state = React.useMemo<ShellState>(
    () => ({
      reviewCount,
      account,
      period,
      sidebarHidden,
      toggleSidebar,
      openNav: () => setDrawerOpen(true),
      openSearch: () => setSearchOpen(true),
      openMore: () => setMoreOpen(true),
      canUseAssistant,
      openAssistant: () => setAssistantOpen(true),
    }),
    [reviewCount, account, period, sidebarHidden, toggleSidebar, canUseAssistant],
  );

  return (
    <ShellProvider value={state}>
      <TooltipProvider delayDuration={450} skipDelayDuration={300}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-[8px] focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-glass"
        >
          Skip to content
        </a>

        <div className="flex min-h-dvh bg-bg">
          <aside
            aria-label="Sidebar"
            className={cn(
              "sticky top-0 hidden h-dvh w-[260px] shrink-0 p-2 lg:block",
              sidebarHidden && "lg:hidden",
            )}
          >
            <SideNav />
          </aside>

          <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/20 data-[state=open]:anim-fade-in data-[state=closed]:anim-fade-out" />
              <DialogPrimitive.Content
                aria-describedby={undefined}
                className="fixed inset-y-0 left-0 z-50 w-[276px] p-2 outline-none data-[state=open]:anim-sheet-in data-[state=closed]:anim-sheet-out"
              >
                <DialogPrimitive.Title className="sr-only">Sections</DialogPrimitive.Title>
                <SideNav variant="drawer" onNavigate={() => setDrawerOpen(false)} />
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>

          <main id="main" className="min-w-0 flex-1">
            <div className="mx-auto w-full max-w-[100rem] px-5 pb-8 max-md:flex max-md:min-h-dvh max-md:flex-col max-md:px-4 max-md:pb-[calc(env(safe-area-inset-bottom)+22px)]">
              {children}
              <TabBar moreOpen={moreOpen} />
            </div>
          </main>
        </div>

        <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} />
        <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} targets={searchTargets} />
        {canUseAssistant ? <ReceiptAssistant open={assistantOpen} onOpenChange={setAssistantOpen} /> : null}
      </TooltipProvider>
    </ShellProvider>
  );
}

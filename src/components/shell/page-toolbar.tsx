"use client";

import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useShell } from "./shell-context";
import { ThemeToggle } from "./theme-toggle";

export interface PageToolbarProps {
  /** The page's large title. Rendered as the page's one <h1>. */
  title: string;
  /** A quiet figure beside the title: "85 · −$6,490.25". Badges are fine too. */
  subtitle?: React.ReactNode;
  /** The page's explanation. Never shown on screen; it opens from an ⓘ beside the title. */
  info?: React.ReactNode;
  /** A parent page: renders a back chevron before the title ("‹ Production runs"). */
  back?: { href: string; label: string };
  /** Any other node for the left of the title (legacy breadcrumbs). */
  leading?: React.ReactNode;
  /** Page actions, right-aligned: <ToolbarGroup>s of <ToolbarButton>/<ToolbarLink>, or <Button>s. */
  actions?: React.ReactNode;
  /** A page-level search field, shown before the actions. */
  search?: React.ReactNode;
  /**
   * Draws the appearance button (default). Pass false when the page draws a second toolbar of its
   * own (a split view with a toolbar over each pane) and puts the button there instead.
   */
  appearanceButton?: boolean;
  /**
   * On a phone, give the large title a row of its own under the bar (iOS: back and actions on the
   * navigation bar, the large title beneath). For pages with a back link and wide actions.
   */
  phoneTitleRow?: boolean;
  /** A shorter large title for the phone ("Cash Flow" for "Statement of Cash Flows"). */
  phoneTitle?: string;
  className?: string;
}

/**
 * The unified toolbar, one per page, always the page's first child: the large title on the left,
 * the page's actions on the right, and the appearance button. It sticks to the top of the window
 * on frosted glass while the page scrolls under it.
 *
 * On a phone it becomes the iOS large-title row: a 34pt title with the actions as round buttons.
 */
export function PageToolbar({
  title,
  subtitle,
  info,
  back,
  leading,
  actions,
  search,
  appearanceButton = true,
  phoneTitleRow = false,
  phoneTitle,
  className,
}: PageToolbarProps) {
  const shell = useShell();
  // iOS: a pushed page (one with a back link) always puts its large title on its own row, under a
  // navigation bar holding the back link and the actions, so neither squeezes the other.
  const titleRow = phoneTitleRow || back !== undefined;

  return (
    <header
      data-slot="page-toolbar"
      data-titlerow={titleRow ? "" : undefined}
      className={cn(
        "relative z-30 -mx-5 flex min-h-[60px] items-center gap-2.5 px-5 md:sticky md:top-0 md:h-[60px] md:vibrancy-bar",
        "max-md:-mx-4 max-md:flex-wrap max-md:gap-y-2 max-md:px-4 max-md:pt-3 max-md:pb-2",
        className,
      )}
    >
      {shell ? (
        <div className={cn("flex items-center max-md:hidden", !shell.sidebarHidden && "lg:hidden")}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Show sidebar"
                onClick={() => {
                  if (window.matchMedia("(min-width: 1024px)").matches) shell.toggleSidebar();
                  else shell.openNav();
                }}
                className="grid h-7 w-8 place-items-center rounded-[8px] text-label2 transition-colors hover:bg-fill2 hover:text-label"
              >
                <Glyph name="sidebar" size={18} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Show sidebar</TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      {back && titleRow ? (
        <Link
          href={back.href}
          className="-ml-1.5 mr-auto inline-flex h-11 min-w-0 shrink items-center gap-0.5 rounded-[8px] pr-2 pl-1 text-sm font-medium text-ink-blue transition-colors hover:bg-fill2 md:hidden"
        >
          <Glyph name="chevron-left" size={16} weight={2.2} />
          <span className="max-w-40 truncate">{back.label}</span>
        </Link>
      ) : null}

      <div className={cn("flex min-w-0 flex-1 items-center gap-2", titleRow && "max-md:order-last max-md:basis-full")}>
        {back ? (
          <Link
            href={back.href}
            className={cn(
              "-ml-1.5 inline-flex h-7 shrink-0 items-center gap-0.5 rounded-[8px] pr-2 pl-1 text-sm font-medium text-ink-blue transition-colors hover:bg-fill2 max-md:h-11",
              titleRow && "max-md:hidden",
            )}
          >
            <Glyph name="chevron-left" size={16} weight={2.2} />
            <span className="max-w-40 truncate">{back.label}</span>
          </Link>
        ) : null}
        {leading ? <div className="shrink-0 [&_svg]:size-3.5">{leading}</div> : null}
        <div
          className={cn(
            "flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1",
            // On a phone's title row the subtitle (badges, a date) sits under the title, never beside it.
            titleRow && "max-md:flex-col max-md:items-start",
          )}
        >
          <h1
            className={cn(
              "min-w-0 truncate text-2xl leading-tight font-bold tracking-[-0.022em] max-md:text-4xl max-md:tracking-[-0.026em]",
              // A title with a row of its own wraps to a second line rather than truncating.
              titleRow && "max-md:line-clamp-2 max-md:whitespace-normal max-md:[overflow-wrap:anywhere]",
            )}
          >
            {phoneTitle ? (
              <>
                <span className="md:hidden">{phoneTitle}</span>
                <span className="max-md:hidden">{title}</span>
              </>
            ) : (
              title
            )}
          </h1>
          {subtitle ? (
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium whitespace-nowrap text-label2",
                titleRow && "max-md:flex-wrap max-md:whitespace-normal max-md:text-sm",
              )}
            >
              {subtitle}
            </span>
          ) : null}
        </div>
        {info ? (
          <InfoButton label="About this page" title={title} align="start" className="self-center">
            {info}
          </InfoButton>
        ) : null}
      </div>

      {search ? <div className="flex shrink-0 items-center max-md:order-last max-md:w-full">{search}</div> : null}
      {actions ? (
        <div
          className={cn(
            "flex shrink-0 flex-wrap items-center justify-end gap-2",
            titleRow && "max-md:flex-nowrap",
            // With the title on its own row and no back link, keep the actions on the right.
            titleRow && !back && "max-md:ml-auto",
          )}
        >
          {actions}
        </div>
      ) : null}

      {shell ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={shell.openSearch}
                aria-label="Search"
                className="grid h-7 w-8 place-items-center rounded-[8px] text-label2 transition-colors hover:bg-fill2 hover:text-label lg:hidden max-md:size-11 max-md:rounded-full max-md:vibrancy max-md:text-label max-md:shadow-glass"
              >
                <Glyph name="search" size={17} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Search ⌘K</TooltipContent>
          </Tooltip>
          {appearanceButton ? <ThemeToggle className="max-md:hidden" /> : null}
        </div>
      ) : null}
    </header>
  );
}

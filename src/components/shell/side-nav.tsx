"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";
import { Glyph } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { Kbd } from "@/components/ui/keycap";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { AccountMenu } from "./account-menu";
import {
  NAV_GROUPS,
  activeChildHref,
  activeSectionHref,
  type NavSection,
} from "./nav";
import { useShell } from "./shell-context";

export interface SideNavProps {
  /** `drawer` is the tablet presentation, opened over the content. */
  variant?: "rail" | "drawer";
  onNavigate?: () => void;
  className?: string;
}

/**
 * The translucent sidebar: coloured System Settings badges, grouped Home · Review · Banking ·
 * Business · Books, Settings and the company at the foot. The section you are in is filled blue;
 * its pages are listed under it.
 */
export function SideNav({ variant = "rail", onNavigate, className }: SideNavProps) {
  const pathname = usePathname() ?? "";
  const shell = useShell();
  const active = activeSectionHref(pathname);
  const groups = NAV_GROUPS.filter((g) => g.key !== "footer");
  const footer = NAV_GROUPS.find((g) => g.key === "footer");

  return (
    <nav
      aria-label="Sections"
      data-slot="side-nav"
      className={cn(
        "flex h-full flex-col rounded-[18px] vibrancy px-2.5 pt-3 pb-2.5 text-label shadow-glass",
        className,
      )}
    >
      <div className="flex h-7 shrink-0 items-center gap-2 pr-0.5 pl-2">
        <span className="flex-1 truncate text-xs font-semibold text-label2">Sooz Books</span>
        {variant === "rail" && shell ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={shell.toggleSidebar}
                aria-label="Hide sidebar"
                className="grid h-7 w-8 place-items-center rounded-[8px] text-label2 transition-colors hover:bg-fill2 hover:text-label"
              >
                <Glyph name="sidebar" size={18} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Hide sidebar</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          shell?.openSearch();
        }}
        className="mx-1 mt-2.5 mb-2 flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] bg-fill2 px-2 text-sm text-label2 transition-colors hover:bg-fill"
      >
        <Glyph name="search" size={14} />
        <span className="flex-1 text-left">Search</span>
        <Kbd className="bg-transparent shadow-none">⌘K</Kbd>
      </button>

      {shell?.canUseAssistant ? (
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            shell.openAssistant();
          }}
          className="mx-1 mb-2 flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-sm text-label2 transition-colors hover:bg-fill2 hover:text-label"
        >
          <Glyph name="sparkle" size={14} />
          <span className="flex-1 text-left">Assistant</span>
        </button>
      ) : null}

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 [scrollbar-width:none]">
        {groups.map((group) => (
          <div key={group.key}>
            {group.label ? (
              <p className="px-2.5 pt-3.5 pb-1 text-2xs font-semibold text-label2">{group.label}</p>
            ) : null}
            <ul className="flex flex-col gap-px">
              {group.sections.map((section) => (
                <SideNavItem
                  key={section.href}
                  section={section}
                  pathname={pathname}
                  active={active === section.href}
                  count={section.count === "review" ? shell?.reviewCount : undefined}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-2 shrink-0 hairline-t pt-2">
        {footer ? (
          <ul className="flex flex-col gap-px">
            {footer.sections.map((section) => (
              <SideNavItem
                key={section.href}
                section={section}
                pathname={pathname}
                active={active === section.href}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        ) : null}
        <AccountMenu account={shell?.account ?? null} period={shell?.period ?? null} className="mt-1" />
      </div>
    </nav>
  );
}

function SideNavItem({
  section,
  pathname,
  active,
  count,
  onNavigate,
}: {
  section: NavSection;
  pathname: string;
  active: boolean;
  count?: number;
  onNavigate?: () => void;
}) {
  const child = active ? activeChildHref(pathname, section) : null;
  const selected = active && child === null;

  return (
    <li>
      <Link
        href={section.href}
        onClick={onNavigate}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex h-[30px] items-center gap-[9px] rounded-[8px] pr-2 pl-1.5 text-sm font-medium outline-none transition-colors duration-150",
          selected ? "bg-accent-fill text-white focus-ring-white" : active ? "bg-fill2 focus-ring-inset" : "hover:bg-fill2 focus-ring-inset",
        )}
      >
        <IconBadge glyph={section.glyph} tint={section.tint} />
        <span className="min-w-0 flex-1 truncate">{section.label}</span>
        {count !== undefined && count > 0 ? (
          <span className={cn("num text-xs font-medium", selected ? "text-white/90" : "text-label2")}>
            <span className="sr-only">, </span>
            {count}
            <span className="sr-only"> to review</span>
          </span>
        ) : null}
      </Link>
      {active && section.children?.length ? (
        <ul className="mt-px mb-1 flex flex-col gap-px">
          {section.children.map((link) => {
            const on = link.href === child;
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={onNavigate}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex h-7 items-center rounded-[7px] pr-2 pl-[37px] text-[0.8125rem] outline-none transition-colors duration-150",
                    on ? "bg-accent-fill font-medium text-white focus-ring-white" : "text-label2 hover:bg-fill2 hover:text-label focus-ring-inset",
                  )}
                >
                  <span className="truncate">{link.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, PanelLeft, PanelLeftClose } from "lucide-react";

import { cn } from "@/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NAV_GROUPS, isRouteActive, type NavSection } from "@/components/shell/nav";

export interface SideNavProps {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** `drawer` is the under-1024px presentation; it is never collapsed and has no rail toggle. */
  variant?: "rail" | "drawer";
  onNavigate?: () => void;
  className?: string;
}

const itemBase =
  "relative flex items-center gap-2.5 rounded-sm text-sm transition-colors outline-none focus-visible:outline-offset-[-2px]";

const activeRule =
  "before:absolute before:top-1 before:bottom-1 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-accent before:content-['']";

export function SideNav({
  collapsed = false,
  onToggleCollapsed,
  variant = "rail",
  onNavigate,
  className,
}: SideNavProps) {
  const pathname = usePathname() ?? "";
  const isRail = variant === "rail";
  const isCollapsed = isRail && collapsed;

  // A section the reader is inside opens itself; anything they open or close by hand overrides that.
  const [overrides, setOverrides] = React.useState<Record<string, boolean>>({});

  const isSectionOpen = React.useCallback(
    (href: string) => overrides[href] ?? isRouteActive(pathname, href),
    [overrides, pathname],
  );

  const toggleSection = React.useCallback(
    (href: string) => {
      setOverrides((current) => ({ ...current, [href]: !isSectionOpen(href) }));
    },
    [isSectionOpen],
  );

  return (
    <nav
      aria-label="Sections"
      data-slot="side-nav"
      className={cn(
        "flex h-full flex-col bg-sidebar text-sidebar-foreground",
        isRail && "border-r border-sidebar-border",
        className,
      )}
    >
      <div
        className={cn(
          "flex h-12 shrink-0 items-center border-b border-sidebar-border",
          isCollapsed ? "justify-center px-2" : "px-3",
        )}
      >
        <Link
          href="/dashboard"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-xs outline-none focus-visible:outline-offset-2"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-xs border border-sidebar-border text-sidebar-strong">
            <span className="num text-[0.6875rem] font-semibold">SB</span>
          </span>
          {isCollapsed ? null : (
            <span className="leading-[0.95]">
              <span className="block text-[0.6875rem] font-bold tracking-[0.22em] text-sidebar-strong">
                SOOZ
              </span>
              <span className="block text-[0.6875rem] font-bold tracking-[0.22em]">BOOKS</span>
            </span>
          )}
        </Link>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto py-2", isCollapsed ? "px-2" : "px-2")}>
        {NAV_GROUPS.map((group, index) => (
          <div key={group.label ?? `group-${index}`} className={index > 0 ? "mt-3" : undefined}>
            {group.label && !isCollapsed ? (
              <p className="px-2 pt-1 pb-1.5 text-[0.5625rem] font-semibold tracking-[0.16em] text-sidebar-foreground/60 uppercase">
                {group.label}
              </p>
            ) : null}
            {group.label && isCollapsed ? (
              <div className="mx-2 mb-2 border-t border-sidebar-border" />
            ) : null}
            <ul className="flex flex-col gap-px">
              {group.sections.map((section) => (
                <SideNavSection
                  key={section.href}
                  section={section}
                  pathname={pathname}
                  collapsed={isCollapsed}
                  open={isSectionOpen(section.href)}
                  onToggle={() => toggleSection(section.href)}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      {isRail && onToggleCollapsed ? (
        <div className="shrink-0 border-t border-sidebar-border p-2">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              itemBase,
              "h-8 w-full text-sidebar-foreground/80 hover:bg-sidebar-strong/8 hover:text-sidebar-strong",
              isCollapsed ? "justify-center px-0" : "px-2",
            )}
          >
            {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
            {isCollapsed ? null : <span className="text-xs">Collapse</span>}
          </button>
        </div>
      ) : null}
    </nav>
  );
}

interface SideNavSectionProps {
  section: NavSection;
  pathname: string;
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}

function SideNavSection({
  section,
  pathname,
  collapsed,
  open,
  onToggle,
  onNavigate,
}: SideNavSectionProps) {
  const Icon = section.icon;
  const active = isRouteActive(pathname, section.href);
  const hasChildren = Boolean(section.children?.length);
  const panelId = `nav-${section.href.replace(/\//g, "-")}`;

  const link = (
    <Link
      href={section.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        itemBase,
        "h-8 flex-1 font-medium",
        collapsed ? "justify-center px-0" : "px-2",
        active
          ? cn("bg-sidebar-strong/8 text-sidebar-strong", activeRule)
          : "text-sidebar-foreground hover:bg-sidebar-strong/6 hover:text-sidebar-strong",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {collapsed ? <span className="sr-only">{section.label}</span> : <span>{section.label}</span>}
    </Link>
  );

  return (
    <li>
      <div className="flex items-center gap-px">
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">{section.label}</TooltipContent>
          </Tooltip>
        ) : (
          link
        )}
        {hasChildren && !collapsed ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${open ? "Hide" : "Show"} ${section.label} pages`}
            className="grid size-8 shrink-0 place-items-center rounded-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-strong/8 hover:text-sidebar-strong"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : null}
      </div>

      {hasChildren && !collapsed && open ? (
        <ul id={panelId} className="mt-px mb-1 ml-[1.0625rem] flex flex-col gap-px border-l border-sidebar-border pl-2">
          {section.children?.map((child) => {
            const childActive = isRouteActive(pathname, child.href);
            return (
              <li key={child.href}>
                <Link
                  href={child.href}
                  onClick={onNavigate}
                  aria-current={childActive ? "page" : undefined}
                  className={cn(
                    itemBase,
                    "h-7 px-2 text-xs",
                    childActive
                      ? "bg-sidebar-strong/8 text-sidebar-strong"
                      : "text-sidebar-foreground/85 hover:bg-sidebar-strong/6 hover:text-sidebar-strong",
                  )}
                >
                  {child.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

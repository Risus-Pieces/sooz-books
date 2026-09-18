"use client";

import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";

import { Glyph, type GlyphName } from "./glyph";
import { Kbd } from "./keycap";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * A capsule of related toolbar controls on frosted glass, the way Mail groups its toolbar.
 * Put two to four related actions in one group; start a new group for a new kind of action.
 */
export function ToolbarGroup({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div
      role="group"
      data-slot="toolbar-group"
      className={cn(
        "flex h-[34px] shrink-0 items-center gap-0.5 rounded-full vibrancy px-[3px] shadow-glass",
        "max-md:h-11 max-md:px-0.5",
        className,
      )}
      {...props}
    />
  );
}

interface ToolbarItemBase {
  glyph: GlyphName;
  /** The action's name: its tooltip and its accessible name. One or two words. */
  label: string;
  /** Shown in the tooltip as a key: "⏎", "E", "⌘N". The key handling itself is the page's. */
  shortcut?: string;
  /** Shows the label beside the glyph (a text-and-icon toolbar item). */
  showLabel?: boolean;
  tone?: "default" | "danger" | "accent";
  className?: string;
}

const toneClass = {
  default: "text-label2 hover:text-label",
  danger: "text-ink-red",
  accent: "text-ink-blue",
} as const;

function itemClasses(tone: ToolbarItemBase["tone"], className?: string): string {
  return cn(
    "relative inline-flex h-7 min-w-[34px] items-center justify-center gap-1.5 rounded-full px-2 text-sm font-medium outline-none focus-ring transition-colors duration-150 hover:bg-fill2 active:bg-fill disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40",
    "max-md:h-10 max-md:min-w-10",
    toneClass[tone ?? "default"],
    className,
  );
}

function ItemBody({ glyph, label, showLabel }: Pick<ToolbarItemBase, "glyph" | "label" | "showLabel">) {
  return (
    <>
      <Glyph name={glyph} size={18} />
      {/* In a phone's navigation bar (a page with a back link) a labelled item folds to its glyph. */}
      {showLabel ? <span className="max-md:in-data-titlerow:sr-only">{label}</span> : null}
    </>
  );
}

function ItemTooltip({ label, shortcut, children }: { label: string; shortcut?: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export interface ToolbarButtonProps
  extends ToolbarItemBase,
    Omit<React.ComponentPropsWithRef<"button">, "className" | "children"> {}

/** An icon button for a toolbar group. Its tooltip gives the name and the shortcut. */
export function ToolbarButton({ glyph, label, shortcut, showLabel, tone, className, type, ...rest }: ToolbarButtonProps) {
  return (
    <ItemTooltip label={label} shortcut={shortcut}>
      <button
        type={type ?? "button"}
        aria-label={showLabel ? undefined : label}
        aria-keyshortcuts={shortcut}
        className={itemClasses(tone, className)}
        {...rest}
      >
        <ItemBody glyph={glyph} label={label} showLabel={showLabel} />
      </button>
    </ItemTooltip>
  );
}

export interface ToolbarLinkProps
  extends ToolbarItemBase,
    Omit<React.ComponentPropsWithRef<typeof Link>, "className" | "children"> {}

/** The same item as a link, for actions that open a page (Import, New entry). */
export function ToolbarLink({ glyph, label, shortcut, showLabel, tone, className, ...rest }: ToolbarLinkProps) {
  return (
    <ItemTooltip label={label} shortcut={shortcut}>
      <Link
        aria-label={showLabel ? undefined : label}
        aria-keyshortcuts={shortcut}
        className={itemClasses(tone, className)}
        {...rest}
      >
        <ItemBody glyph={glyph} label={label} showLabel={showLabel} />
      </Link>
    </ItemTooltip>
  );
}

"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/lib/cn";

import { Glyph } from "./glyph";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps extends React.ComponentPropsWithRef<typeof DialogPrimitive.Content> {
  /**
   * `auto` (default): a panel from the right on a desktop, rising from the bottom on a phone —
   * the detail of a list row, a short create/edit form. `bottom` always rises; `right` always slides.
   */
  side?: "auto" | "right" | "bottom";
  /** The sheet's title, always rendered (visually or not) for assistive technology. */
  title: string;
  /** Hide the title visually when the content carries its own heading. */
  hideTitle?: boolean;
  /** One short line for assistive technology; not shown. */
  description?: string;
  /** Toolbar actions shown at the top right, beside Close. */
  actions?: React.ReactNode;
  width?: "sm" | "md" | "lg";
}

const widths = { sm: "sm:w-[380px]", md: "sm:w-[480px]", lg: "sm:w-[640px]" } as const;

/**
 * Progressive disclosure on a phone, and for short forms everywhere: a sheet over the page with a
 * title bar (title, actions, Close) and scrolling content.
 */
function SheetContent({
  side = "auto",
  title,
  hideTitle,
  description,
  actions,
  width = "md",
  className,
  children,
  ...props
}: SheetContentProps) {
  const right = side === "right" || side === "auto";
  const bottom = side === "bottom" || side === "auto";
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25 data-[state=open]:anim-fade-in data-[state=closed]:anim-fade-out dark:bg-black/45" />
      <DialogPrimitive.Content
        data-slot="sheet"
        {...(description ? {} : { "aria-describedby": undefined })}
        className={cn(
          "fixed z-50 flex flex-col bg-bg text-label shadow-glass outline-none",
          side === "auto" &&
            "max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[94dvh] max-sm:rounded-t-[14px] max-sm:data-[state=open]:anim-rise-in max-sm:data-[state=closed]:anim-rise-out sm:inset-y-2 sm:right-2 sm:rounded-[14px] sm:data-[state=open]:anim-slide-in-right sm:data-[state=closed]:anim-slide-out-right",
          side === "right" &&
            "inset-y-2 right-2 max-w-[calc(100vw-16px)] rounded-[14px] data-[state=open]:anim-slide-in-right data-[state=closed]:anim-slide-out-right",
          side === "bottom" &&
            "inset-x-0 bottom-0 max-h-[94dvh] rounded-t-[14px] data-[state=open]:anim-rise-in data-[state=closed]:anim-rise-out sm:mx-auto sm:max-w-xl",
          right && widths[width],
          bottom && "pb-[env(safe-area-inset-bottom)]",
          className,
        )}
        {...props}
      >
        <header className="flex h-13 shrink-0 items-center gap-2 px-4 max-sm:h-14">
          <DialogPrimitive.Title
            className={cn("min-w-0 flex-1 truncate text-lg font-semibold tracking-[-0.01em]", hideTitle && "sr-only")}
          >
            {title}
          </DialogPrimitive.Title>
          {hideTitle ? <span className="flex-1" /> : null}
          {actions}
          <DialogPrimitive.Close
            aria-label="Close"
            className="grid size-7 place-items-center rounded-full bg-fill2 text-label2 transition-colors hover:bg-fill hover:text-label max-sm:size-9"
          >
            <Glyph name="xmark" size={13} weight={2.2} />
          </DialogPrimitive.Close>
        </header>
        {description ? (
          <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export { Sheet, SheetClose, SheetContent, SheetTrigger };

"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/lib/cn";

import { Glyph } from "./glyph";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/25 data-[state=open]:anim-fade-in data-[state=closed]:anim-fade-out dark:bg-black/45",
        className,
      )}
      {...props}
    />
  );
}

export interface DialogContentProps
  extends React.ComponentPropsWithRef<typeof DialogPrimitive.Content> {
  /** Hides the built-in close control when the dialog supplies its own. */
  hideClose?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
}

const sizeClass: Record<NonNullable<DialogContentProps["size"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

/**
 * A modal sheet, centred: the confirmation that moves money, a short form. On a phone it rises
 * from the bottom edge, the way iOS presents a sheet.
 */
function DialogContent({ className, children, hideClose, size = "md", ...props }: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed z-50 flex flex-col overflow-hidden bg-card text-label shadow-glass outline-none",
          "sm:top-1/2 sm:left-1/2 sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[14px]",
          "sm:data-[state=open]:anim-pop-in sm:data-[state=closed]:anim-pop-out",
          "max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-[14px] max-sm:pb-[env(safe-area-inset-bottom)]",
          "max-sm:data-[state=open]:anim-rise-in max-sm:data-[state=closed]:anim-rise-out",
          sizeClass[size],
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            className="absolute top-3 right-3 grid size-7 place-items-center rounded-full bg-fill2 text-label2 transition-colors hover:bg-fill hover:text-label max-sm:size-9"
            aria-label="Close"
          >
            <Glyph name="xmark" size={13} weight={2.2} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentPropsWithRef<"header">) {
  return (
    <header
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1 px-5 pt-5 pb-2 pr-12", className)}
      {...props}
    />
  );
}

function DialogBody({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div data-slot="dialog-body" className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-3", className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: React.ComponentPropsWithRef<"footer">) {
  return (
    <footer
      data-slot="dialog-footer"
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 px-5 pt-3 pb-5 max-sm:flex-col-reverse max-sm:items-stretch",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentPropsWithRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-lg leading-tight font-semibold tracking-[-0.01em] text-label", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm text-label2", className)} {...props} />;
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};

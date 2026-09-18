"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";

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
        "fixed inset-0 z-50 bg-foreground/35 backdrop-blur-[1px] data-[state=open]:anim-fade-in data-[state=closed]:anim-fade-out",
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

function DialogContent({ className, children, hideClose, size = "md", ...props }: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-3rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border-strong bg-surface text-foreground shadow-overlay outline-none",
          "data-[state=open]:anim-pop-in data-[state=closed]:anim-pop-out",
          sizeClass[size],
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            className="absolute top-2.5 right-2.5 rounded-xs p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
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
      className={cn("flex flex-col gap-0.5 rule-head px-4 py-3 pr-10", className)}
      {...props}
    />
  );
}

function DialogBody({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div data-slot="dialog-body" className={cn("min-h-0 flex-1 overflow-y-auto p-4", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentPropsWithRef<"footer">) {
  return (
    <footer
      data-slot="dialog-footer"
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-sunken/40 px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentPropsWithRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-sm font-semibold tracking-tight text-foreground", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn("text-xs text-muted-foreground", className)} {...props} />
  );
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

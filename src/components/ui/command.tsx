"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";

import { cn } from "@/lib/cn";

import { Glyph } from "./glyph";

function Command({ className, ...props }: React.ComponentPropsWithRef<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn("flex w-full flex-col overflow-hidden text-label", className)}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2.5 hairline-b px-4">
      <Glyph name="search" size={18} className="text-label2" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-12 w-full bg-transparent text-lg text-label outline-none placeholder:text-label2 disabled:cursor-not-allowed max-sm:text-[1rem]",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentPropsWithRef<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-80 overflow-x-hidden overflow-y-auto overscroll-contain p-1.5", className)}
      {...props}
    />
  );
}

function CommandEmpty(props: React.ComponentPropsWithRef<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className="px-3 py-8 text-center text-sm text-label2"
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentPropsWithRef<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden text-label [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-label2",
        className,
      )}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentPropsWithRef<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        // cmdk writes data-disabled="false" on every item, so the menu rows' presence-based
        // disabled style must not be reused here: it would switch off every pointer event.
        "relative flex min-h-8 cursor-default items-center gap-2 rounded-[5px] px-2 py-[3px] text-sm outline-none select-none max-sm:min-h-11 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-label2",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40 data-[selected=true]:bg-accent-fill data-[selected=true]:text-white data-[selected=true]:[&_svg]:text-white data-[selected=true]:[&_[data-slot=command-shortcut]]:text-white/80",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn("mx-2 my-1 h-0 border-t-[0.5px] border-sep", className)} {...props} />;
}

function CommandShortcut({ className, ...props }: React.ComponentPropsWithRef<"span">) {
  return (
    <span data-slot="command-shortcut" className={cn("ml-auto text-xs text-label2", className)} {...props} />
  );
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};

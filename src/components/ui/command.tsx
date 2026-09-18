"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";

import { cn } from "@/lib/cn";

function Command({ className, ...props }: React.ComponentPropsWithRef<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn("flex w-full flex-col overflow-hidden rounded-md bg-surface-raised text-foreground", className)}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 rule-head px-3">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-9 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed",
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
      className={cn("max-h-72 overflow-x-hidden overflow-y-auto overscroll-contain p-1", className)}
      {...props}
    />
  );
}

function CommandEmpty(props: React.ComponentPropsWithRef<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className="px-3 py-6 text-center text-xs text-muted-foreground"
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentPropsWithRef<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase",
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
        "relative flex cursor-default items-center gap-2 rounded-xs px-2 py-1.5 text-sm outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45 data-[selected=true]:bg-muted [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
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
  return <CommandPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

function CommandShortcut({ className, ...props }: React.ComponentPropsWithRef<"span">) {
  return (
    <span className={cn("num ml-auto text-2xs tracking-widest text-muted-foreground", className)} {...props} />
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

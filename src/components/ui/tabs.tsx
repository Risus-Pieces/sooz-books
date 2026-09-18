"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/cn";

const Tabs = TabsPrimitive.Root;

/** Tabs drawn as a segmented control, the way macOS switches between views of one thing. */
function TabsList({ className, ...props }: React.ComponentPropsWithRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 self-start overflow-x-auto rounded-[8px] bg-fill2 p-0.5 [scrollbar-width:none]",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentPropsWithRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-[6px] px-3 text-xs font-medium whitespace-nowrap text-label transition-[background-color,box-shadow] duration-150 outline-none focus-ring max-sm:h-9 max-sm:text-sm",
        "hover:bg-fill2 data-[state=active]:bg-ctl data-[state=active]:font-semibold data-[state=active]:shadow-ctl disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentPropsWithRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("pt-4 outline-none", className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };

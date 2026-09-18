"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/cn";

const Tabs = TabsPrimitive.Root;

/** Index tabs standing on the divider rule, the way a binder's section tabs do. */
function TabsList({ className, ...props }: React.ComponentPropsWithRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex items-end gap-4 rule-head overflow-x-auto", className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentPropsWithRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "-mb-px shrink-0 border-b-2 border-transparent px-0.5 pb-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground disabled:pointer-events-none disabled:opacity-45",
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

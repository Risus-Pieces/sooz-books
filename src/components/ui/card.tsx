import * as React from "react";

import { cn } from "@/lib/cn";

export function Card({ className, ...props }: React.ComponentPropsWithRef<"section">) {
  return (
    <section
      data-slot="card"
      className={cn(
        "rounded-md border border-border bg-surface text-foreground shadow-raised",
        className,
      )}
      {...props}
    />
  );
}

/** Header sits above the content on a solid rule — the head of a ledger column. */
export function CardHeader({ className, ...props }: React.ComponentPropsWithRef<"header">) {
  return (
    <header
      data-slot="card-header"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rule-head px-4 py-2.5",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentPropsWithRef<"h2">) {
  return (
    <h2
      data-slot="card-title"
      className={cn("text-sm leading-tight font-semibold tracking-tight text-foreground", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.ComponentPropsWithRef<"p">) {
  return (
    <p data-slot="card-description" className={cn("text-xs text-muted-foreground", className)} {...props} />
  );
}

export function CardToolbar({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div data-slot="card-toolbar" className={cn("flex items-center gap-1.5", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div data-slot="card-content" className={cn("p-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentPropsWithRef<"footer">) {
  return (
    <footer
      data-slot="card-footer"
      className={cn("flex items-center justify-between gap-3 border-t border-border px-4 py-2.5", className)}
      {...props}
    />
  );
}

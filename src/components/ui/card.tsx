import * as React from "react";

import { cn } from "@/lib/cn";

/** A reading surface on the grouped background: white (or raised grey), 16px radius, no border. */
export function Card({ className, ...props }: React.ComponentPropsWithRef<"section">) {
  return (
    <section
      data-slot="card"
      className={cn("rounded-2xl bg-card text-label shadow-card max-sm:rounded-[22px]", className)}
      {...props}
    />
  );
}

/** The card's title row: a headline, an optional ⓘ and trailing controls. No rule under it. */
export function CardHeader({ className, ...props }: React.ComponentPropsWithRef<"header">) {
  return (
    <header
      data-slot="card-header"
      className={cn("flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-2.5 max-sm:px-4", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentPropsWithRef<"h2">) {
  return (
    <h2
      data-slot="card-title"
      className={cn("text-lg leading-tight font-semibold tracking-[-0.01em] text-label", className)}
      {...props}
    />
  );
}

/** One short line at most; explanations belong in an <InfoButton/>. */
export function CardDescription({ className, ...props }: React.ComponentPropsWithRef<"p">) {
  return <p data-slot="card-description" className={cn("text-xs text-label2", className)} {...props} />;
}

export function CardToolbar({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div data-slot="card-toolbar" className={cn("flex items-center gap-1.5", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div data-slot="card-content" className={cn("px-5 pt-1 pb-5 max-sm:px-4 max-sm:pb-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentPropsWithRef<"footer">) {
  return (
    <footer
      data-slot="card-footer"
      className={cn("flex items-center justify-between gap-3 hairline-t px-5 py-3 max-sm:px-4", className)}
      {...props}
    />
  );
}

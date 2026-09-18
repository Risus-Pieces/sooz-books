import * as React from "react";

import { cn } from "@/lib/cn";

export interface EmptyStateProps extends React.ComponentPropsWithRef<"div"> {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
}

/** An empty screen is an invitation to act, so `action` carries the next step. */
export function EmptyState({
  className,
  icon,
  title,
  description,
  action,
  secondaryAction,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center px-6 py-12 text-center",
        // Inside a table wider than a phone, centre on what is visible rather than on the full
        // scroll width, which would push the message and its button off the right edge.
        "[td_&]:sticky [td_&]:left-0 [td_&]:max-w-[calc(100vw-2.125rem)]",
        className,
      )}
      {...props}
    >
      {icon ? (
        <div className="mb-3 flex size-9 items-center justify-center rounded-sm border border-border bg-muted text-muted-foreground [&_svg]:size-4">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-pretty text-muted-foreground">{description}</p>
      ) : null}
      {action || secondaryAction ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}

import * as React from "react";

import { cn } from "@/lib/cn";

export interface PageHeaderProps {
  title: string;
  /** The section this page belongs to, set in small caps above the title. */
  eyebrow?: string;
  description?: string;
  breadcrumbs?: React.ReactNode;
  /** Status badges, period tags, record counts — anything that qualifies the title. */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  /** A <TabsList/> that hangs off the header rule. */
  tabs?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  eyebrow,
  description,
  breadcrumbs,
  meta,
  actions,
  tabs,
  className,
}: PageHeaderProps) {
  return (
    <header data-slot="page-header" className={cn("flex flex-col gap-3", className)}>
      {breadcrumbs}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? <p className="eyebrow mb-1">{eyebrow}</p> : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl leading-tight font-semibold tracking-tight text-balance text-foreground">
              {title}
            </h1>
            {meta}
          </div>
          {description ? (
            <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {tabs ?? <div className="rule-head" />}
    </header>
  );
}

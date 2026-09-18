import * as React from "react";

import { cn } from "@/lib/cn";

export interface DetailPaneProps extends Omit<React.ComponentPropsWithRef<"article">, "title"> {
  /** A 56px <Monogram size="lg"/> or an <IconBadge size="xl"/>. */
  leading?: React.ReactNode;
  /** The record's name: a payee, an invoice number. */
  title: React.ReactNode;
  /** The quiet line under the title: date · account. Pass items; they are joined with dots. */
  meta?: React.ReactNode[];
  /** The headline figure, right-aligned: a <Money/>. */
  amount?: React.ReactNode;
  /** A <Pill/> under the header ("Mixed use"). */
  status?: React.ReactNode;
  /** One primary button and at most one secondary. Everything else goes in the toolbar. */
  actions?: React.ReactNode;
  /** A <KeyLegend/> pinned to the bottom of the pane. */
  footer?: React.ReactNode;
}

/**
 * The selected item's detail: a header (monogram, title, meta, amount), then its facts as grouped
 * rows and a flow diagram (the children), then one primary action. On a desktop it sits beside the
 * list; on a phone put the same content in a <Sheet/> or its own page.
 */
export function DetailPane({
  leading,
  title,
  meta,
  amount,
  status,
  actions,
  footer,
  className,
  children,
  ...props
}: DetailPaneProps) {
  return (
    <article data-slot="detail-pane" className={cn("flex min-h-full min-w-0 flex-col", className)} {...props}>
      <div className="mx-auto flex w-full max-w-[780px] flex-col gap-4 px-10 pt-7 pb-6 max-lg:px-6 max-sm:px-0 max-sm:pt-2">
        <header className="flex items-center gap-4">
          {leading}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[1.625rem] leading-[1.15] font-bold tracking-[-0.024em] max-sm:line-clamp-2 max-sm:text-2xl max-sm:whitespace-normal">{title}</h2>
            {meta && meta.length > 0 ? <DetailMeta items={meta} /> : null}
          </div>
          {amount ? (
            <div className="num shrink-0 text-4xl font-bold tracking-[-0.03em] max-sm:text-2xl">{amount}</div>
          ) : null}
        </header>
        {status}
        {children}
        {actions ? <div className="mt-1 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {footer ? <div className="mt-auto">{footer}</div> : null}
    </article>
  );
}

/** "Aug 29, 2026 · [bank] Relay ••9726": items separated by a small dot. */
export function DetailMeta({ items, className }: { items: React.ReactNode[]; className?: string }) {
  return (
    <div className={cn("mt-[3px] flex flex-wrap items-center gap-1.5 text-sm font-medium text-label2", className)}>
      {items.map((item, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <span aria-hidden className="size-[3px] rounded-full bg-label3" /> : null}
          <span className="inline-flex items-center gap-1.5">{item}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

/**
 * The desktop split view: a master list pane and the detail beside it. The list scrolls with the
 * page; the detail stays in view (sticky under the toolbar). Below 1024px only the list shows —
 * open the detail in a <Sheet/> or a page.
 */
export function SplitView({
  list,
  detail,
  listWidth = 380,
  className,
}: {
  list: React.ReactNode;
  detail: React.ReactNode;
  listWidth?: number;
  className?: string;
}) {
  return (
    <div
      data-slot="split-view"
      className={cn("grid min-w-0 lg:grid-cols-[var(--list-w)_minmax(0,1fr)]", className)}
      style={{ "--list-w": `${listWidth}px` } as React.CSSProperties & { "--list-w": string }}
    >
      <div className="min-w-0 lg:hairline-r lg:bg-card">{list}</div>
      <div className="min-w-0 max-lg:hidden">
        <div className="sticky top-[60px] max-h-[calc(100dvh-60px)] overflow-y-auto">{detail}</div>
      </div>
    </div>
  );
}

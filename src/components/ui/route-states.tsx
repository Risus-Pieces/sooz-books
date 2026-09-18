import * as React from "react";

import { cn } from "@/lib/cn";

import { Glyph, type GlyphName } from "./glyph";
import { InfoButton } from "./info-button";
import { Skeleton } from "./skeleton";

/*
  Loading placeholders shaped like the Native Mac screens, for the App Router's loading.tsx files.
  Each keeps the page's rhythm (toolbar, cards, inset rows) so nothing jumps when the data arrives.
  They are decorative: the wrapper announces "Loading" once.
*/

function Loading({ label = "Loading", className, children }: { label?: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-label={label} aria-busy className={cn("flex flex-col gap-3.5 max-md:gap-3", className)}>
      {children}
    </div>
  );
}

/** The unified toolbar: a title on the left, a capsule of actions on the right. */
export function ToolbarSkeleton({ actions = 2, back = false }: { actions?: number; back?: boolean }) {
  return (
    <div className="-mx-5 flex h-[60px] items-center gap-3 px-5 max-md:-mx-4 max-md:h-auto max-md:px-4 max-md:pt-3 max-md:pb-2">
      {back ? <Skeleton className="h-4 w-16" /> : null}
      <Skeleton className="h-6 w-36 rounded-[8px] max-md:h-9 max-md:w-44" />
      <span className="flex-1" />
      {actions > 0 ? <Skeleton className="h-[34px] rounded-full max-md:h-11" style={{ width: actions * 36 + 8 }} /> : null}
    </div>
  );
}

/** Inset grouped rows: a monogram, a title and a secondary line, an amount and a quiet date. */
export function RowsSkeleton({
  rows = 6,
  header = true,
  leading = "monogram",
  className,
}: {
  rows?: number;
  header?: boolean;
  leading?: "monogram" | "badge" | "none";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      {header ? <Skeleton className="mx-4 mt-2 mb-2.5 h-3 w-20" /> : null}
      <div className="overflow-hidden rounded-[14px] bg-card shadow-card">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={cn("flex min-h-[58px] items-center gap-[11px] px-4 py-[9px]", i > 0 && "hairline-t")}>
            {leading === "monogram" ? <Skeleton className="size-9 shrink-0 rounded-full" /> : null}
            {leading === "badge" ? <Skeleton className="size-7 shrink-0 rounded-[7px]" /> : null}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-3 max-w-44" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
              <Skeleton className="h-2.5 w-24 opacity-70" />
            </div>
            <div className="flex flex-col items-end gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-2.5 w-10 opacity-70" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A card with a headline and a chart-shaped block. */
export function CardSkeleton({ className, chart = "h-40" }: { className?: string; chart?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4", className)}>
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="h-8 w-40 rounded-[8px]" />
      <Skeleton className={cn("w-full rounded-[10px] opacity-60", chart)} />
    </div>
  );
}

/** Any page: the toolbar, then a list. The default for a segment without its own shape. */
export function PageSkeleton() {
  return (
    <Loading>
      <ToolbarSkeleton />
      <RowsSkeleton rows={7} />
    </Loading>
  );
}

/** Home: the cash card and runway, four tiles, then In & out and Pending spend. */
export function DashboardSkeleton() {
  return (
    <Loading>
      <ToolbarSkeleton />
      <div className="grid gap-3.5 max-md:gap-3 md:grid-cols-2 lg:grid-cols-12">
        <CardSkeleton className="md:col-span-2 lg:col-span-8" chart="h-44" />
        <div className="flex flex-col items-center gap-4 rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:hidden lg:col-span-4">
          <Skeleton className="h-3.5 w-20 self-start" />
          <Skeleton className="size-[150px] rounded-full opacity-70" />
          <Skeleton className="h-16 w-full rounded-[11px]" />
        </div>
        {Array.from({ length: 4 }, (_, i) => (
          <CardSkeleton key={i} className="lg:col-span-3" chart="h-8" />
        ))}
        <CardSkeleton className="md:col-span-2 lg:col-span-8" chart="h-64" />
        <RowsSkeleton rows={6} header={false} leading="none" className="md:col-span-2 lg:col-span-4" />
      </div>
    </Loading>
  );
}

/** A master list beside a detail pane (Review, registers). Below 1024px, the list alone. */
export function SplitSkeleton() {
  return (
    <Loading>
      <ToolbarSkeleton actions={3} />
      <div className="grid min-w-0 lg:grid-cols-[380px_minmax(0,1fr)] lg:overflow-clip lg:rounded-2xl lg:shadow-card">
        <div className="min-w-0 lg:hairline-r lg:bg-card lg:p-1.5">
          <Skeleton className="mx-2.5 mt-2 mb-3 h-7 rounded-[8px] max-lg:mx-0" />
          <RowsSkeleton rows={8} className="lg:[&>div:last-child]:shadow-none" />
        </div>
        <div className="flex flex-col gap-4 px-10 pt-7 max-lg:hidden">
          <div className="flex items-center gap-4">
            <Skeleton className="size-14 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-6 w-44 rounded-[8px]" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="h-9 w-32 rounded-[8px]" />
          </div>
          <Skeleton className="h-[138px] rounded-[14px] bg-card shadow-card" />
          <Skeleton className="h-[72px] rounded-[14px] bg-card shadow-card" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-24 rounded-[9px]" />
            <Skeleton className="h-8 w-24 rounded-[9px]" />
          </div>
        </div>
      </div>
    </Loading>
  );
}

/** A report: its summary chart, then Numbers-style rows. */
export function ReportSkeleton() {
  return (
    <Loading>
      <ToolbarSkeleton actions={2} />
      <CardSkeleton chart="h-36" />
      <div className="overflow-hidden rounded-2xl bg-card shadow-card">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className={cn("flex h-9 items-center gap-4 px-5", i > 0 && "hairline-t", i === 0 && "h-10")}>
            <Skeleton
              className={cn("h-2.5", i % 5 === 0 ? "w-32" : "w-44")}
              style={{ marginLeft: i % 5 === 0 ? 0 : 16 }}
            />
            <span className="flex-1" />
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-2.5 w-16 max-sm:hidden" />
          </div>
        ))}
      </div>
    </Loading>
  );
}

/** One record (an entry, an invoice, a bill): its header, grouped facts, the flow, the lines. */
export function DocumentSkeleton() {
  return (
    <Loading>
      <ToolbarSkeleton back actions={2} />
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-full max-sm:size-11" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-6 w-48 rounded-[8px]" />
            <Skeleton className="h-3 w-36" />
          </div>
          <Skeleton className="h-8 w-28 rounded-[8px]" />
        </div>
        <div className="overflow-hidden rounded-[14px] bg-card shadow-card">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={cn("flex h-[46px] items-center justify-between px-4", i > 0 && "hairline-t")}>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-28" />
            </div>
          ))}
        </div>
        <div className="flex h-[74px] items-center gap-3 rounded-[14px] bg-card px-5 shadow-card">
          <Skeleton className="size-[22px] rounded-[6px]" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-px flex-1" />
          <Skeleton className="size-[22px] rounded-[6px]" />
          <Skeleton className="h-3 w-24" />
        </div>
        <RowsSkeleton rows={3} leading="none" />
      </div>
    </Loading>
  );
}

/** Settings: the pane list beside the chosen pane. */
export function SettingsSkeleton() {
  return (
    <Loading>
      <ToolbarSkeleton actions={0} />
      <div className="grid min-w-0 lg:grid-cols-[280px_minmax(0,1fr)] lg:overflow-clip lg:rounded-2xl lg:shadow-card">
        <div className="min-w-0 lg:hairline-r lg:bg-card lg:p-2.5">
          <RowsSkeleton rows={4} header={false} leading="badge" className="lg:[&>div]:shadow-none" />
        </div>
        <div className="flex flex-col gap-4 px-10 pt-7 max-lg:hidden">
          <div className="flex items-center gap-4">
            <Skeleton className="size-14 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-6 w-44 rounded-[8px]" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
          <RowsSkeleton rows={3} leading="none" />
        </div>
      </div>
    </Loading>
  );
}

/** The large glyph tile the full-screen states open with: a card-coloured rounded square. */
export function StateTile({ glyph, tone = "quiet" }: { glyph: GlyphName; tone?: "quiet" | "orange" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mb-5 grid size-[88px] place-items-center rounded-[22px] bg-card shadow-card max-md:size-20",
        tone === "orange" ? "text-tint-orange" : "text-label3",
      )}
    >
      <Glyph name={glyph} size={44} weight={1.5} />
    </span>
  );
}

/**
 * Nothing at this address. `code` shows the quiet status figure over the title (the app-wide 404);
 * `action` is the one way out.
 */
export function NotFoundState({
  title = "Not found",
  code,
  info,
  action,
  className,
}: {
  title?: string;
  code?: string;
  info?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-24 text-center max-md:py-16", className)}>
      <StateTile glyph="question" />
      {code ? <p className="num text-2xs font-semibold tracking-[0.08em] text-label2">{code}</p> : null}
      <div className="mt-1 flex items-center gap-1">
        <h1 className="text-2xl font-bold tracking-[-0.022em]">{title}</h1>
        {info ? (
          <InfoButton label="More information" align="center">
            {info}
          </InfoButton>
        ) : null}
      </div>
      {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { FilterDisclosure } from "@/components/ui/filter-disclosure";
import { inputBase } from "@/components/ui/input";
import { cn } from "@/lib/cn";

export type MarginGroupKey = "product" | "channel" | "product_channel";

export interface MarginToolbarProps {
  path: string;
  from: string;
  to: string;
  groupBy: MarginGroupKey;
  presets: ReadonlyArray<{ key: string; label: string; from: string; to: string }>;
}

const GROUPS: ReadonlyArray<{ value: MarginGroupKey; label: string }> = [
  { value: "product", label: "Product" },
  { value: "channel", label: "Channel" },
  { value: "product_channel", label: "Product × channel" },
];

function href(path: string, from: string, to: string, by: MarginGroupKey): string {
  return `${path}?${new URLSearchParams({ from, to, by }).toString()}`;
}

/**
 * The margin report's controls. A GET form like every report toolbar: the whole
 * state is in the URL, so a view can be bookmarked or sent to the accountant.
 */
export function MarginToolbar({ path, from, to, groupBy, presets }: MarginToolbarProps) {
  const apply = React.useCallback((event: React.SyntheticEvent<HTMLElement>) => {
    event.currentTarget.closest("form")?.requestSubmit();
  }, []);

  const activePreset = presets.find((preset) => preset.from === from && preset.to === to);
  const groupLabel = GROUPS.find((g) => g.value === groupBy)?.label ?? "";
  const summary = `${activePreset ? activePreset.label : `${from} to ${to}`} · by ${groupLabel.toLowerCase()}`;
  const labelClass = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

  return (
    <form method="get" action={path} className="rounded-md border border-border bg-surface p-3 shadow-raised">
      <FilterDisclosure summary={summary} contentClassName="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {presets.map((preset) => {
            const active = preset.from === from && preset.to === to;
            return (
              <Button
                key={preset.key}
                asChild
                size="sm"
                variant={active ? "secondary" : "ghost"}
                className={active ? "border-border-strong" : undefined}
              >
                <Link href={href(path, preset.from, preset.to, groupBy)}>{preset.label}</Link>
              </Button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={labelClass}>From</span>
            <input
              type="date"
              name="from"
              defaultValue={from}
              onChange={apply}
              className={cn(inputBase, "num w-full tracking-normal sm:w-[9.5rem]")}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={labelClass}>To</span>
            <input
              type="date"
              name="to"
              defaultValue={to}
              onChange={apply}
              className={cn(inputBase, "num w-full tracking-normal sm:w-[9.5rem]")}
            />
          </label>
          <input type="hidden" name="by" value={groupBy} />
          <div className="col-span-2 flex flex-col gap-1.5">
            <span className={labelClass}>Margin by</span>
            <div className="flex rounded-sm border border-border-strong bg-surface-raised p-0.5 sm:inline-flex">
              {GROUPS.map((g) => (
                <Link
                  key={g.value}
                  href={href(path, from, to, g.value)}
                  aria-current={g.value === groupBy ? "page" : undefined}
                  className={cn(
                    "inline-flex h-6.5 flex-1 items-center justify-center rounded-xs px-2.5 text-xs font-medium whitespace-nowrap transition-colors max-sm:h-9 sm:flex-none",
                    g.value === groupBy
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {g.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="col-span-2 pb-0.5 sm:ml-auto">
            <Button type="submit" size="sm" variant="secondary">
              Apply
            </Button>
          </div>
        </div>
      </FilterDisclosure>
    </form>
  );
}

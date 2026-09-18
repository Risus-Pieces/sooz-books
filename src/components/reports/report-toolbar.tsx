"use client";

import * as React from "react";
import Link from "next/link";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { inputBase } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import type { ColumnMode, ReportRequest } from "@/lib/reports/types";

import { FilterDisclosure } from "@/components/ui/filter-disclosure";

import { CopyReportButton } from "./copy-report-button";

export interface PresetLink {
  key: string;
  label: string;
  href: string;
  active: boolean;
}

export interface ChannelOption {
  id: string;
  name: string;
}

export interface ReportToolbarProps {
  /** The page the form submits back to. */
  action: string;
  request: ReportRequest;
  presets: readonly PresetLink[];
  channels: readonly ChannelOption[];
  /** Column modes this report understands. The control is hidden when there is only one. */
  columnModes?: readonly ColumnMode[];
  showCompare?: boolean;
  showPercent?: boolean;
  exportHref: string;
  /** Enables "Copy", which fetches the report as TSV and puts it on the clipboard. */
  copyHref?: string;
  children?: React.ReactNode;
}

const COLUMN_LABELS: Record<ColumnMode, string> = {
  total: "Single total",
  months: "Month by month",
  quarters: "Quarter by quarter",
  channels: "By channel",
};

const selectClass = cn(inputBase, "w-full min-w-[9rem] pr-8 sm:w-auto");

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</span>
      {children}
    </label>
  );
}

/**
 * The controls above every statement.
 *
 * It is a plain GET form, so the whole report state lives in the URL: a
 * bookkeeper can bookmark "last month, cash basis, by channel" and send the link
 * to their accountant. With JavaScript each control applies as it changes; with
 * it switched off the Apply button does the same thing, because a report that
 * needs a bundle to change its date range is not a report.
 */
export function ReportToolbar({
  action,
  request,
  presets,
  channels,
  columnModes = ["total", "months", "quarters", "channels"],
  showCompare = true,
  showPercent = false,
  exportHref,
  copyHref,
  children,
}: ReportToolbarProps) {
  const apply = React.useCallback((event: React.SyntheticEvent<HTMLElement>) => {
    const form = event.currentTarget.closest("form");
    form?.requestSubmit();
  }, []);

  // The dates already sit in the page header's badge, so the folded summary names the rest.
  const summary = [
    request.basis === "cash" ? "Cash basis" : "Accrual basis",
    columnModes.length > 1 ? COLUMN_LABELS[request.columns] : null,
    showCompare && request.compareTo !== undefined ? "compared" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const compareValue =
    request.compareTo === undefined
      ? "none"
      : typeof request.compareTo === "string"
        ? request.compareTo
        : "custom";

  return (
    <form
      method="get"
      action={action}
      className="rounded-md border border-border bg-surface p-3 shadow-raised"
    >
      <FilterDisclosure summary={summary} contentClassName="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {presets.map((preset) => (
            <Button
              key={preset.key}
              asChild
              size="sm"
              variant={preset.active ? "secondary" : "ghost"}
              className={preset.active ? "border-border-strong" : undefined}
            >
              <Link href={preset.href}>{preset.label}</Link>
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
          <Field label="From">
            <input
              type="date"
              name="from"
              defaultValue={request.from}
              onChange={apply}
              className={cn(inputBase, "num w-full tracking-normal sm:w-[9.5rem]")}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              name="to"
              defaultValue={request.to}
              onChange={apply}
              className={cn(inputBase, "num w-full tracking-normal sm:w-[9.5rem]")}
            />
          </Field>

          <Field label="Basis">
            <select name="basis" defaultValue={request.basis} onChange={apply} className={selectClass}>
              <option value="accrual">Accrual</option>
              <option value="cash">Cash</option>
            </select>
          </Field>

          {columnModes.length > 1 ? (
            <Field label="Columns">
              <select
                name="columns"
                defaultValue={request.columns}
                onChange={apply}
                className={selectClass}
              >
                {columnModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {COLUMN_LABELS[mode]}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <input type="hidden" name="columns" value={request.columns} />
          )}

          {showCompare ? (
            <Field label="Compare">
              <select
                name="compare"
                defaultValue={compareValue}
                onChange={apply}
                className={selectClass}
              >
                <option value="none">No comparison</option>
                <option value="prior_period">Prior period</option>
                <option value="prior_year">Prior year</option>
                {compareValue === "custom" ? <option value="custom">Custom</option> : null}
              </select>
            </Field>
          ) : null}

          {typeof request.compareTo === "object" ? (
            <>
              <input type="hidden" name="compare_from" value={request.compareTo.from} />
              <input type="hidden" name="compare_to" value={request.compareTo.to} />
            </>
          ) : null}

          {channels.length > 0 ? (
            <Field label="Channel">
              <select
                name="channel"
                defaultValue={request.channelIds?.[0] ?? ""}
                onChange={apply}
                className={selectClass}
              >
                <option value="">All channels</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <div className="col-span-2 flex flex-wrap items-center gap-4 pb-1.5">
            {showPercent ? (
              <label className="flex items-center gap-1.5 text-xs text-foreground max-sm:min-h-10">
                <input
                  type="checkbox"
                  name="pct"
                  value="1"
                  defaultChecked={request.percentOfNetSales === true}
                  onChange={apply}
                  className="size-3.5 accent-[var(--color-primary)]"
                />
                % of net sales
              </label>
            ) : null}
            <label className="flex items-center gap-1.5 text-xs text-foreground max-sm:min-h-10">
              <input
                type="checkbox"
                name="zeros"
                value="1"
                defaultChecked={request.includeZeroRows}
                onChange={apply}
                className="size-3.5 accent-[var(--color-primary)]"
              />
              Show zero rows
            </label>
          </div>

          {children}

          <div className="col-span-2 flex flex-wrap items-end gap-2 pb-0.5 sm:ml-auto">
            <Button type="submit" size="sm" variant="secondary">
              Apply
            </Button>
            {copyHref ? <CopyReportButton href={copyHref} /> : null}
            <Button asChild size="sm" variant="secondary">
              <a href={exportHref}>
                <Download aria-hidden />
                Export CSV
              </a>
            </Button>
          </div>
        </div>
      </FilterDisclosure>
    </form>
  );
}

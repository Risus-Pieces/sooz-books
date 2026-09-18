"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Glyph } from "@/components/ui/glyph";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { PopUpButton } from "@/components/ui/pop-up-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import type { ColumnMode, ReportRequest } from "@/lib/reports/types";

export interface PresetLink {
  key: string;
  label: string;
  from: string;
  to: string;
  active: boolean;
}

export interface ChannelOption {
  id: string;
  name: string;
}

export interface ReportToolbarProps {
  request: ReportRequest;
  presets: readonly PresetLink[];
  channels: readonly ChannelOption[];
  /** Column modes this report understands. The control is hidden when there is only one. */
  columnModes?: readonly ColumnMode[];
  showCompare?: boolean;
  showPercent?: boolean;
  /** Report-specific controls (the register's account and source), drawn after the rest. */
  children?: React.ReactNode;
}

const COLUMN_LABELS: Record<ColumnMode, string> = {
  total: "Total",
  months: "By month",
  quarters: "By quarter",
  channels: "By channel",
};

const CUSTOM = "custom";
const ALL = "all";

/**
 * Moves the report to a new request by rewriting the URL. Every control on the report goes
 * through here, so the whole report state stays in the URL: "last month, cash basis, by channel"
 * is a link a bookkeeper can bookmark or send to the accountant.
 */
export function useReportParams(): {
  set: (updates: Readonly<Record<string, string | null>>) => void;
  pending: boolean;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = React.useTransition();

  const set = React.useCallback(
    (updates: Readonly<Record<string, string | null>>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      startTransition(() => {
        router.push(`${pathname}?${next.toString()}`, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  return { set, pending };
}

function shortRange(from: string, to: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const part = (date: string) => `${months[Number(date.slice(5, 7)) - 1] ?? "—"} ${Number(date.slice(8, 10))}`;
  return `${part(from)} – ${part(to)}`;
}

/**
 * The controls above every statement, as native controls: a date-range pop-up, the basis as a
 * segmented control, pop-ups for columns, comparison and channel, and a menu of options. On a
 * phone they fold behind one Filters button.
 */
export function ReportToolbar({
  request,
  presets,
  channels,
  columnModes = ["total", "months", "quarters", "channels"],
  showCompare = true,
  showPercent = false,
  children,
}: ReportToolbarProps) {
  const { set, pending } = useReportParams();
  const activePreset = presets.find((preset) => preset.active);
  const [customOpen, setCustomOpen] = React.useState(activePreset === undefined);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const rangeValue = customOpen || activePreset === undefined ? CUSTOM : activePreset.key;

  const compareValue =
    request.compareTo === undefined
      ? "none"
      : typeof request.compareTo === "string"
        ? request.compareTo
        : CUSTOM;

  const range = (
    <PopUpButton
      aria-label="Date range"
      value={rangeValue}
      onValueChange={(value) => {
        if (value === CUSTOM) {
          setCustomOpen(true);
          return;
        }
        const preset = presets.find((p) => p.key === value);
        if (preset === undefined) return;
        setCustomOpen(false);
        set({ from: preset.from, to: preset.to });
      }}
      options={[
        ...presets.map((preset) => ({ value: preset.key, label: preset.label })),
        { value: CUSTOM, label: rangeValue === CUSTOM ? shortRange(request.from, request.to) : "Custom…" },
      ]}
    />
  );

  const dates =
    rangeValue === CUSTOM ? (
      <span className="flex items-center gap-1.5">
        <DateInput
          aria-label="From"
          defaultValue={request.from}
          onValueChange={(value) => (value === "" ? undefined : set({ from: value }))}
          className="h-[26px] w-[8.5rem] max-sm:h-11"
        />
        <span className="text-label2">–</span>
        <DateInput
          aria-label="To"
          defaultValue={request.to}
          onValueChange={(value) => (value === "" ? undefined : set({ to: value }))}
          className="h-[26px] w-[8.5rem] max-sm:h-11"
        />
      </span>
    ) : null;

  const basis = (
    <SegmentedControl
      aria-label="Basis"
      value={request.basis}
      onValueChange={(value) => set({ basis: value })}
      options={[
        { value: "accrual", label: "Accrual" },
        { value: "cash", label: "Cash" },
      ]}
    />
  );

  const columns =
    columnModes.length > 1 ? (
      <PopUpButton
        aria-label="Columns"
        value={request.columns}
        onValueChange={(value) => set({ columns: value })}
        options={columnModes.map((mode) => ({ value: mode, label: COLUMN_LABELS[mode] }))}
      />
    ) : null;

  const compare = showCompare ? (
    <PopUpButton
      aria-label="Compare"
      value={compareValue}
      onValueChange={(value) =>
        set(
          value === "none"
            ? { compare: null, compare_from: null, compare_to: null }
            : { compare: value, compare_from: null, compare_to: null },
        )
      }
      options={[
        { value: "none", label: "No comparison" },
        { value: "prior_period", label: "Prior period" },
        { value: "prior_year", label: "Prior year" },
        ...(compareValue === CUSTOM ? [{ value: CUSTOM, label: "Custom" }] : []),
      ]}
    />
  ) : null;

  const channel =
    channels.length > 0 ? (
      <PopUpButton
        aria-label="Channel"
        value={request.channelIds?.[0] ?? ALL}
        onValueChange={(value) => set({ channel: value === ALL ? null : value })}
        options={[{ value: ALL, label: "All channels" }, ...channels.map((c) => ({ value: c.id, label: c.name }))]}
      />
    ) : null;

  const optionsMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="View options"
        className="grid h-[26px] w-8 place-items-center rounded-[7px] bg-ctl text-label2 shadow-ctl hover:text-label data-[state=open]:text-ink-blue max-sm:h-11 max-sm:w-11"
      >
        <Glyph name="ellipsis" size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {showPercent ? (
          <DropdownMenuCheckboxItem
            checked={request.percentOfNetSales === true}
            onCheckedChange={(checked) => set({ pct: checked ? "1" : null })}
          >
            % of net sales
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuCheckboxItem
          checked={request.includeZeroRows}
          onCheckedChange={(checked) => set({ zeros: checked ? "1" : null })}
        >
          Zero rows
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const summary = [
    rangeValue === CUSTOM ? shortRange(request.from, request.to) : activePreset?.label,
    request.basis === "cash" ? "Cash" : "Accrual",
    columnModes.length > 1 && request.columns !== "total" ? COLUMN_LABELS[request.columns] : null,
    showCompare && request.compareTo !== undefined ? "Compared" : null,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" · ");

  return (
    <>
      {/* Desktop and tablet: one bar of native controls. */}
      <div
        role="group"
        aria-label="Report options"
        className={cn(
          "flex flex-wrap items-center gap-2 text-sm max-sm:hidden",
          pending && "opacity-70 transition-opacity",
        )}
      >
        {range}
        {dates}
        {basis}
        {columns}
        {compare}
        {channel}
        {/* The report's own controls and the ⋯ menu wrap as one, so the menu never sits alone on a row. */}
        <div className="flex flex-1 items-center gap-2">
          {children}
          <span className="ml-auto" />
          {optionsMenu}
        </div>
      </div>

      {/* Phone: the same controls behind one button. */}
      <div className="flex items-center gap-2 sm:hidden">
        <Button variant="secondary" className="min-w-0 flex-1 justify-start" onClick={() => setSheetOpen(true)}>
          <Glyph name="filter" size={16} />
          <span className="truncate">{summary}</span>
        </Button>
        {optionsMenu}
      </div>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent title="Filters" width="sm" className="sm:hidden">
          <InsetGroup header="Dates">
            <GroupRow label="Range">{range}</GroupRow>
            {dates ? <div className="flex justify-end px-4 py-2">{dates}</div> : null}
          </InsetGroup>
          <InsetGroup header="View">
            <GroupRow label="Basis">{basis}</GroupRow>
            {columns ? <GroupRow label="Columns">{columns}</GroupRow> : null}
            {compare ? <GroupRow label="Compare">{compare}</GroupRow> : null}
            {channel ? <GroupRow label="Channel">{channel}</GroupRow> : null}
          </InsetGroup>
          {children ? (
            <InsetGroup header="Register">
              <div className="flex flex-col gap-2 px-4 py-3 [&>*]:w-full">{children}</div>
            </InsetGroup>
          ) : null}
          <div className="mt-4 flex justify-end">
            <Button onClick={() => setSheetOpen(false)}>Done</Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

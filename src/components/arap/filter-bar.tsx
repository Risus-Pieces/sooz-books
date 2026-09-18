import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { inputBase } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchField } from "@/components/ui/search-field";
import { ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";
import { shortDate } from "@/lib/ui/format";

interface PartyFilter {
  name: string;
  label: string;
  value: string;
  options: readonly { id: string; name: string }[];
}

export interface RegisterFilterProps {
  action: string;
  status: string;
  party: PartyFilter;
  from: string;
  to: string;
  q: string;
}

/** Hidden fields that carry the other filters through a GET form. */
function Carry({ keep }: { keep: Record<string, string> }) {
  return (
    <>
      {Object.entries(keep).map(([name, value]) =>
        value !== "" && !(name === "status" && value === "all") ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
    </>
  );
}

/**
 * The register's search, in the toolbar. A plain GET form: every filter lands in the URL, so a
 * narrowed list can be bookmarked or linked, and the page works before any JavaScript arrives.
 */
export function RegisterSearch({ action, status, party, from, to, q }: RegisterFilterProps) {
  return (
    <form method="get" action={action} role="search" className="max-md:w-full">
      <Carry keep={{ status, [party.name]: party.value, from, to }} />
      <SearchField appearance="toolbar" name="q" defaultValue={q} aria-label="Search number, PO or name" />
    </form>
  );
}

/** Who and when: a toolbar button that opens the party and date filters. */
export function RegisterFilter({ action, status, party, from, to, q }: RegisterFilterProps) {
  const active = party.value !== "" || from !== "" || to !== "";
  return (
    <Popover>
      <ToolbarGroup>
        <PopoverTrigger asChild>
          <ToolbarButton glyph="filter" label="Filter" tone={active ? "accent" : "default"} />
        </PopoverTrigger>
      </ToolbarGroup>
      <PopoverContent align="end" className="w-72 p-3">
        <form method="get" action={action} className="flex flex-col gap-3">
          <Carry keep={{ status, q }} />
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {party.label}
            <select name={party.name} defaultValue={party.value} className={cn(inputBase, "pr-8")}>
              <option value="">Everyone</option>
              {party.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              From
              <input type="date" name="from" defaultValue={from} className={cn(inputBase, "num")} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              To
              <input type="date" name="to" defaultValue={to} className={cn(inputBase, "num")} />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            {active ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={hrefWith(action, { status, q }, "q", q)}>Clear</Link>
              </Button>
            ) : null}
            <Button type="submit" size="sm">
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** The filters in force, as removable capsules under the toolbar. */
export function ActiveFilters({ action, status, party, from, to, q }: RegisterFilterProps) {
  const current: Record<string, string> = { status, [party.name]: party.value, from, to, q };
  const partyName = party.options.find((o) => o.id === party.value)?.name;
  const chips: { key: string; label: string }[] = [];
  if (partyName) chips.push({ key: party.name, label: partyName });
  if (from) chips.push({ key: "from", label: `From ${shortDate(from)}` });
  if (to) chips.push({ key: "to", label: `To ${shortDate(to)}` });
  if (q) chips.push({ key: "q", label: `“${q}”` });
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={hrefWith(action, current, chip.key, "")}
          aria-label={`Remove filter ${chip.label}`}
          className="inline-flex h-[26px] items-center gap-1 rounded-full bg-tint-blue/12 pr-2 pl-2.5 text-xs font-semibold text-ink-blue transition-colors hover:bg-tint-blue/18 max-sm:h-9"
        >
          {chip.label}
          <Glyph name="xmark" size={11} weight={2.4} />
        </Link>
      ))}
    </div>
  );
}

/** Rebuilds a register URL with one parameter changed, keeping the rest. */
export function hrefWith(base: string, current: Record<string, string>, key: string, value: string): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, [key]: value })) {
    if (v !== "" && !(k === "status" && v === "all")) params.set(k, v);
  }
  const query = params.toString();
  return query === "" ? base : `${base}?${query}`;
}

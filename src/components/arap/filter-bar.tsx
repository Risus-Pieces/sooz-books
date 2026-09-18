import * as React from "react";
import Link from "next/link";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { inputBase } from "@/components/ui/input";
import { cn } from "@/lib/cn";

/**
 * Register filters as a plain GET form: every filter lands in the URL, so a
 * narrowed list can be bookmarked or linked from an aging row, and the page
 * works before any JavaScript arrives.
 */
export function FilterBar({
  action,
  status,
  party,
  from,
  to,
  q,
}: {
  action: string;
  status: string;
  party: { name: string; label: string; value: string; options: readonly { id: string; name: string }[] };
  from: string;
  to: string;
  q: string;
}) {
  const active = party.value !== "" || from !== "" || to !== "" || q !== "";
  return (
    <form method="get" action={action} className="flex flex-wrap items-end gap-2 border-b border-border px-3 py-2.5">
      {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
      <label className="flex flex-col gap-1">
        <span className="eyebrow">{party.label}</span>
        <select name={party.name} defaultValue={party.value} className={cn(inputBase, "w-auto max-w-56 min-w-40 pr-8")}>
          <option value="">Everyone</option>
          {party.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="eyebrow">From</span>
        <input type="date" name="from" defaultValue={from} className={cn(inputBase, "num w-[9.5rem]")} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="eyebrow">To</span>
        <input type="date" name="to" defaultValue={to} className={cn(inputBase, "num w-[9.5rem]")} />
      </label>
      <label className="flex min-w-40 flex-1 flex-col gap-1 sm:max-w-64">
        <span className="eyebrow">Number, PO or name</span>
        <span className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input type="search" name="q" defaultValue={q} className={cn(inputBase, "pl-7")} />
        </span>
      </label>
      <Button type="submit" variant="secondary" size="md">
        Filter
      </Button>
      {active ? (
        <Button asChild variant="ghost" size="md">
          <Link href={status === "all" ? action : `${action}?status=${status}`}>Clear</Link>
        </Button>
      ) : null}
    </form>
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

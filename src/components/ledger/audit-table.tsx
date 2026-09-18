"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Input } from "@/components/ui/input";
import { PopUpButton } from "@/components/ui/pop-up-button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ToolbarButton } from "@/components/ui/toolbar";

import { tableLabel } from "./audit-timeline";
import type { ActorOption, AuditFilters } from "./types";

const ANY = "any";

const EMPTY_AUDIT_FILTERS: AuditFilters = { table: "", op: "", actorId: "", from: "", to: "", q: "" };

/**
 * The audit trail's filters behind one toolbar button: table, operation, who, when and what,
 * written into the URL on Apply.
 */
export function AuditFilterButton({
  filters,
  tables,
  actors,
}: {
  filters: AuditFilters;
  tables: readonly string[];
  actors: readonly ActorOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<AuditFilters>(filters);

  const set = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const apply = (next: AuditFilters) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) {
      if (value !== "") params.set(key, value);
    }
    const query = params.toString();
    setOpen(false);
    router.push(query === "" ? pathname : `${pathname}?${query}`);
  };

  const count = Object.values(filters).filter((value) => value !== "").length;

  return (
    <>
      <ToolbarButton
        glyph="filter"
        label={count > 0 ? `Filters (${count})` : "Filters"}
        tone={count > 0 ? "accent" : "default"}
        onClick={() => {
          setDraft(filters);
          setOpen(true);
        }}
      />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent title="Filters" width="sm">
          <form
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              apply(draft);
            }}
          >
            <InsetGroup header="What">
              <GroupRow label="Table">
                <PopUpButton
                  aria-label="Table"
                  value={draft.table === "" ? ANY : draft.table}
                  onValueChange={(value) => set("table", value === ANY ? "" : value)}
                  options={[{ value: ANY, label: "Any" }, ...tables.map((t) => ({ value: t, label: tableLabel(t) }))]}
                />
              </GroupRow>
              <GroupRow label="Change">
                <PopUpButton
                  aria-label="Operation"
                  value={draft.op === "" ? ANY : draft.op}
                  onValueChange={(value) => set("op", value === ANY ? "" : value)}
                  options={[
                    { value: ANY, label: "Any" },
                    { value: "INSERT", label: "Added", tint: "green" },
                    { value: "UPDATE", label: "Changed", tint: "blue" },
                    { value: "DELETE", label: "Deleted", tint: "red" },
                  ]}
                />
              </GroupRow>
              <GroupRow label="Who">
                <PopUpButton
                  aria-label="Actor"
                  value={draft.actorId === "" ? ANY : draft.actorId}
                  onValueChange={(value) => set("actorId", value === ANY ? "" : value)}
                  options={[{ value: ANY, label: "Anyone" }, ...actors.map((a) => ({ value: a.id, label: a.label }))]}
                />
              </GroupRow>
            </InsetGroup>

            <InsetGroup header="When">
              <GroupRow label="From" htmlFor="audit-from">
                <DateInput id="audit-from" value={draft.from} onValueChange={(value) => set("from", value)} />
              </GroupRow>
              <GroupRow label="To" htmlFor="audit-to">
                <DateInput id="audit-to" value={draft.to} onValueChange={(value) => set("to", value)} />
              </GroupRow>
            </InsetGroup>

            <InsetGroup header="Value">
              <GroupRow label="Contains" htmlFor="audit-q">
                <Input
                  id="audit-q"
                  placeholder="Search"
                  className="w-48 max-sm:w-44"
                  value={draft.q}
                  onChange={(event) => set("q", event.target.value)}
                />
              </GroupRow>
            </InsetGroup>

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => apply(EMPTY_AUDIT_FILTERS)}>
                Clear
              </Button>
              <Button type="submit">Apply</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}

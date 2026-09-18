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

import { AccountCombobox } from "./account-combobox";
import { EMPTY_JOURNAL_FILTERS, journalQuery } from "./journal-query";
import { sourceLabel, type AccountOption, type JournalFilters } from "./types";

const ANY = "any";

/**
 * The journal's filters, behind one toolbar button: a sheet of grouped rows that writes itself
 * into the URL on Apply, so a narrowed register can be bookmarked or sent to the accountant.
 */
export function JournalFilterButton({
  filters,
  accounts,
  sourceTypes,
}: {
  filters: JournalFilters;
  accounts: readonly AccountOption[];
  sourceTypes: readonly string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<JournalFilters>(filters);

  const set = <K extends keyof JournalFilters>(key: K, value: JournalFilters[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const apply = (next: JournalFilters) => {
    const query = journalQuery(next);
    setOpen(false);
    router.push(query === "" ? pathname : `${pathname}?${query}`);
  };

  const count = Object.entries(filters).filter(([key, value]) => key !== "q" && value !== "").length;

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
            <InsetGroup header="Dates">
              <GroupRow label="From" htmlFor="journal-from">
                <DateInput id="journal-from" value={draft.from} onValueChange={(value) => set("from", value)} />
              </GroupRow>
              <GroupRow label="To" htmlFor="journal-to">
                <DateInput id="journal-to" value={draft.to} onValueChange={(value) => set("to", value)} />
              </GroupRow>
            </InsetGroup>

            <InsetGroup header="Entry">
              <GroupRow label="Status">
                <PopUpButton
                  aria-label="Status"
                  value={draft.status === "" ? ANY : draft.status}
                  onValueChange={(value) => set("status", value === ANY ? "" : value)}
                  options={[
                    { value: ANY, label: "Any" },
                    { value: "posted", label: "Posted" },
                    { value: "draft", label: "Draft" },
                  ]}
                />
              </GroupRow>
              <GroupRow label="Source">
                <PopUpButton
                  aria-label="Source"
                  value={draft.sourceType === "" ? ANY : draft.sourceType}
                  onValueChange={(value) => set("sourceType", value === ANY ? "" : value)}
                  options={[
                    { value: ANY, label: "Any" },
                    ...sourceTypes.map((source) => ({ value: source, label: sourceLabel(source) })),
                  ]}
                />
              </GroupRow>
              <GroupRow label="Account">
                <AccountCombobox
                  accounts={accounts}
                  value={draft.accountId === "" ? null : draft.accountId}
                  placeholder="Any"
                  className="w-48 max-sm:w-44"
                  onChange={(accountId) => set("accountId", accountId)}
                />
              </GroupRow>
            </InsetGroup>

            <InsetGroup header="Amount">
              <GroupRow label="At least" htmlFor="journal-min">
                <Input
                  id="journal-min"
                  numeric
                  inputMode="decimal"
                  placeholder="0.00"
                  className="w-32"
                  value={draft.minAmount}
                  onChange={(event) => set("minAmount", event.target.value)}
                />
              </GroupRow>
              <GroupRow label="At most" htmlFor="journal-max">
                <Input
                  id="journal-max"
                  numeric
                  inputMode="decimal"
                  placeholder="0.00"
                  className="w-32"
                  value={draft.maxAmount}
                  onChange={(event) => set("maxAmount", event.target.value)}
                />
              </GroupRow>
            </InsetGroup>

            <InsetGroup header="Memo">
              <GroupRow label="Contains" htmlFor="journal-q">
                <Input
                  id="journal-q"
                  placeholder="Search"
                  className="w-48 max-sm:w-44"
                  value={draft.q}
                  onChange={(event) => set("q", event.target.value)}
                />
              </GroupRow>
            </InsetGroup>

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => apply(EMPTY_JOURNAL_FILTERS)}>
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

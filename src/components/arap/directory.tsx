"use client";

import * as React from "react";

import { SplitView } from "@/components/ui/detail-pane";
import { InsetGroup, ListRow, type ListRowProps } from "@/components/ui/inset-group";
import { SearchField } from "@/components/ui/search-field";
import { Sheet, SheetContent } from "@/components/ui/sheet";

export interface DirectoryEntry {
  id: string;
  name: string;
  active: boolean;
}

type RowParts = Pick<ListRowProps, "leading" | "subtitle" | "trailing" | "detail">;

/** "Blacksmith Coffee" → "B"; digits and symbols share "#", as Contacts does. */
function letterOf(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : "#";
}

function sections<T extends DirectoryEntry>(rows: readonly T[]): { key: string; rows: T[] }[] {
  const out: { key: string; rows: T[] }[] = [];
  const inactive = rows.filter((r) => !r.active);
  for (const row of rows.filter((r) => r.active)) {
    const key = letterOf(row.name);
    const last = out[out.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else out.push({ key, rows: [row] });
  }
  if (inactive.length > 0) out.push({ key: "Inactive", rows: inactive });
  return out;
}

/**
 * Customers or vendors as Contacts does them: a searchable list in letter sections beside the
 * selected one's card. On a phone the card rises as a sheet when a row is tapped.
 */
export function Directory<T extends DirectoryEntry>({
  rows,
  selectedId,
  onSelect,
  row,
  detail,
  sheetActions,
  above,
  filter,
  noMatch,
}: {
  rows: readonly T[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  row: (entry: T) => RowParts;
  /** The selected entry's detail pane. */
  detail: React.ReactNode;
  /** Buttons for the phone sheet's title bar (Edit). */
  sheetActions?: React.ReactNode;
  /** Above the list, under the search: a segmented filter. */
  above?: React.ReactNode;
  /** An extra filter besides the name search. */
  filter?: (entry: T) => boolean;
  noMatch: string;
}) {
  const [query, setQuery] = React.useState("");
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((r) => r.name.toLowerCase().includes(needle) && (filter ? filter(r) : true));
  const groups = sections(shown);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const choose = (id: string) => {
    onSelect(id);
    if (!window.matchMedia("(min-width: 1024px)").matches) setSheetOpen(true);
  };

  const list = (desktop: boolean) => (
    <div className={desktop ? "flex flex-col gap-2 px-1.5 pt-2.5 pb-2" : "flex flex-col gap-2"}>
      <div className={desktop ? "flex flex-col gap-2 px-1" : "flex flex-col gap-2"}>
        <SearchField value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search by name" />
        {above}
      </div>
      {groups.length === 0 ? (
        <p className="px-3 py-10 text-center text-sm text-label2">{noMatch}</p>
      ) : (
        groups.map((g) => (
          <InsetGroup key={g.key} variant={desktop ? "plain" : "inset"} header={g.key} separatorInset={desktop ? 57 : 63}>
            {g.rows.map((entry) => (
              <ListRow
                key={entry.id}
                onClick={() => choose(entry.id)}
                selected={desktop && entry.id === selectedId}
                chevron={!desktop}
                title={entry.name}
                {...row(entry)}
              />
            ))}
          </InsetGroup>
        ))
      )}
    </div>
  );

  return (
    <>
      <div className="max-lg:hidden">
        <SplitView listWidth={360} className="overflow-clip rounded-2xl bg-bg shadow-card" list={list(true)} detail={detail} />
      </div>
      <div className="lg:hidden">{list(false)}</div>
      <Sheet open={sheetOpen && selected !== null} onOpenChange={setSheetOpen}>
        <SheetContent title={selected?.name ?? ""} hideTitle actions={sheetActions} className="lg:hidden">
          {detail}
        </SheetContent>
      </Sheet>
    </>
  );
}

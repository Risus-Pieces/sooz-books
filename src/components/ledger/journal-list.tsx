import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { SplitView } from "@/components/ui/detail-pane";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { Dot, IconBadge } from "@/components/ui/icon-badge";
import { InsetGroup, ListRow } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { categoryForCode } from "@/lib/ui/categories";
import { monthLong, shortDate } from "@/lib/ui/format";

import { DetailSheet } from "./detail-sheet";
import { EntryPreview } from "./entry-preview";
import { journalQuery } from "./journal-query";
import type { JournalFilters, JournalLineRow, JournalRow } from "./types";
import { leadAccount, shortAccountName, sourceVisual } from "./visuals";

export interface JournalListProps {
  rows: readonly JournalRow[];
  /** The lines of every row on this page, so choosing one costs no round trip. */
  lines: Readonly<Record<string, JournalLineRow[]>>;
  filters: JournalFilters;
  page: number;
  pageSize: number;
  total: number;
  /** Sum of debits over every entry the filter matches, not just this page. */
  totalDebitCents: number;
  /** The entry the URL names, if any. */
  selectedId: string | null;
  canPost: boolean;
  /** The year the books are in: month headers of other years carry theirs. */
  currentYear: number;
}

interface MonthGroup {
  key: string;
  label: string;
  rows: JournalRow[];
}

function byMonth(rows: readonly JournalRow[], currentYear: number): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const row of rows) {
    const key = row.date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.rows.push(row);
      continue;
    }
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7));
    groups.push({ key, label: year === currentYear ? monthLong(month) : `${monthLong(month)} ${year}`, rows: [row] });
  }
  return groups;
}

/**
 * The journal register as a grouped list: one row per entry under its month, the chosen entry's
 * flow and lines beside it on a desktop, in a sheet on a phone. Filtering and paging stay on the
 * server, in the URL.
 */
export function JournalList({
  rows,
  lines,
  filters,
  page,
  pageSize,
  total,
  totalDebitCents,
  selectedId,
  canPost,
  currentYear,
}: JournalListProps) {
  const active = Object.values(filters).some((value) => value !== "");
  const pageExtra: Record<string, string> = page > 1 ? { page: String(page) } : {};
  const hrefFor = (id: string) => `/ledger?${journalQuery(filters, { ...pageExtra, entry: id })}`;
  const closeQuery = journalQuery(filters, pageExtra);
  const closeHref = closeQuery === "" ? "/ledger" : `/ledger?${closeQuery}`;

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl bg-card shadow-card max-sm:rounded-[22px]">
        <EmptyState
          glyph={active ? "filter" : "book"}
          title={active ? "No matching entries" : "No entries yet"}
          description={
            active
              ? "Widen the date range or clear a filter."
              : "Bank lines post here once they are approved in review, as do bills, invoices and payouts. Write an entry by hand for anything else."
          }
          action={
            active ? (
              <Button asChild variant="secondary">
                <Link href="/ledger">Clear filters</Link>
              </Button>
            ) : canPost ? (
              <Button asChild>
                <Link href="/ledger/new">New entry</Link>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  // A desktop always shows one entry beside the list; a phone only when one was chosen.
  const shown = rows.find((row) => row.id === selectedId) ?? rows[0];
  const groups = byMonth(rows, currentYear);

  const row = (entry: JournalRow, variant: "plain" | "inset") => {
    const entryLines = lines[entry.id] ?? [];
    const lead = leadAccount(entryLines);
    const category = lead ? categoryForCode(lead.accountCode) : null;
    const source = sourceVisual(entry.sourceType);
    return (
      <ListRow
        key={entry.id}
        href={hrefFor(entry.id)}
        selected={variant === "plain" && entry.id === shown.id}
        leading={<IconBadge glyph={source.glyph} tint={source.tint} size={variant === "plain" ? "lg" : "xl"} />}
        title={entry.memo ?? source.label}
        trailing={<Money cents={entry.debitCents} currency plain />}
        subtitle={
          <>
            <span className="num">#{entry.entryNo}</span>
            {category && lead ? (
              <>
                <Dot tint={category.tint} size={7} />
                <span className="truncate">{shortAccountName(lead.accountName)}</span>
              </>
            ) : null}
            {entry.status === "draft" ? <Glyph name="pencil" size={12} className="text-ink-orange" label="Draft" /> : null}
            {entry.reversedByEntryNo !== null ? <Glyph name="undo" size={12} label="Reversed" /> : null}
          </>
        }
        detail={shortDate(entry.date)}
      />
    );
  };

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);
  const pageHref = (target: number) => {
    const query = journalQuery(filters, target > 1 ? { page: String(target) } : {});
    return query === "" ? "/ledger" : `/ledger?${query}`;
  };

  const footer = (
    <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-label2">
      <span className="num">
        {firstRow}–{lastRow} of {total} · <Money cents={totalDebitCents} currency plain />
      </span>
      {lastPage > 1 ? (
        <span className="flex items-center gap-1.5">
          <Button asChild variant="secondary" size="sm">
            <Link href={pageHref(Math.max(1, page - 1))} aria-label="Previous page" aria-disabled={page <= 1} className={page <= 1 ? "pointer-events-none opacity-45" : undefined}>
              <Glyph name="chevron-left" size={13} />
            </Link>
          </Button>
          <span className="num">
            {page} / {lastPage}
          </span>
          <Button asChild variant="secondary" size="sm">
            <Link href={pageHref(Math.min(lastPage, page + 1))} aria-label="Next page" aria-disabled={page >= lastPage} className={page >= lastPage ? "pointer-events-none opacity-45" : undefined}>
              <Glyph name="chevron-right" size={13} />
            </Link>
          </Button>
        </span>
      ) : null}
    </div>
  );

  const preview = <EntryPreview row={shown} lines={lines[shown.id] ?? []} canPost={canPost} />;

  return (
    <>
      {/* Desktop: the list pane and the entry beside it. */}
      <SplitView
        className="overflow-clip rounded-2xl bg-bg shadow-card max-lg:hidden"
        listWidth={400}
        list={
          <div className="px-1.5 pb-2">
            {groups.map((group) => (
              <InsetGroup key={group.key} variant="plain" header={group.label} separatorInset={48}>
                {group.rows.map((entry) => row(entry, "plain"))}
              </InsetGroup>
            ))}
            {footer}
          </div>
        }
        detail={preview}
      />

      {/* Phone and tablet: inset groups; a chosen entry rises in a sheet. */}
      <div className="flex flex-col lg:hidden">
        {groups.map((group) => (
          <InsetGroup key={group.key} header={group.label} separatorInset={63} className="first:[&>div:first-child]:pt-1">
            {group.rows.map((entry) => row(entry, "inset"))}
          </InsetGroup>
        ))}
        {footer}
        <DetailSheet selected={selectedId !== null} closeHref={closeHref} title={shown.memo ?? `Entry #${shown.entryNo}`}>
          {preview}
        </DetailSheet>
      </div>
    </>
  );
}

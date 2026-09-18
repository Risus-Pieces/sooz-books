import * as React from "react";
import Link from "next/link";

import { FlowDiagram } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DetailPane } from "@/components/ui/detail-pane";
import { Glyph } from "@/components/ui/glyph";
import { CategoryBadge, IconBadge } from "@/components/ui/icon-badge";
import { InsetGroup } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { categoryForCode } from "@/lib/ui/categories";
import { mediumDate } from "@/lib/ui/format";

import type { JournalLineRow, JournalRow } from "./types";
import { entryFlow, shortAccountName, sourceVisual } from "./visuals";

/** Posted, draft, reversed: the entry's state as one capsule. */
export function EntryStatusPill({
  status,
  reversedByEntryNo,
  reversesEntryNo,
}: {
  status: "draft" | "posted";
  reversedByEntryNo: number | null;
  reversesEntryNo: number | null;
}) {
  if (status === "draft") return <Pill tone="orange" glyph="pencil">Draft</Pill>;
  if (reversedByEntryNo !== null) return <Pill tone="neutral" glyph="undo">Reversed by #{reversedByEntryNo}</Pill>;
  if (reversesEntryNo !== null) return <Pill tone="orange" glyph="undo">Reverses #{reversesEntryNo}</Pill>;
  return <Pill tone="green" glyph="check">Posted</Pill>;
}

/** The lines of an entry as grouped rows: category badge, account, and the amount on its side. */
export function EntryLineList({ lines }: { lines: readonly JournalLineRow[] }) {
  if (lines.length === 0) {
    return (
      <InsetGroup header="Lines">
        <p className="px-4 py-3 text-sm text-label2">No lines</p>
      </InsetGroup>
    );
  }
  return (
    <InsetGroup header="Lines" separatorInset={50}>
      {lines.map((line) => {
        const category = categoryForCode(line.accountCode);
        const debit = line.debitCents > 0;
        return (
          <div
            key={line.id}
            className="relative flex min-h-11 items-center gap-3 px-4 py-2 before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[50px] before:border-t-[0.5px] before:border-sep first:before:hidden"
          >
            <CategoryBadge category={category} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium max-sm:text-lg">{shortAccountName(line.accountName)}</p>
              <p className="truncate text-xs text-label2 max-sm:text-sm">
                <span className="num">{line.accountCode}</span>
                {line.memo ? ` · ${line.memo}` : null}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <Money
                cents={debit ? line.debitCents : line.creditCents}
                currency
                plain
                className="text-sm font-semibold max-sm:text-lg"
              />
              <p className="text-2xs font-medium text-label2 max-sm:text-xs">{debit ? "Debit" : "Credit"}</p>
            </div>
          </div>
        );
      })}
    </InsetGroup>
  );
}

/** What posting did (or will do), on a card. Nothing when the entry has no amounts yet. */
export function EntryFlowCard({ lines }: { lines: readonly JournalLineRow[] }) {
  const flow = entryFlow(lines);
  if (flow === null) return null;
  return (
    <Card className="px-5 py-[18px] max-sm:px-4">
      <FlowDiagram from={flow.from} to={flow.to} />
    </Card>
  );
}

/**
 * One journal entry in the detail pane (desktop) or the sheet (phone): what it is, what it moved,
 * and the way into the full entry.
 */
export function EntryPreview({
  row,
  lines,
  canPost,
}: {
  row: JournalRow;
  lines: readonly JournalLineRow[];
  canPost: boolean;
}) {
  const source = sourceVisual(row.sourceType);
  return (
    <DetailPane
      leading={<IconBadge glyph={source.glyph} tint={source.tint} size="xl" className="max-sm:hidden" />}
      title={row.memo ?? `Entry #${row.entryNo}`}
      meta={[mediumDate(row.date), <span key="no" className="num">#{row.entryNo}</span>, source.label]}
      amount={<Money cents={row.debitCents} currency plain />}
      status={
        <EntryStatusPill
          status={row.status}
          reversedByEntryNo={row.reversedByEntryNo}
          reversesEntryNo={row.reversesEntryNo}
        />
      }
      actions={
        <>
          <Button asChild>
            <Link href={`/ledger/${row.id}`}>
              <Glyph name={row.status === "draft" ? "pencil" : "doc-text"} size={15} />
              {row.status === "draft" ? "Edit draft" : "Open entry"}
            </Link>
          </Button>
          {canPost ? (
            <Button asChild variant="secondary">
              <Link href={`/ledger/new?from=${row.id}`}>
                <Glyph name="plus" size={15} />
                Duplicate
              </Link>
            </Button>
          ) : null}
        </>
      }
    >
      <EntryFlowCard lines={lines} />
      <EntryLineList lines={lines} />
    </DetailPane>
  );
}

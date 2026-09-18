import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { CategoryBadge, IconBadge } from "@/components/ui/icon-badge";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { categoryForCode } from "@/lib/ui/categories";
import { mediumDate } from "@/lib/ui/format";

import { AuditTimeline } from "./audit-timeline";
import { EntryFlowCard, EntryStatusPill } from "./entry-preview";
import { SOURCE_ROUTES, type AuditEntryRow, type EntryDetailRow, type JournalLineRow } from "./types";
import { shortAccountName, sourceVisual } from "./visuals";

export interface EntryDetailProps {
  entry: EntryDetailRow;
  lines: readonly JournalLineRow[];
  /** Every audit row touching this entry or its lines, newest first. */
  audit: readonly AuditEntryRow[];
}

/**
 * A posted entry as the ledger holds it: what it moved, the lines, who put them there, and what
 * has happened to it since. Nothing here changes the entry — the one correction the ledger
 * supports, a reversal, lives in the toolbar.
 */
export function EntryDetail({ entry, lines, audit }: EntryDetailProps) {
  const debitCents = lines.reduce((sum, line) => sum + line.debitCents, 0);
  const creditCents = lines.reduce((sum, line) => sum + line.creditCents, 0);
  const source = sourceVisual(entry.sourceType);
  const sourceRoute = SOURCE_ROUTES[entry.sourceType];

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <Card className="flex items-center gap-4 px-5 py-4 max-sm:flex-wrap max-sm:px-4">
        <IconBadge glyph={source.glyph} tint={source.tint} size="xl" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-bold tracking-[-0.02em] max-sm:whitespace-normal">
            {entry.memo ?? "No memo"}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-medium text-label2">
            {mediumDate(entry.date)}
            <span aria-hidden className="size-[3px] rounded-full bg-label3" />
            {source.label}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 max-sm:w-full max-sm:flex-row max-sm:items-center max-sm:justify-between">
          <Money cents={debitCents} currency plain className="text-3xl font-bold tracking-[-0.03em] max-sm:order-last max-sm:text-2xl" />
          <EntryStatusPill
            status={entry.status}
            reversedByEntryNo={entry.reversedByEntryNo}
            reversesEntryNo={entry.reversesEntryNo}
          />
        </div>
      </Card>

      <div className="grid items-stretch gap-3.5 max-md:gap-3 lg:grid-cols-[minmax(0,1fr)_320px] [&>section:first-child]:flex [&>section:first-child]:items-center">
        <EntryFlowCard lines={lines} />
        <InsetGroup className="min-w-0">
          <GroupRow label="Entry">
            <span className="num text-label">#{entry.entryNo}</span>
          </GroupRow>
          <GroupRow label="Date">
            <span className="num">{entry.date}</span>
          </GroupRow>
          {entry.sourceType !== "manual" && sourceRoute !== undefined ? (
            <GroupRow label="Source" href={entry.sourceId === null ? sourceRoute : `${sourceRoute}/${entry.sourceId}`}>
              <span className="text-ink-blue">{source.label}</span>
            </GroupRow>
          ) : (
            <GroupRow label="Source">{source.label}</GroupRow>
          )}
          <GroupRow label="Created">
            <Stamp at={entry.createdAtLabel} by={entry.createdByLabel} />
          </GroupRow>
          <GroupRow label="Posted">
            {entry.postedAtLabel === null ? "Not posted" : <Stamp at={entry.postedAtLabel} by={entry.postedByLabel} />}
          </GroupRow>
          {entry.reversesId !== null ? (
            <GroupRow label="Reverses" href={`/ledger/${entry.reversesId}`}>
              <span className="num text-ink-blue">#{entry.reversesEntryNo}</span>
            </GroupRow>
          ) : null}
          {entry.reversedById !== null ? (
            <GroupRow label="Reversed by" href={`/ledger/${entry.reversedById}`}>
              <span className="num text-ink-blue">#{entry.reversedByEntryNo}</span>
            </GroupRow>
          ) : null}
        </InsetGroup>
      </div>

      <Card className="min-w-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Lines of entry {entry.entryNo}</caption>
              <thead>
                <tr>
                  <Th className="pl-5">Account</Th>
                  <Th className="max-md:hidden">Memo</Th>
                  <Th className="max-lg:hidden">Channel</Th>
                  <Th className="max-lg:hidden">Product</Th>
                  <Th className="w-28 text-right">Debit</Th>
                  <Th className="w-28 pr-5 text-right">Credit</Th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="align-middle hover:bg-fill2/60">
                    <Td className="w-full max-w-0 pl-5">
                      <Link
                        href={`/ledger?accountId=${line.accountId}`}
                        className="flex min-w-0 items-center gap-2.5 rounded-[6px] hover:text-ink-blue"
                      >
                        <CategoryBadge category={categoryForCode(line.accountCode)} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{shortAccountName(line.accountName)}</span>
                          <span className="num block text-xs text-label2">{line.accountCode}</span>
                        </span>
                      </Link>
                    </Td>
                    <Td className="max-w-[320px] truncate text-label2 max-md:hidden">
                      <span title={line.memo ?? undefined}>{line.memo ?? ""}</span>
                    </Td>
                    <Td className="text-label2 max-lg:hidden">{line.channelCode ?? ""}</Td>
                    <Td className="num text-label2 max-lg:hidden">{line.productSku ?? ""}</Td>
                    <Td className="text-right">
                      <Money cents={line.debitCents} plain zeroDash className={line.debitCents === 0 ? "text-label2" : undefined} />
                    </Td>
                    <Td className="pr-5 text-right">
                      <Money cents={line.creditCents} plain zeroDash className={line.creditCents === 0 ? "text-label2" : undefined} />
                    </Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="rule-subtotal px-3 py-2.5 pl-5 text-xs font-semibold text-label2">Total</td>
                  <td className="rule-subtotal max-md:hidden" />
                  <td colSpan={2} className="rule-subtotal max-lg:hidden" />
                  <td className="rule-subtotal px-3 py-2.5 text-right font-bold">
                    <Money cents={debitCents} plain />
                  </td>
                  <td className="rule-subtotal px-3 py-2.5 pr-5 text-right font-bold">
                    <Money cents={creditCents} plain />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>

      <section aria-label="History">
        <h2 className="flex items-center gap-2 px-1 pt-2 text-lg font-semibold tracking-[-0.01em]">
          <Glyph name="clock" size={17} className="text-label2" />
          History
        </h2>
        {audit.length === 0 ? (
          <p className="px-1 pt-2 text-sm text-label2">Nothing recorded</p>
        ) : (
          <AuditTimeline rows={audit} showTable={false} />
        )}
      </section>
    </div>
  );
}

function Stamp({ at, by }: { at: string; by: string | null }) {
  return (
    <span className="flex flex-col items-end text-right leading-tight">
      <span className="text-xs text-label">{at}</span>
      {by === null ? null : <span className="text-xs text-label2">{by}</span>}
    </span>
  );
}

function Th({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th scope="col" className={cn("rule-head px-3 pt-3 pb-1.5 text-left text-xs font-semibold text-label2", className)}>
      {children}
    </th>
  );
}

function Td({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={cn("rule-row px-3 py-2 align-middle", className)}>{children}</td>;
}

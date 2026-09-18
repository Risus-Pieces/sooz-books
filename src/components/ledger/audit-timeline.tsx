import * as React from "react";
import Link from "next/link";

import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { cn } from "@/lib/cn";

import { AuditDiff, auditChanges, auditFieldLabel } from "./audit-diff";
import type { AuditEntryRow } from "./types";

const OP: Record<AuditEntryRow["op"], { glyph: GlyphName; verb: string; dot: string }> = {
  INSERT: { glyph: "plus", verb: "added", dot: "bg-tint-green" },
  UPDATE: { glyph: "pencil", verb: "changed", dot: "bg-tint-blue" },
  DELETE: { glyph: "trash", verb: "deleted", dot: "bg-tint-red" },
};

const TABLES: Readonly<Record<string, string>> = {
  journal_entries: "Entry",
  journal_lines: "Line",
  accounts: "Account",
  periods: "Period",
  bank_transactions: "Bank line",
  bank_accounts: "Bank account",
  invoices: "Invoice",
  invoice_lines: "Invoice line",
  bills: "Bill",
  bill_lines: "Bill line",
  payments: "Payment",
  customers: "Customer",
  vendors: "Vendor",
  close_checklists: "Close",
  close_tasks: "Close task",
  reconciliations: "Reconciliation",
  cogs_batches: "COGS batch",
  cogs_batch_lines: "COGS batch line",
};

export function tableLabel(table: string): string {
  const known = TABLES[table];
  if (known !== undefined) return known;
  const words = table
    .replace(/ies$/, "y")
    .replace(/(ch|sh|x|ss)es$/, "$1")
    .replace(/s$/, "")
    .replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Sep 15, 2026, 3:04 PM" → ["Sep 15, 2026", "3:04 PM"]: the day, then the time. */
function splitStamp(label: string): [string, string] {
  const at = label.lastIndexOf(", ");
  if (at === -1) return [label, ""];
  return [label.slice(0, at), label.slice(at + 2)];
}

/**
 * The audit trail as a timeline: one dot per write, coloured by what happened, grouped by day.
 * The fields that changed fold under each event.
 */
export function AuditTimeline({
  rows,
  showTable = true,
  openFirst = false,
}: {
  rows: readonly AuditEntryRow[];
  /** Links an entry's writes to the entry (the trail page); off on the entry's own page. */
  showTable?: boolean;
  openFirst?: boolean;
}) {
  // One event per write; a burst of identical writes (twelve lines added in one posting) reads
  // as one event with a count, its diffs folded inside.
  const days: Array<{ day: string; rows: AuditEntryRow[][] }> = [];
  for (const row of rows) {
    const [day] = splitStamp(row.atLabel);
    let group = days[days.length - 1];
    if (!group || group.day !== day) {
      group = { day, rows: [] };
      days.push(group);
    }
    const burst = group.rows[group.rows.length - 1];
    const head = burst?.[0];
    if (
      head &&
      head.tableName === row.tableName &&
      head.op === row.op &&
      head.atLabel === row.atLabel &&
      head.actorLabel === row.actorLabel &&
      row.tableName !== "journal_entries"
    ) {
      burst.push(row);
    } else {
      group.rows.push([row]);
    }
  }

  return (
    <div className="flex flex-col">
      {days.map((group, groupIndex) => (
        <section key={`${group.day}-${groupIndex}`} aria-label={group.day}>
          <h3 className="px-4 pt-5 pb-1.5 text-sm font-semibold text-label2 max-sm:px-1">{group.day}</h3>
          <ol className="rounded-[14px] bg-card px-4 py-1 shadow-card max-sm:px-3">
            {group.rows.map((burst, index) => {
              const row = burst[0];
              const op = OP[row.op];
              const changes = auditChanges(row.op, row.before, row.after);
              const [, time] = splitStamp(row.atLabel);
              const last = index === group.rows.length - 1;
              return (
                <li key={row.id} className="relative flex gap-3 py-2.5">
                  {last ? null : (
                    <span aria-hidden className="absolute top-[38px] bottom-[-6px] left-[13px] w-px bg-sep" />
                  )}
                  <span className={cn("relative z-[1] mt-0.5 grid size-[27px] shrink-0 place-items-center rounded-full text-white", op.dot)}>
                    <Glyph name={op.glyph} size={13} weight={2.2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <p className="text-sm font-semibold">
                        {tableLabel(row.tableName)} {op.verb}
                        {burst.length > 1 ? <span className="num ml-1 font-medium text-label2">×{burst.length}</span> : null}
                      </p>
                      {showTable && row.tableName === "journal_entries" ? (
                        <Link href={`/ledger/${row.rowId}`} className="text-xs font-medium text-ink-blue hover:underline">
                          Open entry
                        </Link>
                      ) : null}
                      <span className="ml-auto text-xs text-label2">{time}</span>
                    </div>
                    <p className="text-xs text-label2">{row.actorLabel ?? "System"}</p>
                    {changes.length === 0 ? null : (
                      <details className="group/diff mt-1" open={openFirst && groupIndex === 0 && index === 0}>
                        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-[6px] text-xs font-medium text-label2 hover:text-label [&::-webkit-details-marker]:hidden">
                          <Glyph name="chevron-right" size={10} weight={2.4} className="transition-transform group-open/diff:rotate-90" />
                          {burst.length > 1
                            ? `${burst.length} rows`
                            : changes.length === 1
                              ? auditFieldLabel(changes[0].key)
                              : `${changes.length} fields`}
                        </summary>
                        {burst.map((item) => (
                          <AuditDiff
                            key={item.id}
                            op={item.op}
                            before={item.before}
                            after={item.after}
                            className="mt-1.5 rounded-[10px] bg-inset px-3 py-2"
                          />
                        ))}
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

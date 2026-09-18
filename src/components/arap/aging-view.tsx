"use client";

import * as React from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { shortDate } from "@/lib/ui/format";

import { AgingBar, BUCKET_META } from "./aging-bar";
import { BUCKETS, type AgingBuckets, type AgingPartyView } from "./types";

const KIND_LABEL: Record<string, string> = {
  invoice: "Invoice",
  receipt: "Unapplied payment",
  credit_memo: "Credit memo",
  deduction: "Deduction",
  bill: "Bill",
  bill_payment: "Prepayment",
  vendor_credit: "Vendor credit",
};

const KIND_ROUTE: Record<string, string> = {
  invoice: "/sales/invoices",
  receipt: "/sales/receipts",
  bill: "/purchases/bills",
  bill_payment: "/purchases/payments",
};

const cell = "px-3 py-2.5 text-right align-middle first:pl-5 last:pr-5 max-sm:first:pl-4 max-sm:last:pr-4";

/**
 * An aging schedule, Numbers-style: one row per party with its money drawn as a bar split by age,
 * then the five buckets and the total. Each row opens to the documents behind it. Credits and
 * unapplied money sit in Current as negatives — they are owed against, not overdue.
 */
export function AgingView({
  parties,
  totals,
  partyLabel,
  partyHrefBase,
}: {
  parties: readonly AgingPartyView[];
  totals: AgingBuckets;
  partyLabel: string;
  /** The party's register, to which its id is appended. */
  partyHrefBase: string;
}) {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const allOpen = parties.length > 0 && parties.every((p) => open.has(p.partyId));

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-5 pt-3 pb-1 max-sm:px-4">
        <h2 className="text-lg font-semibold tracking-[-0.01em]">By {partyLabel.toLowerCase()}</h2>
        <Button variant="ghost" size="sm" className="max-md:hidden" onClick={() => setOpen(allOpen ? new Set() : new Set(parties.map((p) => p.partyId)))}>
          <Glyph name={allOpen ? "chevron-up" : "chevron-down"} size={13} weight={2.2} />
          {allOpen ? "Collapse" : "Expand all"}
        </Button>
      </div>
      <ul className="md:hidden">
        {parties.map((party) => (
          <li key={party.partyId} className="relative before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-sep first:before:hidden">
            <Link href={`${partyHrefBase}${party.partyId}`} className="flex min-h-14 flex-col justify-center gap-1.5 px-4 py-2.5">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-lg">{party.partyName}</span>
                <Money cents={party.buckets.total} currency plain className="text-lg font-semibold" />
              </span>
              <AgingBar buckets={party.buckets} thin />
            </Link>
          </li>
        ))}
        <li className="flex items-baseline justify-between hairline-t px-4 py-3 font-bold">
          <span>Total</span>
          <Money cents={totals.total} currency plain />
        </li>
      </ul>
      <div className="relative overflow-x-auto max-md:hidden">
        <table className="w-full min-w-[50rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{partyLabel} aging</caption>
          <thead>
            <tr>
              <th scope="col" className="rule-head bg-card py-2 pr-3 pl-5 text-left text-xs font-semibold text-label2 max-sm:pl-4">
                {partyLabel}
              </th>
              {BUCKETS.map((bucket) => (
                <th key={bucket} scope="col" className="rule-head bg-card px-3 py-2 text-right text-xs font-semibold whitespace-nowrap text-label2">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="size-2 rounded-[2.5px]" style={{ background: `var(--${BUCKET_META[bucket].tint})` }} />
                    {BUCKET_META[bucket].label}
                  </span>
                </th>
              ))}
              <th scope="col" className="rule-head bg-card py-2 pr-5 pl-3 text-right text-xs font-semibold text-label max-sm:pr-4">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {parties.map((party) => {
              const expanded = open.has(party.partyId);
              return (
                <React.Fragment key={party.partyId}>
                  <tr className="group transition-colors hover:bg-fill2">
                    <td className="rule-row py-2 pr-3 pl-5 max-sm:pl-4">
                      <button
                        type="button"
                        onClick={() => toggle(party.partyId)}
                        aria-expanded={expanded}
                        className="flex w-full min-w-44 flex-col gap-1.5 rounded-[6px] text-left outline-none focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--blue)_45%,transparent)]"
                      >
                        <span className="inline-flex items-center gap-1.5 font-semibold">
                          <Glyph
                            name="chevron-right"
                            size={11}
                            weight={2.4}
                            className={cn("shrink-0 text-label3 transition-transform duration-150", expanded && "rotate-90")}
                          />
                          {party.partyName}
                          <span className="text-xs font-medium text-label2">{party.items.length}</span>
                        </span>
                        <AgingBar buckets={party.buckets} thin className="ml-[17px] max-w-56" />
                      </button>
                    </td>
                    {BUCKETS.map((bucket) => (
                      <td key={bucket} className={cn("rule-row", cell)}>
                        <Money
                          cents={party.buckets[bucket]}
                          zeroDash
                          plain
                          className={cn(
                            party.buckets[bucket] === 0 && "text-label3",
                            bucket !== "current" && party.buckets[bucket] > 0 && "font-semibold text-ink-orange",
                            party.buckets[bucket] < 0 && "text-ink-green",
                          )}
                        />
                      </td>
                    ))}
                    <td className={cn("rule-row font-semibold", cell)}>
                      <Money cents={party.buckets.total} plain />
                    </td>
                  </tr>
                  {expanded
                    ? party.items.map((item) => {
                        const route = KIND_ROUTE[item.kind];
                        return (
                          <tr key={`${item.kind}-${item.id}`} className="bg-inset/60 text-xs">
                            <td className="rule-row py-2 pr-3 pl-10 max-sm:pl-9">
                              <span className="text-label2">{KIND_LABEL[item.kind] ?? item.kind}</span>{" "}
                              {route ? (
                                <Link href={`${route}/${item.id}`} className="num font-medium text-ink-blue hover:underline">
                                  {item.docNo}
                                </Link>
                              ) : (
                                <span className="num">{item.docNo}</span>
                              )}
                              <span className="num ml-2 text-label2">
                                {item.dueDate ? `due ${shortDate(item.dueDate)}` : shortDate(item.docDate)}
                              </span>
                              {item.daysPastDue !== null && item.daysPastDue > 0 ? (
                                <Badge tone="negative" size="sm" className="ml-2">
                                  {item.daysPastDue}d
                                </Badge>
                              ) : null}
                            </td>
                            {BUCKETS.map((bucket) => (
                              <td key={bucket} className={cn("rule-row", cell, "py-2")}>
                                {item.bucket === bucket ? <Money cents={item.balanceCents} plain /> : null}
                              </td>
                            ))}
                            <td className={cn("rule-row", cell, "py-2")} />
                          </tr>
                        );
                      })
                    : null}
                  {expanded ? (
                    <tr className="bg-inset/60">
                      <td colSpan={7} className="rule-row py-2 pr-5 pl-10 text-xs max-sm:pl-9">
                        <Link href={`${partyHrefBase}${party.partyId}`} className="font-medium text-ink-blue hover:underline">
                          All of {party.partyName}&rsquo;s documents
                        </Link>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="py-2.5 pr-3 pl-5 font-bold max-sm:pl-4">Total</td>
              {BUCKETS.map((bucket) => (
                <td key={bucket} className={cn(cell, "font-bold")}>
                  <Money cents={totals[bucket]} zeroDash plain />
                </td>
              ))}
              <td className={cn(cell, "font-bold")}>
                <Money cents={totals.total} currency plain />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

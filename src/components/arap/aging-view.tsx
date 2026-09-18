"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import { BUCKETS, type AgingBuckets, type AgingPartyView, type Bucket } from "./types";

const BUCKET_LABELS: Record<Bucket, string> = {
  current: "Current",
  days1to30: "1–30",
  days31to60: "31–60",
  days61to90: "61–90",
  over90: "Over 90",
};

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

/**
 * An aging schedule: one row per party across the five buckets, each
 * expandable to the documents behind it. Credits and unapplied money sit in
 * the Current column as negatives — they are owed against, not overdue.
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
      <div className="flex justify-end px-3 pt-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(allOpen ? new Set() : new Set(parties.map((p) => p.partyId)))}
        >
          {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
          {allOpen ? "Collapse all" : "Show every document"}
        </Button>
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[48rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{partyLabel} aging</caption>
          <thead>
            <tr>
              <th scope="col" className="rule-head bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                {partyLabel}
              </th>
              {BUCKETS.map((bucket) => (
                <th
                  key={bucket}
                  scope="col"
                  className="rule-head bg-surface-sunken px-3 py-1.5 text-right text-2xs font-semibold tracking-wider whitespace-nowrap text-muted-foreground uppercase"
                >
                  {BUCKET_LABELS[bucket]}
                </th>
              ))}
              <th scope="col" className="rule-head rule-gutter bg-surface-sunken px-3 py-1.5 text-right text-2xs font-semibold tracking-wider text-foreground uppercase">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {parties.map((party) => {
              const expanded = open.has(party.partyId);
              return (
                <React.Fragment key={party.partyId}>
                  <tr className="group hover:bg-muted/60">
                    <td className="rule-row px-3 py-1.5">
                      <button
                        type="button"
                        onClick={() => toggle(party.partyId)}
                        aria-expanded={expanded}
                        className="inline-flex items-center gap-1.5 text-left font-medium"
                      >
                        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")} />
                        {party.partyName}
                        <span className="num text-2xs font-normal text-muted-foreground">{party.items.length}</span>
                      </button>
                    </td>
                    {BUCKETS.map((bucket) => (
                      <td key={bucket} className="rule-row px-3 py-1.5 text-right">
                        <Money cents={party.buckets[bucket]} zeroDash className={cn(bucket !== "current" && party.buckets[bucket] > 0 && "text-warning")} />
                      </td>
                    ))}
                    <td className="rule-row rule-gutter px-3 py-1.5 text-right font-semibold">
                      <Money cents={party.buckets.total} />
                    </td>
                  </tr>
                  {expanded
                    ? party.items.map((item) => {
                        const route = KIND_ROUTE[item.kind];
                        return (
                          <tr key={`${item.kind}-${item.id}`} className="bg-surface-sunken/40 text-xs">
                            <td className="rule-row py-1 pr-3 pl-9">
                              <span className="text-muted-foreground">{KIND_LABEL[item.kind] ?? item.kind}</span>{" "}
                              {route ? (
                                <Link href={`${route}/${item.id}`} className="num text-primary hover:underline">
                                  {item.docNo}
                                </Link>
                              ) : (
                                <span className="num">{item.docNo}</span>
                              )}
                              <span className="num ml-2 text-muted-foreground">
                                {item.dueDate ? `due ${item.dueDate}` : item.docDate}
                              </span>
                              {item.daysPastDue !== null && item.daysPastDue > 0 ? (
                                <Badge tone="negative" size="sm" className="ml-2">
                                  {item.daysPastDue}d
                                </Badge>
                              ) : null}
                            </td>
                            {BUCKETS.map((bucket) => (
                              <td key={bucket} className="rule-row px-3 py-1 text-right">
                                {item.bucket === bucket ? <Money cents={item.balanceCents} /> : null}
                              </td>
                            ))}
                            <td className="rule-row rule-gutter px-3 py-1 text-right" />
                          </tr>
                        );
                      })
                    : null}
                  {expanded ? (
                    <tr>
                      <td colSpan={7} className="rule-row px-3 py-1 pl-9 text-xs">
                        <Link href={`${partyHrefBase}${party.partyId}`} className="text-primary hover:underline">
                          Open {party.partyName}&rsquo;s documents
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
              <td className="rule-subtotal rule-total px-3 py-1.5 font-semibold">Total</td>
              {BUCKETS.map((bucket) => (
                <td key={bucket} className="rule-subtotal rule-total px-3 py-1.5 text-right font-semibold">
                  <Money cents={totals[bucket]} zeroDash />
                </td>
              ))}
              <td className="rule-subtotal rule-total rule-gutter px-3 py-1.5 text-right font-semibold">
                <Money cents={totals.total} currency />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

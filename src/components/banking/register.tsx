"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, FilterX, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/cn";

import { InCell, OutCell, Th } from "./parts";
import { monthLabel, payeeOf, shortDate } from "./review-logic";
import type { EntrySummary, QueueRow, QueueStage, RegisterRowView } from "./types";

const ANY = "__any__";

const STAGE_CHIP: Record<QueueStage, { label: string; tone: "warning" | "info" | "positive" | "neutral" }> = {
  review: { label: "To review", tone: "warning" },
  ready: { label: "Ready", tone: "info" },
  posted: { label: "Posted", tone: "positive" },
  excluded: { label: "Excluded", tone: "neutral" },
};

function statusChip(row: QueueRow) {
  if (row.reconciled) return <Badge tone="primary">Reconciled</Badge>;
  if (row.status === "transfer" && row.stage !== "posted") return <Badge tone="info">Transfer</Badge>;
  const chip = STAGE_CHIP[row.stage];
  return <Badge tone={chip.tone}>{chip.label}</Badge>;
}

export interface RegisterFilters {
  month: string;
  stage: QueueStage | "";
  q: string;
}

export function Register({
  rows,
  entries,
  filters,
  months,
  total,
}: {
  rows: readonly RegisterRowView[];
  entries: Readonly<Record<string, EntrySummary>>;
  filters: RegisterFilters;
  months: readonly string[];
  /** Rows on the account before filtering. */
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = React.useState(filters.q);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());

  const apply = (patch: Partial<RegisterFilters>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === "" || value === undefined) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.push(query === "" ? pathname : `${pathname}?${query}`);
  };

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const active = filters.month !== "" || filters.stage !== "" || filters.q !== "";

  return (
    <Card>
      <form
        className="flex flex-wrap items-end gap-2 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          apply({ q: q.trim() });
        }}
      >
        <div className="relative min-w-0 flex-[1_1_14rem]">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search payee, reference or amount"
            placeholder="Payee, reference or amount"
            className="pl-7"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
        <Select value={filters.month === "" ? ANY : filters.month} onValueChange={(v) => apply({ month: v === ANY ? "" : v })}>
          <SelectTrigger aria-label="Month" className="w-[8.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Every month</SelectItem>
            {months.map((month) => (
              <SelectItem key={month} value={month}>
                {monthLabel(month)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.stage === "" ? ANY : filters.stage}
          onValueChange={(v) => apply({ stage: v === ANY ? "" : (v as QueueStage) })}
        >
          <SelectTrigger aria-label="Status" className="w-[8.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            <SelectItem value="review">To review</SelectItem>
            <SelectItem value="ready">Ready to post</SelectItem>
            <SelectItem value="posted">Posted</SelectItem>
            <SelectItem value="excluded">Excluded</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" variant="secondary">
          <Search />
          Search
        </Button>
        {active ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setQ("");
              apply({ month: "", stage: "", q: "" });
            }}
          >
            <FilterX />
            Clear
          </Button>
        ) : null}
        <p className="num ml-auto text-xs text-muted-foreground">
          {rows.length === total ? `${total} transactions` : `${rows.length} of ${total}`}
        </p>
      </form>

      <div className="relative overflow-x-auto border-t border-border">
        <table className="w-full min-w-[64rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Bank register, newest first</caption>
          <thead>
            <tr>
              <Th className="w-8 pr-0">
                <span className="sr-only">Expand</span>
              </Th>
              <Th className="w-16">Date</Th>
              <Th>Payee</Th>
              <Th className="w-[26%]">Account</Th>
              <Th className="w-24">Status</Th>
              <Th className="w-28 text-right">Money in</Th>
              <Th className="rule-gutter w-28 text-right">Money out</Th>
              <Th className="rule-gutter w-32 text-right">Balance</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <EmptyState
                    title={active ? "No transaction matches" : "No transactions on this account yet"}
                    description={active ? "Clear a filter to see the whole register." : "Import a statement to start the register."}
                    action={
                      active ? undefined : (
                        <Button asChild size="sm">
                          <Link href="/banking/import">Import a statement</Link>
                        </Button>
                      )
                    }
                  />
                </td>
              </tr>
            ) : (
              rows.map(({ row, balanceCents, printed }) => {
                const open = expanded.has(row.id);
                const account = row.stage === "posted" ? row.postedAccount : row.suggestion.account;
                const entry = row.journalEntryId === null ? undefined : entries[row.journalEntryId];
                return (
                  <React.Fragment key={row.id}>
                    <tr className={cn("align-top", open ? "bg-primary/5" : "hover:bg-muted/50")}>
                      <td className="rule-row py-1.5 pr-0 pl-3">
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-label={open ? "Hide the journal entry" : "Show the journal entry"}
                          className="relative rounded-xs p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground max-sm:after:absolute max-sm:after:-inset-3 max-sm:after:content-['']"
                          onClick={() => toggle(row.id)}
                        >
                          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        </button>
                      </td>
                      <td className="rule-row num px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground">
                        {shortDate(row.txnDate)}
                      </td>
                      <td className="rule-row max-w-0 px-3 py-1.5">
                        <p className="truncate font-medium">{payeeOf(row)}</p>
                        {row.reference ? <p className="truncate text-2xs text-muted-foreground">{row.reference}</p> : null}
                      </td>
                      <td className="rule-row max-w-0 px-3 py-1.5">
                        {row.status === "transfer" ? (
                          <span className="text-sm">Transfer</span>
                        ) : account === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <p className="flex min-w-0 items-baseline gap-1.5">
                            <span className="num shrink-0 text-xs text-muted-foreground">{account.code}</span>
                            <span className={cn("truncate", row.stage !== "posted" && "text-muted-foreground italic")}>
                              {account.name}
                            </span>
                          </p>
                        )}
                      </td>
                      <td className="rule-row px-3 py-1.5">{statusChip(row)}</td>
                      <InCell cents={row.amountCents} className="rule-row" />
                      <OutCell cents={row.amountCents} className="rule-row" />
                      <td className="rule-row rule-gutter px-3 py-1.5 text-right" title={printed ? "Printed by the bank" : "Opening balance plus every row through this one"}>
                        <Money cents={balanceCents} className={cn(!printed && "text-muted-foreground")} />
                      </td>
                    </tr>
                    {open ? (
                      <tr className="bg-surface-sunken/40">
                        <td colSpan={8} className="rule-row px-3 py-2 pl-11">
                          {entry === undefined ? (
                            <p className="text-xs text-muted-foreground">
                              {row.stage === "excluded"
                                ? "Excluded: the money never moved, so this never reaches the ledger."
                                : "Not posted yet, so there is no journal entry. "}
                              {row.stage === "review" || row.stage === "ready" ? (
                                <Link
                                  className="text-primary underline decoration-primary/40 underline-offset-4"
                                  href={row.stage === "ready" ? "/banking/review?stage=ready" : "/banking/review"}
                                >
                                  Decide it in the review queue
                                </Link>
                              ) : null}
                            </p>
                          ) : (
                            <EntryLines entry={entry} />
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function EntryLines({ entry }: { entry: EntrySummary }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs">
        <Link href={`/ledger/${entry.id}`} className="num font-medium text-primary hover:underline">
          Entry #{entry.entryNo}
        </Link>{" "}
        <span className="text-muted-foreground">
          · {entry.date} · {entry.memo ?? "No memo"}
        </span>
      </p>
      <table className="w-full max-w-2xl border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <Th>Account</Th>
            <Th className="w-28 text-right">Debit</Th>
            <Th className="rule-gutter w-28 text-right">Credit</Th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((line) => (
            <tr key={line.id}>
              <td className="rule-row px-3 py-1">
                <span className="num mr-2 text-xs text-muted-foreground">{line.accountCode}</span>
                {line.accountName}
              </td>
              <td className="rule-row px-3 py-1 text-right">
                <Money cents={line.debitCents} plain zeroDash />
              </td>
              <td className="rule-row rule-gutter px-3 py-1 text-right">
                <Money cents={line.creditCents} plain zeroDash />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

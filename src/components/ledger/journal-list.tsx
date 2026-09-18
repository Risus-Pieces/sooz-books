"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, FilterX, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/cn";

import { AccountCombobox } from "./account-combobox";
import {
  sourceLabel,
  type AccountOption,
  type JournalFilters,
  type JournalLineRow,
  type JournalRow,
} from "./types";

const ANY = "__any__";

export interface JournalListProps {
  rows: readonly JournalRow[];
  /** The lines of every row on this page, so expanding one costs no round trip. */
  lines: Readonly<Record<string, JournalLineRow[]>>;
  filters: JournalFilters;
  accounts: readonly AccountOption[];
  sourceTypes: readonly string[];
  page: number;
  pageSize: number;
  total: number;
  /** Sum of debits over every entry the filter matches, not just this page. */
  totalDebitCents: number;
}

/**
 * The journal register: every entry, narrowed by whatever question is being
 * asked of it. Filtering and paging happen on the server — the register runs to
 * tens of thousands of rows within a year — so each control writes itself into
 * the URL, which also makes a filtered view something that can be shared.
 */
export function JournalList({
  rows,
  lines,
  filters,
  accounts,
  sourceTypes,
  page,
  pageSize,
  total,
  totalDebitCents,
}: JournalListProps) {
  const router = useRouter();
  const pathname = usePathname();
  // Seeded from the filters the server matched on. The page remounts this
  // component whenever those change, so the panel never drifts from the URL.
  const [draft, setDraft] = React.useState<JournalFilters>(filters);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const apply = React.useCallback(
    (next: JournalFilters, nextPage = 1) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(next)) {
        if (value !== "") params.set(key, value);
      }
      if (nextPage > 1) params.set("page", String(nextPage));
      const query = params.toString();
      router.push(query === "" ? pathname : `${pathname}?${query}`);
    },
    [pathname, router],
  );

  const set = React.useCallback(
    <K extends keyof JournalFilters>(key: K, value: JournalFilters[K]) => {
      setDraft((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const active = Object.values(filters).some((value) => value !== "");
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <form
          className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            apply(draft);
          }}
        >
          <Field label="From">
            <DateInput value={draft.from} onValueChange={(value) => set("from", value)} />
          </Field>
          <Field label="To">
            <DateInput value={draft.to} onValueChange={(value) => set("to", value)} />
          </Field>
          <Field label="Status">
            <Select
              value={draft.status === "" ? ANY : draft.status}
              onValueChange={(value) => set("status", value === ANY ? "" : value)}
            >
              <SelectTrigger aria-label="Status">
                <SelectValue placeholder="Any status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any status</SelectItem>
                <SelectItem value="posted">Posted</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Source">
            <Select
              value={draft.sourceType === "" ? ANY : draft.sourceType}
              onValueChange={(value) => set("sourceType", value === ANY ? "" : value)}
            >
              <SelectTrigger aria-label="Source">
                <SelectValue placeholder="Any source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any source</SelectItem>
                {sourceTypes.map((source) => (
                  <SelectItem key={source} value={source}>
                    {sourceLabel(source)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Account">
            <AccountCombobox
              accounts={accounts}
              value={draft.accountId === "" ? null : draft.accountId}
              placeholder="Any account"
              className="h-8"
              onChange={(accountId) => set("accountId", accountId)}
            />
          </Field>
          <Field label="Amount from">
            <Input
              numeric
              inputMode="decimal"
              placeholder="0.00"
              value={draft.minAmount}
              onChange={(event) => set("minAmount", event.target.value)}
            />
          </Field>
          <Field label="Amount to">
            <Input
              numeric
              inputMode="decimal"
              placeholder="0.00"
              value={draft.maxAmount}
              onChange={(event) => set("maxAmount", event.target.value)}
            />
          </Field>
          <Field label="Memo contains">
            <Input
              placeholder="Search memos"
              value={draft.q}
              onChange={(event) => set("q", event.target.value)}
            />
          </Field>

          <div className="flex items-end gap-2 md:col-span-2 xl:col-span-4">
            <Button type="submit" size="sm">
              <Search />
              Apply
            </Button>
            {active ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  apply({
                    from: "",
                    to: "",
                    status: "",
                    sourceType: "",
                    accountId: "",
                    minAmount: "",
                    maxAmount: "",
                    q: "",
                  })
                }
              >
                <FilterX />
                Clear
              </Button>
            ) : null}
            <p className="ml-auto text-xs text-muted-foreground">
              {total === 0 ? "No entries" : `${firstRow}–${lastRow} of ${total}`}
              {total === 0 ? null : (
                <>
                  {" · "}
                  <Money cents={totalDebitCents} currency plain className="text-xs" /> in debits
                </>
              )}
            </p>
          </div>
        </form>
      </Card>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-3xl border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Journal entries</caption>
            <thead>
              <tr>
                <Th className="w-8" />
                <Th className="w-20 text-right">Entry</Th>
                <Th className="w-28">Date</Th>
                <Th>Memo</Th>
                <Th className="w-32">Source</Th>
                <Th className="w-32 text-right">Debits</Th>
                <Th className="w-24">Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      title={active ? "No entry matches those filters" : "The journal is empty"}
                      description={
                        active
                          ? "Widen the date range or clear a filter."
                          : "Every posting — manual, imported or raised by a sub-ledger — will appear here."
                      }
                      action={
                        <Button asChild size="sm">
                          <Link href="/ledger/new">New entry</Link>
                        </Button>
                      }
                    />
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const open = expanded === row.id;
                  return (
                    <React.Fragment key={row.id}>
                      <tr className={cn("rule-row align-middle", open && "bg-primary/5")}>
                        <Td>
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-label={open ? `Hide lines of entry ${row.entryNo}` : `Show lines of entry ${row.entryNo}`}
                            className="rounded-xs p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            onClick={() => setExpanded(open ? null : row.id)}
                          >
                            {open ? (
                              <ChevronDown className="size-3.5" />
                            ) : (
                              <ChevronRight className="size-3.5" />
                            )}
                          </button>
                        </Td>
                        <Td className="num text-right">
                          <Link href={`/ledger/${row.id}`} className="hover:underline">
                            #{row.entryNo}
                          </Link>
                        </Td>
                        <Td className="num">{row.date}</Td>
                        <Td>
                          <Link href={`/ledger/${row.id}`} className="hover:underline">
                            {row.memo ?? <span className="text-muted-foreground">No memo</span>}
                          </Link>
                          {row.reversesEntryNo === null ? null : (
                            <span className="ml-2 text-2xs text-muted-foreground">
                              reverses #{row.reversesEntryNo}
                            </span>
                          )}
                          {row.reversedByEntryNo === null ? null : (
                            <span className="ml-2 text-2xs text-muted-foreground">
                              reversed by #{row.reversedByEntryNo}
                            </span>
                          )}
                        </Td>
                        <Td className="text-xs text-muted-foreground">{sourceLabel(row.sourceType)}</Td>
                        <Td className="text-right">
                          <Money cents={row.debitCents} plain />
                        </Td>
                        <Td>
                          <Badge tone={row.status === "posted" ? "neutral" : "warning"}>
                            {row.status}
                          </Badge>
                        </Td>
                      </tr>
                      {open ? (
                        <tr className="bg-surface-sunken/40">
                          <td colSpan={7} className="rule-row px-3 py-2">
                            <LineTable lines={lines[row.id] ?? []} />
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

        {lastPage > 1 ? (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => apply(filters, page - 1)}
            >
              Previous
            </Button>
            <span className="num text-xs text-muted-foreground">
              Page {page} of {lastPage}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page >= lastPage}
              onClick={() => apply(filters, page + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function LineTable({ lines }: { lines: readonly JournalLineRow[] }) {
  if (lines.length === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">This draft has no lines yet.</p>;
  }

  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th className="w-8 text-right">#</Th>
          <Th>Account</Th>
          <Th>Memo</Th>
          <Th className="w-28">Channel</Th>
          <Th className="w-28 text-right">Debit</Th>
          <Th className="w-28 rule-gutter text-right">Credit</Th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id} className="align-middle">
            <Td className="num text-right text-xs text-muted-foreground">{line.lineNo}</Td>
            <Td>
              <span className="num mr-2 text-xs text-muted-foreground">{line.accountCode}</span>
              {line.accountName}
            </Td>
            <Td className="text-xs text-muted-foreground">{line.memo ?? "—"}</Td>
            <Td className="text-xs text-muted-foreground">{line.channelCode ?? "—"}</Td>
            <Td className="text-right">
              <Money cents={line.debitCents} plain zeroDash />
            </Td>
            <Td className="rule-gutter text-right">
              <Money cents={line.creditCents} plain zeroDash />
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Th({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={cn("px-3 py-1.5 align-middle", className)}>{children}</td>;
}

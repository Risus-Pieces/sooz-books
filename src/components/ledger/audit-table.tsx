"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FilterX, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { AuditDiff } from "./audit-diff";
import type { ActorOption, AuditEntryRow, AuditFilters } from "./types";

const ANY = "__any__";

const OP_TONE: Record<AuditEntryRow["op"], "positive" | "info" | "negative"> = {
  INSERT: "positive",
  UPDATE: "info",
  DELETE: "negative",
};

export interface AuditTableProps {
  rows: readonly AuditEntryRow[];
  filters: AuditFilters;
  tables: readonly string[];
  actors: readonly ActorOption[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * The audit trail as something a person can read.
 *
 * `audit_log` keeps a whole row snapshot per write, which is the right storage
 * and unreadable as-is; every row here is rendered as the fields that changed,
 * from what to what. A row that touched a journal entry links to it, so a
 * question about a figure ends on the entry that produced it.
 */
export function AuditTable({
  rows,
  filters,
  tables,
  actors,
  page,
  pageSize,
  total,
}: AuditTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  // Seeded from the filters the server matched on; the page remounts this
  // component whenever those change.
  const [draft, setDraft] = React.useState<AuditFilters>(filters);

  const apply = React.useCallback(
    (next: AuditFilters, nextPage = 1) => {
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
    <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => {
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
          className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            apply(draft);
          }}
        >
          <Field label="Table">
            <Select
              value={draft.table === "" ? ANY : draft.table}
              onValueChange={(value) => set("table", value === ANY ? "" : value)}
            >
              <SelectTrigger aria-label="Table">
                <SelectValue placeholder="Any table" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any table</SelectItem>
                {tables.map((table) => (
                  <SelectItem key={table} value={table}>
                    {table}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Operation">
            <Select
              value={draft.op === "" ? ANY : draft.op}
              onValueChange={(value) => set("op", value === ANY ? "" : value)}
            >
              <SelectTrigger aria-label="Operation">
                <SelectValue placeholder="Any operation" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any operation</SelectItem>
                <SelectItem value="INSERT">Insert</SelectItem>
                <SelectItem value="UPDATE">Update</SelectItem>
                <SelectItem value="DELETE">Delete</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Actor">
            <Select
              value={draft.actorId === "" ? ANY : draft.actorId}
              onValueChange={(value) => set("actorId", value === ANY ? "" : value)}
            >
              <SelectTrigger aria-label="Actor">
                <SelectValue placeholder="Anyone" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Anyone</SelectItem>
                {actors.map((actor) => (
                  <SelectItem key={actor.id} value={actor.id}>
                    {actor.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="From">
            <DateInput value={draft.from} onValueChange={(value) => set("from", value)} />
          </Field>
          <Field label="To">
            <DateInput value={draft.to} onValueChange={(value) => set("to", value)} />
          </Field>
          <Field label="Contains">
            <Input
              value={draft.q}
              placeholder="Any value in the row"
              onChange={(event) => set("q", event.target.value)}
            />
          </Field>

          <div className="flex items-end gap-2 md:col-span-2 xl:col-span-5">
            <Button type="submit" size="sm">
              <Search />
              Apply
            </Button>
            {active ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => apply({ table: "", op: "", actorId: "", from: "", to: "", q: "" })}
              >
                <FilterX />
                Clear
              </Button>
            ) : null}
            <p className="ml-auto text-xs text-muted-foreground">
              {total === 0
                ? "No entries"
                : `${firstRow}\u2013${lastRow} of ${total} recorded ${total === 1 ? "write" : "writes"}`}
            </p>
          </div>
        </form>
      </Card>

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title={active ? "Nothing matches those filters" : "Nothing recorded yet"}
            description="Every insert, update and delete on a financial table lands here, attributed to whoever made it."
          />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-1.5 px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={OP_TONE[row.op]}>{row.op}</Badge>
                  <span className="num text-xs text-foreground">{row.tableName}</span>
                  <span className="text-xs text-muted-foreground">{row.atLabel}</span>
                  <span className="text-xs text-foreground">{row.actorLabel ?? "System"}</span>
                  {row.tableName === "journal_entries" ? (
                    <Link
                      href={`/ledger/${row.rowId}`}
                      className="text-xs text-primary hover:underline"
                    >
                      Open entry
                    </Link>
                  ) : null}
                </div>
                <AuditDiff op={row.op} before={row.before} after={row.after} />
              </li>
            ))}
          </ul>
        )}

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

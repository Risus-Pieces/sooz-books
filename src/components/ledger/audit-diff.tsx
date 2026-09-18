"use client";

import * as React from "react";
import { ArrowRight } from "lucide-react";

import { formatCents } from "@/components/ui/money";
import { cn } from "@/lib/cn";

/**
 * The audit trail keeps whole row snapshots as JSON, which is the right thing
 * for a trail and the wrong thing to read. This turns a pair of snapshots into
 * the sentence an auditor is actually asking for: what changed, from what, to
 * what — and nothing else.
 */

/** Columns that say nothing to a reader: surrogate keys and the row's own clock. */
const NOISE = new Set(["id", "created_at", "updated_at"]);

const LABELS: Readonly<Record<string, string>> = {
  entry_no: "Entry no",
  entry_date: "Date",
  source_type: "Source",
  source_id: "Source id",
  reverses_id: "Reverses",
  reversed_by_id: "Reversed by",
  created_by: "Created by",
  posted_by: "Posted by",
  posted_at: "Posted at",
  closed_at: "Closed at",
  closed_by: "Closed by",
  account_id: "Account",
  entry_id: "Entry",
  line_no: "Line",
  debit_cents: "Debit",
  credit_cents: "Credit",
  channel_id: "Channel",
  customer_id: "Customer",
  vendor_id: "Vendor",
  product_id: "Product",
  parent_id: "Parent",
  is_bank: "Bank account",
  is_control: "Control account",
  clearing_for_channel_id: "Clearing for channel",
  full_name: "Name",
};

function label(key: string): string {
  const known = LABELS[key];
  if (known !== undefined) return known;
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function render(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (key.endsWith("_cents")) {
    const cents = typeof value === "number" ? value : Number(value);
    return Number.isFinite(cents) ? formatCents(cents, { currency: true }) : String(value);
  }
  if (typeof value === "string") {
    if (value === "") return "—";
    // Timestamps come back with microseconds and an offset; seconds is enough.
    if (ISO_TIMESTAMP.test(value)) return value.slice(0, 19).replace("T", " ");
    return value;
  }
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

export interface AuditChange {
  key: string;
  before: unknown;
  after: unknown;
}

/** The fields worth showing for one audit row, in the order the table stores them. */
export function auditChanges(
  op: "INSERT" | "UPDATE" | "DELETE",
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditChange[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: AuditChange[] = [];

  for (const key of keys) {
    if (NOISE.has(key)) continue;
    const from = before?.[key] ?? null;
    const to = after?.[key] ?? null;

    if (op === "UPDATE") {
      if (same(from, to)) continue;
      changes.push({ key, before: from, after: to });
      continue;
    }

    // An insert or a delete is a whole row; only the fields that carry
    // something are worth printing.
    const value = op === "INSERT" ? to : from;
    if (value === null || value === undefined || value === "") continue;
    changes.push({ key, before: op === "DELETE" ? from : null, after: op === "INSERT" ? to : null });
  }

  return changes;
}

export interface AuditDiffProps {
  op: "INSERT" | "UPDATE" | "DELETE";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  className?: string;
}

export function AuditDiff({ op, before, after, className }: AuditDiffProps) {
  const changes = React.useMemo(() => auditChanges(op, before, after), [op, before, after]);

  if (changes.length === 0) {
    return <p className={cn("text-xs text-muted-foreground", className)}>No field changed.</p>;
  }

  return (
    <dl className={cn("grid gap-x-3 gap-y-1 sm:grid-cols-[10rem_1fr]", className)}>
      {changes.map((change) => (
        <React.Fragment key={change.key}>
          <dt className="text-xs text-muted-foreground">{label(change.key)}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
            {op === "UPDATE" ? (
              <>
                <span className="num text-muted-foreground line-through decoration-muted-foreground/60">
                  {render(change.key, change.before)}
                </span>
                <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-label="becomes" />
                <span className="num break-all text-foreground">{render(change.key, change.after)}</span>
              </>
            ) : (
              <span
                className={cn(
                  "num break-all",
                  op === "DELETE" ? "text-muted-foreground line-through" : "text-foreground",
                )}
              >
                {render(change.key, op === "DELETE" ? change.before : change.after)}
              </span>
            )}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

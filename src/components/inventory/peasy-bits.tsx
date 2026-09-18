"use client";

import * as React from "react";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

import { Table, TableScroll, Td, Th } from "./table";
import type { PreviewIssue, ProductToCreateInput, UnknownItemPreview } from "./types";

/** What the file said that is worth reading before importing it. Errors first. */
export function IssueList({ issues, limit = 12 }: { issues: readonly PreviewIssue[]; limit?: number }) {
  const [all, setAll] = React.useState(false);
  if (issues.length === 0) return null;
  const order = { fatal: 0, error: 1, warn: 2, info: 3 } as const;
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
  const shown = all ? sorted : sorted.slice(0, limit);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="eyebrow">What the file says ({issues.length})</p>
      <ul className="flex flex-col gap-1">
        {shown.map((issue, index) => {
          const Icon = issue.severity === "info" ? Info : issue.severity === "warn" ? TriangleAlert : CircleAlert;
          return (
            <li key={`${issue.row ?? "file"}-${index}`} className="flex gap-2 text-xs leading-relaxed">
              <Icon
                aria-hidden
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  issue.severity === "info" ? "text-info" : issue.severity === "warn" ? "text-warning" : "text-negative",
                )}
              />
              <span>
                {issue.row === null ? null : <span className="num mr-1.5 text-muted-foreground">row {issue.row}</span>}
                {issue.message}
              </span>
            </li>
          );
        })}
      </ul>
      {sorted.length > limit ? (
        <button type="button" className="self-start text-xs text-primary hover:underline" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      ) : null}
    </div>
  );
}

/** Blockers: why the file cannot be imported as it stands. */
export function BlockerList({ blockers }: { blockers: readonly string[] }) {
  if (blockers.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 rounded-sm border border-negative/35 bg-negative/8 p-3">
      {blockers.map((b) => (
        <li key={b} className="flex gap-2 text-xs text-foreground">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-negative" aria-hidden />
          {b}
        </li>
      ))}
    </ul>
  );
}

/**
 * Items Peasy knows that the books do not. Each one becomes a product only when
 * it is ticked here, under the SKU and name shown; an unticked item refuses the
 * import rather than being dropped.
 */
export function UnknownItems({
  items,
  value,
  onChange,
}: {
  items: readonly UnknownItemPreview[];
  value: readonly ProductToCreateInput[];
  onChange: (next: ProductToCreateInput[]) => void;
}) {
  if (items.length === 0) return null;
  const byKey = new Map(value.map((v) => [v.key, v]));
  const set = (key: string, patch: Partial<ProductToCreateInput> | null, item: UnknownItemPreview) => {
    const current = byKey.get(key);
    if (patch === null) {
      onChange(value.filter((v) => v.key !== key));
      return;
    }
    const next = { key, sku: current?.sku ?? item.suggestedSku, name: current?.name ?? item.suggestedName, ...patch };
    onChange(current ? value.map((v) => (v.key === key ? next : v)) : [...value, next]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="eyebrow">New to the books ({items.length})</p>
      <p className="text-xs text-muted-foreground">
        Tick each item to create it as a product. Check the SKU: it is used on every COGS and margin line.
      </p>
      <div className="overflow-hidden rounded-sm border border-border">
        <TableScroll>
          <Table caption="Items to create as products" className="min-w-[32rem]">
            <thead>
              <tr>
                <Th className="w-10" />
                <Th>In Peasy</Th>
                <Th>SKU</Th>
                <Th>Name</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const chosen = byKey.get(item.key);
                return (
                  <tr key={item.key} className="rule-row">
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`Create ${item.label}`}
                        checked={chosen !== undefined}
                        onChange={(e) => set(item.key, e.target.checked ? {} : null, item)}
                        className="size-3.5 accent-[var(--color-primary)]"
                      />
                    </Td>
                    <Td className="text-sm">{item.label}</Td>
                    <Td>
                      <Input
                        aria-label={`SKU for ${item.label}`}
                        value={chosen?.sku ?? item.suggestedSku}
                        disabled={chosen === undefined}
                        onChange={(e) => set(item.key, { sku: e.target.value }, item)}
                        className="num h-7 w-44"
                      />
                    </Td>
                    <Td>
                      <Input
                        aria-label={`Name for ${item.label}`}
                        value={chosen?.name ?? item.suggestedName}
                        disabled={chosen === undefined}
                        onChange={(e) => set(item.key, { name: e.target.value }, item)}
                        className="h-7 min-w-40"
                      />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      </div>
    </div>
  );
}

/** A plain file input in the field's clothes. */
export function FileField({
  id,
  onFile,
  disabled,
}: {
  id: string;
  onFile: (file: File | null) => void;
  disabled?: boolean;
}) {
  return (
    <input
      id={id}
      type="file"
      accept=".csv,.tsv,.txt,.xlsx,text/csv"
      disabled={disabled}
      onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      className="block w-full text-xs text-muted-foreground file:mr-3 file:h-8 file:cursor-pointer file:rounded-sm file:border file:border-border-strong file:bg-surface-raised file:px-3 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted"
    />
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Save, Undo2 } from "lucide-react";

import { saveBudgetCells } from "@/app/(app)/plan/actions";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { inputBase } from "@/components/ui/input";
import { Money, formatCents } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { parseMoney } from "@/lib/money";

import type { BudgetAccountOption, BudgetCellChange, BudgetGridRow } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface BudgetGridProps {
  versionId: string;
  versionName: string;
  fiscalYear: number;
  editable: boolean;
  rows: readonly BudgetGridRow[];
  accounts: readonly BudgetAccountOption[];
  contraIds: readonly string[];
}

type Drafts = Record<string, string>;

const cellKey = (accountId: string, month: number) => `${accountId}:${month}`;

/** Text in a cell → cents, or null for blank, or an error for text that is not money. */
function readCell(text: string): number | null | Error {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return parseMoney(trimmed);
  } catch (error) {
    return error instanceof Error ? error : new Error("Not an amount.");
  }
}

/**
 * The budget as a spreadsheet: one row an account, one column a month. Figures
 * are in the sign the P&L prints them — revenue, deductions and expenses all
 * positive — and a cell is saved only when it has changed. Blanking a cell that
 * had a figure saves it as zero.
 */
export function BudgetGrid({ versionId, versionName, fiscalYear, editable, rows, accounts, contraIds }: BudgetGridProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [drafts, setDrafts] = React.useState<Drafts>({});
  const [added, setAdded] = React.useState<BudgetGridRow[]>([]);
  const [picker, setPicker] = React.useState("");

  const contra = React.useMemo(() => new Set(contraIds), [contraIds]);
  const all = React.useMemo(() => {
    const merged = [...rows, ...added.filter((a) => !rows.some((r) => r.accountId === a.accountId))];
    return merged.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [rows, added]);
  const available = accounts.filter((a) => !all.some((r) => r.accountId === a.id));

  const valueOf = (row: BudgetGridRow, month: number): number | null => {
    const draft = drafts[cellKey(row.accountId, month)];
    if (draft === undefined) return row.months[month - 1];
    const parsed = readCell(draft);
    return parsed instanceof Error ? row.months[month - 1] : parsed;
  };

  const changes: BudgetCellChange[] = [];
  let invalid = 0;
  for (const row of all) {
    for (let m = 1; m <= 12; m += 1) {
      const draft = drafts[cellKey(row.accountId, m)];
      if (draft === undefined) continue;
      const parsed = readCell(draft);
      if (parsed instanceof Error) {
        invalid += 1;
        continue;
      }
      const before = row.months[m - 1];
      if (parsed === before || (parsed === null && before === null)) continue;
      changes.push({ accountCode: row.code, month: m, amountCents: parsed ?? 0 });
    }
  }

  const sectionTotals = (type: "revenue" | "expense", pickContra?: boolean): number[] =>
    Array.from({ length: 12 }, (_, i) =>
      all
        .filter((r) => r.type === type && (pickContra === undefined || contra.has(r.accountId) === pickContra))
        .reduce((sum, r) => sum + (valueOf(r, i + 1) ?? 0), 0),
    );
  const income = sectionTotals("revenue", false);
  const deductions = sectionTotals("revenue", true);
  const expense = sectionTotals("expense");
  const net = income.map((v, i) => v - deductions[i] - expense[i]);

  const save = () => {
    startTransition(async () => {
      const result = await saveBudgetCells(versionId, changes);
      if (!result.ok) {
        toast.error("Budget not saved", { description: result.error.message });
        return;
      }
      toast.success(`${result.value.cellsWritten} ${result.value.cellsWritten === 1 ? "cell" : "cells"} saved`);
      setDrafts({});
      setAdded([]);
      router.refresh();
    });
  };

  const addRow = (accountId: string) => {
    const account = accounts.find((a) => a.id === accountId);
    if (account === undefined) return;
    setAdded((prev) => [
      ...prev,
      { accountId: account.id, code: account.code, name: account.name, type: account.type, months: Array.from({ length: 12 }, () => null) },
    ]);
    setPicker("");
  };

  const section = (title: string, list: readonly BudgetGridRow[], totals: number[], totalLabel: string) =>
    list.length === 0 ? null : (
      <>
        <tr>
          <th
            colSpan={14}
            scope="colgroup"
            className="sticky left-0 bg-surface px-3 pt-3 pb-1 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase"
          >
            {title}
          </th>
        </tr>
        {list.map((row) => {
          const total = Array.from({ length: 12 }, (_, i) => valueOf(row, i + 1) ?? 0).reduce((s, v) => s + v, 0);
          return (
            <tr key={row.accountId}>
              <th scope="row" className="rule-row sticky left-0 z-10 max-w-52 truncate bg-surface px-3 py-1 text-left font-normal" title={`${row.code} ${row.name}`}>
                <span className="num mr-2 text-xs text-muted-foreground">{row.code}</span>
                <span className="text-sm">{row.name}</span>
              </th>
              {MONTHS.map((label, i) => {
                const month = i + 1;
                const key = cellKey(row.accountId, month);
                const draft = drafts[key];
                const stored = row.months[i];
                const text = draft ?? (stored === null ? "" : formatCents(stored).replace("\u2212", "-"));
                const bad = draft !== undefined && readCell(draft) instanceof Error;
                const dirty = draft !== undefined && !bad && readCell(draft) !== stored;
                return (
                  <td key={label} className="rule-row px-0.5 py-0.5">
                    {editable ? (
                      <input
                        aria-label={`${row.code} ${label} ${fiscalYear}`}
                        inputMode="decimal"
                        value={text}
                        disabled={pending}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                        className={cn(
                          inputBase,
                          "num h-7 w-[4.5rem] border-transparent bg-transparent px-1.5 text-right text-xs tracking-normal hover:border-border focus-visible:bg-surface-raised",
                          dirty && "border-primary/50 bg-primary/5",
                          bad && "border-negative bg-negative/8",
                        )}
                      />
                    ) : (
                      <span className="block w-[4.5rem] px-1.5 text-right text-xs">
                        {stored === null ? <span className="text-muted-foreground">—</span> : <Money cents={stored} plain />}
                      </span>
                    )}
                  </td>
                );
              })}
              <td className="rule-row px-3 py-1 text-right text-xs font-semibold">
                <Money cents={total} zeroDash plain />
              </td>
            </tr>
          );
        })}
        <tr>
          <th scope="row" className="rule-subtotal sticky left-0 z-10 bg-surface px-3 py-1.5 text-left text-xs font-semibold">
            {totalLabel}
          </th>
          {totals.map((v, i) => (
            <td key={MONTHS[i]} className="rule-subtotal px-2 py-1.5 text-right text-xs font-semibold">
              <Money cents={v} zeroDash plain />
            </td>
          ))}
          <td className="rule-subtotal px-3 py-1.5 text-right text-xs font-semibold">
            <Money cents={totals.reduce((s, v) => s + v, 0)} zeroDash plain />
          </td>
        </tr>
      </>
    );

  const incomeRows = all.filter((r) => r.type === "revenue" && !contra.has(r.accountId));
  const deductionRows = all.filter((r) => r.type === "revenue" && contra.has(r.accountId));
  const expenseRows = all.filter((r) => r.type === "expense");

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>
            {versionName} · {fiscalYear}
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Dollars by month, as the P&amp;L prints them: revenue, deductions and expenses all positive.
          </p>
        </div>
        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            {invalid > 0 ? <span className="text-xs text-negative">{invalid} cell{invalid === 1 ? "" : "s"} not an amount</span> : null}
            {changes.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                {changes.length} unsaved {changes.length === 1 ? "change" : "changes"}
              </span>
            ) : null}
            <Button variant="ghost" size="sm" disabled={pending || Object.keys(drafts).length === 0} onClick={() => setDrafts({})}>
              <Undo2 />
              Discard
            </Button>
            <Button size="sm" disabled={pending || changes.length === 0 || invalid > 0} onClick={save}>
              <Save />
              Save changes
            </Button>
          </div>
        ) : null}
      </CardHeader>

      {all.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm font-semibold">This budget has no lines yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Add an account below and type a figure into each month, import a spreadsheet, or copy a year of posted
            actuals.
          </p>
        </div>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Budget by account and month</caption>
            <thead>
              <tr>
                <th scope="col" className="rule-head sticky left-0 z-10 bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Account
                </th>
                {MONTHS.map((m) => (
                  <th key={m} scope="col" className="rule-head bg-surface-sunken px-2 py-1.5 text-right text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                    {m}
                  </th>
                ))}
                <th scope="col" className="rule-head bg-surface-sunken px-3 py-1.5 text-right text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Year
                </th>
              </tr>
            </thead>
            <tbody>
              {section("Revenue", incomeRows, income, "Total revenue")}
              {section("Deductions from revenue", deductionRows, deductions, "Total deductions")}
              {section("Costs and expenses", expenseRows, expense, "Total costs and expenses")}
              <tr>
                <th scope="row" className="rule-total sticky left-0 z-10 bg-surface px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase">
                  Budgeted net income
                </th>
                {net.map((v, i) => (
                  <td key={MONTHS[i]} className="rule-total px-2 py-2 text-right text-xs font-semibold">
                    <Money cents={v} zeroDash />
                  </td>
                ))}
                <td className="rule-total px-3 py-2 text-right text-xs font-semibold">
                  <Money cents={net.reduce((s, v) => s + v, 0)} zeroDash />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {editable ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
          <label htmlFor="budget-add-account" className="eyebrow">
            Add an account
          </label>
          <select
            id="budget-add-account"
            value={picker}
            disabled={pending || available.length === 0}
            onChange={(e) => addRow(e.target.value)}
            className={cn(inputBase, "w-full max-w-sm sm:w-80")}
          >
            <option value="">Choose an income or expense account…</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </Card>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { saveBudgetCells } from "@/app/(app)/plan/actions";
import { DivergingBars, Responsive, type DivergingColumn, type DivergingSeries } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { LegendItem } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { Money, formatCents } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { parseMoney } from "@/lib/money";
import { categoryForCode } from "@/lib/ui/categories";

import type { BudgetAccountOption, BudgetCellChange, BudgetGridRow } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const UP: DivergingSeries[] = [{ key: "revenue", label: "Revenue", tint: "green" }];
const DOWN: DivergingSeries[] = [{ key: "spend", label: "Costs", tint: "red" }];

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

const cellBase = "px-2 py-0 text-right text-xs";
const stickyCol = "sticky left-0 z-10 bg-card";

/**
 * The budget as a spreadsheet, laid out like Numbers: one row an account, one column a month,
 * hairline rows, tabular figures, bold section totals under a rule. Above it, the plan drawn:
 * revenue up, costs down, month by month. Figures are in the sign the P&L prints them — revenue,
 * deductions and expenses all positive — and a cell is saved only when it has changed. Blanking a
 * cell that had a figure saves it as zero.
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
  const netYear = net.reduce((s, v) => s + v, 0);

  const columns = (compact: boolean): DivergingColumn[] =>
    MONTHS.map((m, i) => ({
      label: compact ? m.slice(0, 1) : m,
      name: `${MONTHS_LONG[i]} ${fiscalYear}`,
      up: { revenue: Math.max(0, income[i]) },
      down: { spend: Math.max(0, deductions[i] + expense[i]) },
    }));

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
          <th colSpan={14} scope="colgroup" className={cn(stickyCol, "px-5 pt-4 pb-1 text-left text-xs font-semibold text-label2 max-sm:px-4")}>
            {title}
          </th>
        </tr>
        {list.map((row) => {
          const total = Array.from({ length: 12 }, (_, i) => valueOf(row, i + 1) ?? 0).reduce((s, v) => s + v, 0);
          const tint = categoryForCode(row.code).tint;
          return (
            <tr key={row.accountId} className="[&>td]:rule-row [&>th]:rule-row">
              <th
                scope="row"
                className={cn(stickyCol, "max-w-60 truncate py-1.5 pr-3 pl-5 text-left font-medium max-sm:max-w-40 max-sm:pl-4")}
                title={`${row.code} ${row.name}`}
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: `var(--${tint})` }} />
                  <span className="num text-xs text-label2">{row.code}</span>
                  <span className="truncate text-sm">{row.name}</span>
                </span>
              </th>
              {MONTHS.map((label, i) => {
                const month = i + 1;
                const key = cellKey(row.accountId, month);
                const draft = drafts[key];
                const stored = row.months[i];
                const text = draft ?? (stored === null ? "" : formatCents(stored).replace("−", "-"));
                const bad = draft !== undefined && readCell(draft) instanceof Error;
                const dirty = draft !== undefined && !bad && readCell(draft) !== stored;
                return (
                  <td key={label} className="p-0">
                    {editable ? (
                      <input
                        aria-label={`${row.code} ${label} ${fiscalYear}`}
                        inputMode="decimal"
                        value={text}
                        disabled={pending}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                        className={cn(
                          "num block h-8 w-[5.25rem] rounded-none border-0 bg-transparent px-2 text-right text-xs text-label outline-none transition-colors",
                          "hover:bg-fill2 focus:bg-card focus:shadow-[inset_0_0_0_2px_var(--blue)] max-sm:h-11",
                          dirty && "bg-tint-blue/10 font-semibold",
                          bad && "bg-tint-red/12 text-ink-red shadow-[inset_0_0_0_1.5px_var(--red)]",
                        )}
                      />
                    ) : (
                      <span className={cn(cellBase, "block h-8 w-[5.25rem] leading-8")}>
                        {stored === null ? <span className="text-label2">—</span> : <Money cents={stored} plain />}
                      </span>
                    )}
                  </td>
                );
              })}
              <td className="px-5 text-right text-xs font-semibold max-sm:px-4">
                <Money cents={total} zeroDash plain />
              </td>
            </tr>
          );
        })}
        <tr>
          <th scope="row" className={cn(stickyCol, "rule-subtotal py-2 pr-3 pl-5 text-left text-sm font-semibold max-sm:pl-4")}>
            {totalLabel}
          </th>
          {totals.map((v, i) => (
            <td key={MONTHS[i]} className={cn(cellBase, "rule-subtotal py-2 font-semibold")}>
              <Money cents={v} zeroDash plain />
            </td>
          ))}
          <td className="rule-subtotal px-5 py-2 text-right text-xs font-semibold max-sm:px-4">
            <Money cents={totals.reduce((s, v) => s + v, 0)} zeroDash plain />
          </td>
        </tr>
      </>
    );

  const incomeRows = all.filter((r) => r.type === "revenue" && !contra.has(r.accountId));
  const deductionRows = all.filter((r) => r.type === "revenue" && contra.has(r.accountId));
  const expenseRows = all.filter((r) => r.type === "expense");

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      {all.length > 0 ? (
        <Card className="flex gap-8 px-5 pt-[18px] pb-4 max-lg:flex-col max-lg:gap-3 max-md:p-4">
          <div className="flex shrink-0 flex-col lg:w-64">
            <h2 className="text-sm font-semibold text-label2">Net income, {fiscalYear}</h2>
            <Money
              cents={netYear}
              currency
              plain
              className={cn("mt-0.5 block text-[2.5rem] leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.125rem]", netYear < 0 && "text-ink-red")}
            />
            <dl className="mt-4 grid rounded-[11px] bg-inset lg:mt-auto">
              {[
                { label: "Revenue", tint: "green" as const, cents: income.reduce((s, v) => s + v, 0) },
                { label: "Deductions", tint: "red" as const, cents: deductions.reduce((s, v) => s + v, 0) },
                { label: "Costs", tint: "red" as const, cents: expense.reduce((s, v) => s + v, 0) },
              ].map((f, i) => (
                <div key={f.label} className={cn("flex h-9 items-center justify-between px-3", i > 0 && "hairline-t")}>
                  <dt>
                    <LegendItem tint={f.tint}>{f.label}</LegendItem>
                  </dt>
                  <dd className="font-semibold">
                    <Money cents={f.cents} currency plain />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="min-w-0 flex-1">
            <Responsive
              desktop={<DivergingBars columns={columns(false)} upSeries={UP} downSeries={DOWN} title="Budgeted revenue and costs by month" />}
              phone={<DivergingBars columns={columns(true)} upSeries={UP} downSeries={DOWN} width={342} compact title="Budgeted revenue and costs by month" />}
            />
          </div>
        </Card>
      ) : null}

      <Card className="min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2 max-sm:px-4">
          <h2 className="flex min-w-0 flex-1 items-center gap-1 text-lg font-semibold tracking-[-0.01em]">
            <span className="truncate">{versionName}</span>
            <InfoButton label="About the grid" align="start">
              Dollars by month, as the P&amp;L prints them: revenue, deductions and expenses all positive. Type into a
              cell; nothing is saved until Save.
            </InfoButton>
          </h2>
          {editable ? (
            <div className="flex flex-wrap items-center gap-2">
              {invalid > 0 ? (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink-red">
                  <Glyph name="warning" size={13} />
                  {invalid} not {invalid === 1 ? "an amount" : "amounts"}
                </span>
              ) : null}
              {changes.length > 0 ? (
                <span className="num text-xs font-medium text-label2">
                  {changes.length} {changes.length === 1 ? "change" : "changes"}
                </span>
              ) : null}
              <Button variant="ghost" size="sm" disabled={pending || Object.keys(drafts).length === 0} onClick={() => setDrafts({})}>
                Discard
              </Button>
              <Button size="sm" disabled={pending || changes.length === 0 || invalid > 0} onClick={save}>
                <Glyph name="check" />
                Save
              </Button>
            </div>
          ) : null}
        </div>

        {all.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <Glyph name="grid" size={48} weight={1.4} className="mb-3 text-label3" />
            <p className="text-lg font-semibold">No lines yet</p>
          </div>
        ) : (
          <div className="relative overflow-x-auto overscroll-x-contain">
            <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Budget by account and month</caption>
              <thead>
                <tr>
                  <th scope="col" className={cn(stickyCol, "rule-head py-1.5 pr-3 pl-5 text-left text-xs font-semibold text-label2 max-sm:pl-4")}>
                    Account
                  </th>
                  {MONTHS.map((m) => (
                    <th key={m} scope="col" className="rule-head px-2 py-1.5 text-right text-xs font-semibold text-label2">
                      {m}
                    </th>
                  ))}
                  <th scope="col" className="rule-head px-5 py-1.5 text-right text-xs font-semibold text-label2 max-sm:px-4">
                    Year
                  </th>
                </tr>
              </thead>
              <tbody>
                {section("Revenue", incomeRows, income, "Revenue")}
                {section("Deductions", deductionRows, deductions, "Deductions")}
                {section("Costs and expenses", expenseRows, expense, "Costs")}
                <tr>
                  <th scope="row" className={cn(stickyCol, "rule-total py-2.5 pr-3 pl-5 text-left text-sm font-bold max-sm:pl-4")}>
                    Net income
                  </th>
                  {net.map((v, i) => (
                    <td key={MONTHS[i]} className={cn(cellBase, "rule-total py-2.5 font-bold")}>
                      <Money cents={v} zeroDash />
                    </td>
                  ))}
                  <td className="rule-total px-5 py-2.5 text-right text-xs font-bold max-sm:px-4">
                    <Money cents={netYear} zeroDash />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {editable ? (
          <div className="flex flex-wrap items-center gap-3 hairline-t px-5 py-3 max-sm:px-4">
            <label htmlFor="budget-add-account" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-blue">
              <Glyph name="plus" size={14} />
              Add account
            </label>
            <select
              id="budget-add-account"
              value={picker}
              disabled={pending || available.length === 0}
              onChange={(e) => addRow(e.target.value)}
              className="h-8 w-full max-w-sm rounded-[8px] bg-ctl px-2.5 text-sm shadow-ctl outline-none sm:w-80 max-sm:h-11"
            >
              <option value="">Choose an account</option>
              {available.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

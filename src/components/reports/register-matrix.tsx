import * as React from "react";

import { sourceLabel } from "@/components/ledger/types";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { InsetGroup } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import type { Report, ReportRow } from "@/lib/reports/types";
import { categoryForCode } from "@/lib/ui/categories";
import { shortDate } from "@/lib/ui/format";

/**
 * The General Ledger, drawn as a register rather than a statement.
 *
 * The generic matrix gives every text column its own cell, which made the register wider than the
 * window and pushed the money off the right edge. Here the money never moves: Debit, Credit and
 * Balance are fixed columns on the right, Memo and Other accounts share what is left and truncate,
 * and Entry and Source ride as a caption under the memo. On a phone each line becomes a list row
 * with its amount on the right and its date and entry underneath, like the Journal.
 */

interface Line {
  row: ReportRow;
  date: string;
  entry: string;
  source: string;
  memo: string;
  counter: string;
  debit: number;
  credit: number;
  balance: number;
}

interface Block {
  section: ReportRow;
  lines: Line[];
}

function columnIndex(report: Report, key: string): number {
  return report.columns.findIndex((column) => column.key === key);
}

function readRows(report: Report) {
  const at = {
    date: columnIndex(report, "date"),
    entry: columnIndex(report, "entry"),
    source: columnIndex(report, "source"),
    memo: columnIndex(report, "memo"),
    counter: columnIndex(report, "counter"),
    debit: columnIndex(report, "debit"),
    credit: columnIndex(report, "credit"),
    balance: columnIndex(report, "balance"),
  };
  const text = (row: ReportRow, index: number) => (index < 0 ? "" : (row.cells?.[index] ?? ""));
  const value = (row: ReportRow, index: number) => (index < 0 ? 0 : (row.values[index] ?? 0));

  const blocks: Block[] = [];
  let total: ReportRow | null = null;
  for (const row of report.rows) {
    if (row.style === "section") {
      blocks.push({ section: row, lines: [] });
      continue;
    }
    if (row.style === "total") {
      total = row;
      continue;
    }
    const block = blocks.at(-1);
    if (!block) continue;
    block.lines.push({
      row,
      date: text(row, at.date),
      entry: text(row, at.entry),
      source: text(row, at.source),
      memo: text(row, at.memo),
      counter: text(row, at.counter),
      debit: value(row, at.debit),
      credit: value(row, at.credit),
      balance: value(row, at.balance),
    });
  }
  return { blocks, total };
}

function Amount({ cents, className }: { cents: number; className?: string }) {
  if (cents === 0) return null;
  return <Money cents={cents} parens className={className} />;
}

function caption(line: Line): string {
  const parts: string[] = [];
  if (line.entry !== "") parts.push(`#${line.entry}`);
  if (line.source !== "") parts.push(sourceLabel(line.source));
  return parts.join(" · ");
}

const HEAD = "rule-head bg-card py-2 text-xs font-semibold text-label2 md:sticky md:top-[60px] md:z-10";
const CELL = "px-3 align-top";

export function RegisterMatrix({ report }: { report: Report }) {
  const { blocks, total } = readRows(report);
  const { meta } = report;
  const hasLines = blocks.some((block) => block.lines.some((line) => line.row.style === "detail" && line.row.label === ""));

  return (
    <div className="flex flex-col">
      {meta.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 hairline-b bg-[color-mix(in_srgb,var(--orange)_9%,var(--card))] px-5 py-2.5">
          {meta.warnings.map((warning) => (
            <li key={warning} className="flex gap-2 text-xs text-label">
              <Glyph name="warning" size={13} className="mt-0.5 shrink-0 text-ink-orange" />
              <span className="leading-relaxed">{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {blocks.length === 0 ? (
        <EmptyState glyph="chart" title="Nothing posted" />
      ) : (
        <>
          {/* Desktop and tablet: a fixed-layout register, so the money columns always fit. */}
          <table className="w-full table-fixed border-separate border-spacing-0 text-sm max-sm:hidden">
            <caption className="sr-only">
              {meta.title}, {meta.subtitle}, {meta.basis} basis
            </caption>
            <colgroup>
              <col className="w-[6.75rem]" />
              <col />
              <col className="w-[30%] max-lg:w-[24%]" />
              <col className="w-[7.5rem]" />
              <col className="w-[7.5rem]" />
              <col className="w-[8.25rem]" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className={cn(HEAD, "pr-3 pl-5 text-left")}>Date</th>
                <th scope="col" className={cn(HEAD, "px-3 text-left")}>Memo</th>
                <th scope="col" className={cn(HEAD, "px-3 text-left")}>Other accounts</th>
                <th scope="col" className={cn(HEAD, "px-3 text-right")}>Debit</th>
                <th scope="col" className={cn(HEAD, "px-3 text-right")}>Credit</th>
                <th scope="col" className={cn(HEAD, "pr-5 pl-3 text-right text-label")}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((block) => (
                <DesktopBlock key={block.section.id} block={block} />
              ))}
              {total ? <DesktopTotal row={total} report={report} /> : null}
            </tbody>
          </table>

          {/* Phone: one inset group per account; each line a row with its amount on the right. */}
          <div className="flex flex-col sm:hidden">
            {blocks.map((block) => (
              <PhoneBlock key={block.section.id} block={block} />
            ))}
            {total ? <PhoneTotal row={total} report={report} /> : null}
          </div>
          {hasLines ? null : (
            <p className="flex items-center gap-2 px-5 py-4 text-sm font-medium text-label2 max-sm:hidden">
              <Glyph name="doc" size={16} />
              No lines in range
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SectionLabel({ row }: { row: ReportRow }) {
  const category = row.code ? categoryForCode(row.code) : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {category ? <Dot tint={category.tint} size={7} /> : null}
      <span className="truncate">{row.label}</span>
      {row.code ? <span className="num shrink-0 text-xs font-normal text-label2">{row.code}</span> : null}
    </span>
  );
}

function DesktopBlock({ block }: { block: Block }) {
  return (
    <>
      <tr>
        <th scope="colgroup" colSpan={6} className="px-5 pt-4 pb-1.5 text-left text-sm font-semibold text-label">
          <SectionLabel row={block.section} />
        </th>
      </tr>
      {block.lines.map((line) => {
        const style = line.row.style;
        if (style === "note") {
          return (
            <tr key={line.row.id}>
              <td colSpan={6} className="rule-row py-[5px] pr-5 pl-[8.25rem] text-xs text-label2">
                <span className="block truncate">
                  {line.row.label}
                  {line.memo ? ` · ${line.memo}` : ""}
                </span>
              </td>
            </tr>
          );
        }
        const named = line.row.label !== "";
        const closing = style === "subtotal";
        const rule = closing ? "rule-subtotal" : "rule-row";
        return (
          <tr key={line.row.id} className="hover:[&>*]:bg-[color-mix(in_srgb,var(--fill2)_60%,var(--card))]">
            <td className={cn("num py-[5px] pr-3 pl-5 align-top whitespace-nowrap", rule, named ? "text-label2" : "text-label")}>
              {line.date ? shortDate(line.date) : null}
            </td>
            <td className={cn(CELL, "py-[5px]", rule)}>
              {named ? (
                <span className={cn("block truncate", closing ? "font-semibold" : "text-label2")}>{line.row.label}</span>
              ) : (
                <>
                  <span className="block truncate" title={line.memo.length > 30 ? line.memo : undefined}>
                    {line.memo || "—"}
                  </span>
                  <span className="num block truncate text-2xs text-label2">{caption(line)}</span>
                </>
              )}
            </td>
            <td className={cn(CELL, "py-[5px] text-label2", rule)}>
              <span className="block truncate" title={line.counter.length > 24 ? line.counter : undefined}>
                {line.counter}
              </span>
            </td>
            <td className={cn(CELL, "py-[5px] text-right", rule, closing && "font-semibold")}>
              <Amount cents={line.debit} />
            </td>
            <td className={cn(CELL, "py-[5px] text-right", rule, closing && "font-semibold")}>
              <Amount cents={line.credit} />
            </td>
            <td
              className={cn(
                "py-[5px] pr-5 pl-3 text-right align-top bg-[color-mix(in_srgb,var(--fill2)_45%,var(--card))]",
                rule,
                closing && "font-semibold",
              )}
            >
              {line.balance === 0 ? <span className="num text-label2">—</span> : <Money cents={line.balance} parens />}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function totals(row: ReportRow, report: Report) {
  const debit = report.columns.findIndex((column) => column.key === "debit");
  const credit = report.columns.findIndex((column) => column.key === "credit");
  return { debit: row.values[debit] ?? 0, credit: row.values[credit] ?? 0 };
}

function DesktopTotal({ row, report }: { row: ReportRow; report: Report }) {
  const { debit, credit } = totals(row, report);
  return (
    <>
      <tr aria-hidden className="h-2.5">
        <td colSpan={6} />
      </tr>
      <tr>
        <th scope="row" colSpan={3} className="rule-subtotal rule-total py-2 pr-3 pl-5 text-left font-bold">
          {row.label}
        </th>
        <td className="rule-subtotal rule-total px-3 py-2 text-right font-bold">
          <Money cents={debit} parens />
        </td>
        <td className="rule-subtotal rule-total px-3 py-2 text-right font-bold">
          <Money cents={credit} parens />
        </td>
        <td className="rule-subtotal rule-total py-2 pr-5 pl-3" />
      </tr>
    </>
  );
}

function PhoneBlock({ block }: { block: Block }) {
  return (
    <InsetGroup header={<SectionLabel row={block.section} />}>
      {block.lines.map((line) => {
        const style = line.row.style;
        if (style === "note") {
          return (
            <div key={line.row.id} className="relative px-4 py-2.5 text-xs text-label2 before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-sep first:before:hidden">
              {line.row.label}
            </div>
          );
        }
        const named = line.row.label !== "";
        const closing = style === "subtotal";
        const moved = line.debit !== 0 || line.credit !== 0;
        return (
          <div
            key={line.row.id}
            className="relative flex min-h-11 items-center gap-3 px-4 py-2 before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-sep first:before:hidden"
          >
            <div className="min-w-0 flex-1">
              <p className={cn("truncate text-[0.9375rem]", closing && "font-semibold", named && !closing && "text-label2")}>
                {named ? line.row.label : line.memo || "—"}
              </p>
              <p className="num truncate text-xs text-label2">
                {[line.date ? shortDate(line.date) : "", named ? "" : caption(line)].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              {named && !closing ? (
                <Money cents={line.balance} parens className="text-[0.9375rem]" />
              ) : closing ? (
                <Money cents={line.balance} parens className="text-[0.9375rem] font-semibold" />
              ) : moved ? (
                <span className="flex items-baseline gap-1.5 text-[0.9375rem]">
                  <span className="text-2xs font-semibold text-label2">{line.debit !== 0 ? "Dr" : "Cr"}</span>
                  <Money cents={line.debit !== 0 ? line.debit : line.credit} parens />
                </span>
              ) : null}
              {named ? null : (
                <span className="num text-xs text-label2">
                  Bal <Money cents={line.balance} parens className="text-label2" />
                </span>
              )}
            </div>
          </div>
        );
      })}
    </InsetGroup>
  );
}

function PhoneTotal({ row, report }: { row: ReportRow; report: Report }) {
  const { debit, credit } = totals(row, report);
  return (
    <InsetGroup header={row.label}>
      <div className="flex min-h-11 items-center justify-between px-4 py-2">
        <span className="text-[0.9375rem]">Debits</span>
        <Money cents={debit} parens className="text-[0.9375rem] font-semibold" />
      </div>
      <div className="relative flex min-h-11 items-center justify-between px-4 py-2 before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-sep">
        <span className="text-[0.9375rem]">Credits</span>
        <Money cents={credit} parens className="text-[0.9375rem] font-semibold" />
      </div>
    </InsetGroup>
  );
}

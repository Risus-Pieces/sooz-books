import * as React from "react";

import { FlowDiagram, type FlowNode, type FlowTarget } from "@/components/charts";
import { Glyph } from "@/components/ui/glyph";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { categoryForCode } from "@/lib/ui/categories";
import { mediumDate } from "@/lib/ui/format";

import { EntryFlow } from "./entry-flow";
import { Table, TableScroll, Td, Th } from "./table";
import type { EntryPreviewData, PreviewLine } from "./types";

export interface EntryPreviewProps {
  entry: EntryPreviewData;
  /** Show the SKU and channel each line carries (COGS lines do). */
  dimensions?: boolean;
  className?: string;
  caption?: string;
}

interface Side {
  code: string;
  name: string;
  cents: number;
}

/** Lines on one side of the entry, summed by account, largest first. */
function side(lines: readonly PreviewLine[], pick: (l: PreviewLine) => number): Side[] {
  const byCode = new Map<string, Side>();
  for (const line of lines) {
    const cents = pick(line);
    if (cents <= 0) continue;
    const row = byCode.get(line.accountCode) ?? { code: line.accountCode, name: line.accountName, cents: 0 };
    row.cents += cents;
    byCode.set(line.accountCode, row);
  }
  return [...byCode.values()].sort((a, b) => b.cents - a.cents);
}

function node(s: Side): FlowNode {
  const c = categoryForCode(s.code);
  return { label: s.name, glyph: c.glyph, tint: c.tint };
}

function target(s: Side): FlowTarget {
  return { ...node(s), cents: s.cents };
}

/**
 * The entry an action will post, drawn first: [credited account] —— $ ——▶ [debited account], the
 * same flow diagram the review queue uses. A split draws one arrow per account. The journal lines
 * sit under it in a disclosure, debits and credits either side of the gutter, so nobody approves a
 * number without being able to see exactly where it lands.
 */
export function EntryPreview({ entry, dimensions = false, className, caption }: EntryPreviewProps) {
  const debits = entry.lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = entry.lines.reduce((sum, l) => sum + l.creditCents, 0);
  const balanced = debits === credits;
  const from = side(entry.lines, (l) => l.creditCents);
  const to = side(entry.lines, (l) => l.debitCents);

  // One credit: the kit's diagram, split over the debits. Several: every credit into every debit.
  const single = from.length === 1 && to.length > 0;
  const many = from.length > 1 && to.length > 0;

  return (
    <div className={cn("flex flex-col", className)}>
      {single || many ? (
        <div className="px-5 pt-3 pb-4 max-sm:px-4">
          {single ? (
            <FlowDiagram from={node(from[0])} to={to.map(target)} />
          ) : (
            <EntryFlow from={from.map(target)} to={to.map(target)} />
          )}
        </div>
      ) : null}
      <details className="group/lines hairline-t" open={single || many ? undefined : true}>
        <summary className="flex h-10 cursor-pointer list-none items-center gap-2 px-5 text-xs font-medium text-label2 outline-none focus-ring-inset select-none hover:text-label focus-visible:text-label max-sm:h-11 max-sm:px-4 [&::-webkit-details-marker]:hidden">
          <Glyph name="chevron-right" size={11} weight={2.4} className="transition-transform duration-150 group-open/lines:rotate-90" />
          <span className="num">{mediumDate(entry.date)}</span>
          <span aria-hidden className="size-[3px] rounded-full bg-label3" />
          <span className="num">
            {entry.lines.length} {entry.lines.length === 1 ? "line" : "lines"}
          </span>
          <span className={cn("ml-auto inline-flex items-center gap-1 font-semibold", balanced ? "text-ink-green" : "text-ink-red")}>
            <Glyph name={balanced ? "check-circle" : "warning"} size={13} />
            {balanced ? "Balanced" : "Out of balance"}
          </span>
        </summary>
        {entry.memo ? <p className="truncate px-5 pb-1 text-xs text-label2 max-sm:px-4">{entry.memo}</p> : null}
        <TableScroll>
          <Table caption={caption ?? "Entry to be posted"} className={dimensions ? "min-w-[34rem]" : "min-w-[22rem]"}>
            <thead>
              <tr>
                <Th>Account</Th>
                {dimensions ? <Th className="w-40">SKU · channel</Th> : null}
                <Th align="right" className="w-28">
                  Debit
                </Th>
                <Th align="right" className="rule-gutter w-28">
                  Credit
                </Th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map((line, index) => (
                <tr key={`${line.accountCode}-${index}`} className="[&>td]:rule-row">
                  <Td className={cn("min-w-48", line.creditCents > 0 && "pl-9")}>
                    <span className="num mr-2 text-xs text-label2">{line.accountCode}</span>
                    {line.accountName}
                    {line.memo && !dimensions ? <span className="block truncate text-xs text-label2">{line.memo}</span> : null}
                  </Td>
                  {dimensions ? (
                    <Td className="num text-xs whitespace-nowrap text-label2">
                      {line.sku ?? "—"}
                      {line.channelCode ? ` · ${line.channelCode}` : ""}
                    </Td>
                  ) : null}
                  <Td align="right">{line.debitCents > 0 ? <Money cents={line.debitCents} plain /> : null}</Td>
                  <Td align="right" className="rule-gutter">
                    {line.creditCents > 0 ? <Money cents={line.creditCents} plain /> : null}
                  </Td>
                </tr>
              ))}
              <tr className="font-semibold">
                <Td className="text-xs text-label2" colSpan={dimensions ? 2 : 1}>
                  Total
                </Td>
                <Td align="right" className="rule-total">
                  <Money cents={debits} plain />
                </Td>
                <Td align="right" className="rule-total rule-gutter">
                  <Money cents={credits} plain />
                </Td>
              </tr>
            </tbody>
          </Table>
        </TableScroll>
      </details>
    </div>
  );
}

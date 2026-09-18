import * as React from "react";

import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import { Table, TableScroll, Td, Th } from "./table";
import type { EntryPreviewData } from "./types";

export interface EntryPreviewProps {
  entry: EntryPreviewData;
  /** Show the SKU and channel each line carries (COGS lines do). */
  dimensions?: boolean;
  className?: string;
  caption?: string;
}

/**
 * The journal entry an action will post, set as the ledger will hold it: debits
 * and credits either side of the gutter, and a double rule under the totals.
 * Shown before every posting on these screens, so nobody approves a number
 * without seeing where it lands.
 */
export function EntryPreview({ entry, dimensions = false, className, caption }: EntryPreviewProps) {
  const debits = entry.lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = entry.lines.reduce((sum, l) => sum + l.creditCents, 0);
  const balanced = debits === credits;

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <span className="num text-foreground">{entry.date}</span>
          {entry.memo ? <span> · {entry.memo}</span> : null}
        </p>
        <p className={cn("text-2xs font-semibold tracking-wide uppercase", balanced ? "text-positive" : "text-negative")}>
          {balanced ? "Balanced" : "Out of balance"}
        </p>
      </div>
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
              <tr key={`${line.accountCode}-${index}`} className="rule-row">
                <Td className={cn("min-w-48", line.creditCents > 0 && "pl-8")}>
                  <span className="num mr-2 text-muted-foreground">{line.accountCode}</span>
                  {line.accountName}
                  {line.memo && !dimensions ? (
                    <span className="block text-2xs leading-4 text-muted-foreground">{line.memo}</span>
                  ) : null}
                </Td>
                {dimensions ? (
                  <Td className="num text-xs whitespace-nowrap text-muted-foreground">
                    {line.sku ?? "—"}
                    {line.channelCode ? ` · ${line.channelCode}` : ""}
                  </Td>
                ) : null}
                <Td align="right">
                  {line.debitCents > 0 ? <Money cents={line.debitCents} plain /> : null}
                </Td>
                <Td align="right" className="rule-gutter">
                  {line.creditCents > 0 ? <Money cents={line.creditCents} plain /> : null}
                </Td>
              </tr>
            ))}
            <tr>
              <Td className="rule-subtotal text-xs font-semibold text-muted-foreground" colSpan={dimensions ? 2 : 1}>
                {entry.lines.length} lines
              </Td>
              <Td align="right" className="rule-subtotal rule-total font-semibold">
                <Money cents={debits} plain />
              </Td>
              <Td align="right" className="rule-subtotal rule-total rule-gutter font-semibold">
                <Money cents={credits} plain />
              </Td>
            </tr>
          </tbody>
        </Table>
      </TableScroll>
    </div>
  );
}

import * as React from "react";

import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import { Td, Th } from "./parts";
import type { EntryLineView } from "./types";

/** A journal entry's lines, debit and credit either side of the gutter, closed with a double rule. */
export function EntryTable({
  lines,
  clearingCode,
  caption,
}: {
  lines: readonly EntryLineView[];
  clearingCode: string | null;
  caption: string;
}) {
  const debit = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credit = lines.reduce((sum, l) => sum + l.creditCents, 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <Th>Account</Th>
            <Th>Memo</Th>
            <Th className="w-32 text-right">Debit</Th>
            <Th className="rule-gutter w-32 text-right">Credit</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={`${line.accountCode}-${index}`} className={cn(line.accountCode === clearingCode && "bg-primary/4")}>
              <Td className="rule-row whitespace-nowrap">
                <span className="num mr-2 text-xs text-muted-foreground">{line.accountCode}</span>
                {line.accountName}
              </Td>
              <Td className="rule-row max-w-md text-xs text-muted-foreground">
                <span className="line-clamp-2">{line.memo ?? "—"}</span>
              </Td>
              <Td className="rule-row text-right">
                <Money cents={line.debitCents} plain zeroDash />
              </Td>
              <Td className="rule-row rule-gutter text-right">
                <Money cents={line.creditCents} plain zeroDash />
              </Td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2} className="rule-subtotal rule-total px-3 py-1.5 text-right text-2xs font-semibold tracking-wider uppercase">
              {debit === credit ? "Balanced" : "Out of balance"}
            </td>
            <td className="rule-subtotal rule-total px-3 py-1.5 text-right font-semibold">
              <Money cents={debit} plain />
            </td>
            <td className="rule-subtotal rule-total rule-gutter px-3 py-1.5 text-right font-semibold">
              <Money cents={credit} plain />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

import * as React from "react";

import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import { Table, TableScroll, Td, Th } from "./table";

export interface StageTableRow {
  stage: string;
  label: string;
  accountCode: string;
  accountName: string;
  ledgerCents: number;
  snapshotCents: number | null;
  varianceCents: number | null;
}

export interface StageTableProps {
  rows: readonly StageTableRow[];
  reserveCents: number;
  snapshotDate: string | null;
  asOf: string;
}

const BAR: Record<string, string> = {
  raw: "bg-info/70",
  packaging: "bg-warning/70",
  finished: "bg-primary/80",
  in_transit: "bg-border-strong",
};

/**
 * The ledger's inventory, one row per stage, beside what Peasy counted. The
 * share bar under each figure shows where the value sits — for a brand before
 * its first run, all of it is still in materials.
 */
export function StageTable({ rows, reserveCents, snapshotDate, asOf }: StageTableProps) {
  const ledgerTotal = rows.reduce((sum, r) => sum + r.ledgerCents, 0);
  const snapshotTotal = snapshotDate === null ? null : rows.reduce((sum, r) => sum + (r.snapshotCents ?? 0), 0);
  const varianceTotal = snapshotDate === null ? null : rows.reduce((sum, r) => sum + (r.varianceCents ?? 0), 0);

  return (
    <div className="flex flex-col">
      {ledgerTotal > 0 ? (
        <div className="flex h-1.5 w-full overflow-hidden" role="img" aria-label="Share of inventory value by stage">
          {rows
            .filter((r) => r.ledgerCents > 0)
            .map((r) => (
              <span
                key={r.stage}
                className={cn("h-full", BAR[r.stage] ?? "bg-border-strong")}
                style={{ width: `${(r.ledgerCents / ledgerTotal) * 100}%` }}
              />
            ))}
        </div>
      ) : null}
      <TableScroll>
        <Table caption="Inventory by stage" className="min-w-[34rem]">
          <thead>
            <tr>
              <Th>Stage</Th>
              <Th align="right">
                Ledger <span className="num font-normal tracking-normal normal-case">{asOf}</span>
              </Th>
              <Th align="right" className="rule-gutter">
                Peasy{" "}
                <span className="num font-normal tracking-normal normal-case">{snapshotDate ?? "no count"}</span>
              </Th>
              <Th align="right">Variance</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.stage} className="rule-row">
                <Td>
                  <div className="flex items-center gap-2">
                    <span aria-hidden className={cn("size-2 shrink-0 rounded-[1px]", BAR[r.stage] ?? "bg-border-strong")} />
                    <span className="font-medium">{r.label}</span>
                    <span className="num text-xs text-muted-foreground">{r.accountCode}</span>
                  </div>
                </Td>
                <Td align="right">
                  <Money cents={r.ledgerCents} zeroDash plain />
                </Td>
                <Td align="right" className="rule-gutter">
                  {r.snapshotCents === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Money cents={r.snapshotCents} zeroDash plain />
                  )}
                </Td>
                <Td align="right">
                  {r.varianceCents === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Money cents={r.varianceCents} zeroDash signed plain className={r.varianceCents === 0 ? undefined : "text-warning"} />
                  )}
                </Td>
              </tr>
            ))}
            {reserveCents !== 0 ? (
              <tr className="rule-row text-muted-foreground">
                <Td>
                  Inventory reserve <span className="num text-xs">1390</span>
                </Td>
                <Td align="right">
                  <Money cents={reserveCents} plain />
                </Td>
                <Td align="right" className="rule-gutter text-xs">
                  not counted
                </Td>
                <Td />
              </tr>
            ) : null}
            <tr className="font-semibold">
              <Td className="rule-subtotal">Total inventory</Td>
              <Td align="right" className="rule-subtotal rule-total">
                <Money cents={ledgerTotal + reserveCents} currency plain />
              </Td>
              <Td align="right" className="rule-subtotal rule-total rule-gutter">
                {snapshotTotal === null ? <span className="text-muted-foreground">—</span> : <Money cents={snapshotTotal} currency plain />}
              </Td>
              <Td align="right" className="rule-subtotal rule-total">
                {varianceTotal === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <Money cents={varianceTotal} signed zeroDash currency plain className={varianceTotal === 0 ? undefined : "text-warning"} />
                )}
              </Td>
            </tr>
          </tbody>
        </Table>
      </TableScroll>
    </div>
  );
}

import * as React from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";

import { Table, TableScroll, Td, Th } from "./table";
import { formatUnits } from "./types";

export interface RunsTableRow {
  id: string;
  runNo: string;
  sku: string;
  productName: string;
  runDate: string;
  status: "open" | "costed" | "closed";
  goodUnits: number;
  landedCostCents: number;
  unitCostCents: number | null;
  coManName: string | null;
}

export function RunStatusBadge({ status }: { status: RunsTableRow["status"] }) {
  if (status === "open") return <Badge tone="info">Open</Badge>;
  if (status === "costed") return <Badge tone="positive">Costed</Badge>;
  return <Badge tone="neutral">Closed</Badge>;
}

/** Every run, newest first; the run number opens the run. */
export function RunsTable({ rows }: { rows: readonly RunsTableRow[] }) {
  const landed = rows.reduce((sum, r) => sum + r.landedCostCents, 0);
  return (
    <TableScroll>
      <Table caption="Production runs" className="min-w-[52rem]">
        <thead>
          <tr>
            <Th className="w-28">Run</Th>
            <Th className="w-28">Date</Th>
            <Th>Product</Th>
            <Th>Co-packer</Th>
            <Th className="w-24">Status</Th>
            <Th align="right" className="w-28">
              Good units
            </Th>
            <Th align="right" className="w-32">
              Landed cost
            </Th>
            <Th align="right" className="w-28">
              Unit cost
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="rule-row hover:bg-muted/50">
              <Td>
                <Link href={`/inventory/production/${r.id}`} className="num font-medium whitespace-nowrap text-primary hover:underline">
                  {r.runNo}
                </Link>
              </Td>
              <Td className="num whitespace-nowrap text-muted-foreground">{r.runDate}</Td>
              <Td className="whitespace-nowrap">
                <span className="num mr-2 text-xs text-muted-foreground">{r.sku}</span>
                {r.productName}
              </Td>
              <Td className="text-muted-foreground">{r.coManName ?? "—"}</Td>
              <Td>
                <RunStatusBadge status={r.status} />
              </Td>
              <Td align="right" className="num">
                {r.goodUnits === 0 ? <span className="text-muted-foreground">—</span> : formatUnits(r.goodUnits)}
              </Td>
              <Td align="right">
                <Money cents={r.landedCostCents} zeroDash plain />
              </Td>
              <Td align="right">
                {r.unitCostCents === null ? <span className="text-muted-foreground">—</span> : <Money cents={r.unitCostCents} plain />}
              </Td>
            </tr>
          ))}
          <tr className="font-semibold">
            <Td className="rule-subtotal" colSpan={6}>
              {rows.length} {rows.length === 1 ? "run" : "runs"}
            </Td>
            <Td align="right" className="rule-subtotal rule-total">
              <Money cents={landed} plain />
            </Td>
            <Td className="rule-subtotal" />
          </tr>
        </tbody>
      </Table>
    </TableScroll>
  );
}

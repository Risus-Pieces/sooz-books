import * as React from "react";

import { Money } from "@/components/ui/money";

import { Table, TableScroll, Td, Th } from "./table";
import { COMPONENT_LABELS, formatUnits, type CostComponentKey } from "./types";

export interface BatchLinesProps {
  lines: ReadonlyArray<{
    sku: string;
    productName: string;
    channelCode: string | null;
    channelName: string | null;
    units: number;
    unitCostCents: number;
    cogsCents: number;
    components: Partial<Record<CostComponentKey, number>>;
  }>;
  components: readonly CostComponentKey[];
}

/** A month's COGS by SKU × channel, with the split into the COGS lines it posts to. */
export function BatchLines({ lines, components }: BatchLinesProps) {
  const total = lines.reduce((s, l) => s + l.cogsCents, 0);
  const units = lines.reduce((s, l) => s + l.units, 0);
  return (
    <TableScroll>
      <Table caption="COGS by SKU and channel" className="min-w-[44rem]">
        <thead>
          <tr>
            <Th>SKU</Th>
            <Th>Channel</Th>
            <Th align="right">Units</Th>
            <Th align="right">Unit cost</Th>
            {components.map((c) => (
              <Th key={c} align="right" className="rule-gutter">
                {COMPONENT_LABELS[c]}
              </Th>
            ))}
            <Th align="right" className="rule-gutter">
              COGS
            </Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.sku}-${l.channelCode ?? "none"}`} className="[&>td]:rule-row">
              <Td className="whitespace-nowrap">
                <span className="num font-medium">{l.sku}</span>
                <span className="ml-2 text-xs text-label2">{l.productName}</span>
              </Td>
              <Td className="whitespace-nowrap text-label2">{l.channelName ?? "Unassigned"}</Td>
              <Td align="right" className="num">
                {formatUnits(l.units)}
              </Td>
              <Td align="right">
                <Money cents={l.unitCostCents} plain />
              </Td>
              {components.map((c) => (
                <Td key={c} align="right" className="rule-gutter text-label2">
                  <Money cents={l.components[c] ?? 0} zeroDash plain />
                </Td>
              ))}
              <Td align="right" className="rule-gutter font-medium">
                <Money cents={l.cogsCents} plain />
              </Td>
            </tr>
          ))}
          <tr className="font-semibold">
            <Td colSpan={2}>
              {lines.length} {lines.length === 1 ? "line" : "lines"}
            </Td>
            <Td align="right" className="num">
              {formatUnits(units)}
            </Td>
            <Td />
            {components.map((c) => (
              <Td key={c} align="right" className="rule-gutter">
                <Money cents={lines.reduce((s, l) => s + (l.components[c] ?? 0), 0)} zeroDash plain />
              </Td>
            ))}
            <Td align="right" className="rule-total rule-gutter">
              <Money cents={total} currency plain />
            </Td>
          </tr>
        </tbody>
      </Table>
    </TableScroll>
  );
}

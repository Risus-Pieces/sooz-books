import * as React from "react";
import Link from "next/link";

import { Money } from "@/components/ui/money";

import { DepositBadge, PostedBadge, Td, Th, longDate } from "./parts";
import { PROVIDER_NAME, type SettlementRowView } from "./types";

/** The settlement register: one row per payout, gross to net, and where each stands. */
export function SettlementTable({ rows, showProvider }: { rows: readonly SettlementRowView[]; showProvider: boolean }) {
  const totals = rows.reduce(
    (sum, r) => ({ gross: sum.gross + r.grossCents, fees: sum.fees + r.feesCents, net: sum.net + r.netCents }),
    { gross: 0, fees: 0, net: 0 },
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Imported settlements</caption>
        <thead>
          <tr>
            <Th className="w-28">Date</Th>
            {showProvider ? <Th className="w-24">Channel</Th> : null}
            <Th>Settlement</Th>
            <Th className="w-28 text-right">Gross sales</Th>
            <Th className="w-28 text-right">Fees</Th>
            <Th className="w-28 text-right">Net</Th>
            <Th className="w-32">Deposit</Th>
            <Th className="w-28">Ledger</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="group">
              <Td className="rule-row num text-xs whitespace-nowrap text-muted-foreground">{longDate(row.periodEnd ?? row.periodStart)}</Td>
              {showProvider ? <Td className="rule-row text-xs">{PROVIDER_NAME[row.provider]}</Td> : null}
              <Td className="rule-row">
                <Link href={`/channels/payouts/${row.id}`} className="num text-xs whitespace-nowrap text-primary hover:underline">
                  {row.key ?? "Settlement"}
                </Link>
                {row.reportedCents !== null && row.reportedCents !== row.linesCents ? (
                  <span className="ml-2 text-2xs text-negative">does not tie</span>
                ) : null}
              </Td>
              <Td className="rule-row text-right">
                <Money cents={row.grossCents} plain />
              </Td>
              <Td className="rule-row text-right">
                <Money cents={row.feesCents} plain zeroDash />
              </Td>
              <Td className="rule-row text-right">
                <Money cents={row.netCents} plain className="font-medium" />
              </Td>
              <Td className="rule-row">
                <DepositBadge state={row.depositState} />
              </Td>
              <Td className="rule-row">
                <PostedBadge entryNo={row.entryNo} />
              </Td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={showProvider ? 3 : 2} className="rule-subtotal rule-total px-3 py-1.5 text-right text-2xs font-semibold tracking-wider uppercase">
              {rows.length} settlement{rows.length === 1 ? "" : "s"}
            </td>
            <td className="rule-subtotal rule-total px-3 py-1.5 text-right font-semibold">
              <Money cents={totals.gross} plain />
            </td>
            <td className="rule-subtotal rule-total px-3 py-1.5 text-right font-semibold">
              <Money cents={totals.fees} plain />
            </td>
            <td className="rule-subtotal rule-total px-3 py-1.5 text-right font-semibold">
              <Money cents={totals.net} plain />
            </td>
            <td colSpan={2} className="rule-subtotal rule-total" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

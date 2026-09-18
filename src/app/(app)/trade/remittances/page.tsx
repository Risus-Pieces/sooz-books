import type { Metadata } from "next";
import Link from "next/link";

import { longDate } from "@/components/trade/labels";
import { Table, TableScroll, Td, Th } from "@/components/trade/parts";
import { RemittanceImport } from "@/components/trade/remittance-import";
import { RemittanceFileGuide } from "@/components/trade/workflow";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";

import { remittanceFormOptions, remittanceRows } from "../queries";

export const metadata: Metadata = {
  title: "Remittances",
};

/**
 * Distributor payments. A remittance explains a short payment line by line; importing it posts
 * one entry per payment that relieves AR at full gross, books the cash, and parks every claim
 * that is not already-accrued trade spend in Deductions Receivable for the workbench.
 */
export default async function RemittancesPage() {
  const user = await requireUser("/trade/remittances");
  const canManage = can(user.role, "trade.manage");
  const [rows, options] = await Promise.all([remittanceRows(), canManage ? remittanceFormOptions() : null]);
  const totals = rows.reduce(
    (acc, r) => ({ gross: acc.gross + r.invoicesGrossCents, deducted: acc.deducted + r.deductionsCents, cash: acc.cash + r.totalCents }),
    { gross: 0, deducted: 0, cash: 0 },
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Trade"
        title="Remittances"
        description="What each distributor paid, what it paid for, and what it kept. Revenue is never booked net: AR is relieved at full gross and each deduction is booked on its own line."
      />

      {options !== null ? <RemittanceImport options={options} canPost={canManage} /> : null}

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Posted payments</CardTitle>
            <CardDescription>One entry per payment. A payment imported twice is skipped, never merged.</CardDescription>
          </div>
        </CardHeader>
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            No remittance has been posted. Sooz has no distributor yet; the first KeHE or UNFI payment will arrive with a remittance file like the one described below.
          </p>
        ) : (
          <TableScroll>
            <Table caption="Posted remittances" className="min-w-[56rem]">
              <thead>
                <tr>
                  <Th>Paid</Th>
                  <Th>Payment</Th>
                  <Th>Distributor</Th>
                  <Th align="right">Invoices</Th>
                  <Th align="right">Deducted</Th>
                  <Th align="right">Cash</Th>
                  <Th>Deductions</Th>
                  <Th>Ledger</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="rule-row">
                    <Td className="num text-xs whitespace-nowrap text-muted-foreground">{longDate(r.remittanceDate)}</Td>
                    <Td className="num text-xs">
                      {r.sourceSystem} {r.paymentNumber}
                      {r.filename ? <span className="block max-w-56 truncate text-2xs text-muted-foreground">{r.filename}</span> : null}
                    </Td>
                    <Td className="max-w-48 truncate">{r.customerName}</Td>
                    <Td align="right">
                      <Money cents={r.invoicesGrossCents} plain />
                    </Td>
                    <Td align="right">
                      <Money cents={-r.deductionsCents} plain={r.deductionsCents === 0} zeroDash />
                    </Td>
                    <Td align="right" className="font-medium">
                      <Money cents={r.totalCents} plain />
                    </Td>
                    <Td className="text-xs">
                      <Link href="/trade/deductions" className="text-primary hover:underline">
                        {r.deductionCount}
                      </Link>
                      {r.warningCount > 0 ? (
                        <Badge tone="warning" size="sm" className="ml-2">
                          {r.warningCount} {r.warningCount === 1 ? "warning" : "warnings"}
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="text-xs">
                      {r.entryId !== null ? (
                        <Link href={`/ledger/${r.entryId}`} className="num text-primary hover:underline">
                          JE #{r.entryNo}
                        </Link>
                      ) : (
                        <Badge tone="warning" size="sm">
                          Not posted
                        </Badge>
                      )}
                    </Td>
                  </tr>
                ))}
                <tr>
                  <Td className="rule-subtotal text-xs font-semibold text-muted-foreground" colSpan={3}>
                    {rows.length} {rows.length === 1 ? "payment" : "payments"}
                  </Td>
                  <Td align="right" className="rule-subtotal rule-total font-semibold">
                    <Money cents={totals.gross} plain />
                  </Td>
                  <Td align="right" className="rule-subtotal rule-total font-semibold">
                    <Money cents={-totals.deducted} plain zeroDash />
                  </Td>
                  <Td align="right" className="rule-subtotal rule-total font-semibold">
                    <Money cents={totals.cash} plain />
                  </Td>
                  <Td className="rule-subtotal" colSpan={2} />
                </tr>
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>

      {rows.length === 0 ? <RemittanceFileGuide /> : null}
    </div>
  );
}

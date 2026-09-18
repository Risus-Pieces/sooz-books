import type { Metadata } from "next";
import Link from "next/link";

import { Figure, Td, Th, longDate, monthName } from "@/components/channels/parts";
import { FileReturnButton, PayReturnButton } from "@/components/channels/sales-tax-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { cn } from "@/lib/cn";

import { bankOptions, filings, liability } from "../queries";

export const metadata: Metadata = {
  title: "Sales tax",
};

/**
 * Sales tax by state and month, from the register every settlement and invoice writes to.
 * What Sooz owes is kept apart from what a marketplace collected and remitted itself: that
 * facilitator tax is reported on the return but never owed and never in 2200.
 */
export default async function SalesTaxPage() {
  const user = await requireUser("/channels/sales-tax");
  const [report, returns, banks] = await Promise.all([liability({}), filings(), bankOptions()]);
  const canFile = can(user.role, "ledger.post");
  const owedRows = [...report.rows].filter((r) => r.taxCents !== 0 || r.owedCents !== 0).reverse();
  const facilitatorRows = [...report.rows].filter((r) => r.facilitatorCents !== 0).reverse();
  const filedUnpaid = returns.filter((f) => f.entryId === null).reduce((sum, f) => sum + f.taxDueCents, 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Channels"
        title="Sales tax"
        description="What Sooz collected and owes each state, month by month. Tax a marketplace collected and remitted itself is shown apart: it goes on the return, but it is never owed."
        actions={canFile ? <FileReturnButton state="TX" period={null} owedCents={null} variant="default" label="Record a filed return" /> : null}
      />

      <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border bg-surface shadow-raised lg:grid-cols-4">
        <Figure label="Owed, not yet filed">
          <Money cents={report.totals.unfiledOwedCents} currency plain />
        </Figure>
        <Figure label="Filed, not yet paid" className="border-l">
          <Money cents={filedUnpaid} currency plain />
        </Figure>
        <Figure label="2200 Sales Tax Payable" className="border-t lg:border-t-0 lg:border-l">
          <Money cents={report.ledgerPayableCents} currency plain />
        </Figure>
        <Figure label="Register vs ledger" className="border-t border-l lg:border-t-0">
          <Money
            cents={report.differenceCents}
            currency
            signed={report.differenceCents !== 0}
            plain={report.differenceCents === 0}
            className={cn(report.differenceCents !== 0 && "text-warning")}
          />
        </Figure>
      </div>
      {report.differenceCents === 0 ? null : (
        <p className="-mt-2 px-1 text-xs text-warning">
          2200 and the register disagree by <Money cents={report.differenceCents} currency plain />: tax posted without a register
          entry (non-US tax, or a manual journal entry), or the reverse. Find it before filing.
        </p>
      )}

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Owed by Sooz, by state and month</CardTitle>
            <CardDescription>Collected from customers and held in 2200 until the return is paid.</CardDescription>
          </div>
        </CardHeader>
        {owedRows.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            No sales tax is recorded yet. It arrives when a settlement posts (Square tax is Texas tax) or an invoice charges it.{" "}
            <Link href="/channels" className="text-primary hover:underline">
              Square&apos;s settlements are the missing piece.
            </Link>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Sales tax owed by state and month</caption>
              <thead>
                <tr>
                  <Th className="w-40">Month</Th>
                  <Th className="w-16">State</Th>
                  <Th className="text-right">Taxable sales</Th>
                  <Th className="text-right">Tax owed</Th>
                  <Th className="text-right">Not yet filed</Th>
                  <Th className="w-32" />
                </tr>
              </thead>
              <tbody>
                {owedRows.map((r) => (
                  <tr key={`${r.state}-${r.period}`}>
                    <Td className="rule-row whitespace-nowrap">{monthName(r.period)}</Td>
                    <Td className="rule-row num">{r.state}</Td>
                    <Td className="rule-row text-right">
                      <Money cents={r.taxableCents} plain />
                    </Td>
                    <Td className="rule-row text-right">
                      <Money cents={r.owedCents} plain className="font-medium" />
                    </Td>
                    <Td className="rule-row text-right">
                      {r.unfiledOwedCents === 0 ? (
                        <Badge tone="positive" size="sm">
                          Filed
                        </Badge>
                      ) : (
                        <Money cents={r.unfiledOwedCents} plain className="text-warning" />
                      )}
                    </Td>
                    <Td className="rule-row text-right">
                      {canFile && r.unfiledOwedCents !== 0 ? (
                        <FileReturnButton state={r.state} period={r.period} owedCents={r.unfiledOwedCents} />
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="rule-subtotal rule-total px-3 py-1.5 text-right text-2xs font-semibold tracking-wider uppercase">
                    Total
                  </td>
                  <td className="rule-subtotal rule-total px-3 py-1.5 text-right font-semibold">
                    <Money cents={report.totals.owedCents} plain />
                  </td>
                  <td className="rule-subtotal rule-total px-3 py-1.5 text-right font-semibold">
                    <Money cents={report.totals.unfiledOwedCents} plain />
                  </td>
                  <td className="rule-subtotal rule-total" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Marketplace facilitator tax · pass-through</CardTitle>
            <CardDescription>
              Collected and remitted by Amazon, Faire or the Shop app on Sooz&apos;s sales. Reported on the return as marketplace
              sales; never owed, never in 2200.
            </CardDescription>
          </div>
          <Badge tone="neutral">Not owed</Badge>
        </CardHeader>
        {facilitatorRows.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">No marketplace has collected tax on Sooz&apos;s sales yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Marketplace facilitator tax by state and month</caption>
              <thead>
                <tr>
                  <Th className="w-40">Month</Th>
                  <Th className="w-16">State</Th>
                  <Th className="text-right">Collected and remitted by the marketplace</Th>
                </tr>
              </thead>
              <tbody>
                {facilitatorRows.map((r) => (
                  <tr key={`${r.state}-${r.period}`}>
                    <Td className="rule-row whitespace-nowrap">{monthName(r.period)}</Td>
                    <Td className="rule-row num">{r.state}</Td>
                    <Td className="rule-row text-right text-muted-foreground">
                      <Money cents={r.facilitatorCents} plain />
                    </Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} className="rule-subtotal rule-total px-3 py-1.5 text-right text-2xs font-semibold tracking-wider uppercase">
                    Total pass-through
                  </td>
                  <td className="rule-subtotal rule-total px-3 py-1.5 text-right font-semibold text-muted-foreground">
                    <Money cents={report.totals.facilitatorCents} plain />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Returns</CardTitle>
            <CardDescription>A filed return locks the tax it reported. Paying it posts Dr 2200 / Cr the bank.</CardDescription>
          </div>
        </CardHeader>
        {returns.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">No return has been recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Sales tax returns</caption>
              <thead>
                <tr>
                  <Th className="w-16">State</Th>
                  <Th>Period</Th>
                  <Th className="text-right">Gross sales</Th>
                  <Th className="text-right">Taxable</Th>
                  <Th className="text-right">Tax due</Th>
                  <Th className="w-28">Filed</Th>
                  <Th className="w-44">Paid</Th>
                </tr>
              </thead>
              <tbody>
                {returns.map((f) => (
                  <tr key={f.id}>
                    <Td className="rule-row num">{f.state}</Td>
                    <Td className="rule-row num text-xs whitespace-nowrap">
                      {longDate(f.periodStart)} – {longDate(f.periodEnd)}
                      {f.confirmation === null ? null : <span className="ml-2 text-muted-foreground">#{f.confirmation}</span>}
                    </Td>
                    <Td className="rule-row text-right">
                      <Money cents={f.grossSalesCents} plain />
                    </Td>
                    <Td className="rule-row text-right">
                      <Money cents={f.taxableCents} plain />
                    </Td>
                    <Td className="rule-row text-right">
                      <Money cents={f.taxDueCents} plain className="font-medium" />
                    </Td>
                    <Td className="rule-row text-xs whitespace-nowrap text-muted-foreground">{f.filedAt ?? "—"}</Td>
                    <Td className="rule-row">
                      {f.entryId !== null ? (
                        <Link href={`/ledger/${f.entryId}`} className="text-xs text-primary hover:underline">
                          {longDate(f.paidAt)} · #{f.entryNo}
                        </Link>
                      ) : f.taxDueCents === 0 ? (
                        <span className="text-xs text-muted-foreground">Nothing due</span>
                      ) : canFile ? (
                        <PayReturnButton filing={f} banks={banks} />
                      ) : (
                        <Badge tone="warning" size="sm">
                          Unpaid
                        </Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

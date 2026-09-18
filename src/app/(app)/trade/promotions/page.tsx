import type { Metadata } from "next";
import Link from "next/link";
import { CalendarPlus, CalendarRange } from "lucide-react";

import { longDate, percent, shortDate } from "@/components/trade/labels";
import { PromoStatusBadge, Table, TableScroll, Td, Th } from "@/components/trade/parts";
import { PromotionCalendar } from "@/components/trade/promotion-calendar";
import { TradeWorkflow } from "@/components/trade/workflow";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { today } from "@/lib/dates";

import { promotionRows } from "../queries";

export const metadata: Metadata = {
  title: "Promotions",
};

/**
 * Promotions on a calendar and in a register: what each was planned to cost, what has been
 * accrued month by month, what the distributor actually took for it, and the variance.
 */
export default async function PromotionsPage() {
  const user = await requireUser("/trade/promotions");
  const rows = await promotionRows(user.id);
  const canManage = can(user.role, "trade.manage");
  const totals = rows.reduce(
    (acc, r) => ({
      planned: acc.planned + r.plannedCents,
      accrued: acc.accrued + r.accruedCents,
      deducted: acc.deducted + r.deductedCents,
      open: acc.open + r.openAccrualCents,
      variance: acc.variance + r.accrualVarianceCents,
    }),
    { planned: 0, accrued: 0, deducted: 0, open: 0, variance: 0 },
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Trade"
        title="Promotions"
        description="Each promotion accrues its cost across its ship window, so trade spend lands in the month of the sales it paid for."
        actions={
          canManage ? (
            <Button asChild size="sm">
              <Link href="/trade/promotions/new">
                <CalendarPlus />
                New promotion
              </Link>
            </Button>
          ) : null
        }
      />

      {rows.length === 0 ? (
        <>
          <Card>
            <EmptyState
              icon={<CalendarRange />}
              title="No promotions planned"
              description="A promotion is a deal agreed with a distributor: an MCB billback, a scan-down, slotting for a new item. Plan it here with its products and allowance, and it accrues itself month by month until the deductions arrive to be charged against it."
              action={
                canManage ? (
                  <Button asChild size="sm">
                    <Link href="/trade/promotions/new">Plan a promotion</Link>
                  </Button>
                ) : undefined
              }
            />
          </Card>
          <TradeWorkflow />
        </>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>Calendar</CardTitle>
                <CardDescription>Bars are the performance window; the rule beneath is the ship window the accrual follows. The purple line is today.</CardDescription>
              </div>
            </CardHeader>
            <PromotionCalendar rows={rows} today={today()} />
          </Card>

          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>Plan, accrual and actual</CardTitle>
                <CardDescription>Variance is taken less accrued: positive means the distributor took more than was set aside.</CardDescription>
              </div>
            </CardHeader>
            <TableScroll>
              <Table caption="Promotions" className="min-w-[64rem]">
                <thead>
                  <tr>
                    <Th>Promotion</Th>
                    <Th>Runs</Th>
                    <Th>Status</Th>
                    <Th align="right">Planned</Th>
                    <Th align="right">Accrued</Th>
                    <Th align="right">Taken</Th>
                    <Th align="right">Still accrued</Th>
                    <Th align="right">Variance</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="rule-row">
                      <Td className="min-w-52">
                        <Link href={`/trade/promotions/${r.id}`} className="text-primary hover:underline">
                          {r.name}
                        </Link>
                        <span className="block text-2xs text-muted-foreground">
                          {r.customerName ?? "No customer"} · {r.typeLabel}
                          {r.authorizationNo ? ` · deal ${r.authorizationNo}` : ""}
                        </span>
                      </Td>
                      <Td className="num text-xs whitespace-nowrap text-muted-foreground">
                        {shortDate(r.startDate)} – {longDate(r.endDate)}
                      </Td>
                      <Td>
                        <PromoStatusBadge status={r.status} />
                      </Td>
                      <Td align="right">
                        <Money cents={r.plannedCents} plain />
                      </Td>
                      <Td align="right">
                        <Money cents={r.accruedCents} plain zeroDash />
                      </Td>
                      <Td align="right">
                        <Money cents={r.deductedCents} plain zeroDash />
                      </Td>
                      <Td align="right">
                        <Money cents={r.openAccrualCents} plain zeroDash />
                      </Td>
                      <Td align="right" className="whitespace-nowrap">
                        <Money cents={r.accrualVarianceCents} signed zeroDash plain={r.accrualVarianceCents <= 0} className={r.accrualVarianceCents > 0 ? "text-negative" : undefined} />
                        {r.accrualVarianceRatio !== null ? <span className="num ml-1.5 text-2xs text-muted-foreground">{percent(r.accrualVarianceRatio)}</span> : null}
                      </Td>
                    </tr>
                  ))}
                  <tr>
                    <Td className="rule-subtotal text-xs font-semibold text-muted-foreground" colSpan={3}>
                      {rows.length} {rows.length === 1 ? "promotion" : "promotions"}
                    </Td>
                    <Td align="right" className="rule-subtotal rule-total font-semibold">
                      <Money cents={totals.planned} plain />
                    </Td>
                    <Td align="right" className="rule-subtotal rule-total font-semibold">
                      <Money cents={totals.accrued} plain />
                    </Td>
                    <Td align="right" className="rule-subtotal rule-total font-semibold">
                      <Money cents={totals.deducted} plain />
                    </Td>
                    <Td align="right" className="rule-subtotal rule-total font-semibold">
                      <Money cents={totals.open} plain />
                    </Td>
                    <Td align="right" className="rule-subtotal rule-total font-semibold">
                      <Money cents={totals.variance} signed plain />
                    </Td>
                  </tr>
                </tbody>
              </Table>
            </TableScroll>
          </Card>
        </>
      )}
    </div>
  );
}

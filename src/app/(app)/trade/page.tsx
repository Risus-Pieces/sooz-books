import type { Metadata } from "next";
import Link from "next/link";
import { CalendarPlus, Upload } from "lucide-react";

import { DeductionTable } from "@/components/trade/deduction-table";
import { longDate, percent } from "@/components/trade/labels";
import { Table, TableScroll, Td, Th } from "@/components/trade/parts";
import { RemittanceFileGuide, TradeWorkflow } from "@/components/trade/workflow";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money, formatCents } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { cn } from "@/lib/cn";

import { tradeOverview } from "./queries";

export const metadata: Metadata = {
  title: "Trade",
};

/**
 * Trade spend at a glance: what promotions and deductions cost against gross sales, what is
 * still sitting in Deductions Receivable, which disputes are running out of window, and how
 * close each promotion's accrual came to what the distributor actually took.
 */
export default async function TradePage() {
  const user = await requireUser("/trade");
  const data = await tradeOverview(user.id);
  const canManage = can(user.role, "trade.manage");
  const quiet = data.promotionCount === 0 && data.remittanceCount === 0;
  const maxBucket = Math.max(1, ...data.buckets.map((b) => b.cents));
  const next = data.nearDeadline[0] ?? null;
  const variance = data.accrualVarianceCents;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Trade"
        title="Trade spend"
        description={`Promotions, distributor deductions and the accruals behind them, ${longDate(data.from)} to date.`}
        actions={
          canManage ? (
            <>
              <Button asChild size="sm" variant="secondary">
                <Link href="/trade/promotions/new">
                  <CalendarPlus />
                  New promotion
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/trade/remittances">
                  <Upload />
                  Import remittance
                </Link>
              </Button>
            </>
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Trade rate"
          value={percent(data.tradeSpendRatio)}
          hint="of gross sales"
          footer={
            data.grossSalesCents === 0 ? (
              "No customer-tagged sales posted this year."
            ) : (
              <span>
                <Money cents={data.tradeSpendCents} currency plain className="text-xs" /> spent on{" "}
                <Money cents={data.grossSalesCents} currency plain className="text-xs" /> gross.
              </span>
            )
          }
        />
        <StatTile
          label="Open deductions"
          value={<Money cents={data.openReceivableCents} currency plain />}
          hint={`${data.openCount} in 1210`}
          footer={
            data.openCount === 0 ? (
              "Nothing waiting in Deductions Receivable."
            ) : (
              <span>
                <Money cents={data.unappliedCents} plain className="text-xs" /> unclassified.{" "}
                <Link href="/trade/deductions" className="text-primary hover:underline">
                  Workbench
                </Link>
              </span>
            )
          }
        />
        <StatTile
          label="Disputes near deadline"
          value={<span className={cn("num", data.nearDeadline.length > 0 && "text-warning")}>{data.nearDeadline.length}</span>}
          hint="≥ 60% of window"
          footer={
            next === null
              ? "No dispute window is running short."
              : `Next: ${next.deductionNo}, ${next.daysToDeadline !== null && next.daysToDeadline < 0 ? "missed" : "due"} ${longDate(next.disputeDeadline)}.`
          }
        />
        <StatTile
          label="Accrual vs actual"
          value={data.accruedCents === 0 && data.actualCents === 0 ? "—" : formatCents(variance, { currency: true, signed: true })}
          delta={data.accrualVarianceRatio === null ? undefined : percent(data.accrualVarianceRatio)}
          deltaTone={variance > 0 ? "negative" : variance < 0 ? "positive" : "neutral"}
          deltaLabel={data.accrualVarianceRatio === null ? undefined : variance > 0 ? "under-accrued" : "over-accrued"}
          footer={
            data.accruedCents === 0 && data.actualCents === 0 ? (
              "Nothing accrued or deducted against a promotion yet."
            ) : (
              <span>
                <Money cents={data.accruedCents} plain className="text-xs" /> accrued,{" "}
                <Money cents={data.actualCents} plain className="text-xs" /> taken.
              </span>
            )
          }
        />
      </div>

      {quiet ? (
        <>
          <TradeWorkflow />
          <RemittanceFileGuide />
        </>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>Dispute windows running out</CardTitle>
                <CardDescription>Open deductions past 60% of their window. Past 80% they escalate; past the deadline only a write-off or a recovery is left.</CardDescription>
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href="/trade/deductions">All deductions</Link>
              </Button>
            </CardHeader>
            <DeductionTable rows={data.nearDeadline} compact empty="No open deduction is past 60% of its dispute window." />
          </Card>

          <div className="grid items-start gap-4 lg:grid-cols-[2fr_3fr]">
            <Card>
              <CardHeader>
                <div className="min-w-0">
                  <CardTitle>Deductions receivable by age</CardTitle>
                  <CardDescription>Days since the distributor took it, as of {longDate(data.asOf)}.</CardDescription>
                </div>
              </CardHeader>
              <dl className="flex flex-col gap-2 px-4 py-3">
                {data.buckets.map((b) => (
                  <div key={b.label} className="grid grid-cols-[4.5rem_1fr_6.5rem] items-center gap-3">
                    <dt className="num text-xs text-muted-foreground">{b.label}d</dt>
                    <div className="h-2 rounded-xs bg-muted">
                      <div className="h-full rounded-xs bg-warning/70" style={{ width: `${(b.cents / maxBucket) * 100}%` }} />
                    </div>
                    <dd className="text-right text-sm">
                      <Money cents={b.cents} plain zeroDash />
                    </dd>
                  </div>
                ))}
              </dl>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border px-4 py-3 text-xs">
                <div>
                  <dt className="eyebrow">Deduction rate</dt>
                  <dd className="num text-sm text-foreground">{percent(data.deductionRate)}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Recovery rate</dt>
                  <dd className="num text-sm text-foreground">
                    {percent(data.recoveryRate)} <span className="text-2xs text-muted-foreground">{data.casesClosed} closed</span>
                  </dd>
                </div>
                <div>
                  <dt className="eyebrow">Days to deduction</dt>
                  <dd className="num text-sm text-foreground">
                    {data.daysToDeduction.p50Days ?? "—"}
                    <span className="text-2xs text-muted-foreground"> median · p90 {data.daysToDeduction.p90Days ?? "—"}</span>
                  </dd>
                </div>
                <div>
                  <dt className="eyebrow">Dispute win rate</dt>
                  <dd className="num text-sm text-foreground">{percent(data.winRate)}</dd>
                </div>
              </dl>
            </Card>

            <Card>
              <CardHeader>
                <div className="min-w-0">
                  <CardTitle>Accrual vs actual, by promotion</CardTitle>
                  <CardDescription>Positive means the distributor took more than was accrued: a margin surprise.</CardDescription>
                </div>
              </CardHeader>
              {data.variances.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">No promotion has an accrual or a deduction yet.</p>
              ) : (
                <TableScroll>
                  <Table caption="Accrual variance by promotion" className="min-w-[30rem]">
                    <thead>
                      <tr>
                        <Th>Promotion</Th>
                        <Th align="right">Accrued</Th>
                        <Th align="right">Taken</Th>
                        <Th align="right">Variance</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.variances.map((v) => (
                        <tr key={v.promotionId} className="rule-row">
                          <Td>
                            <Link href={`/trade/promotions/${v.promotionId}`} className="text-primary hover:underline">
                              {v.name}
                            </Link>
                          </Td>
                          <Td align="right">
                            <Money cents={v.accruedCents} plain />
                          </Td>
                          <Td align="right">
                            <Money cents={v.actualCents} plain />
                          </Td>
                          <Td align="right">
                            <Money cents={v.varianceCents} signed className={v.varianceCents > 0 ? "text-negative" : undefined} plain={v.varianceCents <= 0} />
                            <span className="num ml-1.5 text-2xs text-muted-foreground">{percent(v.varianceRatio)}</span>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </TableScroll>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

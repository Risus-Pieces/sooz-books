import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeductionTable } from "@/components/trade/deduction-table";
import { longDate, monthLabel, percent } from "@/components/trade/labels";
import { Fact, PromoStatusBadge, Table, TableScroll, Td, Th } from "@/components/trade/parts";
import { AccrueButton, ClosePromotionButton } from "@/components/trade/promotion-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { today } from "@/lib/dates";

import { promotionDetail } from "../../queries";

export async function generateMetadata({ params }: { params: Promise<{ promotionId: string }> }): Promise<Metadata> {
  const [user, { promotionId }] = await Promise.all([requireUser(), params]);
  const detail = await promotionDetail(promotionId, user.id);
  return { title: detail === null ? "Promotion" : detail.row.name };
}

/**
 * One promotion: the plan, its month-by-month accrual (posted and still to post), the
 * deductions charged against it, and the variance. Accruing and closing each show the entries
 * they post first.
 */
export default async function PromotionPage({ params }: { params: Promise<{ promotionId: string }> }) {
  const [user, { promotionId }] = await Promise.all([requireUser(), params]);
  const detail = await promotionDetail(promotionId, user.id);
  if (detail === null) notFound();
  const { row } = detail;
  const canManage = can(user.role, "trade.manage");
  const open = row.status === "planned" || row.status === "active";
  const now = today();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Trade · Promotion"
        title={row.name}
        meta={<PromoStatusBadge status={row.status} />}
        description={`${row.customerName ?? "No customer"} · ${row.typeLabel} · runs ${longDate(row.startDate)} to ${longDate(row.endDate)}${
          row.shipStartDate !== null && row.shipEndDate !== null ? ` · ships ${longDate(row.shipStartDate)} to ${longDate(row.shipEndDate)}` : ""
        }`}
        actions={
          canManage && open ? (
            <>
              <ClosePromotionButton promotionId={row.id} release={detail.releasePreview} today={now} cancel />
              <ClosePromotionButton promotionId={row.id} release={detail.releasePreview} today={now} cancel={false} />
              <AccrueButton promotionId={row.id} due={detail.duePreview} through={detail.dueThrough} />
            </>
          ) : null
        }
      />

      <Card>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Planned">
            <Money cents={row.plannedCents} currency plain />
          </Fact>
          <Fact label="Accrued">
            <Money cents={row.accruedCents} plain zeroDash />
          </Fact>
          <Fact label="Taken by deductions">
            <Money cents={row.deductedCents} plain zeroDash />
          </Fact>
          <Fact label="Still accrued">
            <Money cents={row.openAccrualCents} plain zeroDash />
          </Fact>
          <Fact label="Released on close">
            <Money cents={row.releasedCents} plain zeroDash />
          </Fact>
          <Fact label="Accrual variance">
            <Money cents={row.accrualVarianceCents} signed zeroDash plain={row.accrualVarianceCents <= 0} className={row.accrualVarianceCents > 0 ? "text-negative" : undefined} />
            <span className="num ml-1.5 text-2xs text-muted-foreground">{percent(row.accrualVarianceRatio)}</span>
          </Fact>
        </dl>
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Deal number <span className="num text-foreground">{row.authorizationNo ?? "none"}</span>
          {row.authorizationNo === null ? " — deductions can only be tied to this promotion by hand." : " — deductions quoting it are charged against this accrual."}
          {detail.notes ? <span className="block pt-1 text-foreground">{detail.notes}</span> : null}
        </p>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Accrual schedule</CardTitle>
              <CardDescription>
                Dr {detail.contraAccount.code} {detail.contraAccount.name}
                {detail.fixedFeeCents > 0 ? " and 4560 for fixed fees" : ""}, Cr 2120 Accrued Trade Spend, at each month-end.
              </CardDescription>
            </div>
          </CardHeader>
          <TableScroll>
            <Table caption="Accrual schedule" className="min-w-[30rem]">
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th align="right">Days</Th>
                  <Th align="right">Allowance</Th>
                  <Th align="right">Fees</Th>
                  <Th align="right">Accrual</Th>
                  <Th>Posted</Th>
                </tr>
              </thead>
              <tbody>
                {detail.schedule.map((m) => (
                  <tr key={m.periodEnd} className="rule-row">
                    <Td className="num text-xs whitespace-nowrap">{monthLabel(m.periodEnd)}</Td>
                    <Td align="right" className="num text-xs text-muted-foreground">
                      {m.days}
                    </Td>
                    <Td align="right">
                      <Money cents={m.allowanceCents} plain zeroDash />
                    </Td>
                    <Td align="right">
                      <Money cents={m.feeCents} plain zeroDash />
                    </Td>
                    <Td align="right" className="font-medium">
                      <Money cents={m.allowanceCents + m.feeCents} plain />
                    </Td>
                    <Td className="text-xs">
                      {m.entryId !== null ? (
                        <Link href={`/ledger/${m.entryId}`} className="num text-primary hover:underline">
                          JE #{m.entryNo}
                        </Link>
                      ) : m.periodEnd <= now && open ? (
                        <Badge tone="warning" size="sm">
                          Due
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">{open ? `on ${longDate(m.periodEnd)}` : "—"}</span>
                      )}
                    </Td>
                  </tr>
                ))}
                <tr>
                  <Td className="rule-subtotal text-xs font-semibold text-muted-foreground" colSpan={2}>
                    {detail.schedule.length} {detail.schedule.length === 1 ? "month" : "months"}
                  </Td>
                  <Td align="right" className="rule-subtotal rule-total font-semibold">
                    <Money cents={detail.allowanceCents} plain />
                  </Td>
                  <Td align="right" className="rule-subtotal rule-total font-semibold">
                    <Money cents={detail.fixedFeeCents} plain zeroDash />
                  </Td>
                  <Td align="right" className="rule-subtotal rule-total font-semibold">
                    <Money cents={detail.allowanceCents + detail.fixedFeeCents} plain />
                  </Td>
                  <Td className="rule-subtotal" />
                </tr>
              </tbody>
            </Table>
          </TableScroll>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>What it pays for</CardTitle>
              <CardDescription>Units times the allowance per unit, plus any fixed fee.</CardDescription>
            </div>
          </CardHeader>
          {detail.products.length === 0 ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">Planned as a whole deal, not per product.</p>
          ) : (
            <TableScroll>
              <Table caption="Products on the promotion" className="min-w-[24rem]">
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th align="right">Units</Th>
                    <Th align="right">Per unit</Th>
                    <Th align="right">Extended</Th>
                  </tr>
                </thead>
                <tbody>
                  {detail.products.map((p) => (
                    <tr key={p.sku} className="rule-row">
                      <Td>
                        <span className="num mr-1.5 text-xs text-muted-foreground">{p.sku}</span>
                        {p.name}
                      </Td>
                      <Td align="right" className="num text-xs">
                        {p.units ?? "—"}
                      </Td>
                      <Td align="right">{p.allowancePerUnitCents === null ? "—" : <Money cents={p.allowancePerUnitCents} plain />}</Td>
                      <Td align="right">
                        <Money cents={p.extendedCents} plain />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
          <dl className="grid grid-cols-2 gap-3 border-t border-border px-4 py-3">
            <Fact label="Allowance">
              <Money cents={detail.allowanceCents} plain />
            </Fact>
            <Fact label="Fixed fees">
              <Money cents={detail.fixedFeeCents} plain zeroDash />
            </Fact>
          </dl>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Deductions charged to it</CardTitle>
            <CardDescription>Taken by the distributor quoting this promotion’s deal number, or tied to it when validated.</CardDescription>
          </div>
        </CardHeader>
        <DeductionTable rows={detail.deductions} compact deadlines={false} empty="No deduction has been charged against this promotion yet." />
      </Card>
    </div>
  );
}

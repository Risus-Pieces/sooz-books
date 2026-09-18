import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CategoryBars } from "@/components/charts";
import { DeductionTable } from "@/components/trade/deduction-table";
import { longDate, monthLabel, percent, shortDate } from "@/components/trade/labels";
import { PromoStatusPill } from "@/components/trade/parts";
import { AccrueButton, ClosePromotionButton } from "@/components/trade/promotion-actions";
import { PROMO_TINT } from "@/components/trade/promotion-calendar";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { DetailPane } from "@/components/ui/detail-pane";
import { Glyph } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { ToolbarGroup } from "@/components/ui/toolbar";
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
 * One promotion: plan, accrued, taken and released as bars, the month-by-month accrual (posted and
 * still to post), what it pays for, and the deductions charged against it. Accruing and closing
 * each show the entries they post first.
 */
export default async function PromotionPage({ params }: { params: Promise<{ promotionId: string }> }) {
  const [user, { promotionId }] = await Promise.all([requireUser(), params]);
  const detail = await promotionDetail(promotionId, user.id);
  if (detail === null) notFound();
  const { row } = detail;
  const canManage = can(user.role, "trade.manage");
  const open = row.status === "planned" || row.status === "active";
  const now = today();
  const varianceBad = row.accrualVarianceCents > 0;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Promotion"
        phoneTitleRow
        back={{ href: "/trade/promotions", label: "Promotions" }}
        info={
          <>
            <p>
              Each month-end of the ship window posts Dr {detail.contraAccount.code} {detail.contraAccount.name}
              {detail.fixedFeeCents > 0 ? " and 4560 for fixed fees" : ""}, Cr 2120 Accrued Trade Spend, so the cost lands with the sales.
            </p>
            <p>Closing releases whatever is still accrued and unclaimed back to contra revenue.</p>
          </>
        }
        actions={
          canManage && open ? (
            <ToolbarGroup>
              <ClosePromotionButton promotionId={row.id} release={detail.releasePreview} today={now} cancel={false} />
              <ClosePromotionButton promotionId={row.id} release={detail.releasePreview} today={now} cancel />
            </ToolbarGroup>
          ) : undefined
        }
      />

      <DetailPane
        leading={<IconBadge glyph="megaphone" tint={PROMO_TINT[row.status] ?? "gray"} size="xl" className="size-14 rounded-[14px] [&_svg]:size-7" />}
        title={row.name}
        meta={[row.customerName ?? "No customer", row.typeLabel, `${shortDate(row.startDate)} – ${longDate(row.endDate)}`]}
        amount={<Money cents={row.plannedCents} currency plain />}
        status={
          <div className="flex flex-wrap gap-1.5">
            <PromoStatusPill status={row.status} />
            {row.authorizationNo !== null ? (
              <Pill tone="neutral" glyph="tag">
                Deal <span className="num">{row.authorizationNo}</span>
              </Pill>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Pill tone="orange" glyph="tag">
                  No deal number
                </Pill>
                <InfoButton label="About the deal number">
                  <p>Without a deal number, deductions can only be tied to this promotion by hand.</p>
                </InfoButton>
              </span>
            )}
          </div>
        }
        actions={canManage && open && detail.duePreview.length > 0 ? <AccrueButton promotionId={row.id} due={detail.duePreview} through={detail.dueThrough} /> : undefined}
      >
        <section aria-labelledby="plan" className="rounded-[14px] bg-card px-5 pt-4 pb-3 shadow-card max-sm:px-4">
          <div className="mb-1 flex items-baseline gap-2">
            <h2 id="plan" className="flex-1 text-lg font-semibold tracking-[-0.01em]">
              Plan and actual
            </h2>
            <span className={varianceBad ? "text-sm font-semibold text-ink-red" : "text-sm font-semibold text-label2"}>
              <Money cents={row.accrualVarianceCents} currency signed plain zeroDash /> <span className="num text-xs">{percent(row.accrualVarianceRatio)}</span>
            </span>
          </div>
          <CategoryBars
            rows={[
              { key: "planned", label: "Planned", tint: "gray", cents: row.plannedCents },
              { key: "accrued", label: "Accrued", tint: "cyan", cents: row.accruedCents },
              { key: "taken", label: "Taken", tint: "orange", cents: row.deductedCents },
              { key: "open", label: "Still accrued", tint: "teal", cents: row.openAccrualCents },
              ...(row.releasedCents !== 0 ? [{ key: "released", label: "Released", tint: "mint" as const, cents: row.releasedCents }] : []),
            ]}
          />
        </section>

        <InsetGroup header="Accrual" separatorInset={16}>
          {detail.schedule.map((m) => (
            <GroupRow
              key={m.periodEnd}
              label={
                <span>
                  {monthLabel(m.periodEnd)} <span className="num text-xs text-label2">· {m.days}d</span>
                </span>
              }
            >
              {m.entryId !== null ? (
                <Link href={`/ledger/${m.entryId}`} className="num inline-flex items-center gap-1 text-xs font-semibold text-ink-green hover:underline">
                  <Glyph name="check-circle" size={12} />#{m.entryNo}
                </Link>
              ) : m.periodEnd <= now && open ? (
                <Pill tone="orange" className="self-auto">
                  Due
                </Pill>
              ) : (
                <span className="text-xs">{open ? shortDate(m.periodEnd) : "—"}</span>
              )}
              <Money cents={m.allowanceCents + m.feeCents} currency plain className="w-24 text-right text-label" />
            </GroupRow>
          ))}
        </InsetGroup>

        <InsetGroup header="Pays for" separatorInset={16}>
          {detail.products.map((p) => (
            <GroupRow
              key={p.sku}
              label={
                <span>
                  {p.name} <span className="num text-xs text-label2">{p.sku}</span>
                </span>
              }
            >
              <span className="num text-xs">
                {p.units ?? "—"} × {p.allowancePerUnitCents === null ? "—" : <Money cents={p.allowancePerUnitCents} currency plain />}
              </span>
              <Money cents={p.extendedCents} currency plain className="text-label" />
            </GroupRow>
          ))}
          {detail.products.length === 0 ? (
            <GroupRow label="Allowance">
              <Money cents={detail.allowanceCents} currency plain className="text-label" />
            </GroupRow>
          ) : null}
          <GroupRow label="Fixed fees">
            <Money cents={detail.fixedFeeCents} currency plain zeroDash className="text-label" />
          </GroupRow>
          {row.shipStartDate !== null && row.shipEndDate !== null ? (
            <GroupRow label="Ships">
              {shortDate(row.shipStartDate)} – {longDate(row.shipEndDate)}
            </GroupRow>
          ) : null}
        </InsetGroup>

        {detail.notes ? (
          <InsetGroup header="Notes">
            <p className="px-4 py-3 text-sm whitespace-pre-line">{detail.notes}</p>
          </InsetGroup>
        ) : null}

        <section aria-labelledby="charged">
          <h3 id="charged" className="px-4 pt-5 pb-1.5 text-sm font-semibold text-label2">
            Deductions
          </h3>
          <div className="overflow-hidden rounded-[14px] bg-card shadow-card">
            <DeductionTable rows={detail.deductions} deadlines={false} empty="None charged yet" />
          </div>
        </section>
      </DetailPane>
    </div>
  );
}

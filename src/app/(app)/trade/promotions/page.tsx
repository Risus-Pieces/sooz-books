import type { Metadata } from "next";
import Link from "next/link";

import { shortDate } from "@/components/trade/labels";
import { PROMO_LABEL } from "@/components/trade/parts";
import { PROMO_TINT, PromotionCalendar } from "@/components/trade/promotion-calendar";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconBadge } from "@/components/ui/icon-badge";
import { InsetGroup, ListRow } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { StatTile } from "@/components/ui/stat-tile";
import { ToolbarGroup, ToolbarLink } from "@/components/ui/toolbar";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { today } from "@/lib/dates";

import { promotionRows } from "../queries";

export const metadata: Metadata = {
  title: "Promotions",
};

/**
 * Promotions on a calendar, then as a list: what each was planned to cost, what has been accrued,
 * and what the distributor actually took for it.
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
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Promotions"
        subtitle={
          rows.length === 0 ? undefined : (
            <>
              {rows.length} · <Money cents={totals.planned} currency plain /> planned
            </>
          )
        }
        info={
          <>
            <p>Each promotion accrues its cost across its ship window, so trade spend lands in the month of the sales it paid for.</p>
            <p>Variance is taken less accrued: positive means the distributor took more than was set aside.</p>
          </>
        }
        actions={
          canManage ? (
            <ToolbarGroup>
              <ToolbarLink href="/trade/promotions/new" glyph="plus" label="New promotion" />
            </ToolbarGroup>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <div className="rounded-2xl bg-card shadow-card max-md:rounded-[22px]">
          <EmptyState
            glyph="calendar"
            title="No promotions planned"
            description="A promotion is a deal agreed with a distributor: an MCB billback, a scan-down, slotting for a new item. Plan it here with its products and allowance, and it accrues itself month by month until the deductions arrive to be charged against it."
            action={
              canManage ? (
                <Button asChild>
                  <Link href="/trade/promotions/new">New promotion</Link>
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3.5 max-md:gap-3 lg:grid-cols-4">
            <StatTile label="Planned" badge={<IconBadge glyph="calendar" tint="gray" />} value={<Money cents={totals.planned} currency plain />} />
            <StatTile label="Accrued" badge={<IconBadge glyph="hourglass" tint="cyan" />} value={<Money cents={totals.accrued} currency plain />} />
            <StatTile label="Taken" badge={<IconBadge glyph="arrow-out" tint="orange" />} value={<Money cents={totals.deducted} currency plain />} />
            <StatTile
              label="Variance"
              badge={<IconBadge glyph="split" tint={totals.variance > 0 ? "red" : "green"} />}
              value={<Money cents={totals.variance} currency signed plain className={totals.variance > 0 ? "text-ink-red" : undefined} />}
            />
          </div>

          <section aria-labelledby="calendar" className="overflow-hidden rounded-2xl bg-card shadow-card max-md:rounded-[22px]">
            <h2 id="calendar" className="px-5 pt-[18px] pb-2 text-lg font-semibold tracking-[-0.01em] max-md:px-4">
              Calendar
            </h2>
            <PromotionCalendar rows={rows} today={today()} />
          </section>

          <InsetGroup header="All" separatorInset={63}>
            {rows.map((r) => (
              <ListRow
                key={r.id}
                href={`/trade/promotions/${r.id}`}
                chevron
                leading={<IconBadge glyph="megaphone" tint={PROMO_TINT[r.status] ?? "gray"} size="xl" className="rounded-full" />}
                title={r.name}
                subtitle={
                  <>
                    {r.customerName ?? "No customer"} · {r.typeLabel}
                  </>
                }
                trailing={<Money cents={r.plannedCents} currency plain />}
                detail={
                  <>
                    <span className="max-sm:hidden">
                      {shortDate(r.startDate)} – {shortDate(r.endDate)} ·{" "}
                    </span>
                    {PROMO_LABEL[r.status] ?? r.status}
                  </>
                }
              />
            ))}
          </InsetGroup>
        </>
      )}
    </div>
  );
}

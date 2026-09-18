import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

import { CategoryBars, SplitBar } from "@/components/charts";
import { longDate, percent } from "@/components/trade/labels";
import { DeadlineTimeline } from "@/components/trade/parts";
import { TradeWorkflow } from "@/components/trade/workflow";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Glyph } from "@/components/ui/glyph";
import { IconBadge, LegendItem } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { Money } from "@/components/ui/money";
import { ToolbarGroup, ToolbarLink } from "@/components/ui/toolbar";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";
import type { GlyphName } from "@/lib/ui/glyphs";
import type { Tint } from "@/lib/ui/tints";

import { tradeOverview } from "./queries";

export const metadata: Metadata = {
  title: "Trade",
};

const AGE_TINTS: Tint[] = ["blue", "teal", "orange", "red", "pink"];

/**
 * Trade spend at a glance: what promotions and deductions cost against gross sales, what is still
 * in Deductions Receivable, which disputes are running out of window, and how close each
 * promotion's accrual came to what the distributor actually took.
 */
export default async function TradePage() {
  const user = await requireUser("/trade");
  const data = await tradeOverview(user.id);
  const canManage = can(user.role, "trade.manage");
  const quiet = data.promotionCount === 0 && data.remittanceCount === 0;
  const next = data.nearDeadline[0] ?? null;
  const variance = data.accrualVarianceCents;
  const nothingAccrued = data.accruedCents === 0 && data.actualCents === 0;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Trade"
        subtitle={`Since ${longDate(data.from)}`}
        info={<p>Promotions, distributor deductions and the accruals behind them, {longDate(data.from)} to date.</p>}
        actions={
          canManage ? (
            <ToolbarGroup>
              <ToolbarLink href="/trade/promotions/new" glyph="plus" label="New promotion" />
              <ToolbarLink href="/trade/remittances#import" glyph="import" label="Import remittance" />
            </ToolbarGroup>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3.5 max-md:gap-3 lg:grid-cols-4">
        <Tile href="/trade/promotions" glyph="percent" tint="cyan" label="Trade rate" cap="of gross">
          <Figure>{percent(data.tradeSpendRatio)}</Figure>
          <div className="mt-auto flex flex-col gap-1.5">
            <SplitBar
              label={`Trade spend ${dollars(data.tradeSpendCents)} of gross sales ${dollars(data.grossSalesCents)}`}
              segments={[
                { label: "Trade spend", value: data.tradeSpendCents, tint: "cyan" },
                { label: "Gross sales", value: Math.max(0, data.grossSalesCents - data.tradeSpendCents), tint: "green", muted: true },
              ]}
            />
            <p className="truncate text-xs font-medium text-label2">
              <Money cents={data.tradeSpendCents} currency plain whole /> of <Money cents={data.grossSalesCents} currency plain whole />
            </p>
          </div>
        </Tile>
        <Tile href="/trade/deductions" glyph="flag" tint="orange" label="Open" cap={`${data.openCount} in 1210`}>
          <Figure>
            <Money cents={data.openReceivableCents} currency plain />
          </Figure>
          <div className="mt-auto flex flex-col gap-1.5">
            <SplitBar
              label={data.buckets.map((b) => `${b.label} days ${dollars(b.cents)}`).join(", ")}
              segments={data.buckets.map((b, i) => ({ label: b.label, value: b.cents, tint: AGE_TINTS[i % AGE_TINTS.length] }))}
            />
            <p className="truncate text-xs font-medium text-label2">
              <Money cents={data.unappliedCents} currency plain whole /> unclassified
            </p>
          </div>
        </Tile>
        <Tile href="/trade/deductions" glyph="clock" tint={data.nearDeadline.length > 0 ? "red" : "gray"} label="Deadlines" cap="≥ 60%">
          <Figure className={data.nearDeadline.length > 0 ? "text-ink-orange" : undefined}>{data.nearDeadline.length}</Figure>
          <p className="mt-auto truncate text-xs font-medium text-label2">
            {next === null
              ? "None running short"
              : `${next.deductionNo} · ${next.daysToDeadline !== null && next.daysToDeadline < 0 ? "missed" : "due"} ${longDate(next.disputeDeadline)}`}
          </p>
        </Tile>
        <Tile href="/trade/promotions" glyph="split" tint={variance > 0 ? "red" : "green"} label="Accrual" cap="vs taken">
          <Figure className={variance > 0 ? "text-ink-red" : undefined}>
            {nothingAccrued ? "—" : <Money cents={variance} currency signed plain />}
          </Figure>
          <div className="mt-auto flex flex-col gap-1.5">
            <SplitBar
              label={`Accrued ${dollars(data.accruedCents)}, taken ${dollars(data.actualCents)}`}
              segments={[
                { label: "Accrued", value: data.accruedCents, tint: "cyan" },
                { label: "Taken", value: data.actualCents, tint: "orange" },
              ]}
            />
            <p className="truncate text-xs font-medium text-label2">{data.accrualVarianceRatio === null ? "Nothing accrued" : `${percent(data.accrualVarianceRatio)} ${variance > 0 ? "under" : "over"}`}</p>
          </div>
        </Tile>
      </div>

      {quiet ? (
        <TradeWorkflow />
      ) : (
        <>
          <section aria-labelledby="running-out" className="rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4">
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 id="running-out" className="flex flex-1 items-center gap-1 text-lg font-semibold tracking-[-0.01em]">
                Running out
                <InfoButton label="About dispute windows" align="start">
                  <p>Open deductions past 60% of their window. Past 80% they escalate; past the deadline only a write-off or a recovery is left.</p>
                </InfoButton>
              </h2>
              <div className="flex gap-3.5">
                <LegendItem tint="orange">60%</LegendItem>
                <LegendItem tint="red">80%</LegendItem>
              </div>
              <Link href="/trade/deductions" aria-label="All deductions" className="grid size-6 place-items-center rounded-full text-label3 hover:text-label2">
                <Glyph name="chevron-right" size={14} weight={2.2} />
              </Link>
            </div>
            {data.nearDeadline.length === 0 ? (
              <p className="py-6 text-center text-sm text-label2">Nothing running short</p>
            ) : (
              <DeadlineTimeline
                items={data.nearDeadline.map((r) => ({ id: r.id, label: r.deductionNo, daysToDeadline: r.daysToDeadline ?? 0, alert: r.alert, cents: r.openCents }))}
              />
            )}
          </section>

          <div className="grid items-start gap-3.5 max-md:gap-3 lg:grid-cols-[2fr_3fr]">
            <section aria-labelledby="by-age" className="rounded-2xl bg-card px-5 pt-[18px] pb-3 shadow-card max-md:rounded-[22px] max-md:p-4">
              <h2 id="by-age" className="mb-1 text-lg font-semibold tracking-[-0.01em]">
                By age
              </h2>
              <CategoryBars rows={data.buckets.map((b, i) => ({ key: b.label, label: `${b.label} days`, tint: AGE_TINTS[i % AGE_TINTS.length], cents: b.cents, href: "/trade/deductions" }))} />
              <dl className="mt-3 grid grid-cols-2 overflow-hidden rounded-[11px] bg-inset">
                {[
                  { label: "Deduction rate", value: percent(data.deductionRate) },
                  { label: "Recovery", value: `${percent(data.recoveryRate)} · ${data.casesClosed}` },
                  { label: "Days to deduct", value: `${data.daysToDeduction.p50Days ?? "—"} · p90 ${data.daysToDeduction.p90Days ?? "—"}` },
                  { label: "Win rate", value: percent(data.winRate) },
                ].map((f, i) => (
                  <div key={f.label} className={cn("px-3 py-2", i % 2 === 1 && "hairline-l", i >= 2 && "hairline-t")}>
                    <dt className="text-2xs font-semibold text-label2">{f.label}</dt>
                    <dd className="num text-sm font-semibold">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section aria-labelledby="variance" className="rounded-2xl bg-card px-5 pt-[18px] pb-3 shadow-card max-md:rounded-[22px] max-md:p-4">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 id="variance" className="flex flex-1 items-center gap-1 text-lg font-semibold tracking-[-0.01em]">
                  Accrued vs taken
                  <InfoButton label="About the variance" align="start">
                    <p>Positive means the distributor took more than was accrued: a margin surprise.</p>
                  </InfoButton>
                </h2>
                <div className="flex gap-3.5">
                  <LegendItem tint="cyan">Accrued</LegendItem>
                  <LegendItem tint="orange">Taken</LegendItem>
                </div>
              </div>
              {data.variances.length === 0 ? (
                <p className="py-6 text-center text-sm text-label2">Nothing accrued yet</p>
              ) : (
                <ul className="flex flex-col">
                  {data.variances.map((v, index) => {
                    const max = Math.max(1, v.accruedCents, v.actualCents);
                    return (
                      <li key={v.promotionId} className={cn(index > 0 && "hairline-t")}>
                        <Link href={`/trade/promotions/${v.promotionId}`} className="block rounded-[6px] py-2 outline-none focus-ring hover:opacity-80 focus-visible:bg-fill2">
                          <span className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{v.name}</span>
                            <Money cents={v.varianceCents} currency signed plain className={cn("text-sm font-semibold", v.varianceCents > 0 && "text-ink-red")} />
                            <span className="num text-2xs text-label2">{percent(v.varianceRatio)}</span>
                          </span>
                          <span aria-hidden className="mt-1.5 flex flex-col gap-1">
                            <span className="block h-1 rounded-[2px] bg-tint-cyan" style={{ width: `${Math.max(0.6, (v.accruedCents / max) * 100)}%` }} />
                            <span className="block h-1 rounded-[2px] bg-tint-orange" style={{ width: `${Math.max(0.6, (v.actualCents / max) * 100)}%` }} />
                          </span>
                          <span className="sr-only">
                            Accrued {dollars(v.accruedCents)}, taken {dollars(v.actualCents)}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ href, glyph, tint, label, cap, children }: { href: string; glyph: GlyphName; tint: Tint; label: string; cap?: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="flex min-h-[148px] min-w-0 flex-col gap-2 rounded-2xl bg-card px-[18px] py-4 shadow-card transition-shadow outline-none hover:shadow-glass focus-visible:ring-2 focus-visible:ring-tint-blue max-md:min-h-[136px] max-md:rounded-[22px] max-md:p-3.5"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
        <IconBadge glyph={glyph} tint={tint} />
        <span className="truncate">{label}</span>
        {cap ? <span className="ml-auto shrink-0 rounded-[6px] bg-fill2 px-[7px] py-0.5 text-2xs font-semibold text-label2 max-sm:hidden">{cap}</span> : null}
      </span>
      {children}
    </Link>
  );
}

function Figure({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("num block text-3xl leading-[1.1] font-bold tracking-[-0.028em] max-md:text-2xl", className)}>{children}</span>;
}

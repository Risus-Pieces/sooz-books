import type { Metadata } from "next";
import Link from "next/link";

import { SplitBar } from "@/components/charts";
import { DeductionWorkbench } from "@/components/trade/deduction-workbench";
import { DeadlineTimeline } from "@/components/trade/parts";
import { DEDUCTION_TABS, type DeductionTab, isDeductionTab } from "@/components/trade/types";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LegendItem } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import { SegmentedNav } from "@/components/ui/segmented-control";
import { ToolbarGroup, ToolbarLink } from "@/components/ui/toolbar";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { today } from "@/lib/dates";
import { AGING_BUCKETS, agingBucket } from "@/lib/trade/kpis";
import { dollars } from "@/lib/ui/format";
import type { Tint } from "@/lib/ui/tints";

import { deductionWorkbench } from "../queries";

export const metadata: Metadata = {
  title: "Deductions",
};

type SearchParams = Record<string, string | string[] | undefined>;

const TAB_LABEL: Record<DeductionTab, string> = { open: "Open", disputed: "Disputed", resolved: "Resolved" };

/** Older is warmer: the aging buckets from the freshest to the stalest. */
const AGE_TINTS: Tint[] = ["blue", "teal", "orange", "red", "pink"];

/**
 * The deduction workbench. Every short-pay a distributor takes that is not already-accrued trade
 * spend lands here: validate it, dispute it before its window closes, then recover or write it off.
 * Open, disputed and resolved are one segmented control; the dispute deadlines are a timeline.
 */
export default async function DeductionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, params] = await Promise.all([requireUser("/trade/deductions"), searchParams]);
  const raw = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const tab: DeductionTab = raw !== undefined && isDeductionTab(raw) ? raw : "open";
  const { rows, counts } = await deductionWorkbench(tab);
  const total = counts.open + counts.disputed + counts.resolved;
  const actionable = rows.filter((r) => r.actionable);
  const openCents = actionable.reduce((s, r) => s + r.openCents, 0);
  const aging = AGING_BUCKETS.map((bucket, index) => ({
    bucket,
    tint: AGE_TINTS[index % AGE_TINTS.length],
    cents: actionable.filter((r) => agingBucket(r.daysOutstanding) === bucket).reduce((s, r) => s + r.openCents, 0),
  }));
  const timeline = actionable
    .filter((r) => r.daysToDeadline !== null)
    .map((r) => ({ id: r.id, label: r.deductionNo, daysToDeadline: r.daysToDeadline ?? 0, alert: r.alert, cents: r.openCents }));
  const canManage = can(user.role, "trade.manage");

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Deductions"
        subtitle={
          total === 0 ? undefined : (
            <>
              {counts.open + counts.disputed} open
              {tab === "resolved" ? null : (
                <>
                  {" "}
                  · <Money cents={openCents} currency plain />
                </>
              )}
            </>
          )
        }
        info={
          <>
            <p>What distributors took off their payments, and what is being done about each claim.</p>
            <p>
              Validate a claim the distributor was entitled to, dispute one it was not before its window closes, then record the recovery
              or write it off. Each action shows the entry it will post before it posts.
            </p>
          </>
        }
        actions={
          canManage ? (
            <ToolbarGroup>
              <ToolbarLink href="/trade/remittances#import" glyph="import" label="Import remittance" />
            </ToolbarGroup>
          ) : undefined
        }
      />

      {total === 0 ? (
        <div className="rounded-2xl bg-card shadow-card max-md:rounded-[22px]">
          <EmptyState
            glyph="tray"
            title="No deductions yet"
            description="A deduction appears when a distributor's remittance pays an invoice short: a promotion billback, an admin fee, a shortage claim. Import the remittance and every short-pay line arrives with its reason code and dispute deadline."
            action={
              <Button asChild>
                <Link href="/trade/remittances#import">Import remittance</Link>
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <SegmentedNav
            aria-label="Deduction status"
            current={tab}
            className="self-start max-sm:w-full"
            fill={false}
            items={DEDUCTION_TABS.map((key) => ({
              value: key,
              label: counts[key] > 0 ? `${TAB_LABEL[key]} ${counts[key]}` : TAB_LABEL[key],
              href: key === "open" ? "/trade/deductions" : `/trade/deductions?tab=${key}`,
            }))}
          />

          {tab !== "resolved" && actionable.length > 0 ? (
            <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <section aria-labelledby="deadlines" className="rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4">
                <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h2 id="deadlines" className="flex-1 text-lg font-semibold tracking-[-0.01em]">
                    Deadlines
                  </h2>
                  <div className="flex gap-3.5">
                    <LegendItem tint="blue">Early</LegendItem>
                    <LegendItem tint="orange">60%</LegendItem>
                    <LegendItem tint="red">80%</LegendItem>
                  </div>
                </div>
                <DeadlineTimeline items={timeline} />
              </section>
              <section aria-labelledby="aging" className="flex flex-col rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4">
                <div className="mb-3 flex items-baseline gap-2">
                  <h2 id="aging" className="flex-1 text-lg font-semibold tracking-[-0.01em]">
                    Age
                  </h2>
                  <Money cents={openCents} currency plain className="text-sm font-semibold text-label2" />
                </div>
                <SplitBar
                  className="h-3 [&>i]:rounded-[5px]"
                  label={aging.map((a) => `${a.bucket} days ${dollars(a.cents)}`).join(", ")}
                  segments={aging.map((a) => ({ label: a.bucket, value: a.cents, tint: a.tint }))}
                />
                <ul className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  {aging.map((a) => (
                    <li key={a.bucket} className="flex items-center justify-between gap-2 text-xs">
                      <LegendItem tint={a.tint}>{a.bucket} days</LegendItem>
                      <Money cents={a.cents} currency plain zeroDash className="font-semibold" />
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          ) : null}

          <section aria-label={TAB_LABEL[tab]} className="overflow-hidden rounded-2xl bg-card shadow-card max-md:rounded-[22px]">
            <DeductionWorkbench key={tab} rows={rows} tab={tab} canManage={canManage} today={today()} />
          </section>
        </>
      )}
    </div>
  );
}

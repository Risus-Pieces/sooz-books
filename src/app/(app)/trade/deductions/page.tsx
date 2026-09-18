import { FileMinus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LinkTabs } from "@/components/banking/link-tabs";
import { DeductionWorkbench } from "@/components/trade/deduction-workbench";
import { DEDUCTION_TABS, type DeductionTab, isDeductionTab } from "@/components/trade/types";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { today } from "@/lib/dates";
import { AGING_BUCKETS, agingBucket } from "@/lib/trade/kpis";

import { deductionWorkbench } from "../queries";

export const metadata: Metadata = {
  title: "Deductions",
};

type SearchParams = Record<string, string | string[] | undefined>;

const TAB_LABEL: Record<DeductionTab, string> = { open: "Open", disputed: "Disputed", resolved: "Resolved" };

const TAB_NOTE: Record<DeductionTab, string> = {
  open: "Claims parked in 1210 Deductions Receivable that nobody has decided on yet, oldest deadline first.",
  disputed: "Cases filed with the distributor. Record the repayment when it comes, or write it off if the dispute is denied.",
  resolved: "Validated, recovered or written off. Each one's entries are on its page.",
};

/**
 * The deduction workbench. Every short-pay a distributor takes that is not already-accrued
 * trade spend lands here: validate it, dispute it before its window closes, then recover or
 * write it off. Each action shows the entry it will post before it posts.
 */
export default async function DeductionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, params] = await Promise.all([requireUser("/trade/deductions"), searchParams]);
  const raw = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const tab: DeductionTab = raw !== undefined && isDeductionTab(raw) ? raw : "open";
  const { rows, counts } = await deductionWorkbench(tab);
  const total = counts.open + counts.disputed + counts.resolved;
  const aging = AGING_BUCKETS.map((bucket) => ({
    bucket,
    cents: rows.filter((r) => r.actionable && agingBucket(r.daysOutstanding) === bucket).reduce((s, r) => s + r.openCents, 0),
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Trade"
        title="Deductions"
        description="What distributors took off their payments, and what is being done about each claim."
        tabs={
          <LinkTabs
            label="Deduction status"
            tabs={DEDUCTION_TABS.map((key) => ({
              href: key === "open" ? "/trade/deductions" : `/trade/deductions?tab=${key}`,
              label: TAB_LABEL[key],
              count: counts[key],
              active: key === tab,
            }))}
          />
        }
      />

      {total === 0 ? (
        <Card>
          <EmptyState
            icon={<FileMinus />}
            title="No deductions yet"
            description="A deduction appears here when a distributor’s remittance pays an invoice short: a promotion billback, an admin fee, a shortage claim. Import the remittance and every short-pay line arrives with its reason code and dispute deadline."
            action={
              <Button asChild size="sm">
                <Link href="/trade/remittances">Import a remittance</Link>
              </Button>
            }
            secondaryAction={
              <Button asChild size="sm" variant="secondary">
                <Link href="/trade">How it works</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>{TAB_LABEL[tab]}</CardTitle>
              <CardDescription>{TAB_NOTE[tab]}</CardDescription>
            </div>
          </CardHeader>
          {tab === "resolved" || rows.length === 0 ? null : (
            <dl className="grid grid-cols-2 border-b border-border sm:grid-cols-5">
              {aging.map((a, index) => (
                <div key={a.bucket} className={index > 0 ? "border-border px-4 py-2 sm:border-l" : "px-4 py-2"}>
                  <dt className="eyebrow">{a.bucket} days</dt>
                  <dd className="text-sm">
                    <Money cents={a.cents} plain zeroDash />
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <DeductionWorkbench key={tab} rows={rows} tab={tab} canManage={can(user.role, "trade.manage")} today={today()} />
        </Card>
      )}
    </div>
  );
}

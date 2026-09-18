import * as React from "react";
import Link from "next/link";
import { CheckCircle2, CircleAlert, Hourglass } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { inputBase } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { StatTile } from "@/components/ui/stat-tile";
import { cn } from "@/lib/cn";

import { AgingView } from "./aging-view";
import { BUCKETS, type AgingBuckets, type AgingPartyView } from "./types";

export interface AgingData {
  side: "ar" | "ap";
  asOf: string;
  parties: AgingPartyView[];
  totals: AgingBuckets;
  controlBalanceCents: number;
  differenceCents: number;
}

/**
 * An aging as of any date, rebuilt from dated records — so last month's aging
 * still says what it said last month — and proved against its control account:
 * the schedule's total must equal 1200 (or 2000) on the same date.
 */
export function AgingReport({
  data,
  action,
  today,
  emptyAction,
}: {
  data: AgingData;
  action: string;
  today: string;
  emptyAction?: React.ReactNode;
}) {
  const ar = data.side === "ar";
  const control = ar ? "1200 Accounts Receivable" : "2000 Accounts Payable";
  const pastDue = BUCKETS.filter((b) => b !== "current").reduce((sum, b) => sum + data.totals[b], 0);
  const over60 = data.totals.days61to90 + data.totals.over90;

  return (
    <div className="flex flex-col gap-4">
      <form method="get" action={action} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="eyebrow">As of</span>
          <input type="date" name="asOf" defaultValue={data.asOf} max="2100-12-31" className={cn(inputBase, "num w-[9.5rem]")} />
        </label>
        <Button type="submit" variant="secondary">
          Show
        </Button>
        {data.asOf !== today ? (
          <Button asChild variant="ghost">
            <Link href={action}>Today</Link>
          </Button>
        ) : null}
        <span className="ml-auto flex items-center gap-2 text-xs">
          {data.differenceCents === 0 ? (
            <Badge tone="positive">
              <CheckCircle2 />
              Ties to {control}
            </Badge>
          ) : (
            <Badge tone="negative">
              <CircleAlert />
              Off from {control} by <Money cents={data.differenceCents} plain />
            </Badge>
          )}
        </span>
      </form>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label={ar ? "Customers owe" : "We owe vendors"} value={<Money cents={data.totals.total} currency plain />} hint={`${data.parties.length} ${ar ? "customers" : "vendors"}`} />
        <StatTile label="Current" value={<Money cents={data.totals.current} currency plain />} footer="Not yet due, and credits on account." />
        <StatTile
          label="Past due"
          value={<Money cents={pastDue} currency plain className={pastDue > 0 ? "text-negative" : undefined} />}
          footer="Anything a day or more past its due date."
        />
        <StatTile
          label="Over 60 days"
          value={<Money cents={over60} currency plain className={over60 > 0 ? "text-negative" : undefined} />}
          footer="Sixty-one days or more past due."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {ar ? "Receivables" : "Payables"} by {ar ? "customer" : "vendor"}
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            Control balance <Money cents={data.controlBalanceCents} plain className="text-foreground" /> on {data.asOf}
          </span>
        </CardHeader>
        {data.parties.length === 0 ? (
          <EmptyState
            icon={<Hourglass />}
            title={ar ? `Nothing owed to Sooz on ${data.asOf}` : `Nothing owed to vendors on ${data.asOf}`}
            description={
              ar
                ? "The aging lists issued invoices not yet paid, sorted into how late they are, alongside any customer credits. It fills in once invoices are issued."
                : "The aging lists approved bills not yet paid, by how late they are, alongside any prepayments. It fills in once bills are approved."
            }
            action={emptyAction}
          />
        ) : (
          <AgingView
            parties={data.parties}
            totals={data.totals}
            partyLabel={ar ? "Customer" : "Vendor"}
            partyHrefBase={ar ? "/sales/invoices?customer=" : "/purchases/bills?vendor="}
          />
        )}
      </Card>
    </div>
  );
}

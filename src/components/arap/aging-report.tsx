import * as React from "react";

import { PageToolbar } from "@/components/shell/page-toolbar";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { ToolbarGroup, ToolbarLink } from "@/components/ui/toolbar";
import { mediumDate } from "@/lib/ui/format";

import { AgingBar, AgingLegend } from "./aging-bar";
import { AgingView } from "./aging-view";
import { AgingSplitLine, agingSplit } from "./overview";
import type { AgingBuckets, AgingPartyView } from "./types";

export interface AgingData {
  side: "ar" | "ap";
  asOf: string;
  parties: AgingPartyView[];
  totals: AgingBuckets;
  controlBalanceCents: number;
  differenceCents: number;
}

/**
 * An aging as of any date, rebuilt from dated records — so last month's aging still says what it
 * said last month — and proved against its control account: the schedule's total must equal 1200
 * (or 2000) on the same date. The page's toolbar is drawn here, with the as-of date in it.
 */
export function AgingReport({
  data,
  action,
  today,
  title,
  back,
  emptyAction,
  createHref,
  createLabel,
}: {
  data: AgingData;
  action: string;
  today: string;
  title: string;
  back: { href: string; label: string };
  emptyAction?: React.ReactNode;
  createHref?: string;
  createLabel?: string;
}) {
  const ar = data.side === "ar";
  const control = ar ? "1200 Accounts Receivable" : "2000 Accounts Payable";
  const ties = data.differenceCents === 0;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={title}
        back={back}
        phoneTitleRow
        subtitle={data.asOf === today ? "Today" : mediumDate(data.asOf)}
        info={
          <>
            <p>
              What {ar ? "each customer owes Sooz" : "Sooz owes each vendor"}, by how late it is. Credits and unapplied
              money sit in Current as negatives: they are owed against, not overdue.
            </p>
            <p>
              Pick any past date to see the aging exactly as it stood then. The total is checked against {control} on
              the same date.
            </p>
          </>
        }
        actions={
          <>
            <form method="get" action={action} className="flex h-[34px] items-center gap-1 rounded-full vibrancy pr-1 pl-3 shadow-glass max-md:h-11">
              <label htmlFor="aging-asof" className="text-xs font-medium text-label2 max-md:sr-only">
                As of
              </label>
              <input
                id="aging-asof"
                type="date"
                name="asOf"
                defaultValue={data.asOf}
                max="2100-12-31"
                className="num h-7 bg-transparent px-1 text-sm font-medium text-label outline-none focus-ring rounded-[5px]"
              />
              <button
                type="submit"
                aria-label="Show the aging on this date"
                className="grid size-7 place-items-center rounded-full text-ink-blue transition-colors hover:bg-fill2 max-md:size-10"
              >
                <Glyph name="arrow-right" size={15} weight={2} />
              </button>
            </form>
            {data.asOf !== today || createHref ? (
              <ToolbarGroup className="max-md:hidden">
                {data.asOf !== today ? <ToolbarLink href={action} glyph="calendar" label="Today" /> : null}
                {createHref && createLabel ? <ToolbarLink href={createHref} glyph="plus" label={createLabel} /> : null}
              </ToolbarGroup>
            ) : null}
          </>
        }
      />

      <section className="flex flex-col gap-4 rounded-2xl bg-card px-5 pt-[18px] pb-5 shadow-card max-md:rounded-[22px] max-md:p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-label2">{ar ? "Customers owe" : "Sooz owes"}</h2>
            <Money
              cents={data.totals.total}
              currency
              plain
              className="mt-0.5 block text-5xl leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.5rem]"
            />
            <AgingSplitLine split={agingSplit(data.parties)} />
          </div>
          <div className="flex items-center gap-1">
            {ties ? (
              <Pill tone="green" glyph="check-circle">
                Ties to {ar ? "1200" : "2000"}
              </Pill>
            ) : (
              <Pill tone="red" glyph="warning">
                Off by <Money cents={data.differenceCents} currency plain />
              </Pill>
            )}
            <InfoButton label="About the tie-out">
              <p>
                {control} stood at <Money cents={data.controlBalanceCents} currency plain /> on {mediumDate(data.asOf)}.
                {ties ? " The aging adds up to the same figure." : " The aging does not add up to it; something posted to the account outside a document."}
              </p>
            </InfoButton>
          </div>
        </div>
        <AgingBar buckets={data.totals} />
        <AgingLegend buckets={data.totals} />
      </section>

      {data.parties.length === 0 ? (
        <Card>
          <EmptyState
            glyph="hourglass"
            title="Nothing owed"
            description={
              ar
                ? "The aging lists issued invoices not yet paid, sorted into how late they are, alongside any customer credits. It fills in once invoices are issued."
                : "The aging lists approved bills not yet paid, by how late they are, alongside any prepayments. It fills in once bills are approved."
            }
            action={emptyAction}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <AgingView
            parties={data.parties}
            totals={data.totals}
            partyLabel={ar ? "Customer" : "Vendor"}
            partyHrefBase={ar ? "/sales/invoices?customer=" : "/purchases/bills?vendor="}
          />
        </Card>
      )}
    </div>
  );
}

import type { Metadata } from 'next';

import { Responsive } from '@/components/charts';
import { ForecastLine } from '@/components/planning/forecast-chart';
import { ForecastItems } from '@/components/planning/forecast-items';
import { ForecastTable } from '@/components/planning/forecast-table';
import { FreezeForecastButton } from '@/components/planning/freeze-forecast-button';
import { PlanTabs } from '@/components/planning/plan-tabs';
import { Caveats } from '@/components/ui/caveats';
import { RunwayCallout } from '@/components/planning/runway-callout';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Card } from '@/components/ui/card';
import { Dot, IconBadge, LegendItem } from '@/components/ui/icon-badge';
import { InfoButton } from '@/components/ui/info-button';
import { GroupRow, InsetGroup, ListRow } from '@/components/ui/inset-group';
import { Money } from '@/components/ui/money';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { mediumDate, shortDate } from '@/lib/ui/format';

import { forecastScreen } from '../queries';

export const metadata: Metadata = {
  title: 'Cash Forecast',
};

export const dynamic = 'force-dynamic';

/** "Relay — Operating Expenses ••9726" → "Operating Expenses": the mask is shown beside it. */
function accountName(name: string): string {
  const bare = name.replace(/\s*—?\s*••\d+$/, '');
  return bare.replace(/^[^—]*—\s*/, '') || bare || name;
}

/**
 * Thirteen weeks of cash: today's balance in the Relay accounts carried forward by open invoices,
 * open bills and the expected movements entered here — drawn as the cash line, with the trailing
 * burn's cash-out date and the runway ring beside it.
 */
export default async function ForecastPage() {
  const user = await requireCapability('reports.view');
  const canEdit = can(user.role, 'ledger.close');
  const { forecast, weeks, items, bankAccounts, snapshots } = await forecastScreen();
  const { opening, burn, runway } = forecast;
  const flowCount = weeks.reduce((n, w) => n + w.flows.length, 0);
  const frozenToday = snapshots.some((s) => s.asOfDate === forecast.asOf);
  const closing = weeks[weeks.length - 1]?.closingCents ?? opening.cashCents;
  const points = weeks.map((w) => ({ weekEnd: w.weekEnd, closingCents: w.closingCents }));

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Forecast"
        subtitle={
          <>
            {shortDate(forecast.asOf)}
            {opening.bankDataThrough !== null ? <> · bank to {shortDate(opening.bankDataThrough)}</> : null}
          </>
        }
        info="Cash in the Relay accounts today, carried forward thirteen weeks by open invoices, open bills and the movements you expect. Beside it, the runway the bank’s own history implies."
        actions={
          canEdit ? (
            <ToolbarGroup>
              <FreezeForecastButton frozenToday={frozenToday} />
            </ToolbarGroup>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <PlanTabs current="forecast" varianceHref="/plan/budget?tab=variance" />
        <span className="flex-1" />
        <Caveats items={forecast.warnings} />
      </div>

      <div className="grid gap-3.5 max-md:gap-3 md:grid-cols-2 lg:grid-cols-12">
        <section className="min-w-0 rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4 md:col-span-2 lg:col-span-8">
          <div className="mb-1.5 flex flex-wrap items-start justify-between gap-x-5 gap-y-2">
            <div>
              <h2 className="flex items-center gap-1 text-sm font-semibold text-label2">
                In 13 weeks
                <InfoButton label="About the forecast" align="start">
                  <p>The solid line is today’s cash carried forward week by week by what is known: open invoices, open bills and the expected movements below, each weighted by its confidence.</p>
                  <p>The dotted line is the trailing burn: what happens if nothing new comes in. It reaches $0 on the cash-out date.</p>
                </InfoButton>
              </h2>
              <Money
                cents={closing}
                currency
                plain
                className={`mt-0.5 block text-5xl leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.5rem] ${closing < 0 ? 'text-ink-red' : ''}`}
              />
              <p className="mt-1 text-xs font-medium text-label2">
                from <Money cents={opening.cashCents} currency plain className="font-semibold text-label" /> today
              </p>
            </div>
            <div className="flex gap-3.5 pt-1">
              <LegendItem tint="blue">Forecast</LegendItem>
              <LegendItem tint="orange">At burn</LegendItem>
            </div>
          </div>
          <Responsive
            desktop={
              <ForecastLine asOf={forecast.asOf} cashCents={opening.cashCents} weeks={points} cashOutDate={burn.cashOutDate} />
            }
            phone={
              <div className="mt-2">
                <ForecastLine
                  asOf={forecast.asOf}
                  cashCents={opening.cashCents}
                  weeks={points}
                  cashOutDate={burn.cashOutDate}
                  width={342}
                  height={170}
                  compact
                />
              </div>
            }
          />
        </section>

        <div className="min-w-0 md:col-span-1 lg:col-span-4">
          <RunwayCallout
            facts={{
              asOf: forecast.asOf,
              cashCents: opening.cashCents,
              netBurnCents: burn.netBurnCents,
              monthlyBurnCents: burn.monthlyBurnCents,
              windowDays: burn.windowDays,
              burnFrom: burn.from,
              runwayDays: burn.runwayDays,
              cashOutDate: burn.cashOutDate,
              financingInflowCents: burn.financingInflowCents,
              suggestedCents: burn.suggestedCents,
              firstNegativeWeekStart: runway.firstNegativeWeekStart,
              lowestClosingCents: runway.lowestClosingCents,
              lowestWeekStart: runway.lowestWeekStart,
              forecastFlowCount: flowCount,
            }}
          />
        </div>

        <InsetGroup
          header="Today"
          headerAccessory={<Money cents={opening.cashCents} currency plain className="text-sm font-semibold text-label" />}
          separatorInset={34}
          className="min-w-0 md:col-span-1 lg:hidden [&>div:first-child]:pt-0"
        >
          <OpeningRows opening={opening} />
        </InsetGroup>
      </div>

      <Card className="min-w-0 overflow-hidden pt-3">
        <div className="flex items-center gap-2 px-5 pb-1 max-sm:px-4">
          <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">Thirteen weeks</h2>
          <span className="num text-xs font-medium text-label2">
            {shortDate(weeks[0]?.weekStart ?? forecast.asOf)} – {shortDate(forecast.horizonEnd)}
          </span>
        </div>
        <ForecastTable weeks={weeks} />
      </Card>

      <div className="grid items-start gap-3.5 max-md:gap-3 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <ForecastItems items={items} bankAccounts={bankAccounts} asOf={forecast.asOf} canEdit={canEdit} />
        </div>
        <InsetGroup
          header="Today"
          headerAccessory={<Money cents={opening.cashCents} currency plain className="text-sm font-semibold text-label" />}
          separatorInset={34}
          className="min-w-0 max-lg:hidden lg:col-span-4 [&>div:first-child]:pt-4"
        >
          <OpeningRows opening={opening} />
        </InsetGroup>
      </div>

      <InsetGroup
        header={
          <span className="flex items-center gap-1">
            Frozen
            <InfoButton label="About frozen forecasts" align="start">
              Freeze the forecast each week; each frozen copy is scored against what the bank shows happened — how far its
              closing cash landed from the real one.
            </InfoButton>
          </span>
        }
        separatorInset={63}
      >
        {snapshots.length === 0 ? (
          <p className="px-4 py-4 text-sm font-medium text-label2">None yet</p>
        ) : (
          snapshots.map((s) => (
            <ListRow
              key={s.id}
              leading={<IconBadge glyph="clock" tint="mint" size="xl" />}
              title={<span className="num">{mediumDate(s.asOfDate)}</span>}
              subtitle={
                <span className="num">
                  {s.scoredWeeks} of {s.scoredWeeks + s.unscoredWeeks} weeks scored
                </span>
              }
              trailing={
                s.scoredWeeks === 0 ? (
                  <span className="text-label2">—</span>
                ) : (
                  <span className="inline-flex items-baseline gap-1">
                    <span className="text-xs font-medium text-label2">±</span>
                    <Money cents={s.meanAbsClosingErrorCents} currency plain />
                  </span>
                )
              }
              detail={
                s.scoredWeeks === 0 ? undefined : (
                  <>
                    Latest <Money cents={s.finalClosingVarianceCents} currency signed plain />
                  </>
                )
              }
            />
          ))
        )}
      </InsetGroup>
    </div>
  );
}

function OpeningRows({
  opening,
}: {
  opening: Awaited<ReturnType<typeof forecastScreen>>['forecast']['opening'];
}) {
  return (
    <>
      {opening.accounts.map((a, i) => (
        <GroupRow
          key={a.bankAccountId}
          label={
            <span className="flex min-w-0 items-center gap-2.5">
              <Dot tint={i === 0 ? 'blue' : 'gray'} />
              <span className="truncate">{accountName(a.name)}</span>
              {a.mask ? <span className="num text-xs font-normal text-label2">••{a.mask}</span> : null}
            </span>
          }
        >
          <Money cents={a.cashCents} currency plain zeroDash className="font-semibold text-label" />
        </GroupRow>
      ))}
      <GroupRow label={<span className="pl-[18px] text-label2">Posted</span>}>
        <Money cents={opening.ledgerCents} currency plain />
      </GroupRow>
      {opening.unpostedOpeningCents !== 0 ? (
        <GroupRow label={<span className="pl-[18px] text-label2">Opening, unbooked</span>}>
          <Money cents={opening.unpostedOpeningCents} currency plain />
        </GroupRow>
      ) : null}
      <GroupRow
        href="/banking/review"
        label={
          <span className="pl-[18px] text-label2">
            <span className="num">{opening.unpostedCount}</span> in review
          </span>
        }
      >
        <Money cents={opening.unpostedActivityCents} currency plain />
      </GroupRow>
    </>
  );
}

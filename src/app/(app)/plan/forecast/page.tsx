import type { Metadata } from 'next';
import { TriangleAlert } from 'lucide-react';

import { LinkTabs } from '@/components/banking/link-tabs';
import { ForecastChart } from '@/components/planning/forecast-chart';
import { ForecastItems } from '@/components/planning/forecast-items';
import { ForecastTable, weekLabel } from '@/components/planning/forecast-table';
import { FreezeForecastButton } from '@/components/planning/freeze-forecast-button';
import { RunwayCallout, shortDate } from '@/components/planning/runway-callout';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';

import { forecastScreen } from '../queries';

export const metadata: Metadata = {
  title: 'Cash Forecast',
};

export const dynamic = 'force-dynamic';

/**
 * Thirteen weeks of cash: today's balance in the Relay accounts carried forward
 * by open invoices, open bills and the expected movements entered here, with the
 * runway the bank's own history implies beside it.
 */
export default async function ForecastPage() {
  const user = await requireCapability('reports.view');
  const canEdit = can(user.role, 'ledger.close');
  const { forecast, weeks, items, bankAccounts, snapshots } = await forecastScreen();
  const { opening, burn, runway } = forecast;
  const flowCount = weeks.reduce((n, w) => n + w.flows.length, 0);
  const frozenToday = snapshots.some((s) => s.asOfDate === forecast.asOf);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Plan"
        title="Cash Forecast"
        description="Cash in the Relay accounts today, carried forward thirteen weeks by open invoices, open bills and the movements you expect."
        meta={
          <>
            <Badge tone="outline">as of {shortDate(forecast.asOf)}</Badge>
            {opening.bankDataThrough !== null ? (
              <Badge tone="neutral">bank data through {shortDate(opening.bankDataThrough)}</Badge>
            ) : null}
          </>
        }
        actions={canEdit ? <FreezeForecastButton frozenToday={frozenToday} /> : null}
        tabs={
          <LinkTabs
            label="Plan"
            tabs={[
              { href: '/plan/forecast', label: 'Cash forecast', active: true },
              { href: '/plan/budget', label: 'Budget', active: false },
              { href: '/plan/budget?tab=variance', label: 'Budget vs actual', active: false },
            ]}
          />
        }
      />

      <Card className="p-4">
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
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Closing cash by week</CardTitle>
            <span className="text-xs text-muted-foreground">Line: closing balance · bars: net for the week</span>
          </CardHeader>
          <div className="p-3">
            <ForecastChart
              data={weeks.map((w) => ({
                label: weekLabel(w.weekStart),
                closingCents: w.closingCents,
                netCents: w.closingCents - w.openingCents,
              }))}
            />
          </div>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Opening cash</CardTitle>
            <Money cents={opening.cashCents} currency plain className="text-sm font-semibold" />
          </CardHeader>
          <ul className="flex flex-col">
            {opening.accounts.map((a) => (
              <li key={a.bankAccountId} className="rule-row flex items-baseline justify-between gap-3 px-4 py-1.5 text-sm">
                <span className="min-w-0 truncate">
                  {a.name.replace(/\s*—\s*••\d+$/, '')}
                  {a.mask ? <span className="num ml-1.5 text-xs text-muted-foreground">••{a.mask}</span> : null}
                </span>
                <Money cents={a.cashCents} zeroDash plain />
              </li>
            ))}
          </ul>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-4 py-2.5 text-xs text-muted-foreground">
            <dt>Posted in the ledger</dt>
            <dd><Money cents={opening.ledgerCents} plain /></dd>
            <dt>Opening balance not yet booked</dt>
            <dd><Money cents={opening.unpostedOpeningCents} plain /></dd>
            <dt>{opening.unpostedCount} bank lines not yet posted</dt>
            <dd><Money cents={opening.unpostedActivityCents} plain /></dd>
          </dl>
        </Card>
      </div>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>Thirteen weeks</CardTitle>
          <span className="num text-xs text-muted-foreground">
            {shortDate(weeks[0]?.weekStart ?? forecast.asOf)} – {shortDate(forecast.horizonEnd)}
          </span>
        </CardHeader>
        <ForecastTable weeks={weeks} />
      </Card>

      {forecast.warnings.length > 0 ? (
        <Card className="border-warning/35">
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-warning">
              <TriangleAlert className="size-4" aria-hidden />
              Read before trusting these figures
            </CardTitle>
          </CardHeader>
          <ul className="flex list-disc flex-col gap-1 py-3 pr-4 pl-8 text-xs text-foreground">
            {forecast.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ForecastItems items={items} bankAccounts={bankAccounts} asOf={forecast.asOf} canEdit={canEdit} />

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Frozen forecasts</CardTitle>
          <span className="text-xs text-muted-foreground">Each is scored against what the bank shows happened.</span>
        </CardHeader>
        {snapshots.length === 0 ? (
          <p className="px-4 py-4 text-xs text-muted-foreground">
            None yet. Freeze the forecast each week and this lists how far each one landed from the real closing cash.
          </p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-xl border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Frozen forecasts and their scores</caption>
              <thead>
                <tr>
                  {['As of', 'Weeks scored', 'Average miss', 'Latest miss'].map((h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={`rule-head bg-surface-sunken px-3 py-1.5 text-2xs font-semibold tracking-wider text-muted-foreground uppercase ${i === 0 ? 'text-left' : 'text-right'}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id} className="rule-row">
                    <td className="num px-3 py-1.5">{s.asOfDate}</td>
                    <td className="num px-3 py-1.5 text-right">
                      {s.scoredWeeks} of {s.scoredWeeks + s.unscoredWeeks}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {s.scoredWeeks === 0 ? <span className="text-muted-foreground">—</span> : <Money cents={s.meanAbsClosingErrorCents} plain />}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {s.scoredWeeks === 0 ? <span className="text-muted-foreground">—</span> : <Money cents={s.finalClosingVarianceCents} signed />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

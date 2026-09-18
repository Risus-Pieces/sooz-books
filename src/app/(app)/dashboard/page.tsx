import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, BookOpen, Inbox, Lock } from 'lucide-react';

import { NetIncomeChart } from '@/components/ledger/net-income-chart';
import { monthLabel, sourceLabel } from '@/components/ledger/types';
import { RunwayCallout, shortDate } from '@/components/planning/runway-callout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { StatTile } from '@/components/ui/stat-tile';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { cn } from '@/lib/cn';
import { ACCOUNTS } from '@/lib/ledger/coa';

import { dashboardData } from '../ledger/queries';
import {
  bankRows,
  closeStatus,
  founderContributions,
  inventoryCapitalized,
  reviewQueue,
  runwayForecast,
  squareClearing,
} from './queries';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export const dynamic = 'force-dynamic';

/** "Relay — ••9727" → "Relay": the mask is shown on its own. */
function accountName(name: string): string {
  return name.replace(/\s*—\s*••\d+$/, '');
}

/**
 * The first screen of the books, built from what is true for Sooz today: four
 * Relay accounts, a review queue the ledger is waiting on, a founder funding the
 * business, and inventory being bought ahead of launch. Every figure is a query;
 * a tile with nothing true to say is left off.
 */
export default async function DashboardPage() {
  const user = await requireUser('/dashboard');
  // Sequential on purpose: the connection pool this app shares is small.
  const banks = await bankRows();
  const queue = await reviewQueue();
  const forecast = await runwayForecast();
  const founder = await founderContributions();
  const inventory = await inventoryCapitalized();
  const square = await squareClearing();
  const close = await closeStatus();
  const ledger = await dashboardData();

  const hasCards = banks.some((b) => b.kind === 'credit_card' || b.kind === 'line_of_credit');
  const depository = banks.filter((b) => b.kind !== 'credit_card' && b.kind !== 'line_of_credit');
  const cards = banks.filter((b) => b.kind === 'credit_card' || b.kind === 'line_of_credit');
  const bankTotal = depository.reduce((s, b) => s + (b.bankCents ?? 0), 0);
  const bookTotal = depository.reduce((s, b) => s + b.bookCents, 0);
  const flowCount = forecast.weeks.reduce((n, w) => n + w.flows.length, 0);
  const posted = ledger.recentEntries.some((e) => e.status === 'posted');
  const anyNetIncome = ledger.monthly.some((m) => m.netCents !== 0);
  const month = monthLabel(close.current.year, close.current.month);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Dashboard"
        description={`Sooz Beverage as of ${shortDate(ledger.asOf)}.`}
        meta={
          <Badge tone={close.current.status === 'closed' ? 'neutral' : 'info'}>
            {close.current.status === 'closed' ? <Lock /> : null}
            {month} {close.current.status}
          </Badge>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="min-w-0 border-primary/40">
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="eyebrow flex items-center gap-1.5">
                <Inbox className="size-3.5" aria-hidden />
                Review queue
              </p>
              {queue.unreviewedCount === 0 ? (
                <p className="mt-1 text-3xl font-semibold tracking-tight">Nothing to review</p>
              ) : (
                <p className="mt-1 text-3xl font-semibold tracking-tight">
                  <span className="num">{queue.unreviewedCount}</span>
                  <span className="text-muted-foreground"> bank transactions to review</span>
                </p>
              )}
              <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted-foreground">
                {queue.unreviewedCount === 0 ? (
                  'Every imported bank line has been reviewed.'
                ) : (
                  <>
                    <Money cents={queue.unreviewedOutCents} currency plain className="text-foreground" /> out and{' '}
                    <Money cents={queue.unreviewedInCents} currency plain className="text-foreground" /> in, back to{' '}
                    {queue.oldestUnreviewed === null ? '—' : shortDate(queue.oldestUnreviewed)}. Nothing reaches the
                    ledger until you approve it, so every figure below waits on this queue.
                  </>
                )}
                {queue.categorizedCount > 0 ? (
                  <>
                    {' '}
                    {queue.categorizedCount} more {queue.categorizedCount === 1 ? 'line is' : 'lines are'} categorized by
                    an auto-post rule (<Money cents={queue.categorizedNetCents} currency plain signed className="text-foreground" /> net)
                    and not yet posted.
                  </>
                ) : null}
              </p>
            </div>
            {queue.unreviewedCount > 0 ? (
              <Button asChild className="shrink-0 self-start sm:self-auto">
                <Link href="/banking/review">
                  Open the review queue
                  <ArrowRight />
                </Link>
              </Button>
            ) : null}
          </div>
          {queue.bySuggestion.length > 0 ? (
            <div className="border-t border-border">
              <p className="eyebrow px-4 pt-2.5 pb-1">Waiting, by suggested account</p>
              <ul className="grid grid-cols-1 gap-x-6 px-4 pb-3 sm:grid-cols-2">
                {queue.bySuggestion.slice(0, 6).map((g) => (
                  <li key={g.code ?? 'none'} className="rule-row flex items-baseline justify-between gap-3 py-1 text-xs">
                    <span className="min-w-0 truncate">
                      {g.code !== null ? <span className="num mr-1.5 text-muted-foreground">{g.code}</span> : null}
                      {g.name}
                      <span className="num ml-1.5 text-muted-foreground">×{g.count}</span>
                    </span>
                    <Money cents={g.netCents} signed colorPositive />
                  </li>
                ))}
              </ul>
              {queue.bySuggestion.length > 6 ? (
                <p className="px-4 pb-3 text-2xs text-muted-foreground">
                  and {queue.bySuggestion.length - 6} more accounts. Suggestions come from rules, AI and history; you approve each one.
                </p>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card className="min-w-0 p-4">
          <RunwayCallout
            compact
            facts={{
              asOf: forecast.asOf,
              cashCents: forecast.opening.cashCents,
              netBurnCents: forecast.burn.netBurnCents,
              monthlyBurnCents: forecast.burn.monthlyBurnCents,
              windowDays: forecast.burn.windowDays,
              burnFrom: forecast.burn.from,
              runwayDays: forecast.burn.runwayDays,
              cashOutDate: forecast.burn.cashOutDate,
              financingInflowCents: forecast.burn.financingInflowCents,
              suggestedCents: forecast.burn.suggestedCents,
              firstNegativeWeekStart: forecast.runway.firstNegativeWeekStart,
              lowestClosingCents: forecast.runway.lowestClosingCents,
              lowestWeekStart: forecast.runway.lowestWeekStart,
              forecastFlowCount: flowCount,
            }}
          />
          <Link href="/plan/forecast" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Open the 13-week forecast
            <ArrowRight className="size-3" aria-hidden />
          </Link>
        </Card>
      </div>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Cash in the bank</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The bank&apos;s balance from its latest imported statement line, against what the books show posted. The
              gap is activity still waiting in review.
            </p>
          </div>
        </CardHeader>
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-xl border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Bank balances against book balances</caption>
            <thead>
              <tr>
                <Th className="text-left">Account</Th>
                <Th>Bank balance</Th>
                <Th>In the books</Th>
                <Th>Awaiting review</Th>
              </tr>
            </thead>
            <tbody>
              {depository.map((b) => {
                const gap = b.bankCents === null ? null : b.bankCents - b.bookCents;
                return (
                  <tr key={b.bankAccountId} className="rule-row">
                    <td className="px-3 py-1.5">
                      <Link href={`/banking?account=${b.bankAccountId}`} className="hover:underline">
                        {accountName(b.name)}
                      </Link>
                      {b.mask ? <span className="num ml-1.5 text-xs text-muted-foreground">••{b.mask}</span> : null}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {b.bankCents === null ? (
                        <span className="text-xs text-muted-foreground">no activity</span>
                      ) : (
                        <>
                          <Money cents={b.bankCents} plain />
                          <span className="num block text-2xs text-muted-foreground">{b.bankDate === null ? '' : shortDate(b.bankDate)}</span>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Money cents={b.bookCents} zeroDash plain />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {gap === null || gap === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Money cents={gap} className="text-warning" />
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <th scope="row" className="rule-subtotal rule-total px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase">
                  Total
                </th>
                <td className="rule-subtotal rule-total px-3 py-2 text-right font-semibold">
                  <Money cents={bankTotal} currency plain />
                </td>
                <td className="rule-subtotal rule-total px-3 py-2 text-right font-semibold">
                  <Money cents={bookTotal} currency plain />
                </td>
                <td className="rule-subtotal rule-total px-3 py-2 text-right font-semibold">
                  <Money cents={bankTotal - bookTotal} currency plain className={bankTotal === bookTotal ? undefined : 'text-warning'} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Founder contributions"
          value={<Money cents={founder.postedCents} currency plain />}
          hint={`posted · ${ACCOUNTS.MEMBER_CONTRIBUTIONS}`}
          footer={
            founder.pendingCount === 0 && founder.unbookedOpeningCents === 0 ? (
              'Money from the founder, booked as Member Contributions, never revenue.'
            ) : (
              <span>
                {founder.pendingCount > 0 ? (
                  <>
                    <Money cents={founder.pendingCents} currency plain className="text-foreground" /> more in{' '}
                    {founder.pendingCount} ACH {founder.pendingCount === 1 ? 'pull' : 'pulls'} waiting to post
                  </>
                ) : null}
                {founder.pendingCount > 0 && founder.unbookedOpeningCents !== 0 ? ', and ' : null}
                {founder.unbookedOpeningCents !== 0 ? (
                  <>
                    the <Money cents={founder.unbookedOpeningCents} currency plain className="text-foreground" /> opening
                    deposit not yet booked
                  </>
                ) : null}
                .
              </span>
            )
          }
        />

        <StatTile
          label="Inventory capitalized"
          value={<Money cents={inventory.postedCents} currency plain />}
          hint={`posted · ${ACCOUNTS.INVENTORY}`}
          footer={
            inventory.pendingCount === 0 ? (
              'Ingredients and packaging are held as inventory until they are used.'
            ) : (
              <span>
                <Money cents={inventory.pendingCents} currency plain className="text-foreground" /> more waiting to post:
                ingredients <Money cents={inventory.ingredients.pendingCents} plain className="text-foreground" />,
                packaging <Money cents={inventory.packaging.pendingCents} plain className="text-foreground" />.
              </span>
            )
          }
        />

        <StatTile
          label="Square Clearing"
          value={<Money cents={square.postedCents} currency plain />}
          hint={`posted · ${ACCOUNTS.CLEARING_SQUARE}`}
          footer={
            <span>
              Square sales post here gross; each SQ deposit into Relay clears them. A balance is money Square still
              holds.
              {square.depositsCount > 0 ? (
                <>
                  {' '}
                  {square.depositsCount} deposits so far, <Money cents={square.depositsCents} currency plain className="text-foreground" />.
                </>
              ) : null}
            </span>
          }
        />

        <StatTile
          label="Month-end close"
          value={
            close.nextToClose === null ? (
              <span>All closed</span>
            ) : (
              <span className="text-xl">{monthLabel(close.nextToClose.year, close.nextToClose.month)}</span>
            )
          }
          hint={close.nextToClose === null ? undefined : 'next to close'}
          footer={
            <span>
              {close.closedCount === 0
                ? 'No month has been closed yet.'
                : `${close.closedCount} closed, through ${close.lastClosed === null ? '—' : monthLabel(close.lastClosed.year, close.lastClosed.month)}.`}{' '}
              {close.checklist !== null ? `Checklist ${close.checklist.done} of ${close.checklist.total} ready. ` : null}
              <Link href="/close" className="text-primary hover:underline">
                Work the close
              </Link>
            </span>
          }
        />

        {hasCards ? (
          <StatTile
            label="Card balances"
            value={<Money cents={-cards.reduce((s, c) => s + c.bookCents, 0)} currency plain />}
            hint="owed, posted"
            footer={`${cards.length} ${cards.length === 1 ? 'card' : 'cards'} or credit lines.`}
          />
        ) : null}
      </div>

      {!posted ? (
        <Card>
          <EmptyState
            icon={<BookOpen />}
            title="Nothing has been posted to the ledger yet"
            description={`Profit and loss, expenses and recent entries appear here as bank lines are approved. ${queue.unreviewedCount} are waiting.`}
            action={
              can(user.role, 'bank.approve') && queue.unreviewedCount > 0 ? (
                <Button asChild size="sm">
                  <Link href="/banking/review">Open the review queue</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Net income by month</CardTitle>
                <p className="text-xs text-muted-foreground">Last six months, posted entries only.</p>
              </CardHeader>
              <div className="p-3">
                {anyNetIncome ? (
                  <NetIncomeChart data={ledger.monthly} />
                ) : (
                  <p className="px-1 py-10 text-center text-xs text-muted-foreground">
                    No income or expense posted in the last six months.
                  </p>
                )}
              </div>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Top expenses · {month.split(' ')[0]}</CardTitle>
                <Money cents={ledger.expenseTotalCents} currency plain className="text-sm font-semibold" />
              </CardHeader>
              {ledger.topExpenses.length === 0 ? (
                <EmptyState title="No expense posted this month" description="Expense accounts with activity in the month rank here." />
              ) : (
                <ul className="flex flex-col gap-2 p-4">
                  {ledger.topExpenses.map((expense) => {
                    const share = ledger.expenseTotalCents === 0 ? 0 : Math.round((expense.cents * 100) / ledger.expenseTotalCents);
                    return (
                      <li key={expense.accountId} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <Link href={`/ledger?accountId=${expense.accountId}`} className="min-w-0 truncate hover:underline">
                            <span className="num mr-2 text-xs text-muted-foreground">{expense.code}</span>
                            {expense.name}
                          </Link>
                          <Money cents={expense.cents} plain />
                        </div>
                        <div className="h-1 w-full rounded-xs bg-muted">
                          <div className="h-1 rounded-xs bg-primary" style={{ width: `${Math.max(share, 2)}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Recent entries</CardTitle>
              <Link href="/ledger" className="text-xs text-primary hover:underline">
                Open the journal
              </Link>
            </CardHeader>
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-2xl border-separate border-spacing-0 text-sm">
                <caption className="sr-only">Recent journal entries</caption>
                <thead>
                  <tr>
                    <Th className="text-left">Entry</Th>
                    <Th className="text-left">Date</Th>
                    <Th className="text-left">Memo</Th>
                    <Th className="text-left">Source</Th>
                    <Th>Debits</Th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.recentEntries.map((entry) => (
                    <tr key={entry.id} className="rule-row">
                      <td className="num px-3 py-1.5">
                        <Link href={`/ledger/${entry.id}`} className="hover:underline">
                          #{entry.entryNo}
                        </Link>
                        {entry.status === 'draft' ? (
                          <Badge tone="warning" size="sm" className="ml-2">draft</Badge>
                        ) : null}
                      </td>
                      <td className="num px-3 py-1.5">{entry.date}</td>
                      <td className="px-3 py-1.5">{entry.memo ?? <span className="text-muted-foreground">No memo</span>}</td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">{sourceLabel(entry.sourceType)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <Money cents={entry.debitCents} plain />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Th({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <th
      scope="col"
      className={cn(
        'rule-head bg-surface-sunken px-3 py-1.5 text-right text-2xs font-semibold tracking-wider text-muted-foreground uppercase',
        className,
      )}
    >
      {children}
    </th>
  );
}

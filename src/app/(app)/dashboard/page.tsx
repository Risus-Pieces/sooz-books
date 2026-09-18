import type { Metadata } from 'next';
import Link from 'next/link';
import { Lock, Plus } from 'lucide-react';

import { NetIncomeChart } from '@/components/ledger/net-income-chart';
import { monthLabel, sourceLabel } from '@/components/ledger/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCents, Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { StatTile } from '@/components/ui/stat-tile';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { periodOf } from '@/lib/dates';

import { dashboardData } from '../ledger/queries';

export const metadata: Metadata = {
  title: 'Dashboard',
};

/**
 * The first screen of the books.
 *
 * Every figure here is a query against posted entries — there are no estimates
 * and no placeholders. Tiles that would need a module that does not exist yet,
 * such as receivable aging or trade spend accrued against promotions, are left
 * off rather than filled with something that looks like an answer.
 */
export default async function DashboardPage() {
  const [user, data] = await Promise.all([requireUser('/dashboard'), dashboardData()]);
  const { month } = periodOf(data.asOf);

  const netDelta = data.netIncomeCents - data.previousNetIncomeCents;
  const previousMonth = monthLabel(
    month === 1 ? data.period.year - 1 : data.period.year,
    month === 1 ? 12 : month - 1,
  ).split(' ')[0];

  const emptyBooks = data.recentEntries.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Dashboard"
        description={`Sooz Books as of ${data.asOf}.`}
        meta={
          <Badge tone={data.period.status === 'closed' ? 'neutral' : 'info'}>
            {data.period.status === 'closed' ? <Lock /> : null}
            {monthLabel(data.period.year, data.period.month)} {data.period.status}
          </Badge>
        }
        actions={
          can(user.role, 'ledger.post') ? (
            <Button asChild size="sm">
              <Link href="/ledger/new">
                <Plus />
                New entry
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Cash in bank"
          value={<Money cents={data.cashCents} currency plain />}
          hint={`${data.bankAccounts.length} ${data.bankAccounts.length === 1 ? 'account' : 'accounts'}`}
          footer={
            data.bankAccounts.length === 0 ? (
              'No bank account has posted activity yet.'
            ) : (
              <ul className="flex flex-col gap-0.5">
                {data.bankAccounts.map((account) => (
                  <li key={account.accountId} className="flex justify-between gap-3">
                    <span className="truncate">{account.name}</span>
                    <Money cents={account.cents} plain className="text-xs" />
                  </li>
                ))}
              </ul>
            )
          }
        />

        <StatTile
          label={`Net income · ${monthLabel(data.period.year, data.period.month).split(' ')[0]}`}
          value={<Money cents={data.netIncomeCents} currency plain />}
          delta={formatCents(netDelta, { currency: true, signed: true })}
          deltaTone={netDelta === 0 ? 'neutral' : netDelta > 0 ? 'positive' : 'negative'}
          deltaDirection={netDelta === 0 ? 'flat' : netDelta > 0 ? 'up' : 'down'}
          deltaLabel={`vs. ${previousMonth}`}
          footer={
            <span>
              Revenue less expense on posted entries.{' '}
              <Link href="/reports/profit-loss" className="text-primary hover:underline">
                P&amp;L
              </Link>
            </span>
          }
        />

        <StatTile
          label="Card balances"
          value={<Money cents={data.cardBalanceCents} currency plain />}
          hint="owed"
          footer="Company cards reconciled against a statement feed."
        />

        <StatTile
          label="Drafts to post"
          value={<span className="num">{data.draftCount}</span>}
          footer={
            data.draftCount === 0 ? (
              'Nothing unposted.'
            ) : (
              <Link href="/ledger?status=draft" className="text-primary hover:underline">
                Work the drafts
              </Link>
            )
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Net income by month</CardTitle>
            <p className="text-xs text-muted-foreground">Last six months, posted entries only.</p>
          </CardHeader>
          <div className="p-3">
            <NetIncomeChart data={data.monthly} />
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              Top expenses · {monthLabel(data.period.year, data.period.month).split(' ')[0]}
            </CardTitle>
            <Money cents={data.expenseTotalCents} currency plain className="text-sm font-semibold" />
          </CardHeader>
          {data.topExpenses.length === 0 ? (
            <EmptyState
              title="No expense posted this month"
              description="Expense accounts with activity in the month will rank here."
            />
          ) : (
            <ul className="flex flex-col gap-2 p-4">
              {data.topExpenses.map((expense) => {
                const share =
                  data.expenseTotalCents === 0
                    ? 0
                    : Math.round((expense.cents / data.expenseTotalCents) * 100);
                return (
                  <li key={expense.accountId} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <Link
                        href={`/ledger?accountId=${expense.accountId}`}
                        className="min-w-0 truncate hover:underline"
                      >
                        <span className="num mr-2 text-xs text-muted-foreground">
                          {expense.code}
                        </span>
                        {expense.name}
                      </Link>
                      <Money cents={expense.cents} plain />
                    </div>
                    <div className="h-1 w-full rounded-xs bg-muted">
                      <div
                        className="h-1 rounded-xs bg-primary"
                        style={{ width: `${Math.max(share, 2)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent entries</CardTitle>
          <Link href="/ledger" className="text-xs text-primary hover:underline">
            Open the journal
          </Link>
        </CardHeader>
        {emptyBooks ? (
          <EmptyState
            title="Nothing has been posted yet"
            description="The first entry can be written by hand, or arrive from a bank import once one is loaded."
            action={
              can(user.role, 'ledger.post') ? (
                <Button asChild size="sm">
                  <Link href="/ledger/new">New entry</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-2xl border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Recent journal entries</caption>
              <thead>
                <tr>
                  <th scope="col" className="rule-head bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Entry
                  </th>
                  <th scope="col" className="rule-head bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Date
                  </th>
                  <th scope="col" className="rule-head bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Memo
                  </th>
                  <th scope="col" className="rule-head bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Source
                  </th>
                  <th scope="col" className="rule-head bg-surface-sunken px-3 py-1.5 text-right text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Debits
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.recentEntries.map((entry) => (
                  <tr key={entry.id} className="rule-row align-middle">
                    <td className="num px-3 py-1.5">
                      <Link href={`/ledger/${entry.id}`} className="hover:underline">
                        #{entry.entryNo}
                      </Link>
                      {entry.status === 'draft' ? (
                        <Badge tone="warning" size="sm" className="ml-2">
                          draft
                        </Badge>
                      ) : null}
                    </td>
                    <td className="num px-3 py-1.5">{entry.date}</td>
                    <td className="px-3 py-1.5">
                      {entry.memo ?? <span className="text-muted-foreground">No memo</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">
                      {sourceLabel(entry.sourceType)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Money cents={entry.debitCents} plain />
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

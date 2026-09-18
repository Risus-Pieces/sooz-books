import type { Metadata } from 'next';
import Link from 'next/link';
import { BookOpenText, Landmark, Scale, Target, TrendingUp, Waves } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requireCapability } from '@/lib/auth/session';
import { monthStart, today } from '@/lib/dates';
import { datePresets, reportRequestToParams, type ReportRequest } from '@/lib/reports/types';

export const metadata: Metadata = {
  title: 'Reports',
};

const ICONS = {
  'profit-loss': TrendingUp,
  'balance-sheet': Scale,
  'trial-balance': Landmark,
  'general-ledger': BookOpenText,
  'cash-flow': Waves,
  'budget-vs-actual': Target,
} as const;

interface ReportCard {
  key: keyof typeof ICONS;
  href: string;
  title: string;
  description: string;
  tags: string[];
}

export default async function ReportsIndexPage() {
  await requireCapability('reports.view');

  const anchor = today();
  const presets = datePresets(anchor);
  const ytd = presets.find((preset) => preset.key === 'ytd');

  const monthly: ReportRequest = {
    from: monthStart(anchor),
    to: anchor,
    columns: 'total',
    basis: 'accrual',
    includeZeroRows: false,
  };
  const yearToDate: ReportRequest = {
    ...monthly,
    from: ytd?.from ?? monthStart(anchor),
    to: ytd?.to ?? anchor,
  };

  const query = (request: ReportRequest): string => `?${reportRequestToParams(request).toString()}`;

  const cards: ReportCard[] = [
    {
      key: 'profit-loss',
      href: `/reports/profit-loss${query({ ...yearToDate, percentOfNetSales: true })}`,
      title: 'Profit & Loss',
      description:
        'Gross sales, trade spend, net sales, COGS and the two margin lines this business is run on. By month, by channel, against last year.',
      tags: ['Net sales', 'Gross margin', 'Contribution margin'],
    },
    {
      key: 'balance-sheet',
      href: `/reports/balance-sheet${query(monthly)}`,
      title: 'Balance Sheet',
      description:
        'Assets, liabilities and equity as of a date, split current and non-current, with the period result broken out of retained earnings.',
      tags: ['Working capital', 'Retained earnings'],
    },
    {
      key: 'trial-balance',
      href: `/reports/trial-balance${query(monthly)}`,
      title: 'Trial Balance',
      description:
        'Every account with a balance, in debit and credit columns that tie. The first thing to open when a statement looks wrong.',
      tags: ['Tie-out', 'Wrong-side flags'],
    },
    {
      key: 'general-ledger',
      href: `/reports/general-ledger${query(monthly)}`,
      title: 'General Ledger',
      description:
        'The register behind every figure: opening balance, each posted line with its entry and source, running balance, closing balance.',
      tags: ['Drill-down', 'Audit trail'],
    },
    {
      key: 'cash-flow',
      href: `/reports/cash-flow${query(yearToDate)}`,
      title: 'Cash Flow',
      description:
        'Net income walked to the change in cash: operating, investing and financing, tied to the Relay accounts with no plug.',
      tags: ['Indirect method', 'Member contributions'],
    },
    {
      key: 'budget-vs-actual',
      href: '/plan/budget?tab=variance',
      title: 'Budget vs Actual',
      description:
        'The active budget against posted actuals on the P&L spine, with each variance coloured by whether it helps or hurts.',
      tags: ['Variance', 'Favourability'],
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Reports"
        title="Reports"
        description="Every report reads the posted ledger directly. Nothing here is cached, so what you see is what is in the books right now."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {cards.map((card) => {
          const Icon = ICONS[card.key];
          return (
            <Card key={card.key} className="transition-colors hover:border-border-strong">
              <Link href={card.href} className="flex flex-col gap-2 p-4">
                <div className="flex items-center gap-2">
                  <span className="flex size-7 items-center justify-center rounded-sm border border-border bg-muted text-muted-foreground [&_svg]:size-4">
                    <Icon aria-hidden />
                  </span>
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">
                    {card.title}
                  </h2>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{card.description}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {card.tags.map((tag) => (
                    <Badge key={tag} tone="neutral">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </Link>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

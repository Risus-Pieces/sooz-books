import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { PageToolbar } from '@/components/shell/page-toolbar';
import { Glyph } from '@/components/ui/glyph';
import { IconBadge } from '@/components/ui/icon-badge';
import { requireCapability } from '@/lib/auth/session';
import { monthStart, today } from '@/lib/dates';
import { datePresets, reportRequestToParams, type ReportRequest } from '@/lib/reports/types';
import type { GlyphName } from '@/lib/ui/glyphs';
import type { Tint } from '@/lib/ui/tints';

export const metadata: Metadata = {
  title: 'Reports',
};

interface ReportTile {
  key: string;
  href: string;
  title: string;
  /** Two words at most: what the report answers. */
  caption: string;
  glyph: GlyphName;
  tint: Tint;
  preview: ReactNode;
}

/* Tiny preview graphics: the shape each report's summary chart takes, drawn as a thumbnail. */

function PnlPreview() {
  const up = [8, 12, 10, 16, 14, 22, 26];
  const down = [10, 9, 12, 8, 11, 9, 7];
  return (
    <svg viewBox="0 0 120 56" aria-hidden className="h-14 w-full">
      <line x1="0" x2="120" y1="30" y2="30" stroke="var(--label3)" strokeWidth="0.8" />
      {up.map((h, i) => (
        <rect key={`u${i}`} x={6 + i * 16} y={29 - h} width="9" height={h} rx="2" fill="var(--green)" />
      ))}
      {down.map((h, i) => (
        <rect key={`d${i}`} x={6 + i * 16} y={31} width="9" height={h * 0.9} rx="2" fill="var(--red)" opacity="0.82" />
      ))}
    </svg>
  );
}

function BalancePreview() {
  return (
    <svg viewBox="0 0 120 56" aria-hidden className="h-14 w-full">
      <rect x="0" y="12" width="120" height="12" rx="4" fill="var(--blue)" />
      <rect x="0" y="32" width="34" height="12" rx="4" fill="var(--red)" />
      <rect x="36" y="32" width="84" height="12" rx="4" fill="var(--indigo)" />
    </svg>
  );
}

function TrialPreview() {
  return (
    <svg viewBox="0 0 120 56" aria-hidden className="h-14 w-full">
      <rect x="4" y="24" width="44" height="8" rx="4" fill="var(--blue)" />
      <rect x="72" y="24" width="44" height="8" rx="4" fill="var(--indigo)" />
      <circle cx="60" cy="28" r="10" fill="var(--green)" />
      <path d="M55.5 28.2l3 3 6-6.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LedgerPreview() {
  return (
    <svg viewBox="0 0 120 56" aria-hidden className="h-14 w-full">
      <polygon points="2,44 18,38 34,40 50,28 66,31 82,20 98,24 118,12 118,50 2,50" fill="var(--teal)" opacity="0.14" />
      <polyline
        points="2,44 18,38 34,40 50,28 66,31 82,20 98,24 118,12"
        fill="none"
        stroke="var(--teal)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="118" cy="12" r="3" fill="var(--teal)" />
    </svg>
  );
}

function CashPreview() {
  return (
    <svg viewBox="0 0 120 56" aria-hidden className="h-14 w-full">
      <line x1="0" x2="120" y1="50" y2="50" stroke="var(--label3)" strokeWidth="0.8" />
      <rect x="4" y="30" width="16" height="20" rx="3" fill="var(--blue)" />
      <rect x="28" y="14" width="16" height="16" rx="3" fill="var(--green)" />
      <rect x="52" y="14" width="16" height="8" rx="3" fill="var(--red)" opacity="0.88" />
      <rect x="76" y="6" width="16" height="16" rx="3" fill="var(--green)" />
      <rect x="100" y="6" width="16" height="44" rx="3" fill="var(--blue)" />
    </svg>
  );
}

function BudgetPreview() {
  const bars = [
    [30, 26],
    [22, 28],
    [36, 30],
    [18, 20],
    [28, 34],
  ];
  return (
    <svg viewBox="0 0 120 56" aria-hidden className="h-14 w-full">
      {bars.map(([plan, actual], i) => (
        <g key={i}>
          <rect x={6 + i * 23} y={52 - plan} width="8" height={plan} rx="2" fill="var(--fill)" />
          <rect x={15 + i * 23} y={52 - actual} width="8" height={actual} rx="2" fill={actual > plan ? 'var(--orange)' : 'var(--purple)'} />
        </g>
      ))}
    </svg>
  );
}

function MarginPreview() {
  const rows = [100, 78, 60, 42];
  return (
    <svg viewBox="0 0 120 56" aria-hidden className="h-14 w-full">
      {rows.map((w, i) => (
        <g key={i}>
          <rect x="0" y={4 + i * 13} width={w * 1.2} height="8" rx="4" fill="var(--fill)" />
          <rect x="0" y={4 + i * 13} width={w * 0.62} height="8" rx="4" fill="var(--mint)" />
        </g>
      ))}
    </svg>
  );
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

  const statements: ReportTile[] = [
    {
      key: 'profit-loss',
      href: `/reports/profit-loss${query({ ...yearToDate, percentOfNetSales: true })}`,
      title: 'Profit & Loss',
      caption: 'Earned vs spent',
      glyph: 'chart',
      tint: 'green',
      preview: <PnlPreview />,
    },
    {
      key: 'balance-sheet',
      href: `/reports/balance-sheet${query(monthly)}`,
      title: 'Balance Sheet',
      caption: 'Owned vs owed',
      glyph: 'book',
      tint: 'blue',
      preview: <BalancePreview />,
    },
    {
      key: 'cash-flow',
      href: `/reports/cash-flow${query(yearToDate)}`,
      title: 'Cash Flow',
      caption: 'Where cash went',
      glyph: 'bank',
      tint: 'cyan',
      preview: <CashPreview />,
    },
  ];

  const books: ReportTile[] = [
    {
      key: 'trial-balance',
      href: `/reports/trial-balance${query(monthly)}`,
      title: 'Trial Balance',
      caption: 'Debits = credits',
      glyph: 'check-circle',
      tint: 'indigo',
      preview: <TrialPreview />,
    },
    {
      key: 'general-ledger',
      href: `/reports/general-ledger${query(monthly)}`,
      title: 'General Ledger',
      caption: 'Every line',
      glyph: 'list',
      tint: 'teal',
      preview: <LedgerPreview />,
    },
    {
      key: 'budget-vs-actual',
      href: '/plan/budget?tab=variance',
      title: 'Budget vs Actual',
      caption: 'Plan vs real',
      glyph: 'target',
      tint: 'purple',
      preview: <BudgetPreview />,
    },
    {
      key: 'margin',
      href: '/reports/margin',
      title: 'Gross Margin',
      caption: 'By product',
      glyph: 'percent',
      tint: 'mint',
      preview: <MarginPreview />,
    },
  ];

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Reports"
        info={
          <p>
            Every report reads the posted ledger directly. Nothing is cached, so what you see is what is in the books
            right now. Lines still waiting in review are not in these figures.
          </p>
        }
      />
      <TileGroup label="Statements" tiles={statements} />
      <TileGroup label="Books" tiles={books} />
    </div>
  );
}

function TileGroup({ label, tiles }: { label: string; tiles: ReportTile[] }) {
  return (
    <section aria-label={label}>
      <h2 className="px-1 pt-1 pb-2 text-sm font-semibold text-label2">{label}</h2>
      <div className="grid grid-cols-2 gap-3.5 max-md:gap-3 lg:grid-cols-3 xl:grid-cols-4">
        {tiles.map((tile) => (
          <Link
            key={tile.key}
            href={tile.href}
            className="group flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4 shadow-card outline-none transition-shadow duration-150 hover:shadow-glass focus-visible:ring-2 focus-visible:ring-tint-blue/60 max-sm:rounded-[22px] max-sm:p-3.5"
          >
            <div className="rounded-[11px] bg-inset px-3 py-2.5">{tile.preview}</div>
            <div className="flex min-w-0 items-center gap-2.5">
              <IconBadge glyph={tile.glyph} tint={tile.tint} size="lg" className="max-sm:hidden" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold max-sm:text-[0.9375rem]">{tile.title}</p>
                <p className="truncate text-xs text-label2">{tile.caption}</p>
              </div>
              <Glyph name="chevron-right" size={12} weight={2.4} className="shrink-0 text-label3 transition-transform group-hover:translate-x-0.5" />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

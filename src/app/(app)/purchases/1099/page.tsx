import type { Metadata } from 'next';
import Link from 'next/link';

import { NumbersTable, Td, Th } from '@/components/arap/doc-status';
import { YearPicker } from '@/components/arap/year-picker';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Glyph } from '@/components/ui/glyph';
import { IconBadge } from '@/components/ui/icon-badge';
import { InfoButton } from '@/components/ui/info-button';
import { inputBase } from '@/components/ui/input';
import { Money, formatCents } from '@/components/ui/money';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { StatTile } from '@/components/ui/stat-tile';
import { ToolbarButton, ToolbarGroup, ToolbarLink } from '@/components/ui/toolbar';
import { type Form1099Row, form1099NecThresholdCents, form1099Report } from '@/lib/arap';
import { requireUser } from '@/lib/auth/session';
import { cn } from '@/lib/cn';
import { today } from '@/lib/dates';
import { mediumDate } from '@/lib/ui/format';

import { FIRST_1099_YEAR, read1099Params } from './params';

export const metadata: Metadata = { title: '1099-NEC' };

type SearchParams = Record<string, string | string[] | undefined>;

const STATUS: Record<string, { label: string; tone: 'positive' | 'warning' | 'neutral' | 'info' }> = {
  file: { label: 'File', tone: 'positive' },
  needs_w9: { label: 'Needs W-9', tone: 'warning' },
  below_threshold: { label: 'Below', tone: 'neutral' },
  review_flag: { label: 'Review', tone: 'info' },
};

export default async function Form1099Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [, raw] = await Promise.all([requireUser('/purchases/1099'), searchParams]);
  const { year, thresholdCents, thresholdText } = read1099Params(raw);
  const report = await form1099Report(year, thresholdCents === null ? {} : { thresholdCents });
  const statutory = form1099NecThresholdCents(year);
  const currentYear = Number(today().slice(0, 4));
  const years = Array.from({ length: currentYear - FIRST_1099_YEAR + 1 }, (_, i) => currentYear - i);

  const thresholdQuery = thresholdCents === null ? '' : `&threshold=${encodeURIComponent(thresholdText)}`;
  const toFile = report.vendors.filter((v) => v.status === 'file' || v.status === 'needs_w9');
  const missingW9 = report.vendors.filter((v) => v.status === 'needs_w9').length;
  const exportHref = `/purchases/1099/export?year=${year}${thresholdQuery}`;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="1099-NEC"
        back={{ href: '/purchases', label: 'Purchases' }}
        phoneTitleRow
        info={
          <>
            <p>
              What each contractor was paid in the year by bank transfer or check: bill payments and bank lines booked
              with the vendor tagged. Card payments are left out; the card network reports those on a 1099-K.
            </p>
            <p>
              The threshold is $600 for payments through 2025 and $2,000 from 2026. Confirm the figure with your tax
              preparer before filing.
            </p>
          </>
        }
        actions={
          <>
            <ToolbarGroup>
              <YearPicker
                years={years}
                year={year}
                hrefFor={Object.fromEntries(years.map((y) => [String(y), `/purchases/1099?year=${y}${thresholdQuery}`]))}
              />
              <Popover>
                <PopoverTrigger asChild>
                  <ToolbarButton glyph="dollar" label="Threshold" tone={thresholdCents === null ? 'default' : 'accent'} />
                </PopoverTrigger>
                <PopoverContent align="end" className="w-64 p-3">
                  <form method="get" action="/purchases/1099" className="flex flex-col gap-2.5">
                    <input type="hidden" name="year" value={year} />
                    <label htmlFor="threshold" className="text-sm font-medium">
                      Threshold
                    </label>
                    <input
                      id="threshold"
                      name="threshold"
                      inputMode="decimal"
                      defaultValue={thresholdText}
                      placeholder={formatCents(statutory)}
                      className={cn(inputBase, 'num text-right')}
                    />
                    <p className="text-xs text-label2">Blank for the statutory figure.</p>
                    <Button type="submit" size="sm" className="self-end">
                      Apply
                    </Button>
                  </form>
                </PopoverContent>
              </Popover>
            </ToolbarGroup>
            <ToolbarGroup>
              <ToolbarLink href={exportHref} download prefetch={false} glyph="export" label="Export CSV" />
            </ToolbarGroup>
          </>
        }
      />

      {report.warnings.length > 0 ? (
        <Card className="flex flex-col gap-2 px-5 py-3.5 max-sm:px-4">
          {report.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 text-sm">
              <Glyph name="warning" size={15} className="mt-0.5 shrink-0 text-tint-orange" />
              {w}
            </p>
          ))}
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3.5 max-md:gap-3 lg:grid-cols-4">
        <StatTile
          label="Threshold"
          badge={<IconBadge glyph="dollar" tint="gray" />}
          hint={thresholdCents === null ? undefined : 'Override'}
          value={<Money cents={report.thresholdCents} currency plain whole />}
        />
        <StatTile label="To file" badge={<IconBadge glyph="doc-text" tint="purple" />} value={toFile.length} />
        <StatTile
          label="No W-9"
          badge={<IconBadge glyph="warning" tint="orange" />}
          value={<span className={missingW9 > 0 ? 'text-ink-orange' : undefined}>{missingW9}</span>}
        />
        <StatTile label="To review" badge={<IconBadge glyph="question" tint="blue" />} value={report.candidates.length} />
      </div>

      <Card className="overflow-hidden">
        <header className="flex items-center gap-2 px-5 pt-4 pb-2.5 max-sm:px-4">
          <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">Flagged</h2>
          <Link href="/purchases/vendors" className="text-sm font-medium text-ink-blue hover:underline">
            Vendors
          </Link>
        </header>
        {report.vendors.length === 0 ? (
          <EmptyState
            glyph="doc-text"
            title="Nobody flagged for 1099"
            description="Flag the individuals and LLCs you pay for services (a formulator, a designer, a photographer) on the Vendors page, and record their W-9. Payments to them then total here by year, ready to file."
            action={
              <Button asChild variant="secondary">
                <Link href="/purchases/vendors">Open vendors</Link>
              </Button>
            }
          />
        ) : (
          <Rows1099 rows={report.vendors} caption={`Flagged vendors, ${year}`} />
        )}
      </Card>

      <Card className="overflow-hidden">
        <header className="flex items-center gap-1 px-5 pt-4 pb-2.5 max-sm:px-4">
          <h2 className="text-lg font-semibold tracking-[-0.01em]">Worth a look</h2>
          <InfoButton label="About worth a look">
            <p>
              Paid by bank in {year}, not flagged, and typed as professional or broker, or usually posting to fees or
              R&amp;D. Bank lines still in review do not count until they are posted.
            </p>
          </InfoButton>
        </header>
        {report.candidates.length === 0 ? (
          <EmptyState glyph="check-circle" title="Nothing to review" className="py-8" />
        ) : (
          <Rows1099 rows={report.candidates} caption={`Vendors worth a look, ${year}`} />
        )}
      </Card>
    </div>
  );
}

function Rows1099({ rows, caption }: { rows: readonly Form1099Row[]; caption: string }) {
  return (
    <NumbersTable
      caption={caption}
      minWidth="min-w-[54rem]"
      head={
        <>
          <Th>Vendor</Th>
          <Th>Tax id</Th>
          <Th>W-9</Th>
          <Th align="right">Bills</Th>
          <Th align="right">Direct</Th>
          <Th align="right">Card</Th>
          <Th align="right">Reportable</Th>
          <Th>Status</Th>
        </>
      }
      foot={
        <tr>
          <td className="px-5 py-2.5 font-bold max-sm:px-4" colSpan={6}>
            Total
          </td>
          <td className="px-3 py-2.5 text-right font-bold">
            <Money cents={rows.reduce((s, r) => s + r.reportableCents, 0)} currency plain />
          </td>
          <td />
        </tr>
      }
    >
      {rows.map((row) => {
        const status = STATUS[row.status] ?? { label: row.status, tone: 'neutral' as const };
        return (
          <tr key={row.vendorId} className="transition-colors hover:bg-fill2">
            <Td>
              <Link href={`/purchases/bills?vendor=${row.vendorId}`} className="font-semibold hover:underline">
                {row.vendorName}
              </Link>
              {row.legalName ? <span className="block text-xs text-label2">{row.legalName}</span> : null}
            </Td>
            <Td className="num">{row.taxIdLast4 ? `••${row.taxIdLast4}` : <span className="text-label2">None</span>}</Td>
            <Td className="whitespace-nowrap">
              {row.w9OnFile ? (
                <span className="inline-flex items-center gap-1.5">
                  <Glyph name="check-circle" size={14} className="text-tint-green" />
                  {row.w9ReceivedAt ? mediumDate(row.w9ReceivedAt) : 'On file'}
                </span>
              ) : (
                <span className="text-label2">None</span>
              )}
            </Td>
            <Td align="right">
              <Money cents={row.billPaymentCents} zeroDash plain />
            </Td>
            <Td align="right">
              <Money cents={row.directPaymentCents} zeroDash plain />
            </Td>
            <Td align="right" className="text-label2">
              <Money cents={row.cardPaymentCents} zeroDash plain />
            </Td>
            <Td align="right" className="font-semibold">
              <Money cents={row.reportableCents} plain />
            </Td>
            <Td>
              <Badge tone={status.tone}>{status.label}</Badge>
            </Td>
          </tr>
        );
      })}
    </NumbersTable>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, FileCheck2, TriangleAlert } from 'lucide-react';

import { Td, Th } from '@/components/arap/doc-status';
import { STATUS_1099_LABELS } from '@/components/arap/form-1099-csv';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { inputBase } from '@/components/ui/input';
import { Money, formatCents } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { StatTile } from '@/components/ui/stat-tile';
import { type Form1099Row, form1099NecThresholdCents, form1099Report } from '@/lib/arap';
import { requireUser } from '@/lib/auth/session';
import { today } from '@/lib/dates';
import { cn } from '@/lib/cn';

import { FIRST_1099_YEAR, read1099Params } from './params';

export const metadata: Metadata = { title: '1099-NEC' };

type SearchParams = Record<string, string | string[] | undefined>;

const STATUS_TONE: Record<string, 'positive' | 'warning' | 'neutral' | 'info'> = {
  file: 'positive',
  needs_w9: 'warning',
  below_threshold: 'neutral',
  review_flag: 'info',
};

export default async function Form1099Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [, raw] = await Promise.all([requireUser('/purchases/1099'), searchParams]);
  const { year, thresholdCents, thresholdText } = read1099Params(raw);
  const report = await form1099Report(year, thresholdCents === null ? {} : { thresholdCents });
  const statutory = form1099NecThresholdCents(year);
  const currentYear = Number(today().slice(0, 4));
  const years = Array.from({ length: currentYear - FIRST_1099_YEAR + 1 }, (_, i) => currentYear - i);

  const toFile = report.vendors.filter((v) => v.status === 'file' || v.status === 'needs_w9');
  const exportHref = `/purchases/1099/export?year=${year}${thresholdCents === null ? '' : `&threshold=${encodeURIComponent(thresholdText)}`}`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Purchases"
        title="1099-NEC"
        description="What each contractor was paid in the year by bank transfer or check — bill payments and bank lines booked with the vendor tagged. Card payments are left out; the card network reports those on a 1099-K."
        actions={
          <Button asChild variant="secondary" size="sm">
            <a href={exportHref} download>
              <Download />
              Export CSV
            </a>
          </Button>
        }
      />

      <form method="get" action="/purchases/1099" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Tax year</span>
          <select name="year" defaultValue={String(year)} className={cn(inputBase, 'num w-28 pr-8')}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Threshold</span>
          <input
            name="threshold"
            inputMode="decimal"
            defaultValue={thresholdText}
            placeholder={formatCents(statutory)}
            className={cn(inputBase, 'num w-32 text-right')}
          />
        </label>
        <Button type="submit" variant="secondary">
          Show
        </Button>
        <p className="max-w-xl text-xs text-muted-foreground">
          Leave the threshold blank for the statutory figure: $600 for payments through 2025, $2,000 from 2026 under
          the One Big Beautiful Bill Act. Confirm the figure with your tax preparer before filing.
        </p>
      </form>

      {report.warnings.length > 0 ? (
        <Card className="border-warning/40">
          <ul className="flex flex-col gap-1 px-4 py-3 text-sm">
            {report.warnings.map((w) => (
              <li key={w} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {w}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Threshold" value={<Money cents={report.thresholdCents} currency plain />} hint={thresholdCents === null ? 'statutory' : 'override'} />
        <StatTile label="Forms to file" value={<span className="num">{toFile.length}</span>} footer={`Flagged vendors paid ${formatCents(report.thresholdCents, { currency: true })} or more in ${year}.`} />
        <StatTile
          label="Missing W-9"
          value={<span className={cn('num', report.vendors.some((v) => v.status === 'needs_w9') && 'text-warning')}>{report.vendors.filter((v) => v.status === 'needs_w9').length}</span>}
          footer="Collect before January 31."
        />
        <StatTile label="To review" value={<span className="num">{report.candidates.length}</span>} footer="Unflagged vendors that look like contractors." />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Flagged vendors · {year}</CardTitle>
          <Link href="/purchases/vendors" className="text-xs text-primary hover:underline">
            Change flags and W-9s
          </Link>
        </CardHeader>
        {report.vendors.length === 0 ? (
          <EmptyState
            icon={<FileCheck2 />}
            title="No vendor is flagged for 1099"
            description="Flag the individuals and LLCs you pay for services — a formulator, a designer, a freelance photographer — on the Vendors page, and record their W-9. Payments to them then total here by year, ready to file."
            action={
              <Button asChild size="sm" variant="secondary">
                <Link href="/purchases/vendors">Open vendors</Link>
              </Button>
            }
          />
        ) : (
          <Rows1099 rows={report.vendors} />
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Worth a look</CardTitle>
          <span className="text-xs text-muted-foreground">Paid by bank in {year}, not flagged, and typed as professional or broker, or usually posting to fees or R&amp;D</span>
        </CardHeader>
        {report.candidates.length === 0 ? (
          <p className="px-4 py-4 text-xs text-muted-foreground">
            No unflagged vendor looks like a contractor on posted payments for {year}. Bank lines still in review do not
            count until they are posted.
          </p>
        ) : (
          <Rows1099 rows={report.candidates} />
        )}
      </Card>
    </div>
  );
}

function Rows1099({ rows }: { rows: readonly Form1099Row[] }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[56rem] border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <Th>Vendor</Th>
            <Th>TIN</Th>
            <Th>W-9</Th>
            <Th align="right">Bill payments</Th>
            <Th align="right">Direct</Th>
            <Th align="right">Card (excluded)</Th>
            <Th align="right">Reportable</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.vendorId}>
              <Td>
                <Link href={`/purchases/bills?vendor=${row.vendorId}`} className="font-medium hover:underline">
                  {row.vendorName}
                </Link>
                {row.legalName ? <span className="block text-2xs text-muted-foreground">{row.legalName}</span> : null}
              </Td>
              <Td className="num text-xs">{row.taxIdLast4 ? `••${row.taxIdLast4}` : <span className="text-muted-foreground">—</span>}</Td>
              <Td className="text-xs">
                {row.w9OnFile ? (
                  <span>
                    On file{row.w9ReceivedAt ? <span className="num text-muted-foreground"> {row.w9ReceivedAt}</span> : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </Td>
              <Td align="right">
                <Money cents={row.billPaymentCents} zeroDash />
              </Td>
              <Td align="right">
                <Money cents={row.directPaymentCents} zeroDash />
              </Td>
              <Td align="right">
                <Money cents={row.cardPaymentCents} zeroDash className="text-muted-foreground" />
              </Td>
              <Td align="right">
                <Money cents={row.reportableCents} className="font-semibold" />
              </Td>
              <Td>
                <Badge tone={STATUS_TONE[row.status] ?? 'neutral'} size="sm">
                  {STATUS_1099_LABELS[row.status] ?? row.status}
                </Badge>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

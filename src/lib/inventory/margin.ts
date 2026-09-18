/**
 * Gross margin by product, channel, or both, read straight off the ledger's
 * dimensions.
 *
 * Net sales and COGS are drawn the same way the P&L draws them: net sales is
 * everything under 4000 Gross Revenue less everything under 4500 Contra Revenue
 * (credit − debit), COGS is everything under 5000 Cost of Goods Sold
 * (debit − credit). Only posted entries in the window count; reversals are
 * posted entries and net their originals out naturally.
 *
 * A line with no product or channel tag falls into an "Unassigned" bucket rather
 * than disappearing: Square deposits today carry no product, and margin that
 * silently omitted them would overstate the tagged SKUs' share.
 */

import { sql as sqlTag } from 'drizzle-orm';

import { type CalendarDate, isCalendarDate, today } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';
import {
  basisPoints,
  formatWindow,
  row,
  type ColumnDef,
  type Report,
  type ReportRow,
} from '@/lib/reports/types';

import { reader } from './context';
import { InventoryError } from './errors';

export type MarginGroupBy = 'product' | 'channel' | 'product_channel';

export interface MarginRequest {
  from: CalendarDate;
  to: CalendarDate;
  groupBy: MarginGroupBy;
}

export interface MarginRow {
  productId: string | null;
  sku: string | null;
  productName: string | null;
  channelId: string | null;
  channelCode: string | null;
  channelName: string | null;
  netSalesCents: number;
  cogsCents: number;
  grossMarginCents: number;
  /** Basis points of net sales; 0 when there are no sales. */
  grossMarginBps: number;
}

export interface MarginResult {
  request: MarginRequest;
  rows: MarginRow[];
  totals: Omit<MarginRow, 'productId' | 'sku' | 'productName' | 'channelId' | 'channelCode' | 'channelName'>;
  report: Report;
}

interface QueryRow extends Record<string, unknown> {
  product_id: string | null;
  sku: string | null;
  product_name: string | null;
  channel_id: string | null;
  channel_code: string | null;
  channel_name: string | null;
  net_sales: string | number;
  cogs: string | number;
}

export async function grossMarginBy(request: MarginRequest, exec?: LedgerDb): Promise<MarginResult> {
  const { from, to, groupBy } = request;
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    throw new InventoryError('invalid_input', 'Choose a valid date range.');
  }
  const byProduct = groupBy !== 'channel';
  const byChannel = groupBy !== 'product';

  const rows = await reader(exec).execute<QueryRow>(sqlTag`
    with recursive tree as (
      select id, code as root from accounts
       where code in (${ACCOUNTS.GROSS_REVENUE}, ${ACCOUNTS.CONTRA_REVENUE}, ${ACCOUNTS.COGS})
      union all
      select a.id, t.root from accounts a join tree t on a.parent_id = t.id
    )
    select ${byProduct ? sqlTag`l.product_id` : sqlTag`null::uuid`} as product_id,
           ${byProduct ? sqlTag`max(p.sku)` : sqlTag`null`} as sku,
           ${byProduct ? sqlTag`max(p.name)` : sqlTag`null`} as product_name,
           ${byChannel ? sqlTag`l.channel_id` : sqlTag`null::uuid`} as channel_id,
           ${byChannel ? sqlTag`max(ch.code)` : sqlTag`null`} as channel_code,
           ${byChannel ? sqlTag`max(ch.name)` : sqlTag`null`} as channel_name,
           coalesce(sum(case when t.root in (${ACCOUNTS.GROSS_REVENUE}, ${ACCOUNTS.CONTRA_REVENUE})
                             then l.credit_cents - l.debit_cents else 0 end), 0) as net_sales,
           coalesce(sum(case when t.root = ${ACCOUNTS.COGS}
                             then l.debit_cents - l.credit_cents else 0 end), 0) as cogs
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join tree t on t.id = l.account_id
      left join products p on p.id = l.product_id
      left join channels ch on ch.id = l.channel_id
     where e.entry_date between ${from} and ${to}
     group by 1, 4
  `);

  const out: MarginRow[] = [...rows].map((r) => {
    const netSalesCents = Number(r.net_sales);
    const cogsCents = Number(r.cogs);
    const grossMarginCents = netSalesCents - cogsCents;
    return {
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      channelId: r.channel_id,
      channelCode: r.channel_code,
      channelName: r.channel_name,
      netSalesCents,
      cogsCents,
      grossMarginCents,
      grossMarginBps: basisPoints(grossMarginCents, netSalesCents),
    };
  });
  out.sort(
    (a, b) =>
      b.netSalesCents - a.netSalesCents ||
      (a.sku ?? '\uffff').localeCompare(b.sku ?? '\uffff') ||
      (a.channelCode ?? '\uffff').localeCompare(b.channelCode ?? '\uffff'),
  );

  const netSalesCents = out.reduce((s, r) => s + r.netSalesCents, 0);
  const cogsCents = out.reduce((s, r) => s + r.cogsCents, 0);
  const totals = {
    netSalesCents,
    cogsCents,
    grossMarginCents: netSalesCents - cogsCents,
    grossMarginBps: basisPoints(netSalesCents - cogsCents, netSalesCents),
  };

  return { request, rows: out, totals, report: toReport(request, out, totals) };
}

function labelOf(r: MarginRow, groupBy: MarginGroupBy): string {
  const product = r.sku === null ? 'Unassigned product' : `${r.sku} · ${r.productName ?? ''}`.trim();
  const channel = r.channelName ?? 'Unassigned channel';
  if (groupBy === 'product') return product;
  if (groupBy === 'channel') return channel;
  return `${product} — ${channel}`;
}

function toReport(
  request: MarginRequest,
  rows: readonly MarginRow[],
  totals: MarginResult['totals'],
): Report {
  const columns: ColumnDef[] = [
    { key: 'net_sales', label: 'Net sales', kind: 'amount' },
    { key: 'cogs', label: 'COGS', kind: 'amount' },
    { key: 'gross_margin', label: 'Gross margin', kind: 'amount', emphasis: true },
    { key: 'gm_pct', label: 'GM %', kind: 'percent' },
  ];
  const body: ReportRow[] = rows.map((r) =>
    row({
      id: `margin:${r.productId ?? 'none'}:${r.channelId ?? 'none'}`,
      label: labelOf(r, request.groupBy),
      level: 1,
      values: [r.netSalesCents, r.cogsCents, r.grossMarginCents, r.grossMarginBps],
      drilldown: {
        from: request.from,
        to: request.to,
        ...(request.groupBy === 'product' ? {} : { channelId: r.channelId }),
      },
    }),
  );
  body.push(
    row({
      id: 'margin:total',
      label: 'Total',
      style: 'total',
      values: [totals.netSalesCents, totals.cogsCents, totals.grossMarginCents, totals.grossMarginBps],
    }),
  );
  const by = { product: 'product', channel: 'channel', product_channel: 'product and channel' }[request.groupBy];
  return {
    columns,
    rows: body,
    meta: {
      title: `Gross margin by ${by}`,
      subtitle: formatWindow(request.from, request.to),
      from: request.from,
      to: request.to,
      basis: 'accrual',
      columns: 'total',
      generatedAt: today(),
      warnings: rows.some((r) => r.productId === null && request.groupBy !== 'channel')
        ? ['Some revenue or COGS carries no product tag and is shown as Unassigned.']
        : [],
    },
  };
}

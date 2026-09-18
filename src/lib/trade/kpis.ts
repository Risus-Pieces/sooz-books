/**
 * Trade KPIs, defined once so every report agrees
 * (docs/formats/distributor-deductions.md §10).
 *
 *  - Trade spend % of gross sales   Σ trade-spend contra revenue ÷ Σ gross sales, by customer and month,
 *                                   from the ledger — so accruals land in the promotion's month
 *  - Deduction rate                 Σ deductions taken ÷ Σ gross invoiced, same customer and month
 *  - Dispute recovery rate          Σ recovered ÷ Σ disputed deductions closed in the period (cash-weighted)
 *  - Dispute win rate               cases with any recovery ÷ cases closed
 *  - Days-to-deduction              payment date − invoice date per deduction; mean, p50, p90, by class
 *  - Accrual-to-actual variance     (actual charged to a promotion − accrued) ÷ accrued
 *  - Open Deductions Receivable     aged 0–30 / 31–60 / 61–90 / 91–180 / 180+, plus the unapplied (suspense) part
 *
 * Money stays in integer cents. Ratios are plain numbers rounded to four places
 * (0.085 = 8.5 %) and are null when the denominator is zero.
 */

import { sql } from 'drizzle-orm';

import { BOOKS_TIME_ZONE, type CalendarDate, daysBetween, today } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';

import { type TradeContext, requireDate, requireUuid, runTrade } from './common';
import { invalidInput } from './errors';

/**
 * Contra-revenue accounts that measure trade spend. 4570 marketplace fees are a
 * channel's selling cost, and 4585 returns and 4590 write-offs are conceded
 * claims rather than spend, so none of the three is counted here. 4560
 * Distributor Fees carries fines as well as fees; the per-code `is_trade_spend`
 * flag separates them on the deduction side.
 */
export const TRADE_SPEND_ACCOUNT_CODES: readonly string[] = Object.freeze([
  ACCOUNTS.TRADE_OFF_INVOICE,
  ACCOUNTS.TRADE_BILLBACK,
  ACCOUNTS.TRADE_SCAN_DOWN,
  ACCOUNTS.TRADE_SLOTTING,
  ACCOUNTS.TRADE_SPOILAGE_ALLOWANCE,
  ACCOUNTS.DISTRIBUTOR_FEES,
  ACCOUNTS.COUPONS_AND_PROMOS,
  ACCOUNTS.EARLY_PAYMENT_DISCOUNTS,
]);

/** numerator ÷ denominator to four places, or null when there is nothing to divide by. */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/** Nearest-rank percentile of whole numbers; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p < 0 || p > 1) throw invalidInput('percentile p must be between 0 and 1.');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

export const AGING_BUCKETS = ['0-30', '31-60', '61-90', '91-180', '180+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucket(days: number): AgingBucket {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  if (days <= 180) return '91-180';
  return '180+';
}

export interface KpiFilter {
  from: CalendarDate;
  to: CalendarDate;
  customerId?: string;
  /** The day open balances are aged to. Defaults to `to` or today, whichever is earlier. */
  asOf?: CalendarDate;
}

export interface CustomerMonthKpi {
  customerId: string;
  customerName: string;
  year: number;
  month: number;
  grossSalesCents: number;
  tradeSpendCents: number;
  tradeSpendRatio: number | null;
  grossInvoicedCents: number;
  deductionsCents: number;
  deductionRate: number | null;
}

export interface DaysToDeduction {
  count: number;
  meanDays: number | null;
  p50Days: number | null;
  p90Days: number | null;
}

export interface TradeKpis {
  from: CalendarDate;
  to: CalendarDate;
  byCustomerMonth: CustomerMonthKpi[];
  totals: {
    grossSalesCents: number;
    tradeSpendCents: number;
    tradeSpendRatio: number | null;
    grossInvoicedCents: number;
    deductionsCents: number;
    deductionRate: number | null;
  };
  disputes: {
    casesClosed: number;
    casesWon: number;
    closedCents: number;
    recoveredCents: number;
    writtenOffCents: number;
    recoveryRate: number | null;
    winRate: number | null;
  };
  daysToDeduction: DaysToDeduction & { byCategory: (DaysToDeduction & { category: string })[] };
  accrualVariance: {
    promotionId: string;
    name: string;
    customerId: string | null;
    accruedCents: number;
    actualCents: number;
    varianceCents: number;
    varianceRatio: number | null;
  }[];
  openReceivable: {
    asOf: CalendarDate;
    totalCents: number;
    unappliedCents: number;
    buckets: Record<AgingBucket, number>;
  };
}

function summarize(days: readonly number[]): DaysToDeduction {
  const count = days.length;
  const total = days.reduce((a, b) => a + b, 0);
  return {
    count,
    meanDays: count === 0 ? null : Math.round((total / count) * 10) / 10,
    p50Days: percentile(days, 0.5),
    p90Days: percentile(days, 0.9),
  };
}

type Row = Record<string, unknown>;

export async function tradeKpis(filter: KpiFilter, ctx: TradeContext): Promise<TradeKpis> {
  const from = requireDate('from', filter.from);
  const to = requireDate('to', filter.to);
  if (to < from) throw invalidInput('The period ends before it starts.');
  const customerId = filter.customerId === undefined ? null : requireUuid('customerId', filter.customerId);
  const now = today();
  const asOf = filter.asOf === undefined ? (to < now ? to : now) : requireDate('asOf', filter.asOf);
  const customerClause = (column: string) => (customerId === null ? sql`true` : sql`${sql.raw(column)} = ${customerId}`);

  return runTrade(ctx, async (tx) => {
    // Revenue and trade spend from the ledger, by the line's customer and the entry's month.
    const ledger = await tx.execute<Row>(sql`
      select jl.customer_id, c.name as customer_name,
             extract(year from je.entry_date)::int as year, extract(month from je.entry_date)::int as month,
             coalesce(sum(case when a.subtype = 'sales' then jl.credit_cents - jl.debit_cents end), 0)::bigint as gross_sales,
             coalesce(sum(case when a.code in ${TRADE_SPEND_ACCOUNT_CODES} then jl.debit_cents - jl.credit_cents end), 0)::bigint as trade_spend
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
        join accounts a on a.id = jl.account_id
        join customers c on c.id = jl.customer_id
       where je.entry_date between ${from} and ${to}
         and ${customerClause('jl.customer_id')}
         and (a.subtype = 'sales' or a.code in ${TRADE_SPEND_ACCOUNT_CODES})
       group by 1, 2, 3, 4
    `);

    const invoiced = await tx.execute<Row>(sql`
      select i.customer_id, c.name as customer_name,
             extract(year from i.invoice_date)::int as year, extract(month from i.invoice_date)::int as month,
             sum(i.total_cents)::bigint as gross_invoiced
        from invoices i
        join customers c on c.id = i.customer_id
       where i.journal_entry_id is not null
         and i.status <> 'void' and i.status <> 'draft'
         and i.invoice_date between ${from} and ${to}
         and ${customerClause('i.customer_id')}
       group by 1, 2, 3, 4
    `);

    const deducted = await tx.execute<Row>(sql`
      select d.customer_id, c.name as customer_name,
             extract(year from d.deduction_date)::int as year, extract(month from d.deduction_date)::int as month,
             sum(d.amount_cents)::bigint as deductions
        from deductions d
        join customers c on c.id = d.customer_id
        join journal_entries je on je.id = d.journal_entry_id and je.status = 'posted'
       where d.deduction_date between ${from} and ${to}
         and not exists (select 1 from journal_entries r where r.reverses_id = je.id and r.status = 'posted')
         and ${customerClause('d.customer_id')}
       group by 1, 2, 3, 4
    `);

    const cells = new Map<string, CustomerMonthKpi>();
    const cell = (r: Row): CustomerMonthKpi => {
      const key = `${String(r.customer_id)}|${String(r.year)}|${String(r.month)}`;
      let existing = cells.get(key);
      if (existing === undefined) {
        existing = {
          customerId: String(r.customer_id),
          customerName: String(r.customer_name),
          year: Number(r.year),
          month: Number(r.month),
          grossSalesCents: 0,
          tradeSpendCents: 0,
          tradeSpendRatio: null,
          grossInvoicedCents: 0,
          deductionsCents: 0,
          deductionRate: null,
        };
        cells.set(key, existing);
      }
      return existing;
    };
    for (const r of ledger) {
      const c = cell(r);
      c.grossSalesCents += Number(r.gross_sales);
      c.tradeSpendCents += Number(r.trade_spend);
    }
    for (const r of invoiced) cell(r).grossInvoicedCents += Number(r.gross_invoiced);
    for (const r of deducted) cell(r).deductionsCents += Number(r.deductions);
    const byCustomerMonth = [...cells.values()]
      .map((c) => ({ ...c, tradeSpendRatio: ratio(c.tradeSpendCents, c.grossSalesCents), deductionRate: ratio(c.deductionsCents, c.grossInvoicedCents) }))
      .sort((a, b) => a.customerName.localeCompare(b.customerName) || a.year - b.year || a.month - b.month);

    const sum = (pick: (c: CustomerMonthKpi) => number) => byCustomerMonth.reduce((acc, c) => acc + pick(c), 0);
    const totals = {
      grossSalesCents: sum((c) => c.grossSalesCents),
      tradeSpendCents: sum((c) => c.tradeSpendCents),
      tradeSpendRatio: null as number | null,
      grossInvoicedCents: sum((c) => c.grossInvoicedCents),
      deductionsCents: sum((c) => c.deductionsCents),
      deductionRate: null as number | null,
    };
    totals.tradeSpendRatio = ratio(totals.tradeSpendCents, totals.grossSalesCents);
    totals.deductionRate = ratio(totals.deductionsCents, totals.grossInvoicedCents);

    // Disputes closed in the period: every deduction that was contested (disputed, or
    // recovered/written off out of Deductions Receivable) and has nothing left open.
    const [disputeRow] = await tx.execute<Row>(sql`
      select count(*)::int as cases_closed,
             count(*) filter (where d.recovered_cents > 0)::int as cases_won,
             coalesce(sum(d.amount_cents), 0)::bigint as closed_cents,
             coalesce(sum(d.recovered_cents), 0)::bigint as recovered_cents,
             coalesce(sum(d.written_off_cents), 0)::bigint as written_off_cents
        from deductions d
       where d.resolved_at is not null
         and (d.resolved_at at time zone ${BOOKS_TIME_ZONE})::date between ${from} and ${to}
         and (d.disputed_at is not null or d.recovered_cents > 0 or d.written_off_cents > 0)
         and (d.status in ('recovered', 'written_off', 'validated')
              or (d.status = 'partially_recovered' and d.amount_cents = d.recovered_cents + d.written_off_cents))
         and ${customerClause('d.customer_id')}
    `);
    const closedCents = Number(disputeRow?.closed_cents ?? 0);
    const recoveredCents = Number(disputeRow?.recovered_cents ?? 0);
    const casesClosed = Number(disputeRow?.cases_closed ?? 0);
    const casesWon = Number(disputeRow?.cases_won ?? 0);

    // Days from invoice to the deduction, per reason class.
    const lagRows = await tx.execute<Row>(sql`
      select coalesce(rc.category, 'unmapped') as category,
             (d.deduction_date - coalesce(d.invoice_date, i.invoice_date))::int as days
        from deductions d
        left join invoices i on i.id = d.invoice_id
        left join deduction_reason_codes rc on rc.code = d.reason_code
       where d.deduction_date between ${from} and ${to}
         and coalesce(d.invoice_date, i.invoice_date) is not null
         and d.journal_entry_id is not null
         and ${customerClause('d.customer_id')}
    `);
    const lags = lagRows.map((r) => ({ category: String(r.category), days: Number(r.days) }));
    const categories = [...new Set(lags.map((l) => l.category))].sort();

    const variance = await tx.execute<Row>(sql`
      select p.id, p.name, p.customer_id,
             coalesce(sum(ta.accrued_cents), 0)::bigint as accrued,
             p.actual_spend_cents as actual
        from promotions p
        left join trade_accruals ta on ta.promotion_id = p.id
       where p.start_date <= ${to} and p.end_date >= ${from}
         and ${customerClause('p.customer_id')}
       group by p.id, p.name, p.customer_id, p.actual_spend_cents
       order by p.name
    `);

    // Open Deductions Receivable as of `asOf`.
    const openRows = await tx.execute<Row>(sql`
      select d.deduction_date::text as deduction_date, d.treatment::text as treatment,
             (d.amount_cents - d.recovered_cents - d.written_off_cents)::bigint as open_cents
        from deductions d
       where d.treatment in ('dispute', 'suspense')
         and d.status in ('open', 'disputed', 'partially_recovered')
         and d.amount_cents - d.recovered_cents - d.written_off_cents > 0
         and d.deduction_date <= ${asOf}
         and ${customerClause('d.customer_id')}
    `);
    const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
    let openTotal = 0;
    let unapplied = 0;
    for (const r of openRows) {
      const cents = Number(r.open_cents);
      buckets[agingBucket(daysBetween(String(r.deduction_date), asOf))] += cents;
      openTotal += cents;
      if (r.treatment === 'suspense') unapplied += cents;
    }

    return {
      from,
      to,
      byCustomerMonth,
      totals,
      disputes: {
        casesClosed,
        casesWon,
        closedCents,
        recoveredCents,
        writtenOffCents: Number(disputeRow?.written_off_cents ?? 0),
        recoveryRate: ratio(recoveredCents, closedCents),
        winRate: ratio(casesWon, casesClosed),
      },
      daysToDeduction: {
        ...summarize(lags.map((l) => l.days)),
        byCategory: categories.map((category) => ({
          category,
          ...summarize(lags.filter((l) => l.category === category).map((l) => l.days)),
        })),
      },
      accrualVariance: variance.map((r) => {
        const accrued = Number(r.accrued);
        const actual = Number(r.actual);
        return {
          promotionId: String(r.id),
          name: String(r.name),
          customerId: r.customer_id === null ? null : String(r.customer_id),
          accruedCents: accrued,
          actualCents: actual,
          varianceCents: actual - accrued,
          varianceRatio: ratio(actual - accrued, accrued),
        };
      }),
      openReceivable: { asOf, totalCents: openTotal, unappliedCents: unapplied, buckets },
    };
  });
}

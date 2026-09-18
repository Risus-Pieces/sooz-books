/**
 * Receivables and payables aging, as of any date.
 *
 * Everything is reconstructed for the as-of date from dated records, never read
 * off the documents' current `paid_cents` — so the March aging still says what
 * March said after April's payments arrive:
 *
 *   - a document counts from its own date until the date it was voided (the
 *     date of its reversal entry);
 *   - an application counts from its application date (see `appliedAtFor`);
 *   - money received or paid and not yet applied, and credits not yet applied,
 *     are items of their own with a negative balance.
 *
 * Days past due are counted on calendar dates from the as-of date, which is a
 * books-calendar date — never the database's `current_date`, which is UTC.
 *
 * The total of an aging always equals the balance of its control account as of
 * the same date; `differenceCents` reports any gap, and the close checklist
 * treats a non-zero difference as a failure.
 */

import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { type CalendarDate, daysBetween, formatDateUS, today } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type ColumnDef, type Report, type ReportRow, row } from '@/lib/reports/types';

import { type LedgerDb, appliedOn, requireDate } from './common';

export const AGING_BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Readonly<Record<AgingBucket, string>> = {
  current: 'Current',
  days1to30: '1–30',
  days31to60: '31–60',
  days61to90: '61–90',
  over90: '90+',
};

export type AgingBuckets = Record<AgingBucket, number> & { total: number };

export type AgingItemKind =
  | 'invoice'
  | 'receipt'
  | 'credit_memo'
  | 'deduction'
  | 'bill'
  | 'bill_payment'
  | 'vendor_credit';

export interface AgingItem {
  kind: AgingItemKind;
  id: string;
  docNo: string;
  docDate: CalendarDate;
  dueDate: CalendarDate | null;
  /** Null for credits and unapplied money, which have no due date. */
  daysPastDue: number | null;
  bucket: AgingBucket;
  /** Positive: owed (to us for AR, by us for AP). Negative: a credit. */
  balanceCents: number;
}

export interface AgingParty {
  partyId: string;
  partyName: string;
  buckets: AgingBuckets;
  items: AgingItem[];
}

export interface Aging {
  side: 'ar' | 'ap';
  asOf: CalendarDate;
  parties: AgingParty[];
  totals: AgingBuckets;
  /** The control account's balance as of the same date, in its normal sign. */
  controlBalanceCents: number;
  /** totals.total − controlBalanceCents. Zero when the sub-ledger ties. */
  differenceCents: number;
}

export function emptyBuckets(): AgingBuckets {
  return { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0 };
}

export function bucketFor(daysPastDue: number | null): AgingBucket {
  if (daysPastDue === null || daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'days1to30';
  if (daysPastDue <= 60) return 'days31to60';
  if (daysPastDue <= 90) return 'days61to90';
  return 'over90';
}

interface ItemRow extends Record<string, unknown> {
  kind: AgingItemKind;
  id: string;
  doc_no: string;
  party_id: string;
  party_name: string;
  doc_date: string;
  due_date: string | null;
  balance_cents: string | number;
}

function num(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** Entries that were reversed, and the date of the reversal: the void date of the document. */
const VOIDED = sql`(
  select r.reverses_id as entry_id, min(r.entry_date) as void_date
    from journal_entries r
   where r.reverses_id is not null and r.status = 'posted'
   group by r.reverses_id
)`;

function arItemsSql(asOf: CalendarDate) {
  return sql`
    with voided as ${VOIDED},
    live_receipts as (
      select r.* from receipts r
        left join voided v on v.entry_id = r.journal_entry_id
       where r.journal_entry_id is not null
         and r.customer_id is not null
         and r.receipt_date <= ${asOf}
         and (v.void_date is null or v.void_date > ${asOf})
    ),
    live_memos as (
      select m.* from credit_memos m
        left join voided v on v.entry_id = m.journal_entry_id
       where m.journal_entry_id is not null
         and m.memo_date <= ${asOf}
         and (v.void_date is null or v.void_date > ${asOf})
    ),
    ra as (
      select ra.invoice_id, ra.receipt_id, ra.amount_cents, ra.discount_cents
        from receipt_applications ra
        join live_receipts r on r.id = ra.receipt_id
       where ${appliedOn('ra.applied_at')} <= ${asOf}
    ),
    ca as (
      select ca.invoice_id, ca.credit_memo_id, ca.amount_cents
        from credit_memo_applications ca
        join live_memos m on m.id = ca.credit_memo_id
       where ${appliedOn('ca.applied_at')} <= ${asOf}
    ),
    ded as (
      select d.* from deductions d
        left join voided v on v.entry_id = d.journal_entry_id
       where d.journal_entry_id is not null
         and d.deduction_date <= ${asOf}
         and (v.void_date is null or v.void_date > ${asOf})
    ),
    items as (
      select 'invoice'::text as kind, i.id, i.invoice_no as doc_no, i.customer_id as party_id,
             i.invoice_date as doc_date, i.due_date,
             i.total_cents
               - coalesce((select sum(x.amount_cents + x.discount_cents) from ra x where x.invoice_id = i.id), 0)
               - coalesce((select sum(x.amount_cents) from ca x where x.invoice_id = i.id), 0)
               - coalesce((select sum(x.amount_cents) from ded x where x.invoice_id = i.id), 0)
               as balance_cents
        from invoices i
        left join voided v on v.entry_id = i.journal_entry_id
       where i.journal_entry_id is not null
         and i.invoice_date <= ${asOf}
         and (v.void_date is null or v.void_date > ${asOf})
      union all
      select 'receipt', r.id, r.receipt_no, r.customer_id, r.receipt_date, null::date,
             -(r.amount_cents - coalesce((select sum(x.amount_cents) from ra x where x.receipt_id = r.id), 0))
        from live_receipts r
      union all
      select 'credit_memo', m.id, m.memo_no, m.customer_id, m.memo_date, null::date,
             -(m.amount_cents - coalesce((select sum(x.amount_cents) from ca x where x.credit_memo_id = m.id), 0))
        from live_memos m
      union all
      select 'deduction', d.id, d.deduction_no, d.customer_id, d.deduction_date, null::date, -d.amount_cents
        from ded d
       where d.invoice_id is null
    )
    select it.kind, it.id, it.doc_no, it.party_id, c.name as party_name,
           it.doc_date::text as doc_date, it.due_date::text as due_date, it.balance_cents
      from items it
      join customers c on c.id = it.party_id
     where it.balance_cents <> 0
     order by c.name, it.party_id, it.due_date nulls first, it.doc_date, it.doc_no
  `;
}

function apItemsSql(asOf: CalendarDate) {
  return sql`
    with voided as ${VOIDED},
    live_payments as (
      select p.* from bill_payments p
        left join voided v on v.entry_id = p.journal_entry_id
       where p.journal_entry_id is not null
         and p.payment_date <= ${asOf}
         and (v.void_date is null or v.void_date > ${asOf})
    ),
    live_credits as (
      select c.* from vendor_credits c
        left join voided v on v.entry_id = c.journal_entry_id
       where c.journal_entry_id is not null
         and c.credit_date <= ${asOf}
         and (v.void_date is null or v.void_date > ${asOf})
    ),
    pa as (
      select pa.bill_id, pa.payment_id, pa.amount_cents, pa.discount_cents
        from bill_payment_applications pa
        join live_payments p on p.id = pa.payment_id
       where ${appliedOn('pa.applied_at')} <= ${asOf}
    ),
    ca as (
      select ca.bill_id, ca.credit_id, ca.amount_cents
        from vendor_credit_applications ca
        join live_credits c on c.id = ca.credit_id
       where ${appliedOn('ca.applied_at')} <= ${asOf}
    ),
    items as (
      select 'bill'::text as kind, b.id, b.bill_no as doc_no, b.vendor_id as party_id,
             b.bill_date as doc_date, b.due_date,
             b.total_cents
               - coalesce((select sum(x.amount_cents + x.discount_cents) from pa x where x.bill_id = b.id), 0)
               - coalesce((select sum(x.amount_cents) from ca x where x.bill_id = b.id), 0)
               as balance_cents
        from bills b
        left join voided v on v.entry_id = b.journal_entry_id
       where b.journal_entry_id is not null
         and b.bill_date <= ${asOf}
         and (v.void_date is null or v.void_date > ${asOf})
      union all
      select 'bill_payment', p.id, p.payment_no, p.vendor_id, p.payment_date, null::date,
             -(p.amount_cents - coalesce((select sum(x.amount_cents) from pa x where x.payment_id = p.id), 0))
        from live_payments p
      union all
      select 'vendor_credit', c.id, c.credit_no, c.vendor_id, c.credit_date, null::date,
             -(c.amount_cents - coalesce((select sum(x.amount_cents) from ca x where x.credit_id = c.id), 0))
        from live_credits c
    )
    select it.kind, it.id, it.doc_no, it.party_id, v.name as party_name,
           it.doc_date::text as doc_date, it.due_date::text as due_date, it.balance_cents
      from items it
      join vendors v on v.id = it.party_id
     where it.balance_cents <> 0
     order by v.name, it.party_id, it.due_date nulls first, it.doc_date, it.doc_no
  `;
}

/**
 * The control account's balance at close of business on `asOf`, in its normal
 * sign: debit-positive for AR, credit-positive for AP.
 */
export async function controlBalance(side: 'ar' | 'ap', asOf: CalendarDate, exec: LedgerDb = db): Promise<number> {
  const code = side === 'ar' ? ACCOUNTS.AR : ACCOUNTS.AP;
  const rows = await exec.execute<{ balance: string | number | null }>(sql`
    select coalesce(sum(l.debit_cents - l.credit_cents), 0) as balance
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.status = 'posted'
       and e.entry_date <= ${asOf}
       and a.code = ${code}
  `);
  const debitNet = num(rows[0]?.balance);
  return side === 'ar' ? debitNet : -debitNet;
}

async function aging(side: 'ar' | 'ap', asOfInput: CalendarDate | undefined, exec: LedgerDb): Promise<Aging> {
  const asOf = asOfInput === undefined ? today() : requireDate('asOf', asOfInput);
  const rows = await exec.execute<ItemRow>(side === 'ar' ? arItemsSql(asOf) : apItemsSql(asOf));

  const parties = new Map<string, AgingParty>();
  const totals = emptyBuckets();
  for (const r of rows) {
    const balance = num(r.balance_cents);
    const daysPastDue = r.due_date === null ? null : daysBetween(r.due_date, asOf);
    const bucket = bucketFor(daysPastDue);
    let party = parties.get(r.party_id);
    if (party === undefined) {
      party = { partyId: r.party_id, partyName: r.party_name, buckets: emptyBuckets(), items: [] };
      parties.set(r.party_id, party);
    }
    party.items.push({
      kind: r.kind,
      id: r.id,
      docNo: r.doc_no,
      docDate: r.doc_date,
      dueDate: r.due_date,
      daysPastDue,
      bucket,
      balanceCents: balance,
    });
    party.buckets[bucket] += balance;
    party.buckets.total += balance;
    totals[bucket] += balance;
    totals.total += balance;
  }

  const controlBalanceCents = await controlBalance(side, asOf, exec);
  return {
    side,
    asOf,
    parties: [...parties.values()],
    totals,
    controlBalanceCents,
    differenceCents: totals.total - controlBalanceCents,
  };
}

/** Receivables aging by customer as of `asOf` (default: today on the books' calendar). */
export async function arAging(asOf?: CalendarDate, exec: LedgerDb = db): Promise<Aging> {
  return aging('ar', asOf, exec);
}

/** Payables aging by vendor as of `asOf` (default: today on the books' calendar). */
export async function apAging(asOf?: CalendarDate, exec: LedgerDb = db): Promise<Aging> {
  return aging('ap', asOf, exec);
}

/** An aging in the shared report shape: one row per party, bucket columns, a total. */
export function agingReport(result: Aging): Report {
  const columns: ColumnDef[] = [
    ...AGING_BUCKETS.map((bucket): ColumnDef => ({ key: bucket, label: AGING_BUCKET_LABELS[bucket], kind: 'amount' })),
    { key: 'total', label: 'Total', kind: 'amount', emphasis: true },
  ];
  const values = (b: AgingBuckets): number[] => [...AGING_BUCKETS.map((k) => b[k]), b.total];
  const rows: ReportRow[] = result.parties.map((party) =>
    row({ id: party.partyId, label: party.partyName, level: 1, values: values(party.buckets) }),
  );
  rows.push(row({ id: 'total', label: 'Total', values: values(result.totals), style: 'total' }));
  const controlLabel = result.side === 'ar' ? '1200 Accounts Receivable' : '2000 Accounts Payable';
  if (result.differenceCents !== 0) {
    rows.push(
      row({
        id: 'difference',
        label: `Does not tie to ${controlLabel}`,
        values: [0, 0, 0, 0, 0, result.differenceCents],
        blankColumns: [0, 1, 2, 3, 4],
        style: 'error',
        note: `The general ledger shows ${result.controlBalanceCents} cents.`,
      }),
    );
  }
  const title = result.side === 'ar' ? 'Accounts receivable aging' : 'Accounts payable aging';
  return {
    columns,
    rows,
    meta: {
      title,
      subtitle: `As of ${formatDateUS(result.asOf)}`,
      from: result.asOf,
      to: result.asOf,
      basis: 'accrual',
      columns: 'total',
      generatedAt: today(),
      warnings:
        result.differenceCents === 0
          ? []
          : [`The aging total differs from ${controlLabel} by ${result.differenceCents} cents.`],
    },
  };
}

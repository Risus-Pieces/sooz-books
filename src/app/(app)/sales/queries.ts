/**
 * The reads behind the Sales screens. Nothing here writes; mutations live in
 * `./actions`. Aggregates are done in Postgres, and every figure is read from
 * the documents the AR engine maintains — balances are total less paid,
 * credited and deducted, the same arithmetic as the `ar_open_items` view.
 */

import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import type {
  Address,
  CustomerPick,
  CustomerRow,
  CustomerType,
  DocStatus,
  InvoiceDetail,
  InvoiceListRow,
  MoneyDocDetail,
  OpenDoc,
  Option,
  PaymentMethod,
  ReceiptListRow,
  SettlementView,
} from '@/components/arap/types';
import { BOOKS_TIME_ZONE, type CalendarDate, addDays, daysBetween, isCalendarDate, today } from '@/lib/dates';
import { CHANNEL_REVENUE_ACCOUNT, type ChannelCode } from '@/lib/ledger/coa';

type Row = Record<string, unknown>;

function cents(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error(`Expected whole cents, received ${String(value)}.`);
  return amount;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function str(value: unknown): string {
  return String(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Where a customer of this type sells through when its record names no channel — as the engine resolves it. */
const CHANNEL_BY_CUSTOMER_TYPE: Readonly<Record<CustomerType, ChannelCode | null>> = {
  dtc: 'DTC',
  marketplace: 'AMAZON',
  distributor: 'DISTRIBUTOR',
  wholesale: 'WHOLESALE',
  foodservice: 'FOODSERVICE',
  other: null,
};

/** The company as it heads an invoice. */
export async function companyName(): Promise<string> {
  const rows = await db.execute<{ company_name: string | null }>(sql`select company_name from app_settings limit 1`);
  return rows[0]?.company_name ?? 'Sooz Beverage LLC';
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export async function salesChannelOptions(): Promise<Option[]> {
  const rows = await db.execute<Row>(sql`
    select id, name, code from channels where active order by sort_order, code
  `);
  return rows.map((r) => ({ id: str(r.id), label: str(r.name), hint: str(r.code) }));
}

/** Revenue accounts a line can be credited to — never contra revenue, which is what discounts are for. */
export function revenueAccountsOf<T extends { type: string; subtype: string | null; postable: boolean; active: boolean }>(
  accounts: readonly T[],
): T[] {
  return accounts.filter((a) => a.type === 'revenue' && a.subtype !== 'contra_revenue' && a.postable && a.active);
}

export async function productPickOptions(): Promise<Option[]> {
  const rows = await db.execute<Row>(sql`select id, sku, name from products where active order by sku`);
  return rows.map((r) => ({ id: str(r.id), label: str(r.name), hint: str(r.sku) }));
}

/** Accounts a customer payment can land in: bank, cash, undeposited funds, clearing. */
export async function depositAccountOptions(): Promise<Option[]> {
  const rows = await db.execute<Row>(sql`
    select a.id, a.code, a.name
      from accounts a
     where a.active and not a.is_control
       and coalesce(a.subtype, '') <> 'credit_card'
       and (a.is_bank or a.subtype in ('bank', 'cash', 'undeposited_funds', 'clearing'))
       and not exists (select 1 from accounts c where c.parent_id = a.id)
     order by case when a.subtype = 'undeposited_funds' then 0 else 1 end, a.code
  `);
  return rows.map((r) => ({ id: str(r.id), label: `${str(r.code)} ${str(r.name)}`, hint: str(r.code) }));
}

export async function customerPicks(): Promise<CustomerPick[]> {
  const rows = await db.execute<Row>(sql`
    select c.id, c.name, c.terms_days, c.terms_discount_pct::text as pct, c.terms_discount_days,
           c.channel_id, c.customer_type, ch.code as channel_code
      from customers c
      left join channels ch on ch.id = c.channel_id
     where c.active
     order by lower(c.name)
  `);
  const accounts = await db.execute<Row>(sql`select id, code from accounts`);
  const idByCode = new Map(accounts.map((a) => [str(a.code), str(a.id)]));
  return rows.map((r) => {
    const code = (text(r.channel_code) ?? CHANNEL_BY_CUSTOMER_TYPE[r.customer_type as CustomerType]) as ChannelCode | null;
    const revenueCode = code !== null && code in CHANNEL_REVENUE_ACCOUNT ? CHANNEL_REVENUE_ACCOUNT[code] : null;
    return {
      id: str(r.id),
      name: str(r.name),
      termsDays: Number(r.terms_days),
      termsDiscountPct: str(r.pct),
      termsDiscountDays: Number(r.terms_discount_days),
      channelId: text(r.channel_id),
      defaultRevenueAccountId: revenueCode === null ? null : (idByCode.get(revenueCode) ?? null),
    };
  });
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function customerRows(asOf: CalendarDate = today()): Promise<CustomerRow[]> {
  const rows = await db.execute<Row>(sql`
    with open_docs as (
      select i.customer_id,
             i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents as balance,
             i.due_date
        from invoices i
       where i.status in ('open', 'partial')
    )
    select c.*, c.terms_discount_pct::text as pct, ch.name as channel_name,
           coalesce((select sum(balance) from open_docs o where o.customer_id = c.id), 0) as open_cents,
           coalesce((select sum(balance) from open_docs o where o.customer_id = c.id and o.due_date < ${asOf}::date), 0) as overdue_cents,
           (select count(*) from open_docs o where o.customer_id = c.id) as open_count
      from customers c
      left join channels ch on ch.id = c.channel_id
     order by c.active desc, lower(c.name)
  `);
  return rows.map((r) => ({
    id: str(r.id),
    name: str(r.name),
    displayName: text(r.display_name),
    customerType: r.customer_type as CustomerType,
    channelId: text(r.channel_id),
    channelName: text(r.channel_name),
    email: text(r.email),
    phone: text(r.phone),
    termsDays: Number(r.terms_days),
    termsDiscountPct: str(r.pct),
    termsDiscountDays: Number(r.terms_discount_days),
    creditLimitCents: r.credit_limit_cents === null ? null : cents(r.credit_limit_cents),
    notes: text(r.notes),
    active: Boolean(r.active),
    openCents: cents(r.open_cents),
    overdueCents: cents(r.overdue_cents),
    openInvoiceCount: Number(r.open_count),
  }));
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export const INVOICE_STATUS_FILTERS = ['all', 'open', 'overdue', 'draft', 'paid', 'void'] as const;
export type InvoiceStatusFilter = (typeof INVOICE_STATUS_FILTERS)[number];

export interface InvoiceFilters {
  status: InvoiceStatusFilter;
  customerId: string;
  from: string;
  to: string;
  q: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : '';
}

export function readInvoiceFilters(params: SearchParams): InvoiceFilters {
  const status = one(params.status);
  const customerId = one(params.customer);
  const from = one(params.from);
  const to = one(params.to);
  return {
    status: (INVOICE_STATUS_FILTERS as readonly string[]).includes(status) ? (status as InvoiceStatusFilter) : 'all',
    customerId: isUuid(customerId) ? customerId : '',
    from: isCalendarDate(from) ? from : '',
    to: isCalendarDate(to) ? to : '',
    q: one(params.q).trim().slice(0, 80),
  };
}

function invoiceRow(r: Row, asOf: CalendarDate): InvoiceListRow {
  const status = r.status as DocStatus;
  const balance = cents(r.balance_cents);
  const due = str(r.due_date);
  const overdue = (status === 'open' || status === 'partial') && due < asOf;
  return {
    id: str(r.id),
    invoiceNo: str(r.invoice_no),
    customerId: str(r.customer_id),
    customerName: str(r.customer_name),
    invoiceDate: str(r.invoice_date),
    dueDate: due,
    poNumber: text(r.po_number),
    status,
    totalCents: cents(r.total_cents),
    balanceCents: status === 'void' || status === 'draft' ? 0 : balance,
    daysOverdue: overdue ? daysBetween(due, asOf) : 0,
  };
}

export async function invoiceList(filters: InvoiceFilters, asOf: CalendarDate = today()): Promise<InvoiceListRow[]> {
  const conditions = [sql`true`];
  if (filters.status === 'open') conditions.push(sql`i.status in ('open', 'partial')`);
  if (filters.status === 'overdue') conditions.push(sql`i.status in ('open', 'partial') and i.due_date < ${asOf}::date`);
  if (filters.status === 'draft' || filters.status === 'paid' || filters.status === 'void') {
    conditions.push(sql`i.status = ${filters.status}`);
  }
  if (filters.customerId) conditions.push(sql`i.customer_id = ${filters.customerId}::uuid`);
  if (filters.from) conditions.push(sql`i.invoice_date >= ${filters.from}::date`);
  if (filters.to) conditions.push(sql`i.invoice_date <= ${filters.to}::date`);
  if (filters.q) {
    const like = `%${filters.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conditions.push(sql`(i.invoice_no ilike ${like} or i.po_number ilike ${like} or c.name ilike ${like})`);
  }
  const rows = await db.execute<Row>(sql`
    select i.id, i.invoice_no, i.customer_id, c.name as customer_name, i.invoice_date::text, i.due_date::text,
           i.po_number, i.status, i.total_cents,
           i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents as balance_cents
      from invoices i
      join customers c on c.id = i.customer_id
     where ${sql.join(conditions, sql` and `)}
     order by i.invoice_date desc, i.invoice_no desc
     limit 500
  `);
  return rows.map((r) => invoiceRow(r, asOf));
}

export async function invoiceStatusCounts(asOf: CalendarDate = today()): Promise<Record<InvoiceStatusFilter, number>> {
  const rows = await db.execute<Row>(sql`
    select count(*) as all,
           count(*) filter (where status in ('open', 'partial')) as open,
           count(*) filter (where status in ('open', 'partial') and due_date < ${asOf}::date) as overdue,
           count(*) filter (where status = 'draft') as draft,
           count(*) filter (where status = 'paid') as paid,
           count(*) filter (where status = 'void') as void
      from invoices
  `);
  const r = rows[0] ?? {};
  return {
    all: Number(r.all ?? 0),
    open: Number(r.open ?? 0),
    overdue: Number(r.overdue ?? 0),
    draft: Number(r.draft ?? 0),
    paid: Number(r.paid ?? 0),
    void: Number(r.void ?? 0),
  };
}

function address(value: unknown): Address | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  return value as Address;
}

export async function invoiceDetail(invoiceId: string): Promise<InvoiceDetail | null> {
  if (!isUuid(invoiceId)) return null;
  const [r] = await db.execute<Row>(sql`
    select i.*, i.invoice_date::text as invoice_date_text, i.due_date::text as due_date_text,
           c.name as customer_name, c.email as customer_email, c.billing_address, c.shipping_address,
           c.terms_discount_pct::text as pct, c.terms_discount_days,
           ch.name as channel_name, je.entry_no,
           (select r.id from journal_entries r where r.reverses_id = i.journal_entry_id and r.status = 'posted' limit 1) as void_entry_id
      from invoices i
      join customers c on c.id = i.customer_id
      left join channels ch on ch.id = i.channel_id
      left join journal_entries je on je.id = i.journal_entry_id
     where i.id = ${invoiceId}::uuid
  `);
  if (r === undefined) return null;

  const lines = await db.execute<Row>(sql`
    select l.*, l.quantity::text as qty, p.sku, p.name as product_name, a.code as account_code, a.name as account_name
      from invoice_lines l
      left join products p on p.id = l.product_id
      left join accounts a on a.id = l.revenue_account_id
     where l.invoice_id = ${invoiceId}::uuid
     order by l.line_no
  `);

  const settlements = await db.execute<Row>(sql`
    select 'receipt' as kind, r.id, r.receipt_no as doc_no, (ra.applied_at at time zone ${BOOKS_TIME_ZONE})::date::text as date,
           ra.amount_cents, ra.discount_cents,
           exists (select 1 from journal_entries v where v.reverses_id = r.journal_entry_id and v.status = 'posted') as void
      from receipt_applications ra join receipts r on r.id = ra.receipt_id
     where ra.invoice_id = ${invoiceId}::uuid
    union all
    select 'credit_memo', m.id, m.memo_no, (ca.applied_at at time zone ${BOOKS_TIME_ZONE})::date::text, ca.amount_cents, 0,
           exists (select 1 from journal_entries v where v.reverses_id = m.journal_entry_id and v.status = 'posted')
      from credit_memo_applications ca join credit_memos m on m.id = ca.credit_memo_id
     where ca.invoice_id = ${invoiceId}::uuid
    union all
    select 'deduction', d.id, d.deduction_no, d.deduction_date::text, d.amount_cents, 0,
           exists (select 1 from journal_entries v where v.reverses_id = d.journal_entry_id and v.status = 'posted')
      from deductions d
     where d.invoice_id = ${invoiceId}::uuid and d.journal_entry_id is not null
     order by 4, 3
  `);

  return {
    id: str(r.id),
    invoiceNo: str(r.invoice_no),
    status: r.status as DocStatus,
    customerId: str(r.customer_id),
    customerName: str(r.customer_name),
    customerEmail: text(r.customer_email),
    billingAddress: address(r.billing_address),
    shippingAddress: address(r.shipping_address),
    channelName: text(r.channel_name),
    invoiceDate: str(r.invoice_date_text),
    dueDate: str(r.due_date_text),
    termsDays: Number(r.terms_days),
    termsDiscountPct: str(r.pct),
    termsDiscountDays: Number(r.terms_discount_days),
    poNumber: text(r.po_number),
    memo: text(r.memo),
    subtotalCents: cents(r.subtotal_cents),
    discountCents: cents(r.discount_cents),
    shippingCents: cents(r.shipping_cents),
    taxCents: cents(r.tax_cents),
    totalCents: cents(r.total_cents),
    paidCents: cents(r.paid_cents),
    creditedCents: cents(r.credited_cents),
    deductedCents: cents(r.deducted_cents),
    balanceCents: cents(r.total_cents) - cents(r.paid_cents) - cents(r.credited_cents) - cents(r.deducted_cents),
    journalEntryId: text(r.journal_entry_id),
    journalEntryNo: r.entry_no === null || r.entry_no === undefined ? null : Number(r.entry_no),
    voidEntryId: text(r.void_entry_id),
    lines: lines.map((l) => ({
      lineNo: Number(l.line_no),
      description: str(l.description),
      productId: text(l.product_id),
      productLabel: l.sku === null ? null : `${str(l.sku)} · ${str(l.product_name)}`,
      quantity: str(l.qty),
      unitPriceCents: cents(l.unit_price_cents),
      amountCents: cents(l.amount_cents),
      discountCents: cents(l.discount_cents),
      taxCents: cents(l.tax_cents),
      revenueAccountId: text(l.revenue_account_id),
      revenueAccountLabel: l.account_code === null ? null : `${str(l.account_code)} ${str(l.account_name)}`,
    })),
    settlements: settlements.map(
      (s): SettlementView => ({
        kind: s.kind as SettlementView['kind'],
        id: str(s.id),
        docNo: str(s.doc_no),
        date: str(s.date),
        amountCents: cents(s.amount_cents),
        discountCents: cents(s.discount_cents),
        void: Boolean(s.void),
      }),
    ),
  };
}

/** Issued invoices of one customer with money still owing, oldest due first. */
export async function openInvoicesFor(customerId: string): Promise<OpenDoc[]> {
  if (!isUuid(customerId)) return [];
  const rows = await db.execute<Row>(sql`
    select id, invoice_no, invoice_date::text, due_date::text, total_cents, paid_cents,
           total_cents - paid_cents - credited_cents - deducted_cents as balance
      from invoices
     where customer_id = ${customerId}::uuid and status in ('open', 'partial')
     order by due_date, invoice_no
  `);
  return rows.map((r) => ({
    id: str(r.id),
    docNo: str(r.invoice_no),
    date: str(r.invoice_date),
    dueDate: str(r.due_date),
    totalCents: cents(r.total_cents),
    paidCents: cents(r.paid_cents),
    balanceCents: cents(r.balance),
  }));
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

const VOIDED_RECEIPT = sql`exists (select 1 from journal_entries v where v.reverses_id = r.journal_entry_id and v.status = 'posted')`;

export async function receiptList(): Promise<ReceiptListRow[]> {
  const rows = await db.execute<Row>(sql`
    select r.id, r.receipt_no, r.customer_id, c.name as customer_name, r.receipt_date::text, r.method, r.reference,
           r.amount_cents, r.applied_cents, a.code || ' ' || a.name as account_label,
           ${VOIDED_RECEIPT} as void, r.bank_transaction_id is not null as from_bank
      from receipts r
      left join customers c on c.id = r.customer_id
      join accounts a on a.id = r.deposit_account_id
     order by r.receipt_date desc, r.receipt_no desc
     limit 500
  `);
  return rows.map((r) => ({
    id: str(r.id),
    receiptNo: str(r.receipt_no),
    customerId: text(r.customer_id),
    customerName: text(r.customer_name),
    receiptDate: str(r.receipt_date),
    method: r.method as PaymentMethod,
    reference: text(r.reference),
    amountCents: cents(r.amount_cents),
    appliedCents: cents(r.applied_cents),
    depositAccountLabel: str(r.account_label),
    void: Boolean(r.void),
    fromBank: Boolean(r.from_bank),
  }));
}

export async function receiptDetail(receiptId: string): Promise<MoneyDocDetail | null> {
  if (!isUuid(receiptId)) return null;
  const [r] = await db.execute<Row>(sql`
    select r.*, r.receipt_date::text as date_text, c.name as customer_name, a.code || ' ' || a.name as account_label,
           je.entry_no,
           (select min(v.entry_date)::text from journal_entries v where v.reverses_id = r.journal_entry_id and v.status = 'posted') as void_date
      from receipts r
      left join customers c on c.id = r.customer_id
      join accounts a on a.id = r.deposit_account_id
      left join journal_entries je on je.id = r.journal_entry_id
     where r.id = ${receiptId}::uuid
  `);
  if (r === undefined) return null;
  const apps = await db.execute<Row>(sql`
    select i.id, i.invoice_no, i.invoice_date::text, (ra.applied_at at time zone ${BOOKS_TIME_ZONE})::date::text as applied_on,
           ra.amount_cents, ra.discount_cents
      from receipt_applications ra join invoices i on i.id = ra.invoice_id
     where ra.receipt_id = ${receiptId}::uuid
     order by ra.applied_at, i.invoice_no
  `);
  return {
    id: str(r.id),
    docNo: str(r.receipt_no),
    partyId: text(r.customer_id),
    partyName: text(r.customer_name),
    date: str(r.date_text),
    method: r.method as PaymentMethod,
    reference: text(r.reference),
    memo: text(r.memo),
    amountCents: cents(r.amount_cents),
    appliedCents: cents(r.applied_cents),
    accountLabel: str(r.account_label),
    journalEntryId: text(r.journal_entry_id),
    journalEntryNo: r.entry_no === null || r.entry_no === undefined ? null : Number(r.entry_no),
    void: r.void_date !== null && r.void_date !== undefined,
    voidDate: text(r.void_date),
    bankTransactionId: text(r.bank_transaction_id),
    is1099Reportable: null,
    applications: apps.map((a) => ({
      docId: str(a.id),
      docNo: str(a.invoice_no),
      docDate: str(a.invoice_date),
      appliedOn: str(a.applied_on),
      amountCents: cents(a.amount_cents),
      discountCents: cents(a.discount_cents),
    })),
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface SalesOverview {
  asOf: CalendarDate;
  openCents: number;
  openCount: number;
  overdueCents: number;
  overdueCount: number;
  dueSoonCents: number;
  dueSoonCount: number;
  draftCount: number;
  unappliedCents: number;
  customerCount: number;
  receivedThisMonthCents: number;
  recentInvoices: InvoiceListRow[];
  overdueInvoices: InvoiceListRow[];
}

export async function salesOverview(): Promise<SalesOverview> {
  const asOf = today();
  const soon = addDays(asOf, 14);
  const monthStart = `${asOf.slice(0, 8)}01`;
  const [totals] = await db.execute<Row>(sql`
    with open_docs as (
      select due_date, total_cents - paid_cents - credited_cents - deducted_cents as balance
        from invoices where status in ('open', 'partial')
    )
    select coalesce(sum(balance), 0) as open_cents, count(*) as open_count,
           coalesce(sum(balance) filter (where due_date < ${asOf}::date), 0) as overdue_cents,
           count(*) filter (where due_date < ${asOf}::date) as overdue_count,
           coalesce(sum(balance) filter (where due_date between ${asOf}::date and ${soon}::date), 0) as soon_cents,
           count(*) filter (where due_date between ${asOf}::date and ${soon}::date) as soon_count,
           (select count(*) from invoices where status = 'draft') as draft_count,
           (select count(*) from customers where active) as customer_count,
           (select coalesce(sum(r.amount_cents - r.applied_cents), 0) from receipts r
             where r.journal_entry_id is not null and not ${VOIDED_RECEIPT}) as unapplied_cents,
           (select coalesce(sum(r.amount_cents), 0) from receipts r
             where r.journal_entry_id is not null and not ${VOIDED_RECEIPT}
               and r.receipt_date >= ${monthStart}::date and r.receipt_date <= ${asOf}::date) as received_cents
      from open_docs
  `);
  const t = totals ?? {};
  const recent = await invoiceList({ status: 'all', customerId: '', from: '', to: '', q: '' }, asOf);
  const overdue = await invoiceList({ status: 'overdue', customerId: '', from: '', to: '', q: '' }, asOf);
  return {
    asOf,
    openCents: cents(t.open_cents),
    openCount: Number(t.open_count ?? 0),
    overdueCents: cents(t.overdue_cents),
    overdueCount: Number(t.overdue_count ?? 0),
    dueSoonCents: cents(t.soon_cents),
    dueSoonCount: Number(t.soon_count ?? 0),
    draftCount: Number(t.draft_count ?? 0),
    unappliedCents: cents(t.unapplied_cents),
    customerCount: Number(t.customer_count ?? 0),
    receivedThisMonthCents: cents(t.received_cents),
    recentInvoices: recent.slice(0, 8),
    overdueInvoices: [...overdue].sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, 8),
  };
}

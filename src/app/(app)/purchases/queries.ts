/**
 * The reads behind the Purchases screens. Nothing here writes; mutations live
 * in `./actions`. Balances are total less paid and credited, the arithmetic the
 * AP engine maintains on every bill.
 */

import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import type {
  BillDetail,
  BillListRow,
  DocStatus,
  MoneyDocDetail,
  OpenDoc,
  Option,
  PaymentListRow,
  PaymentMethod,
  SettlementView,
  VendorPick,
  VendorRow,
  VendorType,
} from '@/components/arap/types';
import { BOOKS_TIME_ZONE, type CalendarDate, addDays, daysBetween, isCalendarDate, today } from '@/lib/dates';

import { isUuid } from '../sales/queries';

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

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const MONEY_SUBTYPES = new Set(['bank', 'cash', 'undeposited_funds', 'clearing', 'credit_card']);

/**
 * Accounts a bill line may land on: what was bought — an expense, COGS,
 * inventory, a prepaid or a fixed asset — never a control account or one that
 * holds money, which the engine refuses.
 */
export function billLineAccounts<
  T extends { postable: boolean; active: boolean; isControl: boolean; isBank: boolean; subtype: string | null },
>(accounts: readonly T[]): T[] {
  return accounts.filter(
    (a) => a.postable && a.active && !a.isControl && !a.isBank && !MONEY_SUBTYPES.has(a.subtype ?? ''),
  );
}

/** Accounts a bill can be paid from: bank, cash, or a company card. */
export async function paymentAccountOptions(): Promise<Option[]> {
  const rows = await db.execute<Row>(sql`
    select a.id, a.code, a.name, a.subtype
      from accounts a
     where a.active and not a.is_control
       and (a.is_bank or a.subtype in ('bank', 'cash', 'credit_card'))
       and not exists (select 1 from accounts c where c.parent_id = a.id)
     order by case when a.subtype = 'credit_card' then 1 else 0 end, a.code
  `);
  return rows.map((r) => ({
    id: str(r.id),
    label: `${str(r.code)} ${str(r.name)}`,
    hint: r.subtype === 'credit_card' ? 'card' : 'bank',
  }));
}

export async function vendorPicks(): Promise<VendorPick[]> {
  const rows = await db.execute<Row>(sql`
    select id, name, terms_days, default_expense_account_id, is_1099
      from vendors where active order by lower(name)
  `);
  return rows.map((r) => ({
    id: str(r.id),
    name: str(r.name),
    termsDays: Number(r.terms_days),
    defaultExpenseAccountId: text(r.default_expense_account_id),
    is1099: Boolean(r.is_1099),
  }));
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export async function vendorRows(): Promise<VendorRow[]> {
  const rows = await db.execute<Row>(sql`
    select v.*, v.w9_received_at::text as w9_date, a.code || ' ' || a.name as account_label,
           coalesce((select sum(b.total_cents - b.paid_cents - b.credited_cents) from bills b
                      where b.vendor_id = v.id and b.status in ('open', 'partial')), 0) as open_cents,
           (select count(*) from bills b where b.vendor_id = v.id and b.status in ('open', 'partial')) as open_count,
           (select count(*) from vendor_aliases va where va.vendor_id = v.id) as alias_count
      from vendors v
      left join accounts a on a.id = v.default_expense_account_id
     order by v.active desc, lower(v.name)
  `);
  return rows.map((r) => ({
    id: str(r.id),
    name: str(r.name),
    displayName: text(r.display_name),
    vendorType: r.vendor_type as VendorType,
    email: text(r.email),
    phone: text(r.phone),
    termsDays: Number(r.terms_days),
    defaultExpenseAccountId: text(r.default_expense_account_id),
    defaultAccountLabel: text(r.account_label),
    is1099: Boolean(r.is_1099),
    w9OnFile: Boolean(r.w9_on_file),
    w9ReceivedAt: text(r.w9_date),
    taxIdLast4: text(r.tax_id_last4),
    legalName: text(r.legal_name),
    notes: text(r.notes),
    active: Boolean(r.active),
    openCents: cents(r.open_cents),
    openBillCount: Number(r.open_count),
    aliasCount: Number(r.alias_count),
  }));
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

export const BILL_STATUS_FILTERS = ['all', 'open', 'overdue', 'draft', 'paid', 'void'] as const;
export type BillStatusFilter = (typeof BILL_STATUS_FILTERS)[number];

export interface BillFilters {
  status: BillStatusFilter;
  vendorId: string;
  from: string;
  to: string;
  q: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : '';
}

export function readBillFilters(params: SearchParams): BillFilters {
  const status = one(params.status);
  const vendorId = one(params.vendor);
  const from = one(params.from);
  const to = one(params.to);
  return {
    status: (BILL_STATUS_FILTERS as readonly string[]).includes(status) ? (status as BillStatusFilter) : 'all',
    vendorId: isUuid(vendorId) ? vendorId : '',
    from: isCalendarDate(from) ? from : '',
    to: isCalendarDate(to) ? to : '',
    q: one(params.q).trim().slice(0, 80),
  };
}

export async function billList(filters: BillFilters, asOf: CalendarDate = today()): Promise<BillListRow[]> {
  const conditions = [sql`true`];
  if (filters.status === 'open') conditions.push(sql`b.status in ('open', 'partial')`);
  if (filters.status === 'overdue') conditions.push(sql`b.status in ('open', 'partial') and b.due_date < ${asOf}::date`);
  if (filters.status === 'draft' || filters.status === 'paid' || filters.status === 'void') {
    conditions.push(sql`b.status = ${filters.status}`);
  }
  if (filters.vendorId) conditions.push(sql`b.vendor_id = ${filters.vendorId}::uuid`);
  if (filters.from) conditions.push(sql`b.bill_date >= ${filters.from}::date`);
  if (filters.to) conditions.push(sql`b.bill_date <= ${filters.to}::date`);
  if (filters.q) {
    const like = `%${filters.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conditions.push(sql`(b.bill_no ilike ${like} or b.po_number ilike ${like} or v.name ilike ${like})`);
  }
  const rows = await db.execute<Row>(sql`
    select b.id, b.bill_no, b.vendor_id, v.name as vendor_name, b.bill_date::text, b.due_date::text, b.status,
           b.total_cents, b.total_cents - b.paid_cents - b.credited_cents as balance_cents,
           coalesce((select sum(l.amount_cents) from bill_lines l where l.bill_id = b.id and l.is_inventory), 0) as inventory_cents
      from bills b
      join vendors v on v.id = b.vendor_id
     where ${sql.join(conditions, sql` and `)}
     order by b.bill_date desc, b.created_at desc
     limit 500
  `);
  return rows.map((r) => {
    const status = r.status as DocStatus;
    const due = str(r.due_date);
    const open = status === 'open' || status === 'partial';
    return {
      id: str(r.id),
      billNo: str(r.bill_no),
      vendorId: str(r.vendor_id),
      vendorName: str(r.vendor_name),
      billDate: str(r.bill_date),
      dueDate: due,
      status,
      totalCents: cents(r.total_cents),
      balanceCents: status === 'void' || status === 'draft' ? 0 : cents(r.balance_cents),
      inventoryCents: cents(r.inventory_cents),
      daysOverdue: open && due < asOf ? daysBetween(due, asOf) : 0,
    };
  });
}

export async function billStatusCounts(asOf: CalendarDate = today()): Promise<Record<BillStatusFilter, number>> {
  const rows = await db.execute<Row>(sql`
    select count(*) as all,
           count(*) filter (where status in ('open', 'partial')) as open,
           count(*) filter (where status in ('open', 'partial') and due_date < ${asOf}::date) as overdue,
           count(*) filter (where status = 'draft') as draft,
           count(*) filter (where status = 'paid') as paid,
           count(*) filter (where status = 'void') as void
      from bills
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

export async function billDetail(billId: string): Promise<BillDetail | null> {
  if (!isUuid(billId)) return null;
  const [r] = await db.execute<Row>(sql`
    select b.*, b.bill_date::text as bill_date_text, b.due_date::text as due_date_text, v.name as vendor_name, je.entry_no
      from bills b
      join vendors v on v.id = b.vendor_id
      left join journal_entries je on je.id = b.journal_entry_id
     where b.id = ${billId}::uuid
  `);
  if (r === undefined) return null;
  const lines = await db.execute<Row>(sql`
    select l.*, l.quantity::text as qty, a.code || ' ' || a.name as account_label
      from bill_lines l join accounts a on a.id = l.account_id
     where l.bill_id = ${billId}::uuid
     order by l.line_no
  `);
  const settlements = await db.execute<Row>(sql`
    select 'bill_payment' as kind, p.id, p.payment_no as doc_no,
           (pa.applied_at at time zone ${BOOKS_TIME_ZONE})::date::text as date, pa.amount_cents, pa.discount_cents,
           exists (select 1 from journal_entries v where v.reverses_id = p.journal_entry_id and v.status = 'posted') as void
      from bill_payment_applications pa join bill_payments p on p.id = pa.payment_id
     where pa.bill_id = ${billId}::uuid
    union all
    select 'vendor_credit', c.id, c.credit_no, (ca.applied_at at time zone ${BOOKS_TIME_ZONE})::date::text, ca.amount_cents, 0,
           exists (select 1 from journal_entries v where v.reverses_id = c.journal_entry_id and v.status = 'posted')
      from vendor_credit_applications ca join vendor_credits c on c.id = ca.credit_id
     where ca.bill_id = ${billId}::uuid
     order by 4, 3
  `);
  const mapped = lines.map((l) => ({
    lineNo: Number(l.line_no),
    description: str(l.description),
    accountId: str(l.account_id),
    accountLabel: str(l.account_label),
    quantity: text(l.qty),
    unitCostCents: l.unit_cost_cents === null ? null : cents(l.unit_cost_cents),
    amountCents: cents(l.amount_cents),
    isInventory: Boolean(l.is_inventory),
  }));
  return {
    id: str(r.id),
    billNo: str(r.bill_no),
    status: r.status as DocStatus,
    vendorId: str(r.vendor_id),
    vendorName: str(r.vendor_name),
    billDate: str(r.bill_date_text),
    dueDate: str(r.due_date_text),
    termsDays: Number(r.terms_days),
    poNumber: text(r.po_number),
    memo: text(r.memo),
    totalCents: cents(r.total_cents),
    paidCents: cents(r.paid_cents),
    creditedCents: cents(r.credited_cents),
    balanceCents: cents(r.total_cents) - cents(r.paid_cents) - cents(r.credited_cents),
    inventoryCents: mapped.filter((l) => l.isInventory).reduce((sum, l) => sum + l.amountCents, 0),
    journalEntryId: text(r.journal_entry_id),
    journalEntryNo: r.entry_no === null || r.entry_no === undefined ? null : Number(r.entry_no),
    source: str(r.source),
    lines: mapped,
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

/** Approved bills of one vendor with money still owing, oldest due first. */
export async function openBillsFor(vendorId: string): Promise<OpenDoc[]> {
  if (!isUuid(vendorId)) return [];
  const rows = await db.execute<Row>(sql`
    select id, bill_no, bill_date::text, due_date::text, total_cents, paid_cents,
           total_cents - paid_cents - credited_cents as balance
      from bills
     where vendor_id = ${vendorId}::uuid and status in ('open', 'partial')
     order by due_date, bill_no
  `);
  return rows.map((r) => ({
    id: str(r.id),
    docNo: str(r.bill_no),
    date: str(r.bill_date),
    dueDate: str(r.due_date),
    totalCents: cents(r.total_cents),
    paidCents: cents(r.paid_cents),
    balanceCents: cents(r.balance),
  }));
}

/** Vendors with approved bills still owing, and how much: the payment screen's starting list. */
export async function vendorsWithOpenBills(): Promise<{ id: string; name: string; openCents: number; count: number }[]> {
  const rows = await db.execute<Row>(sql`
    select v.id, v.name, sum(b.total_cents - b.paid_cents - b.credited_cents) as open_cents, count(*) as n
      from bills b join vendors v on v.id = b.vendor_id
     where b.status in ('open', 'partial')
     group by v.id, v.name
     order by min(b.due_date)
  `);
  return rows.map((r) => ({ id: str(r.id), name: str(r.name), openCents: cents(r.open_cents), count: Number(r.n) }));
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const VOIDED_PAYMENT = sql`exists (select 1 from journal_entries v where v.reverses_id = p.journal_entry_id and v.status = 'posted')`;

export async function paymentList(): Promise<PaymentListRow[]> {
  const rows = await db.execute<Row>(sql`
    select p.id, p.payment_no, p.vendor_id, v.name as vendor_name, p.payment_date::text, p.method, p.reference,
           p.amount_cents, p.applied_cents, a.code || ' ' || a.name as account_label, p.is_1099_reportable,
           ${VOIDED_PAYMENT} as void, p.bank_transaction_id is not null as from_bank
      from bill_payments p
      join vendors v on v.id = p.vendor_id
      join accounts a on a.id = p.payment_account_id
     order by p.payment_date desc, p.payment_no desc
     limit 500
  `);
  return rows.map((r) => ({
    id: str(r.id),
    paymentNo: str(r.payment_no),
    vendorId: str(r.vendor_id),
    vendorName: str(r.vendor_name),
    paymentDate: str(r.payment_date),
    method: r.method as PaymentMethod,
    reference: text(r.reference),
    amountCents: cents(r.amount_cents),
    appliedCents: cents(r.applied_cents),
    accountLabel: str(r.account_label),
    is1099Reportable: Boolean(r.is_1099_reportable),
    void: Boolean(r.void),
    fromBank: Boolean(r.from_bank),
  }));
}

export async function paymentDetail(paymentId: string): Promise<MoneyDocDetail | null> {
  if (!isUuid(paymentId)) return null;
  const [r] = await db.execute<Row>(sql`
    select p.*, p.payment_date::text as date_text, v.name as vendor_name, a.code || ' ' || a.name as account_label,
           je.entry_no,
           (select min(x.entry_date)::text from journal_entries x where x.reverses_id = p.journal_entry_id and x.status = 'posted') as void_date
      from bill_payments p
      join vendors v on v.id = p.vendor_id
      join accounts a on a.id = p.payment_account_id
      left join journal_entries je on je.id = p.journal_entry_id
     where p.id = ${paymentId}::uuid
  `);
  if (r === undefined) return null;
  const apps = await db.execute<Row>(sql`
    select b.id, b.bill_no, b.bill_date::text, (pa.applied_at at time zone ${BOOKS_TIME_ZONE})::date::text as applied_on,
           pa.amount_cents, pa.discount_cents
      from bill_payment_applications pa join bills b on b.id = pa.bill_id
     where pa.payment_id = ${paymentId}::uuid
     order by pa.applied_at, b.bill_no
  `);
  return {
    id: str(r.id),
    docNo: str(r.payment_no),
    partyId: text(r.vendor_id),
    partyName: text(r.vendor_name),
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
    is1099Reportable: Boolean(r.is_1099_reportable),
    applications: apps.map((a) => ({
      docId: str(a.id),
      docNo: str(a.bill_no),
      docDate: str(a.bill_date),
      appliedOn: str(a.applied_on),
      amountCents: cents(a.amount_cents),
      discountCents: cents(a.discount_cents),
    })),
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface PurchasesOverview {
  asOf: CalendarDate;
  openCents: number;
  openCount: number;
  overdueCents: number;
  overdueCount: number;
  dueSoonCents: number;
  dueSoonCount: number;
  draftCount: number;
  prepaidCents: number;
  vendorCount: number;
  flagged1099Count: number;
  capitalizedThisYearCents: number;
  upcoming: BillListRow[];
  drafts: BillListRow[];
}

export async function purchasesOverview(): Promise<PurchasesOverview> {
  const asOf = today();
  const soon = addDays(asOf, 14);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const [t = {}] = await db.execute<Row>(sql`
    with open_docs as (
      select due_date, total_cents - paid_cents - credited_cents as balance
        from bills where status in ('open', 'partial')
    )
    select coalesce(sum(balance), 0) as open_cents, count(*) as open_count,
           coalesce(sum(balance) filter (where due_date < ${asOf}::date), 0) as overdue_cents,
           count(*) filter (where due_date < ${asOf}::date) as overdue_count,
           coalesce(sum(balance) filter (where due_date between ${asOf}::date and ${soon}::date), 0) as soon_cents,
           count(*) filter (where due_date between ${asOf}::date and ${soon}::date) as soon_count,
           (select count(*) from bills where status = 'draft') as draft_count,
           (select count(*) from vendors where active) as vendor_count,
           (select count(*) from vendors where active and is_1099) as flagged_count,
           (select coalesce(sum(p.amount_cents - p.applied_cents), 0) from bill_payments p
             where p.journal_entry_id is not null and not ${VOIDED_PAYMENT}) as prepaid_cents,
           (select coalesce(sum(l.amount_cents), 0) from bill_lines l join bills b on b.id = l.bill_id
             where l.is_inventory and b.status in ('open', 'partial', 'paid')
               and b.bill_date between ${yearStart}::date and ${asOf}::date) as capitalized_cents
      from open_docs
  `);
  const open = await billList({ status: 'open', vendorId: '', from: '', to: '', q: '' }, asOf);
  const drafts = await billList({ status: 'draft', vendorId: '', from: '', to: '', q: '' }, asOf);
  return {
    asOf,
    openCents: cents(t.open_cents),
    openCount: Number(t.open_count ?? 0),
    overdueCents: cents(t.overdue_cents),
    overdueCount: Number(t.overdue_count ?? 0),
    dueSoonCents: cents(t.soon_cents),
    dueSoonCount: Number(t.soon_count ?? 0),
    draftCount: Number(t.draft_count ?? 0),
    prepaidCents: cents(t.prepaid_cents),
    vendorCount: Number(t.vendor_count ?? 0),
    flagged1099Count: Number(t.flagged_count ?? 0),
    capitalizedThisYearCents: cents(t.capitalized_cents),
    upcoming: [...open].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0)).slice(0, 8),
    drafts: drafts.slice(0, 8),
  };
}

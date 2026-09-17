-- Sooz Books — accounts receivable and accounts payable sub-ledgers.
-- Control-account discipline: AR and AP balances in the GL are only ever moved by entries
-- whose source_type is one of these sub-ledger documents (enforced in postJournalEntry).

create type doc_status      as enum ('draft', 'open', 'partial', 'paid', 'void');
create type payment_method  as enum ('ach', 'check', 'wire', 'card', 'cash', 'marketplace', 'bill_pay', 'other');
create type customer_type   as enum ('dtc', 'marketplace', 'distributor', 'wholesale', 'foodservice', 'other');
create type vendor_type     as enum ('co_manufacturer', 'ingredients', 'packaging', 'freight', 'warehouse_3pl',
                                     'broker', 'marketing', 'professional', 'software', 'other');

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
create table customers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  display_name    text,
  customer_type   customer_type not null default 'wholesale',
  channel_id      uuid references channels (id),
  email           text,
  phone           text,
  billing_address jsonb,
  shipping_address jsonb,
  -- payment terms: net days, plus an optional early-payment discount (2/10 net 30 => 2.00, 10, 30)
  terms_days           int not null default 30,
  terms_discount_pct   numeric(5,2) not null default 0,
  terms_discount_days  int not null default 0,
  credit_limit_cents   bigint,
  -- ids this customer is known by in other systems (shopify, faire, peasy, distributor vendor number)
  external_ids    jsonb not null default '{}'::jsonb,
  notes           text,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create index customers_name_idx on customers (lower(name));
create index customers_channel_idx on customers (channel_id);

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
create table invoices (
  id            uuid primary key default gen_random_uuid(),
  invoice_no    text not null unique,
  customer_id   uuid not null references customers (id),
  channel_id    uuid references channels (id),
  invoice_date  date not null,
  due_date      date not null,
  terms_days    int not null default 30,
  po_number     text,
  memo          text,
  status        doc_status not null default 'draft',
  subtotal_cents bigint not null default 0,
  discount_cents bigint not null default 0,
  shipping_cents bigint not null default 0,
  tax_cents      bigint not null default 0,
  total_cents    bigint not null default 0,
  -- maintained by the application as payments, credits and deductions are applied
  paid_cents      bigint not null default 0,
  credited_cents  bigint not null default 0,
  deducted_cents  bigint not null default 0,
  journal_entry_id uuid references journal_entries (id),
  source        text not null default 'manual',   -- manual, shopify, faire, amazon, import, qbo_migration
  external_id   text,
  created_by    uuid references app_users (id),
  created_at    timestamptz not null default now(),
  constraint invoice_amounts_nonneg check (
    subtotal_cents >= 0 and shipping_cents >= 0 and tax_cents >= 0 and
    paid_cents >= 0 and credited_cents >= 0 and deducted_cents >= 0)
);
create index invoices_customer_idx on invoices (customer_id);
create index invoices_date_idx on invoices (invoice_date);
create index invoices_status_idx on invoices (status) where status in ('open', 'partial');
create index invoices_due_idx on invoices (due_date) where status in ('open', 'partial');
create unique index invoices_source_external_idx on invoices (source, external_id)
  where external_id is not null;

-- Open balance is always derived, never stored, so it cannot drift.
create or replace function invoice_balance_cents(inv invoices) returns bigint
language sql immutable as $$
  select inv.total_cents - inv.paid_cents - inv.credited_cents - inv.deducted_cents
$$;

create table invoice_lines (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoices (id) on delete cascade,
  line_no     int not null,
  product_id  uuid references products (id),
  description text not null,
  quantity    numeric(14,4) not null default 1,
  unit_price_cents bigint not null default 0,
  amount_cents     bigint not null default 0,
  discount_cents   bigint not null default 0,
  tax_cents        bigint not null default 0,
  revenue_account_id uuid references accounts (id),
  channel_id  uuid references channels (id),
  unique (invoice_id, line_no)
);
create index invoice_lines_invoice_idx on invoice_lines (invoice_id);
create index invoice_lines_product_idx on invoice_lines (product_id);

-- ---------------------------------------------------------------------------
-- Customer receipts (cash in) and their application to invoices
-- ---------------------------------------------------------------------------
create table receipts (
  id            uuid primary key default gen_random_uuid(),
  receipt_no    text not null unique,
  customer_id   uuid references customers (id),
  receipt_date  date not null,
  method        payment_method not null default 'ach',
  reference     text,                                   -- check number, ACH trace, payout id
  amount_cents  bigint not null check (amount_cents > 0),
  applied_cents bigint not null default 0,
  deposit_account_id uuid not null references accounts (id),
  journal_entry_id   uuid references journal_entries (id),
  bank_transaction_id uuid,                             -- FK added with the banking migration
  remittance_id uuid,                                   -- FK added with the trade migration
  memo          text,
  created_by    uuid references app_users (id),
  created_at    timestamptz not null default now()
);
create index receipts_customer_idx on receipts (customer_id);
create index receipts_date_idx on receipts (receipt_date);

create table receipt_applications (
  id          uuid primary key default gen_random_uuid(),
  receipt_id  uuid not null references receipts (id) on delete cascade,
  invoice_id  uuid not null references invoices (id),
  amount_cents bigint not null check (amount_cents > 0),
  -- an early-payment discount taken on this invoice; posts to contra-revenue, not to cash
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  applied_at  timestamptz not null default now(),
  unique (receipt_id, invoice_id)
);
create index receipt_apps_invoice_idx on receipt_applications (invoice_id);

-- ---------------------------------------------------------------------------
-- Credit memos
-- ---------------------------------------------------------------------------
create table credit_memos (
  id           uuid primary key default gen_random_uuid(),
  memo_no      text not null unique,
  customer_id  uuid not null references customers (id),
  memo_date    date not null,
  reason       text not null,
  amount_cents bigint not null check (amount_cents > 0),
  applied_cents bigint not null default 0,
  revenue_account_id uuid references accounts (id),
  journal_entry_id uuid references journal_entries (id),
  created_by   uuid references app_users (id),
  created_at   timestamptz not null default now()
);

create table credit_memo_applications (
  id            uuid primary key default gen_random_uuid(),
  credit_memo_id uuid not null references credit_memos (id) on delete cascade,
  invoice_id    uuid not null references invoices (id),
  amount_cents  bigint not null check (amount_cents > 0),
  applied_at    timestamptz not null default now(),
  unique (credit_memo_id, invoice_id)
);

-- ---------------------------------------------------------------------------
-- Vendors
-- ---------------------------------------------------------------------------
create table vendors (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  display_name  text,
  vendor_type   vendor_type not null default 'other',
  email         text,
  phone         text,
  address       jsonb,
  terms_days    int not null default 30,
  terms_discount_pct  numeric(5,2) not null default 0,
  terms_discount_days int not null default 0,
  -- 1099-NEC tracking
  is_1099        boolean not null default false,
  tax_id_last4   text,
  w9_on_file     boolean not null default false,
  w9_received_at date,
  legal_name     text,
  default_expense_account_id uuid references accounts (id),
  external_ids   jsonb not null default '{}'::jsonb,
  notes          text,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index vendors_name_idx on vendors (lower(name));
create index vendors_1099_idx on vendors (is_1099) where is_1099;

-- ---------------------------------------------------------------------------
-- Bills
-- ---------------------------------------------------------------------------
create table bills (
  id           uuid primary key default gen_random_uuid(),
  bill_no      text not null,                 -- the vendor's invoice number
  vendor_id    uuid not null references vendors (id),
  bill_date    date not null,
  due_date     date not null,
  terms_days   int not null default 30,
  po_number    text,
  memo         text,
  status       doc_status not null default 'draft',
  subtotal_cents bigint not null default 0,
  tax_cents      bigint not null default 0,
  shipping_cents bigint not null default 0,
  total_cents    bigint not null default 0,
  paid_cents     bigint not null default 0,
  credited_cents bigint not null default 0,
  journal_entry_id uuid references journal_entries (id),
  source       text not null default 'manual',  -- manual, peasy, import, qbo_migration
  external_id  text,
  created_by   uuid references app_users (id),
  created_at   timestamptz not null default now(),
  unique (vendor_id, bill_no)
);
create index bills_vendor_idx on bills (vendor_id);
create index bills_date_idx on bills (bill_date);
create index bills_open_idx on bills (due_date) where status in ('open', 'partial');

create table bill_lines (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid not null references bills (id) on delete cascade,
  line_no     int not null,
  description text not null,
  account_id  uuid not null references accounts (id),
  amount_cents bigint not null,
  quantity    numeric(14,4),
  unit_cost_cents bigint,
  product_id  uuid references products (id),
  channel_id  uuid references channels (id),
  -- true when this line capitalises into inventory rather than hitting expense directly;
  -- the inventory/COGS module allocates these into landed cost per production run
  is_inventory boolean not null default false,
  production_run_id uuid,                        -- FK added with the inventory migration
  unique (bill_id, line_no)
);
create index bill_lines_bill_idx on bill_lines (bill_id);
create index bill_lines_account_idx on bill_lines (account_id);

-- ---------------------------------------------------------------------------
-- Bill payments (cash out)
-- ---------------------------------------------------------------------------
create table bill_payments (
  id           uuid primary key default gen_random_uuid(),
  payment_no   text not null unique,
  vendor_id    uuid not null references vendors (id),
  payment_date date not null,
  method       payment_method not null default 'ach',
  reference    text,
  amount_cents bigint not null check (amount_cents > 0),
  applied_cents bigint not null default 0,
  payment_account_id uuid not null references accounts (id),
  journal_entry_id   uuid references journal_entries (id),
  bank_transaction_id uuid,
  -- card payments are excluded from 1099 reporting (the card network reports them on 1099-K)
  is_1099_reportable boolean not null default true,
  memo         text,
  created_by   uuid references app_users (id),
  created_at   timestamptz not null default now()
);
create index bill_payments_vendor_idx on bill_payments (vendor_id);
create index bill_payments_date_idx on bill_payments (payment_date);

create table bill_payment_applications (
  id         uuid primary key default gen_random_uuid(),
  payment_id uuid not null references bill_payments (id) on delete cascade,
  bill_id    uuid not null references bills (id),
  amount_cents bigint not null check (amount_cents > 0),
  discount_cents bigint not null default 0,
  applied_at timestamptz not null default now(),
  unique (payment_id, bill_id)
);
create index bill_payment_apps_bill_idx on bill_payment_applications (bill_id);

create table vendor_credits (
  id           uuid primary key default gen_random_uuid(),
  credit_no    text not null unique,
  vendor_id    uuid not null references vendors (id),
  credit_date  date not null,
  reason       text not null,
  amount_cents bigint not null check (amount_cents > 0),
  applied_cents bigint not null default 0,
  account_id   uuid references accounts (id),
  journal_entry_id uuid references journal_entries (id),
  created_at   timestamptz not null default now()
);

create table vendor_credit_applications (
  id        uuid primary key default gen_random_uuid(),
  credit_id uuid not null references vendor_credits (id) on delete cascade,
  bill_id   uuid not null references bills (id),
  amount_cents bigint not null check (amount_cents > 0),
  applied_at timestamptz not null default now(),
  unique (credit_id, bill_id)
);

-- The foreign keys tying journal_lines.customer_id / vendor_id to these tables are
-- added separately in 0012, so this migration only creates tables and never alters
-- one the ledger is already writing to.
create index jl_customer_idx on journal_lines (customer_id);
create index jl_vendor_idx   on journal_lines (vendor_id);

-- ---------------------------------------------------------------------------
-- Aging views. Both must always tie to their control account in the GL; the
-- close checklist asserts exactly that.
-- ---------------------------------------------------------------------------
create view ar_open_items as
  select i.id as invoice_id, i.invoice_no, i.customer_id, c.name as customer_name,
         i.channel_id, i.invoice_date, i.due_date, i.total_cents,
         i.paid_cents, i.credited_cents, i.deducted_cents,
         (i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents) as balance_cents,
         (current_date - i.due_date) as days_past_due
    from invoices i
    join customers c on c.id = i.customer_id
   where i.status in ('open', 'partial')
     and (i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents) <> 0;

create view ap_open_items as
  select b.id as bill_id, b.bill_no, b.vendor_id, v.name as vendor_name,
         b.bill_date, b.due_date, b.total_cents, b.paid_cents, b.credited_cents,
         (b.total_cents - b.paid_cents - b.credited_cents) as balance_cents,
         (current_date - b.due_date) as days_past_due
    from bills b
    join vendors v on v.id = b.vendor_id
   where b.status in ('open', 'partial')
     and (b.total_cents - b.paid_cents - b.credited_cents) <> 0;

-- ---------------------------------------------------------------------------
-- Audit + RLS
-- ---------------------------------------------------------------------------
select attach_audit('customers');
select attach_audit('invoices');
select attach_audit('invoice_lines');
select attach_audit('receipts');
select attach_audit('receipt_applications');
select attach_audit('credit_memos');
select attach_audit('credit_memo_applications');
select attach_audit('vendors');
select attach_audit('bills');
select attach_audit('bill_lines');
select attach_audit('bill_payments');
select attach_audit('bill_payment_applications');
select attach_audit('vendor_credits');
select attach_audit('vendor_credit_applications');

alter table customers                 enable row level security;
alter table invoices                  enable row level security;
alter table invoice_lines             enable row level security;
alter table receipts                  enable row level security;
alter table receipt_applications      enable row level security;
alter table credit_memos              enable row level security;
alter table credit_memo_applications  enable row level security;
alter table vendors                   enable row level security;
alter table bills                     enable row level security;
alter table bill_lines                enable row level security;
alter table bill_payments             enable row level security;
alter table bill_payment_applications enable row level security;
alter table vendor_credits            enable row level security;
alter table vendor_credit_applications enable row level security;

grant all privileges on all tables in schema public to sooz_app;
grant all privileges on all sequences in schema public to sooz_app;

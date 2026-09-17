-- Sooz Books — trade spend and deductions.
--
-- The CPG-specific heart of the system. A distributor pays a $10,000 invoice with a
-- $9,150 ACH; the $850 gap is several deductions with different reason codes. Some are
-- legitimate promotional spend (contra-revenue, often already accrued), some are claims
-- to dispute (Deductions Receivable). Booking the short-pay as a discount loses both the
-- trade-spend measurement and the money that could be recovered.

create type promo_type as enum (
  'off_invoice', 'billback', 'mcb', 'scan_down', 'slotting', 'free_fill',
  'new_item_allowance', 'ad_fee', 'tpr', 'demo', 'sampling', 'spoils_allowance',
  'freight_allowance', 'early_pay_discount', 'other'
);
create type promo_status as enum ('planned', 'active', 'completed', 'cancelled');
create type deduction_status as enum ('open', 'validated', 'disputed', 'recovered', 'written_off', 'partially_recovered');
create type deduction_treatment as enum ('contra_revenue', 'dispute', 'cogs', 'expense', 'ar_payment');

-- ---------------------------------------------------------------------------
-- Reason codes. Seeded with the vocabulary distributors actually use, then
-- extended by the bookkeeper as new codes appear on remittances.
-- ---------------------------------------------------------------------------
create table deduction_reason_codes (
  code            text primary key,
  label           text not null,
  category        text not null,            -- trade | logistics | quality | pricing | admin
  default_treatment deduction_treatment not null,
  default_account_id uuid references accounts (id),
  -- how long the distributor's contract gives us to dispute; drives the work queue
  dispute_window_days int not null default 90,
  typically_valid boolean not null default true,
  notes           text,
  active          boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Promotions: planned trade spend, so the liability is accrued when the promotion
-- runs rather than when the deduction arrives months later.
-- ---------------------------------------------------------------------------
create table promotions (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  customer_id    uuid references customers (id),
  channel_id     uuid references channels (id),
  promo_type     promo_type not null,
  start_date     date not null,
  end_date       date not null,
  ship_start_date date,
  ship_end_date   date,
  planned_units  numeric(14,2),
  allowance_per_unit_cents bigint,
  planned_spend_cents bigint not null default 0,
  accrued_cents  bigint not null default 0,
  actual_spend_cents bigint not null default 0,
  status         promo_status not null default 'planned',
  authorization_no text,
  notes          text,
  created_by     uuid references app_users (id),
  created_at     timestamptz not null default now(),
  constraint promo_dates check (end_date >= start_date)
);
create index promotions_customer_idx on promotions (customer_id);
create index promotions_dates_idx on promotions (start_date, end_date);

create table promotion_products (
  promotion_id uuid not null references promotions (id) on delete cascade,
  product_id   uuid not null references products (id),
  planned_units numeric(14,2),
  allowance_per_unit_cents bigint,
  primary key (promotion_id, product_id)
);

-- ---------------------------------------------------------------------------
-- Remittances: the file a distributor sends explaining what a payment covers.
-- ---------------------------------------------------------------------------
create table remittances (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references customers (id),
  remittance_date date not null,
  reference      text,
  total_cents    bigint not null,
  invoices_gross_cents bigint not null default 0,
  deductions_cents bigint not null default 0,
  filename       text,
  file_hash      text,
  storage_path   text,
  receipt_id     uuid references receipts (id),
  bank_transaction_id uuid references bank_transactions (id),
  status         text not null default 'imported',   -- imported | posted | discrepancy
  warnings       jsonb not null default '[]'::jsonb,
  imported_by    uuid references app_users (id),
  created_at     timestamptz not null default now()
);
create unique index remittance_hash_idx on remittances (customer_id, file_hash) where file_hash is not null;

create table remittance_lines (
  id             uuid primary key default gen_random_uuid(),
  remittance_id  uuid not null references remittances (id) on delete cascade,
  line_no        int not null,
  invoice_no     text,
  invoice_id     uuid references invoices (id),
  gross_cents    bigint not null default 0,
  deduction_cents bigint not null default 0,
  net_cents      bigint not null default 0,
  reason_code    text references deduction_reason_codes (code),
  description    text,
  raw            jsonb,
  unique (remittance_id, line_no)
);

alter table receipts
  add constraint receipts_remittance_fk foreign key (remittance_id) references remittances (id);

-- ---------------------------------------------------------------------------
-- Deductions. One row per short-pay line, tracked from arrival to resolution.
-- ---------------------------------------------------------------------------
create table deductions (
  id             uuid primary key default gen_random_uuid(),
  deduction_no   text not null unique,
  customer_id    uuid not null references customers (id),
  deduction_date date not null,
  reason_code    text references deduction_reason_codes (code),
  invoice_id     uuid references invoices (id),
  invoice_no     text,
  promotion_id   uuid references promotions (id),
  remittance_id  uuid references remittances (id),
  remittance_line_id uuid references remittance_lines (id),
  reference      text,
  description    text,
  amount_cents   bigint not null check (amount_cents > 0),
  status         deduction_status not null default 'open',
  treatment      deduction_treatment not null default 'dispute',
  recovered_cents  bigint not null default 0,
  written_off_cents bigint not null default 0,
  -- the entry that booked the deduction when the short payment was recorded
  journal_entry_id uuid references journal_entries (id),
  -- the entry that resolved it (recovery or write-off)
  resolution_entry_id uuid references journal_entries (id),
  disputed_at    timestamptz,
  dispute_reference text,
  dispute_notes  text,
  dispute_deadline date,
  resolved_at    timestamptz,
  resolved_by    uuid references app_users (id),
  assigned_to    uuid references app_users (id),
  created_at     timestamptz not null default now(),
  constraint deduction_resolution_within_amount
    check (recovered_cents + written_off_cents <= amount_cents)
);
create index deductions_customer_idx on deductions (customer_id);
create index deductions_status_idx on deductions (status) where status in ('open', 'disputed');
create index deductions_date_idx on deductions (deduction_date);
create index deductions_promo_idx on deductions (promotion_id);
create index deductions_deadline_idx on deductions (dispute_deadline) where status in ('open', 'disputed');

-- ---------------------------------------------------------------------------
-- Monthly trade accruals, and the variance when actual deductions land.
-- ---------------------------------------------------------------------------
create table trade_accruals (
  id            uuid primary key default gen_random_uuid(),
  period_year   int not null,
  period_month  int not null check (period_month between 1 and 12),
  promotion_id  uuid references promotions (id),
  customer_id   uuid references customers (id),
  basis         text not null default 'planned',   -- planned | rate | manual
  accrued_cents bigint not null default 0,
  relieved_cents bigint not null default 0,
  reversed_cents bigint not null default 0,
  journal_entry_id uuid references journal_entries (id),
  reversal_entry_id uuid references journal_entries (id),
  notes         text,
  created_by    uuid references app_users (id),
  created_at    timestamptz not null default now()
);
create index trade_accruals_period_idx on trade_accruals (period_year, period_month);

-- ---------------------------------------------------------------------------
-- Reporting views
-- ---------------------------------------------------------------------------
create view deduction_aging as
  select d.id, d.deduction_no, d.customer_id, c.name as customer_name,
         d.deduction_date, d.reason_code, rc.label as reason_label, rc.category,
         d.amount_cents, d.recovered_cents, d.written_off_cents,
         (d.amount_cents - d.recovered_cents - d.written_off_cents) as open_cents,
         d.status, d.dispute_deadline,
         (current_date - d.deduction_date) as days_outstanding,
         case when d.dispute_deadline is not null
              then (d.dispute_deadline - current_date) end as days_to_deadline
    from deductions d
    join customers c on c.id = d.customer_id
    left join deduction_reason_codes rc on rc.code = d.reason_code
   where d.status in ('open', 'disputed', 'partially_recovered');

create view promotion_performance as
  select p.id, p.name, p.promo_type, p.customer_id, c.name as customer_name,
         p.start_date, p.end_date, p.status,
         p.planned_spend_cents, p.accrued_cents,
         coalesce(sum(d.amount_cents), 0) as deducted_cents,
         p.planned_spend_cents - coalesce(sum(d.amount_cents), 0) as variance_cents
    from promotions p
    left join customers c on c.id = p.customer_id
    left join deductions d on d.promotion_id = p.id
   group by p.id, p.name, p.promo_type, p.customer_id, c.name, p.start_date,
            p.end_date, p.status, p.planned_spend_cents, p.accrued_cents;

select attach_audit('deduction_reason_codes');
select attach_audit('promotions');
select attach_audit('promotion_products');
select attach_audit('remittances');
select attach_audit('remittance_lines');
select attach_audit('deductions');
select attach_audit('trade_accruals');

alter table deduction_reason_codes enable row level security;
alter table promotions         enable row level security;
alter table promotion_products enable row level security;
alter table remittances        enable row level security;
alter table remittance_lines   enable row level security;
alter table deductions         enable row level security;
alter table trade_accruals     enable row level security;

grant all privileges on all tables in schema public to sooz_app;
grant all privileges on all sequences in schema public to sooz_app;

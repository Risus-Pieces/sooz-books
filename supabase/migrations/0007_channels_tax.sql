-- Sooz Books — channel payout settlements and sales tax.
--
-- The rule this module exists to enforce: revenue is NEVER booked net of fees.
-- A settlement posts its full gross detail against a per-channel clearing account;
-- the bank deposit then clears that account to zero. A non-zero clearing balance at
-- month end is an exception that the close checklist surfaces.

create type payout_provider as enum ('shopify', 'amazon', 'faire', 'stripe', 'paypal', 'other');
create type payout_status   as enum ('imported', 'posted', 'deposited', 'discrepancy');

create type payout_line_type as enum (
  'gross_sales',            -- product revenue, credit revenue
  'shipping_income',
  'tip',
  'gift_card',
  'discount',               -- contra-revenue
  'coupon',                 -- contra-revenue
  'promotion_rebate',       -- contra-revenue (Amazon promotions)
  'refund',                 -- contra-revenue
  'chargeback',
  'chargeback_reversal',
  'sales_tax_collected',    -- liability we remit
  'facilitator_tax',        -- collected and remitted BY the marketplace: pass-through, never a liability
  'referral_fee',           -- marketplace commission
  'processing_fee',
  'fulfillment_fee',        -- FBA / pick-pack
  'storage_fee',
  'shipping_cost',
  'advertising',
  'subscription_fee',
  'reimbursement',          -- lost/damaged inventory: other income, not sales
  'adjustment',
  'reserve_held',
  'reserve_released',
  'other'
);

-- ---------------------------------------------------------------------------
-- One settlement / payout file
-- ---------------------------------------------------------------------------
create table payout_imports (
  id            uuid primary key default gen_random_uuid(),
  provider      payout_provider not null,
  channel_id    uuid not null references channels (id),
  external_id   text,                      -- settlement id / payout id from the provider
  period_start  date,
  period_end    date,
  deposit_date  date,
  -- the provider's own control total; the importer asserts the parsed lines sum to it
  reported_total_cents bigint,
  computed_total_cents bigint not null default 0,
  gross_cents   bigint not null default 0,
  fees_cents    bigint not null default 0,
  net_cents     bigint not null default 0,
  clearing_account_id uuid references accounts (id),
  status        payout_status not null default 'imported',
  discrepancy_cents bigint not null default 0,
  filename      text,
  file_hash     text,
  storage_path  text,
  journal_entry_id    uuid references journal_entries (id),
  bank_transaction_id uuid references bank_transactions (id),
  warnings      jsonb not null default '[]'::jsonb,
  imported_by   uuid references app_users (id),
  created_at    timestamptz not null default now()
);
create unique index payout_external_idx on payout_imports (provider, external_id)
  where external_id is not null;
create unique index payout_file_hash_idx on payout_imports (provider, file_hash)
  where file_hash is not null;
create index payout_deposit_idx on payout_imports (deposit_date);

create table payout_lines (
  id             uuid primary key default gen_random_uuid(),
  payout_import_id uuid not null references payout_imports (id) on delete cascade,
  line_no        int not null,
  line_type      payout_line_type not null,
  posted_date    date,
  external_ref   text,                     -- order id / adjustment id
  sku            text,
  product_id     uuid references products (id),
  quantity       numeric(14,4),
  -- signed from the company's point of view: positive increases the payout, negative reduces it
  amount_cents   bigint not null,
  account_id     uuid references accounts (id),
  jurisdiction   text,                     -- state code for tax lines
  description    text,
  raw            jsonb,
  unique (payout_import_id, line_no)
);
create index payout_lines_import_idx on payout_lines (payout_import_id);
create index payout_lines_type_idx on payout_lines (line_type);
create index payout_lines_product_idx on payout_lines (product_id);

-- The importer must never post a settlement whose lines do not sum to its reported total.
create or replace function payout_is_balanced(p uuid) returns boolean
language sql stable as $$
  select coalesce(
    (select pi.reported_total_cents is null
         or pi.reported_total_cents = (select coalesce(sum(amount_cents), 0)
                                         from payout_lines where payout_import_id = pi.id)
       from payout_imports pi where pi.id = p),
    false)
$$;

-- ---------------------------------------------------------------------------
-- Sales tax. Tax a marketplace collects and remits on our behalf is recorded
-- for reporting (states still ask about it) but is flagged so it never lands in
-- the Sales Tax Payable liability.
-- ---------------------------------------------------------------------------
create table sales_tax_entries (
  id            uuid primary key default gen_random_uuid(),
  source_type   text not null,             -- invoice | payout | manual
  source_id     uuid,
  tax_date      date not null,
  state         text not null,             -- two-letter code
  jurisdiction  text,                      -- county/city detail when available
  channel_id    uuid references channels (id),
  customer_id   uuid references customers (id),
  taxable_cents bigint not null default 0,
  exempt_cents  bigint not null default 0,
  tax_cents     bigint not null default 0,
  facilitator_remitted boolean not null default false,
  filing_id     uuid,
  created_at    timestamptz not null default now()
);
create index sales_tax_state_date_idx on sales_tax_entries (state, tax_date);
create index sales_tax_source_idx on sales_tax_entries (source_type, source_id);

create table sales_tax_filings (
  id            uuid primary key default gen_random_uuid(),
  state         text not null,
  period_start  date not null,
  period_end    date not null,
  gross_sales_cents  bigint not null default 0,
  taxable_cents      bigint not null default 0,
  tax_due_cents      bigint not null default 0,
  tax_paid_cents     bigint not null default 0,
  filed_at      timestamptz,
  paid_at       date,
  confirmation  text,
  journal_entry_id uuid references journal_entries (id),
  notes         text,
  created_at    timestamptz not null default now(),
  unique (state, period_start, period_end)
);

alter table sales_tax_entries
  add constraint sales_tax_filing_fk foreign key (filing_id) references sales_tax_filings (id) on delete set null;

-- Liability owed by Sooz, by state and period: facilitator tax excluded by construction.
create view sales_tax_liability as
  select state,
         date_trunc('month', tax_date)::date as period,
         sum(taxable_cents) as taxable_cents,
         sum(tax_cents)     as tax_cents,
         sum(case when facilitator_remitted then tax_cents else 0 end) as facilitator_cents,
         sum(case when facilitator_remitted then 0 else tax_cents end) as owed_cents
    from sales_tax_entries
   group by state, date_trunc('month', tax_date);

-- Channel clearing balances: anything non-zero after a deposit lands is an exception.
create view channel_clearing_balances as
  select a.id as account_id, a.code, a.name, ch.code as channel_code,
         coalesce(sum(l.debit_cents) - sum(l.credit_cents), 0) as balance_cents
    from accounts a
    join channels ch on ch.id = a.clearing_for_channel_id
    left join journal_lines l on l.account_id = a.id
    left join journal_entries e on e.id = l.entry_id and e.status = 'posted'
   where a.clearing_for_channel_id is not null
     and (e.id is not null or l.id is null)
   group by a.id, a.code, a.name, ch.code;

select attach_audit('payout_imports');
select attach_audit('payout_lines');
select attach_audit('sales_tax_entries');
select attach_audit('sales_tax_filings');

alter table payout_imports    enable row level security;
alter table payout_lines      enable row level security;
alter table sales_tax_entries enable row level security;
alter table sales_tax_filings enable row level security;

grant all privileges on all tables in schema public to sooz_app;
grant all privileges on all sequences in schema public to sooz_app;

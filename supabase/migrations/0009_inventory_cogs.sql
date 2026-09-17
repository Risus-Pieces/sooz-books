-- Sooz Books — inventory value and cost of goods sold.
--
-- Peasy remains the system of record for quantities, purchase orders and production.
-- This module carries the VALUE side: what a unit costs landed, what inventory is worth
-- on the balance sheet, and what COGS to recognise against units shipped each month.
--
-- Landed cost for a co-manufactured product = co-man tolling + ingredients + packaging
-- + freight-in + duty, allocated across the units a production run actually yielded.

create type cost_component as enum (
  'tolling', 'ingredients', 'packaging', 'freight_in', 'duty', 'labor', 'overhead', 'other'
);
create type cost_method as enum ('actual_run', 'standard', 'moving_average');
create type inventory_adjustment_reason as enum (
  'count_variance', 'spoilage', 'damage', 'expiry', 'samples', 'demo', 'donation',
  'theft', 'rework', 'revaluation', 'opening_balance'
);

-- ---------------------------------------------------------------------------
-- Production runs at the co-manufacturer
-- ---------------------------------------------------------------------------
create table production_runs (
  id            uuid primary key default gen_random_uuid(),
  run_no        text not null unique,
  product_id    uuid not null references products (id),
  co_man_vendor_id uuid references vendors (id),
  run_date      date not null,
  lot_code      text,
  units_planned numeric(14,2),
  units_produced numeric(14,2) not null default 0,
  units_rejected numeric(14,2) not null default 0,
  status        text not null default 'open',      -- open | costed | closed
  -- filled in by the costing step
  total_cost_cents bigint not null default 0,
  unit_cost_cents  bigint,
  costed_at     timestamptz,
  peasy_work_order_id text,
  notes         text,
  created_at    timestamptz not null default now()
);
create index production_runs_product_idx on production_runs (product_id);
create index production_runs_date_idx on production_runs (run_date);

alter table bill_lines
  add constraint bill_lines_production_run_fk
  foreign key (production_run_id) references production_runs (id) on delete set null;

-- Every cost that lands in a run's landed cost, traced back to the bill line it came from.
create table landed_costs (
  id            uuid primary key default gen_random_uuid(),
  production_run_id uuid not null references production_runs (id) on delete cascade,
  component     cost_component not null,
  bill_id       uuid references bills (id),
  bill_line_id  uuid references bill_lines (id),
  description   text,
  amount_cents  bigint not null,
  -- when one bill covers several runs, the share allocated here; shares must sum to the bill line
  allocation_basis text,                            -- units | value | manual
  created_at    timestamptz not null default now()
);
create index landed_costs_run_idx on landed_costs (production_run_id);
create index landed_costs_bill_idx on landed_costs (bill_id);

-- ---------------------------------------------------------------------------
-- The cost used to value a unit shipped on a given date.
-- ---------------------------------------------------------------------------
create table product_costs (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products (id),
  effective_date date not null,
  unit_cost_cents bigint not null check (unit_cost_cents >= 0),
  method         cost_method not null default 'actual_run',
  production_run_id uuid references production_runs (id),
  -- the component breakdown behind the unit cost, for margin analysis
  breakdown      jsonb not null default '{}'::jsonb,
  notes          text,
  created_by     uuid references app_users (id),
  created_at     timestamptz not null default now(),
  unique (product_id, effective_date)
);
create index product_costs_lookup_idx on product_costs (product_id, effective_date desc);

create or replace function unit_cost_at(p_product uuid, p_date date) returns bigint
language sql stable as $$
  select unit_cost_cents from product_costs
   where product_id = p_product and effective_date <= p_date
   order by effective_date desc limit 1
$$;

-- ---------------------------------------------------------------------------
-- Inventory position imported from Peasy, and the tie-out against the ledger.
-- ---------------------------------------------------------------------------
create table inventory_imports (
  id            uuid primary key default gen_random_uuid(),
  source        text not null default 'peasy',     -- peasy | manual | csv
  snapshot_date date not null,
  filename      text,
  file_hash     text,
  storage_path  text,
  row_count     int not null default 0,
  total_value_cents bigint not null default 0,
  status        import_status not null default 'preview',
  warnings      jsonb not null default '[]'::jsonb,
  imported_by   uuid references app_users (id),
  created_at    timestamptz not null default now()
);
create unique index inventory_import_hash_idx on inventory_imports (file_hash) where file_hash is not null;

create table inventory_snapshots (
  id            uuid primary key default gen_random_uuid(),
  import_id     uuid references inventory_imports (id) on delete cascade,
  snapshot_date date not null,
  product_id    uuid not null references products (id),
  location      text not null default 'default',
  stage         text not null default 'finished',  -- raw | packaging | wip | finished | in_transit
  quantity      numeric(14,2) not null default 0,
  unit_cost_cents bigint not null default 0,
  value_cents   bigint not null default 0,
  unique (snapshot_date, product_id, location, stage)
);
create index inventory_snapshots_date_idx on inventory_snapshots (snapshot_date);

-- Units shipped per SKU per channel in a month: the driver for COGS.
create table shipment_imports (
  id            uuid primary key default gen_random_uuid(),
  source        text not null default 'peasy',
  period_year   int not null,
  period_month  int not null check (period_month between 1 and 12),
  filename      text,
  file_hash     text,
  row_count     int not null default 0,
  status        import_status not null default 'preview',
  imported_by   uuid references app_users (id),
  created_at    timestamptz not null default now()
);

create table shipment_units (
  id            uuid primary key default gen_random_uuid(),
  import_id     uuid references shipment_imports (id) on delete cascade,
  period_year   int not null,
  period_month  int not null check (period_month between 1 and 12),
  product_id    uuid not null references products (id),
  channel_id    uuid references channels (id),
  customer_id   uuid references customers (id),
  units         numeric(14,2) not null default 0,
  returns_units numeric(14,2) not null default 0,
  unique (period_year, period_month, product_id, channel_id, customer_id)
);

-- ---------------------------------------------------------------------------
-- The monthly COGS posting: units shipped x landed unit cost, per SKU per channel.
-- ---------------------------------------------------------------------------
create table cogs_batches (
  id            uuid primary key default gen_random_uuid(),
  period_year   int not null,
  period_month  int not null check (period_month between 1 and 12),
  status        text not null default 'draft',     -- draft | posted | reversed
  total_units   numeric(14,2) not null default 0,
  total_cogs_cents bigint not null default 0,
  journal_entry_id uuid references journal_entries (id),
  reversal_entry_id uuid references journal_entries (id),
  notes         text,
  created_by    uuid references app_users (id),
  created_at    timestamptz not null default now()
);
-- at most one posted COGS batch per period; drafts and reversals may coexist
create unique index cogs_batch_posted_idx on cogs_batches (period_year, period_month)
  where status = 'posted';

create table cogs_batch_lines (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references cogs_batches (id) on delete cascade,
  product_id    uuid not null references products (id),
  channel_id    uuid references channels (id),
  units         numeric(14,2) not null default 0,
  unit_cost_cents bigint not null default 0,
  cogs_cents    bigint not null default 0,
  -- split of the landed cost so the P&L can show tolling vs ingredients vs freight-in
  breakdown     jsonb not null default '{}'::jsonb,
  unique (batch_id, product_id, channel_id)
);
create index cogs_lines_product_idx on cogs_batch_lines (product_id);

-- ---------------------------------------------------------------------------
-- Write-offs, samples, spoilage and count variances
-- ---------------------------------------------------------------------------
create table inventory_adjustments (
  id            uuid primary key default gen_random_uuid(),
  adjustment_no text not null unique,
  adjustment_date date not null,
  product_id    uuid not null references products (id),
  reason        inventory_adjustment_reason not null,
  quantity      numeric(14,2) not null,             -- negative reduces inventory
  unit_cost_cents bigint not null default 0,
  value_cents   bigint not null,
  expense_account_id uuid references accounts (id),
  channel_id    uuid references channels (id),
  memo          text,
  journal_entry_id uuid references journal_entries (id),
  created_by    uuid references app_users (id),
  created_at    timestamptz not null default now()
);
create index inventory_adjustments_date_idx on inventory_adjustments (adjustment_date);

-- ---------------------------------------------------------------------------
-- Tie-out: what Peasy says inventory is worth vs what the ledger says.
-- A variance here is the single most useful inventory control in the system.
-- ---------------------------------------------------------------------------
create table inventory_tieouts (
  id            uuid primary key default gen_random_uuid(),
  as_of_date    date not null,
  snapshot_value_cents bigint not null,
  ledger_value_cents   bigint not null,
  variance_cents bigint not null,
  explanation   text,
  adjustment_entry_id uuid references journal_entries (id),
  resolved      boolean not null default false,
  created_by    uuid references app_users (id),
  created_at    timestamptz not null default now(),
  unique (as_of_date)
);

-- Gross margin by SKU and channel, straight from the ledger dimensions.
create view margin_by_product_channel as
  select l.product_id, p.sku, p.name as product_name,
         l.channel_id, ch.code as channel_code,
         date_trunc('month', e.entry_date)::date as period,
         sum(case when a.type = 'revenue' then l.credit_cents - l.debit_cents else 0 end) as net_sales_cents,
         sum(case when a.subtype = 'cogs' then l.debit_cents - l.credit_cents else 0 end) as cogs_cents
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    join accounts a on a.id = l.account_id
    left join products p on p.id = l.product_id
    left join channels ch on ch.id = l.channel_id
   where a.type = 'revenue' or a.subtype = 'cogs'
   group by l.product_id, p.sku, p.name, l.channel_id, ch.code, date_trunc('month', e.entry_date);

select attach_audit('production_runs');
select attach_audit('landed_costs');
select attach_audit('product_costs');
select attach_audit('inventory_imports');
select attach_audit('inventory_snapshots');
select attach_audit('shipment_imports');
select attach_audit('shipment_units');
select attach_audit('cogs_batches');
select attach_audit('cogs_batch_lines');
select attach_audit('inventory_adjustments');
select attach_audit('inventory_tieouts');

alter table production_runs       enable row level security;
alter table landed_costs          enable row level security;
alter table product_costs         enable row level security;
alter table inventory_imports     enable row level security;
alter table inventory_snapshots   enable row level security;
alter table shipment_imports      enable row level security;
alter table shipment_units        enable row level security;
alter table cogs_batches          enable row level security;
alter table cogs_batch_lines      enable row level security;
alter table inventory_adjustments enable row level security;
alter table inventory_tieouts     enable row level security;

grant all privileges on all tables in schema public to sooz_app;
grant all privileges on all sequences in schema public to sooz_app;

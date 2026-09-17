-- Sooz Books — budgeting, cash forecasting, period close, attachments
-- and recurring journal entries.

create type close_task_status as enum ('pending', 'in_progress', 'done', 'skipped', 'blocked');
create type forecast_direction as enum ('inflow', 'outflow');

-- ---------------------------------------------------------------------------
-- Budget
-- ---------------------------------------------------------------------------
create table budget_versions (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  fiscal_year  int not null,
  status       text not null default 'draft',      -- draft | active | archived
  notes        text,
  created_by   uuid references app_users (id),
  created_at   timestamptz not null default now(),
  unique (name, fiscal_year)
);
-- exactly one active version per year
create unique index budget_active_idx on budget_versions (fiscal_year) where status = 'active';

create table budget_lines (
  id           uuid primary key default gen_random_uuid(),
  version_id   uuid not null references budget_versions (id) on delete cascade,
  account_id   uuid not null references accounts (id),
  channel_id   uuid references channels (id),
  year         int not null,
  month        int not null check (month between 1 and 12),
  amount_cents bigint not null default 0,
  notes        text,
  unique (version_id, account_id, channel_id, year, month)
);
create index budget_lines_period_idx on budget_lines (version_id, year, month);

-- ---------------------------------------------------------------------------
-- 13-week cash forecast. Open AR and AP are computed live from the sub-ledgers;
-- these rows hold everything the ledger cannot know: payroll, rent, an inventory
-- buy that has not been ordered yet, an expected investment.
-- ---------------------------------------------------------------------------
create table forecast_items (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,
  category     text not null,                       -- payroll | rent | inventory | marketing | tax | financing | other
  direction    forecast_direction not null,
  amount_cents bigint not null check (amount_cents > 0),
  expected_date date not null,
  -- 'none' means a one-off; otherwise the item repeats until end_date
  recurrence   text not null default 'none',        -- none | weekly | biweekly | semimonthly | monthly | quarterly
  end_date     date,
  bank_account_id uuid references bank_accounts (id),
  confidence   numeric(4,3) not null default 1.0,
  active       boolean not null default true,
  notes        text,
  created_by   uuid references app_users (id),
  created_at   timestamptz not null default now()
);
create index forecast_items_date_idx on forecast_items (expected_date) where active;

-- Snapshots of a forecast as it stood, so last month's projection can be scored
-- against what actually happened.
create table forecast_snapshots (
  id           uuid primary key default gen_random_uuid(),
  as_of_date   date not null unique,
  weeks        jsonb not null,                      -- [{weekStart, opening, inflow, outflow, closing}]
  created_by   uuid references app_users (id),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Period close checklist
-- ---------------------------------------------------------------------------
create table close_checklists (
  id           uuid primary key default gen_random_uuid(),
  year         int not null,
  month        int not null check (month between 1 and 12),
  status       text not null default 'open',        -- open | in_progress | complete
  started_at   timestamptz,
  completed_at timestamptz,
  completed_by uuid references app_users (id),
  notes        text,
  created_at   timestamptz not null default now(),
  unique (year, month)
);

create table close_tasks (
  id           uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references close_checklists (id) on delete cascade,
  key          text not null,                       -- stable identifier, e.g. 'bank_recs_complete'
  label        text not null,
  description  text,
  sort_order   int not null default 0,
  -- a blocking task must be done (or explicitly skipped with a reason) before the period locks
  blocking     boolean not null default true,
  -- when set, the task is evaluated automatically rather than ticked by hand
  auto_check   text,                                -- e.g. 'no_draft_entries' | 'clearing_zero' | 'ar_ties'
  status       close_task_status not null default 'pending',
  result       jsonb,                               -- what the automatic check found
  completed_by uuid references app_users (id),
  completed_at timestamptz,
  notes        text,
  unique (checklist_id, key)
);

-- ---------------------------------------------------------------------------
-- Recurring journal entries (rent, depreciation, amortised prepaid, accruals)
-- ---------------------------------------------------------------------------
create table recurring_entries (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  frequency    text not null,                       -- monthly | quarterly | annually | weekly
  day_of_month int,
  start_date   date not null,
  end_date     date,
  next_date    date not null,
  memo         text,
  -- the entry shape: [{accountCode, debitCents, creditCents, memo, channelCode, ...}]
  template     jsonb not null,
  auto_post    boolean not null default false,
  active       boolean not null default true,
  last_posted_date date,
  created_by   uuid references app_users (id),
  created_at   timestamptz not null default now()
);
create index recurring_next_idx on recurring_entries (next_date) where active;

-- ---------------------------------------------------------------------------
-- Attachments: receipts, vendor invoices, statements, remittance PDFs.
-- Files live in Supabase Storage; this is the index.
-- ---------------------------------------------------------------------------
create table attachments (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,                       -- journal_entry | bill | invoice | bank_transaction | deduction | ...
  entity_id    uuid not null,
  filename     text not null,
  storage_path text not null,
  mime_type    text,
  size_bytes   bigint,
  sha256       text,
  uploaded_by  uuid references app_users (id),
  uploaded_at  timestamptz not null default now()
);
create index attachments_entity_idx on attachments (entity_type, entity_id);
create index attachments_sha_idx on attachments (sha256);

-- No QuickBooks migration tables: Sooz's books begin with the January 2026 Relay
-- statements, so opening balances come from the first statement's derived opening
-- balance rather than from an imported history. See docs/formats/quickbooks-migration.md
-- if that ever changes.

select attach_audit('budget_versions');
select attach_audit('budget_lines');
select attach_audit('forecast_items');
select attach_audit('close_checklists');
select attach_audit('close_tasks');
select attach_audit('recurring_entries');
select attach_audit('attachments');

alter table budget_versions    enable row level security;
alter table budget_lines       enable row level security;
alter table forecast_items     enable row level security;
alter table forecast_snapshots enable row level security;
alter table close_checklists   enable row level security;
alter table close_tasks        enable row level security;
alter table recurring_entries  enable row level security;
alter table attachments        enable row level security;

grant all privileges on all tables in schema public to sooz_app;
grant all privileges on all sequences in schema public to sooz_app;

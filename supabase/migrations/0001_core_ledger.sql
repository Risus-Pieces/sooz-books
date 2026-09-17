-- Sooz Books — core ledger
-- Double-entry general ledger with invariants enforced in the database.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type account_type as enum ('asset', 'liability', 'equity', 'revenue', 'expense');
create type je_status   as enum ('draft', 'posted');
create type period_status as enum ('open', 'closed');
create type app_role    as enum ('owner', 'bookkeeper', 'approver', 'viewer');

-- ---------------------------------------------------------------------------
-- Users / roles
-- ---------------------------------------------------------------------------
create table app_users (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  role        app_role not null default 'viewer',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Resolve the acting user: the app sets `app.user_id` inside its transaction;
-- otherwise fall back to the Supabase JWT subject.
create or replace function acting_user_id() returns uuid
language plpgsql stable as $$
declare v text;
begin
  v := current_setting('app.user_id', true);
  if v is null or v = '' then
    begin
      return auth.uid();
    exception when others then
      return null;
    end;
  end if;
  return v::uuid;
end $$;

-- ---------------------------------------------------------------------------
-- Dimensions
-- ---------------------------------------------------------------------------
create table channels (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,          -- DTC, AMAZON, DISTRIBUTOR, WHOLESALE, FOODSERVICE
  name       text not null,
  active     boolean not null default true,
  sort_order int not null default 0
);

create table products (
  id            uuid primary key default gen_random_uuid(),
  sku           text not null unique,
  name          text not null,
  unit          text not null default 'each',
  units_per_case int,
  active        boolean not null default true,
  peasy_id      text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
create table accounts (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name         text not null,
  type         account_type not null,
  subtype      text,                        -- e.g. bank, accounts_receivable, inventory, cogs
  parent_id    uuid references accounts (id),
  description  text,
  is_bank      boolean not null default false,
  is_control   boolean not null default false,  -- AR / AP control accounts: only sub-ledgers post here
  clearing_for_channel_id uuid references channels (id),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index accounts_type_idx on accounts (type);
create index accounts_parent_idx on accounts (parent_id);

-- Accounts that have ever been posted to cannot be deleted; enforced by FK from journal_lines.

-- ---------------------------------------------------------------------------
-- Accounting periods
-- ---------------------------------------------------------------------------
create table periods (
  id         uuid primary key default gen_random_uuid(),
  year       int not null,
  month      int not null check (month between 1 and 12),
  status     period_status not null default 'open',
  closed_at  timestamptz,
  closed_by  uuid references app_users (id),
  unique (year, month)
);

create or replace function period_is_open(d date) returns boolean
language sql stable as $$
  select coalesce(
    (select p.status = 'open' from periods p
      where p.year = extract(year from d)::int
        and p.month = extract(month from d)::int),
    true)   -- a period that has never been created is open
$$;

-- ---------------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------------
create sequence journal_entry_number_seq;

create table journal_entries (
  id           uuid primary key default gen_random_uuid(),
  entry_no     bigint not null default nextval('journal_entry_number_seq') unique,
  entry_date   date not null,
  memo         text,
  status       je_status not null default 'draft',
  -- provenance: which module created this entry
  source_type  text not null default 'manual',   -- manual, bank, invoice, receipt, bill, bill_payment,
                                                 -- payout, deduction, cogs, accrual, qbo_migration, reversal
  source_id    uuid,
  reverses_id  uuid references journal_entries (id),
  reversed_by_id uuid references journal_entries (id),
  created_by   uuid references app_users (id),
  created_at   timestamptz not null default now(),
  posted_by    uuid references app_users (id),
  posted_at    timestamptz
);
create index je_date_idx on journal_entries (entry_date);
create index je_status_idx on journal_entries (status);
create index je_source_idx on journal_entries (source_type, source_id);

create table journal_lines (
  id           uuid primary key default gen_random_uuid(),
  entry_id     uuid not null references journal_entries (id) on delete cascade,
  line_no      int not null,
  account_id   uuid not null references accounts (id),
  debit_cents  bigint not null default 0 check (debit_cents  >= 0),
  credit_cents bigint not null default 0 check (credit_cents >= 0),
  memo         text,
  channel_id   uuid references channels (id),
  customer_id  uuid,     -- FK added in the AR/AP migration
  vendor_id    uuid,     -- FK added in the AR/AP migration
  product_id   uuid references products (id),
  constraint one_side_only check (
    (debit_cents > 0 and credit_cents = 0) or
    (credit_cents > 0 and debit_cents = 0) or
    (debit_cents = 0 and credit_cents = 0)
  ),
  unique (entry_id, line_no)
);
create index jl_entry_idx   on journal_lines (entry_id);
create index jl_account_idx on journal_lines (account_id);
create index jl_channel_idx on journal_lines (channel_id);
create index jl_product_idx on journal_lines (product_id);

-- ---------------------------------------------------------------------------
-- Invariant 1: a posted entry balances (deferred to commit)
-- ---------------------------------------------------------------------------
create or replace function check_entry_balanced() returns trigger
language plpgsql as $$
declare
  eid uuid;
  st  je_status;
  d   bigint;
  c   bigint;
  n   int;
begin
  eid := case when tg_table_name = 'journal_entries'
              then coalesce(new.id, old.id)
              else coalesce(new.entry_id, old.entry_id) end;

  select status into st from journal_entries where id = eid;
  if st is null or st <> 'posted' then
    return null;   -- drafts and deleted entries are exempt
  end if;

  select coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0), count(*)
    into d, c, n
    from journal_lines where entry_id = eid;

  if n < 2 then
    raise exception 'journal entry % must have at least two lines to post', eid
      using errcode = 'check_violation';
  end if;
  if d <> c then
    raise exception 'journal entry % is out of balance: debits % <> credits %', eid, d, c
      using errcode = 'check_violation';
  end if;
  if d = 0 then
    raise exception 'journal entry % has no amounts', eid
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger je_balanced
  after insert or update on journal_entries
  deferrable initially deferred
  for each row execute function check_entry_balanced();

create constraint trigger jl_balanced
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function check_entry_balanced();

-- ---------------------------------------------------------------------------
-- Invariant 2: posted entries are immutable
-- ---------------------------------------------------------------------------
create or replace function guard_posted_entry() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      raise exception 'posted journal entry % cannot be deleted; post a reversing entry instead', old.entry_no
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.status = 'posted' then
    -- The only permitted change to a posted entry is linking its reversal.
    if (new.entry_date, new.memo, new.status, new.source_type, new.source_id,
        new.reverses_id, new.entry_no)
       is distinct from
       (old.entry_date, old.memo, old.status, old.source_type, old.source_id,
        old.reverses_id, old.entry_no)
    then
      raise exception 'posted journal entry % is immutable', old.entry_no
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger je_immutable
  before update or delete on journal_entries
  for each row execute function guard_posted_entry();

create or replace function guard_posted_lines() returns trigger
language plpgsql as $$
declare st je_status;
begin
  select status into st from journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
  if st = 'posted' then
    raise exception 'lines of a posted journal entry cannot be changed'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

-- Runs only for statements that touch the line directly. A cascade delete from a
-- draft entry is fine; a posted entry can't be deleted at all (see je_immutable).
create trigger jl_immutable
  before insert or update or delete on journal_lines
  for each row execute function guard_posted_lines();

-- ---------------------------------------------------------------------------
-- Invariant 3: no posting into a closed period
-- ---------------------------------------------------------------------------
create or replace function guard_period_open() returns trigger
language plpgsql as $$
begin
  if new.status = 'posted' and not period_is_open(new.entry_date) then
    raise exception 'period %-% is closed', extract(year from new.entry_date)::int,
                                            extract(month from new.entry_date)::int
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger je_period_open
  before insert or update on journal_entries
  for each row execute function guard_period_open();

-- Stamp who posted and when.
create or replace function stamp_posting() returns trigger
language plpgsql as $$
begin
  if new.status = 'posted' and (tg_op = 'INSERT' or old.status <> 'posted') then
    new.posted_at := now();
    new.posted_by := coalesce(new.posted_by, acting_user_id());
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, acting_user_id());
  end if;
  return new;
end $$;

create trigger je_stamp
  before insert or update on journal_entries
  for each row execute function stamp_posting();

-- ---------------------------------------------------------------------------
-- Invariant 4: audit log on every financial table
-- ---------------------------------------------------------------------------
create table audit_log (
  id         bigserial primary key,
  table_name text not null,
  row_id     text not null,
  op         text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  actor_id   uuid,
  at         timestamptz not null default now(),
  before     jsonb,
  after      jsonb
);
create index audit_row_idx on audit_log (table_name, row_id);
create index audit_at_idx  on audit_log (at desc);

create or replace function write_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare rid text;
begin
  rid := case tg_op when 'DELETE' then (to_jsonb(old) ->> 'id') else (to_jsonb(new) ->> 'id') end;
  insert into audit_log (table_name, row_id, op, actor_id, before, after)
  values (
    tg_table_name, rid, tg_op, acting_user_id(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;

create or replace function attach_audit(tbl regclass) returns void
language plpgsql as $$
begin
  execute format(
    'create trigger %I after insert or update or delete on %s
       for each row execute function write_audit()',
    'audit_' || replace(tbl::text, '.', '_'), tbl);
end $$;

select attach_audit('accounts');
select attach_audit('journal_entries');
select attach_audit('journal_lines');
select attach_audit('periods');
select attach_audit('app_users');
select attach_audit('products');

-- ---------------------------------------------------------------------------
-- Balances helper: signed amount by account normal balance
-- ---------------------------------------------------------------------------
create or replace function account_sign(t account_type) returns int
language sql immutable as $$
  select case when t in ('asset', 'expense') then 1 else -1 end
$$;

-- Running balance per account, posted entries only.
create view account_balances as
  select a.id as account_id, a.code, a.name, a.type,
         coalesce(sum(l.debit_cents), 0) as debit_cents,
         coalesce(sum(l.credit_cents), 0) as credit_cents,
         account_sign(a.type) *
           (coalesce(sum(l.debit_cents), 0) - coalesce(sum(l.credit_cents), 0)) as balance_cents
    from accounts a
    left join journal_lines l on l.account_id = a.id
    left join journal_entries e on e.id = l.entry_id and e.status = 'posted'
   where e.id is not null or l.id is null
   group by a.id, a.code, a.name, a.type;

-- ---------------------------------------------------------------------------
-- Row level security: deny by default. All access is through server code that
-- connects as the service role after checking the caller's app role.
-- ---------------------------------------------------------------------------
alter table app_users       enable row level security;
alter table channels        enable row level security;
alter table products        enable row level security;
alter table accounts        enable row level security;
alter table periods         enable row level security;
alter table journal_entries enable row level security;
alter table journal_lines   enable row level security;
alter table audit_log       enable row level security;

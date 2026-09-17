-- Sooz Books — bank and credit card statement intake, categorization and reconciliation.

create type bank_account_kind as enum ('checking', 'savings', 'credit_card', 'line_of_credit', 'merchant');
create type bank_txn_status   as enum ('unreviewed', 'categorized', 'matched', 'transfer', 'excluded');
create type import_status     as enum ('parsing', 'preview', 'imported', 'failed', 'cancelled');
create type suggestion_source as enum ('rule', 'history', 'ai', 'match');
create type amount_mode       as enum ('signed', 'debit_credit', 'amount_with_type');
create type recon_status      as enum ('in_progress', 'completed', 'abandoned');

-- ---------------------------------------------------------------------------
-- Bank accounts: a GL account plus the real-world details of the statement it produces.
-- ---------------------------------------------------------------------------
create table bank_accounts (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null unique references accounts (id),
  name          text not null,
  institution   text,
  kind          bank_account_kind not null default 'checking',
  mask          text,                                  -- last 4 digits, for matching statements
  -- a credit card's natural balance is a credit; statements show charges as positive.
  -- normalized_sign = -1 means "a positive amount in the file is money leaving the company".
  statement_sign int not null default 1 check (statement_sign in (1, -1)),
  opening_balance_cents bigint not null default 0,
  opening_date  date,
  default_profile_id uuid,                             -- FK added after import_profiles exists
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Import profiles: the saved answer to "what do this bank's columns mean?".
-- Confirmed once by a human on the first import, reused silently afterwards.
-- ---------------------------------------------------------------------------
create table import_profiles (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  bank_account_id uuid references bank_accounts (id) on delete cascade,
  file_type       text not null default 'csv',         -- csv | xlsx
  delimiter       text not null default ',',
  encoding        text not null default 'utf-8',
  skip_rows       int not null default 0,              -- preamble rows before the header
  header_row      int not null default 0,              -- 0-based index after skip_rows
  date_column     text not null,
  date_format     text,                                -- null = auto-detect
  description_columns text[] not null default '{}',    -- concatenated in order when a bank splits it
  counterparty_column text,
  mode            amount_mode not null default 'signed',
  amount_column   text,
  debit_column    text,
  credit_column   text,
  type_column     text,                                -- for amount_with_type
  debit_type_values  text[] not null default '{}',     -- e.g. {DEBIT,WITHDRAWAL,DR}
  credit_type_values text[] not null default '{}',
  balance_column  text,                                -- captured but NEVER treated as an amount
  reference_column text,
  external_id_column text,                             -- a stable bank-provided id when one exists
  invert_sign     boolean not null default false,
  -- rows to drop entirely, e.g. footer totals or pending transactions
  skip_row_rules  jsonb not null default '[]'::jsonb,
  detected_from_filename text,
  times_used      int not null default 0,
  created_by      uuid references app_users (id),
  created_at      timestamptz not null default now(),
  constraint amount_columns_present check (
    (mode = 'signed'           and amount_column is not null) or
    (mode = 'debit_credit'     and debit_column is not null and credit_column is not null) or
    (mode = 'amount_with_type' and amount_column is not null and type_column is not null))
);

alter table bank_accounts
  add constraint bank_accounts_default_profile_fk
  foreign key (default_profile_id) references import_profiles (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Import batches: one uploaded file. The file hash stops the same file landing twice;
-- the per-row fingerprint stops overlapping date ranges duplicating transactions.
-- ---------------------------------------------------------------------------
create table import_batches (
  id              uuid primary key default gen_random_uuid(),
  bank_account_id uuid not null references bank_accounts (id),
  profile_id      uuid references import_profiles (id),
  filename        text not null,
  file_hash       text not null,
  storage_path    text,
  row_count       int not null default 0,
  imported_count  int not null default 0,
  duplicate_count int not null default 0,
  skipped_count   int not null default 0,
  period_start    date,
  period_end      date,
  status          import_status not null default 'preview',
  error           text,
  warnings        jsonb not null default '[]'::jsonb,
  imported_by     uuid references app_users (id),
  created_at      timestamptz not null default now()
);
create unique index import_batches_hash_idx on import_batches (bank_account_id, file_hash)
  where status = 'imported';

-- ---------------------------------------------------------------------------
-- Bank transactions. amount_cents is signed in company terms:
--   positive = money into the company, negative = money out. Always.
-- ---------------------------------------------------------------------------
create table bank_transactions (
  id              uuid primary key default gen_random_uuid(),
  bank_account_id uuid not null references bank_accounts (id),
  import_batch_id uuid references import_batches (id),
  txn_date        date not null,
  post_date       date,
  description     text not null,
  description_normalized text not null,   -- upper-cased, punctuation and trailing ref digits stripped
  counterparty    text,
  amount_cents    bigint not null,
  balance_cents   bigint,
  reference       text,
  external_id     text,
  fingerprint     text not null,
  status          bank_txn_status not null default 'unreviewed',
  journal_entry_id uuid references journal_entries (id),
  -- what this transaction was matched to, when it settles an existing document
  matched_type    text,                   -- invoice | bill | receipt | bill_payment | payout | transfer
  matched_id      uuid,
  transfer_pair_id uuid references bank_transactions (id),
  -- the proposal shown in the review queue before a human approves it
  suggested_account_id uuid references accounts (id),
  suggested_vendor_id  uuid references vendors (id),
  suggested_customer_id uuid references customers (id),
  suggested_channel_id uuid references channels (id),
  suggested_memo   text,
  suggestion_source suggestion_source,
  suggestion_confidence numeric(4,3),
  suggestion_reasoning text,
  rule_id         uuid,                   -- FK added after categorization_rules exists
  reconciliation_id uuid,                 -- FK added after reconciliations exists
  reconciled_at   timestamptz,
  notes           text,
  reviewed_by     uuid references app_users (id),
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  constraint bank_txn_amount_nonzero check (amount_cents <> 0)
);
create unique index bank_txn_fingerprint_idx on bank_transactions (bank_account_id, fingerprint);
create index bank_txn_date_idx on bank_transactions (bank_account_id, txn_date);
create index bank_txn_status_idx on bank_transactions (status) where status = 'unreviewed';
create index bank_txn_desc_idx on bank_transactions using gin (to_tsvector('english', description));
create index bank_txn_amount_idx on bank_transactions (amount_cents);

alter table receipts
  add constraint receipts_bank_txn_fk foreign key (bank_transaction_id) references bank_transactions (id);
alter table bill_payments
  add constraint bill_payments_bank_txn_fk foreign key (bank_transaction_id) references bank_transactions (id);

-- ---------------------------------------------------------------------------
-- Categorization rules. Applied in priority order; the first match wins.
-- ---------------------------------------------------------------------------
create table categorization_rules (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  priority     int not null default 100,
  bank_account_id uuid references bank_accounts (id) on delete cascade,  -- null = every account
  -- ALL conditions must match. Shape: [{"field":"payee|description|reference|type","op":"contains|
  -- starts_with|ends_with|exact|regex|not_contains","value":"..."}]
  -- Real statements need this: "payee contains CHASE COLLEGE **and** reference is ACH Pull" is a
  -- member contribution, while "reference is ACH Pull" alone is not.
  conditions   jsonb not null default '[]'::jsonb,
  amount_min_cents bigint,
  amount_max_cents bigint,
  direction    text not null default 'any',            -- in | out | any
  account_id   uuid references accounts (id),
  vendor_id    uuid references vendors (id),
  customer_id  uuid references customers (id),
  channel_id   uuid references channels (id),
  memo_template text,
  -- when true the rule posts without landing in the review queue; reserved for
  -- high-confidence recurring items the owner has explicitly trusted
  auto_post    boolean not null default false,
  active       boolean not null default true,
  hit_count    int not null default 0,
  last_hit_at  timestamptz,
  created_by   uuid references app_users (id),
  created_at   timestamptz not null default now(),
  constraint rule_has_conditions check (jsonb_typeof(conditions) = 'array' and jsonb_array_length(conditions) > 0)
);
create index rules_priority_idx on categorization_rules (priority) where active;
create index rules_conditions_idx on categorization_rules using gin (conditions);

alter table bank_transactions
  add constraint bank_txn_rule_fk foreign key (rule_id) references categorization_rules (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Reconciliation. A reconciliation only completes when the difference is zero.
-- ---------------------------------------------------------------------------
create table reconciliations (
  id              uuid primary key default gen_random_uuid(),
  bank_account_id uuid not null references bank_accounts (id),
  statement_start_date date not null,
  statement_date  date not null,
  opening_balance_cents bigint not null,
  closing_balance_cents bigint not null,
  cleared_balance_cents bigint not null default 0,
  difference_cents bigint not null default 0,
  status          recon_status not null default 'in_progress',
  notes           text,
  completed_at    timestamptz,
  completed_by    uuid references app_users (id),
  created_by      uuid references app_users (id),
  created_at      timestamptz not null default now(),
  constraint completed_must_tie check (status <> 'completed' or difference_cents = 0)
);
create unique index recon_period_idx on reconciliations (bank_account_id, statement_date)
  where status <> 'abandoned';

create table reconciliation_items (
  id                 uuid primary key default gen_random_uuid(),
  reconciliation_id  uuid not null references reconciliations (id) on delete cascade,
  bank_transaction_id uuid references bank_transactions (id),
  journal_line_id    uuid references journal_lines (id),
  amount_cents       bigint not null,
  cleared            boolean not null default true,
  unique (reconciliation_id, bank_transaction_id),
  constraint recon_item_target check (bank_transaction_id is not null or journal_line_id is not null)
);

alter table bank_transactions
  add constraint bank_txn_recon_fk foreign key (reconciliation_id) references reconciliations (id) on delete set null;

-- A reconciled transaction is locked: it cannot change status or lose its entry.
create or replace function guard_reconciled_txn() returns trigger
language plpgsql as $$
begin
  if old.reconciliation_id is not null and old.reconciled_at is not null then
    if (new.amount_cents, new.txn_date, new.journal_entry_id, new.status)
       is distinct from
       (old.amount_cents, old.txn_date, old.journal_entry_id, old.status)
       and new.reconciliation_id is not null
    then
      raise exception 'bank transaction % is reconciled and cannot be changed; undo the reconciliation first', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger bank_txn_reconciled_guard
  before update on bank_transactions
  for each row execute function guard_reconciled_txn();

-- ---------------------------------------------------------------------------
-- Description normalisation and fingerprinting, in the database so that the
-- importer and any later backfill always agree on the same key.
-- ---------------------------------------------------------------------------
create or replace function normalize_description(d text) returns text
language sql immutable as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(upper(coalesce(d, '')), '[^A-Z0-9 ]', ' ', 'g'),
             '\s+', ' ', 'g'),
           '^\s+|\s+$', '', 'g')
$$;

create or replace function bank_txn_fingerprint(
  p_bank_account uuid, p_date date, p_amount bigint, p_description text,
  p_external_id text, p_occurrence int) returns text
language sql immutable as $$
  select case
    when p_external_id is not null and p_external_id <> ''
      then 'x:' || p_external_id
    else encode(sha256(convert_to(
           p_bank_account::text || '|' || p_date::text || '|' || p_amount::text || '|' ||
           normalize_description(p_description) || '|' || p_occurrence::text, 'utf8')), 'hex')
  end
$$;

select attach_audit('bank_accounts');
select attach_audit('import_profiles');
select attach_audit('import_batches');
select attach_audit('bank_transactions');
select attach_audit('categorization_rules');
select attach_audit('reconciliations');
select attach_audit('reconciliation_items');

alter table bank_accounts        enable row level security;
alter table import_profiles      enable row level security;
alter table import_batches       enable row level security;
alter table bank_transactions    enable row level security;
alter table categorization_rules enable row level security;
alter table reconciliations      enable row level security;
alter table reconciliation_items enable row level security;

grant all privileges on all tables in schema public to sooz_app;
grant all privileges on all sequences in schema public to sooz_app;

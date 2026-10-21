-- Bank feeds (Plaid) and scoped API keys.
--
-- A Plaid item is one sign-in to one bank (Relay) made by an owner through Plaid Link. Its access
-- token is stored only encrypted (AES-256-GCM, key in the PLAID_TOKEN_KEY environment variable),
-- never in plain text. Each of the item's accounts is mapped to one of our bank accounts and syncs
-- from `sync_from`, the day after the last transaction the books already held for it, so the CSV
-- history and the feed can never overlap.
--
-- An API key lets an unattended agent act for the person who made it, limited to `scopes`. Only the
-- sha256 of the token is stored; the token is shown once.
--
-- Ownership: apply as `sooz_app` through `psql "$DATABASE_URL"`, like every table migration.

create table plaid_items (
  id                uuid primary key default gen_random_uuid(),
  item_id           text not null unique,
  institution_name  text,
  access_token_enc  text not null,
  cursor            text,
  status            text not null default 'active' check (status in ('active', 'disconnected')),
  last_synced_at    timestamptz,
  last_error        text,
  created_by        uuid not null references app_users (id),
  created_at        timestamptz not null default now(),
  disconnected_at   timestamptz
);

create table plaid_accounts (
  id                uuid primary key default gen_random_uuid(),
  plaid_item_id     uuid not null references plaid_items (id) on delete cascade,
  plaid_account_id  text not null unique,
  -- Null until an owner maps it; an unmapped account never syncs.
  bank_account_id   uuid unique references bank_accounts (id),
  name              text not null,
  mask              text,
  sync_from         date,
  created_at        timestamptz not null default now(),
  constraint plaid_accounts_mapped_has_start check (bank_account_id is null or sync_from is not null)
);

create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) > 0),
  -- Whose role the key acts under, intersected with its scopes.
  user_id       uuid not null references app_users (id),
  token_hash    text not null unique,
  prefix        text not null,
  scopes        text[] not null,
  created_by    uuid not null references app_users (id),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

select attach_audit('plaid_accounts');

-- The sync cursor, last-sync time and a key's last-used time change every night or every call.
-- Those are statistics, not events (the 0043 rule), so only the other columns are audited.
create trigger audit_plaid_items
  after insert or delete on plaid_items
  for each row execute function write_audit();
create trigger audit_plaid_items_update
  after update on plaid_items
  for each row
  when ((to_jsonb(old) - 'cursor' - 'last_synced_at' - 'last_error') is distinct from
        (to_jsonb(new) - 'cursor' - 'last_synced_at' - 'last_error'))
  execute function write_audit();

create trigger audit_api_keys
  after insert or delete on api_keys
  for each row execute function write_audit();
create trigger audit_api_keys_update
  after update on api_keys
  for each row
  when ((to_jsonb(old) - 'last_used_at') is distinct from (to_jsonb(new) - 'last_used_at'))
  execute function write_audit();

alter table plaid_items enable row level security;
alter table plaid_accounts enable row level security;
alter table api_keys enable row level security;

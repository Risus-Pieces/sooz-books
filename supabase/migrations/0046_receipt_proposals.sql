-- Receipt proposals.
--
-- A member who pays for something on a personal card has no Relay statement line for it, so the
-- receipt is the only evidence. The receipt assistant reads a receipt into a proposed journal
-- entry; this table holds that proposal until a person posts or skips it.
--
-- A proposal is not a ledger entry and moves no money. `entry_id` is set only when the entry
-- posts, in the same transaction, which is what the check constraint below enforces.
--
-- Ownership: apply this as `sooz_app`, through `psql "$DATABASE_URL"`, like every other table
-- migration, so that `sooz_app` OWNS the table. An owner bypasses row-level security. The table has
-- RLS enabled and no policies, which is correct only under that ownership: applied as any other
-- role, the app's queries would see no rows at all. (Contrast 0047, the storage bucket, which
-- cannot be applied as `sooz_app` and needs an elevated role.)

create table receipt_proposals (
  id            uuid primary key default gen_random_uuid(),
  -- One proposal per stored file. The stored file's own hash is what stops the same receipt
  -- being filed twice.
  attachment_id uuid not null unique references attachments (id),
  uploaded_by   uuid not null references app_users (id),
  -- The member whose contributions account is credited. Null until chosen.
  payer_id      uuid references app_users (id),
  status        text not null default 'proposed'
                  check (status in ('proposed', 'posted', 'skipped')),
  vendor_id     uuid references vendors (id),
  -- What the receipt said, kept when no vendor matched so one can be created on posting.
  vendor_name   text,
  receipt_date  date,
  total_cents   bigint,
  -- The parsed extraction and the model's failure text, for the audit trail and for retries.
  extracted     jsonb,
  error         text,
  -- The debits the entry will carry: [{ description, cents, accountId }].
  lines         jsonb not null default '[]'::jsonb,
  warnings      jsonb not null default '[]'::jsonb,
  entry_id      uuid references journal_entries (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint receipt_proposals_posted_has_entry
    check ((status = 'posted') = (entry_id is not null))
);

create index receipt_proposals_status_idx on receipt_proposals (status, created_at);
create index receipt_proposals_dup_idx on receipt_proposals (receipt_date, total_cents) where status = 'posted';

select attach_audit('receipt_proposals');

alter table receipt_proposals enable row level security;

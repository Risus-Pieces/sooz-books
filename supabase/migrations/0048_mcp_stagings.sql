-- Proposals made through the MCP connector.
--
-- When Claude is connected to Sooz Books it cannot change the books in one step. It first stages a
-- change: the server validates it exactly as posting would, stores what it would do here, and
-- returns a preview for the person to read. Only `commit_staged` with that stage's id posts it, and
-- only the exact payload stored here. A stage is single use (`committed_at`), expires after a short
-- while, and belongs to the person who staged it.
--
-- A staging is not a ledger entry and moves no money.
--
-- Ownership: apply as `sooz_app` through `psql "$DATABASE_URL"`, like every table migration, so
-- that `sooz_app` owns the table. RLS is enabled with no policies, which is correct only under that
-- ownership (an owner bypasses row-level security). See 0046 for the same note.

create table mcp_stagings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_users (id),
  -- The OAuth client that made the connection (Claude's connector), from the access token.
  client_id    text,
  kind         text not null
                 check (kind in ('bank_decisions', 'journal_entry', 'new_account')),
  -- Exactly what commit will do. Account references are already resolved to ids.
  payload      jsonb not null,
  -- What the person was shown.
  preview      jsonb not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  committed_at timestamptz,
  -- What happened on commit: entry numbers, or the per-item failures.
  result       jsonb,
  constraint mcp_stagings_result_needs_commit check ((committed_at is null) = (result is null))
);

create index mcp_stagings_user_idx on mcp_stagings (user_id, created_at desc);

alter table mcp_stagings enable row level security;

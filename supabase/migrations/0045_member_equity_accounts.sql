-- Each member's own capital accounts.
--
-- Sooz has two members. Until now every dollar either of them put in landed in one account,
-- 3015 Member Contributions, so the books could say how much founder money was in the company
-- but not whose it was. An LLC's members each have their own capital balance, and at some point
-- that balance decides who is owed what — it cannot be a single pooled number.
--
-- Rather than hard-code a second set of account codes into the chart, each member points at the
-- two accounts that belong to them. A member with no accounts set falls back to 3015 and 3020,
-- which is what a single-member set of books wants and what the test fixtures rely on.
--
-- The accounts themselves are ordinary rows in `accounts`, created like any other: nested under
-- 3015 and 3020, which then become rollups and stop accepting postings of their own.

alter table app_users
  add column contributions_account_id uuid references accounts (id),
  add column draws_account_id uuid references accounts (id);

comment on column app_users.contributions_account_id is
  'Equity account credited when this member puts money into the company. Null falls back to 3015.';
comment on column app_users.draws_account_id is
  'Contra-equity account debited when this member takes money out. Null falls back to 3020.';

-- Sooz Books — one budget line per (version, account, channel, year, month).
--
-- 0010 declared the key with a plain UNIQUE, under which NULLs are distinct, so an
-- account budgeted with no channel could carry any number of rows for the same month
-- and an upsert on the key never fires for them. A budget cell is one number; NULLS
-- NOT DISTINCT makes the no-channel cell a single cell too.

alter table budget_lines
  drop constraint budget_lines_version_id_account_id_channel_id_year_month_key;

alter table budget_lines
  add constraint budget_lines_version_id_account_id_channel_id_year_month_key
  unique nulls not distinct (version_id, account_id, channel_id, year, month);

alter table budget_versions
  add constraint budget_versions_status_check
  check (status in ('draft', 'active', 'archived'));

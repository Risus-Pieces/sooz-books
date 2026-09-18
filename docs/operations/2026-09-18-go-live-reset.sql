-- Sooz Books — one-time clean start before go-live, approved by the owner on 2026-09-18.
--
-- Run once against production as `postgres` (a member of sooz_audit). NOT a migration: it must never replay on a test
-- database. Kept here as the record of exactly what was done to the live books.
--
-- Why: until 2026-09-18 the unit suite ran against the live project. Postgres sequences do not
-- roll back, so test runs advanced the journal-entry numbering to 93,596 (the first real entry
-- was #92,434), and the audit log — append-only by design — accumulated ~49,000 rows about
-- throwaway fixtures, no-op re-seeds and rule hit-counter bumps. The suite now runs against a
-- disposable local database (vitest.global-setup.ts), so this cannot recur.
--
-- What it does, in one transaction:
--   1. Removes the 22 setup entries (the $1,000 opening balance and the 21 auto-post matches),
--      which scripts/post-authorized.ts re-posts as #1-#22 credited to the owner.
--   2. Returns those 21 bank rows to 'categorized' with no entry, exactly the state
--      postAutoPostMatches selects.
--   3. Purges audit rows about subjects that no longer exist, updates that changed nothing,
--      and rule updates that changed only hit_count / last_hit_at.
--   4. Records the reset itself as an audit row.
--   5. Restarts journal numbering at 1.
-- Nothing else changes: all 110 bank transactions, imports, vendors, rules and accounts stay.

begin;

do $$
begin
  if (select count(*) from journal_entries) <> 22 then
    raise exception 'expected exactly the 22 setup entries, found %', (select count(*) from journal_entries);
  end if;
  if exists (select 1 from journal_entries where posted_by is not null or created_by is not null) then
    raise exception 'a setup entry is attributed to a user; this reset only covers system-posted setup entries';
  end if;
  if (select count(*) from bank_transactions where journal_entry_id is not null) <> 21 then
    raise exception 'expected 21 bank rows linked to setup entries';
  end if;
  if exists (select 1 from invoices) or exists (select 1 from bills) or exists (select 1 from receipts)
     or exists (select 1 from bill_payments) or exists (select 1 from reconciliations where status = 'completed') then
    raise exception 'real documents or completed reconciliations exist; refusing to reset';
  end if;
end $$;

create temp table reset_summary as
select (select string_agg(entry_no::text, ',' order by entry_no) from journal_entries) as entry_nos,
       (select count(*) from journal_entries) as entries,
       (select count(*) from journal_lines) as lines,
       (select count(*) from audit_log) as audit_before,
       (select last_value from journal_entry_number_seq) as seq_before;

-- Bypass the immutability guards and the audit triggers for this transaction only.
set local session_replication_role = replica;

-- 0015 revoked DELETE on audit_log from every role, the owner included, so not even the owner
-- can prune it. For this one approved cleanup the owner grants itself DELETE (postgres inherits
-- it through membership), and revokes it again below; the ACL is asserted unchanged before commit.
set local role sooz_audit;
grant delete on audit_log to sooz_audit;
reset role;

update bank_transactions
   set journal_entry_id = null, reviewed_by = null, reviewed_at = null
 where journal_entry_id is not null;

delete from journal_lines;
delete from journal_entries;

-- Audit rows whose subject no longer exists: test fixtures created and cleaned up, and the
-- setup entries removed above.
do $$
declare t text;
begin
  for t in select distinct table_name from audit_log loop
    if to_regclass('public.' || quote_ident(t)) is null then
      delete from audit_log where table_name = t;
    elsif exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t and column_name = 'id') then
      execute format(
        'delete from audit_log a where a.table_name = %L and a.row_id is not null
            and not exists (select 1 from public.%I x where x.id::text = a.row_id)', t, t);
    end if;
  end loop;
end $$;

-- Updates that changed nothing (idempotent re-seeds, re-imports).
delete from audit_log where op = 'UPDATE' and before = after;

-- Rule hit-counter bookkeeping; a real rule edit changes something else and is kept.
delete from audit_log
 where op = 'UPDATE' and table_name = 'categorization_rules'
   and (before - 'hit_count' - 'last_hit_at') = (after - 'hit_count' - 'last_hit_at');

set local role sooz_audit;
revoke delete on audit_log from sooz_audit;
reset role;

do $$
begin
  if (select relacl::text from pg_class where oid = 'public.audit_log'::regclass)
     <> '{sooz_audit=arxtm/sooz_audit,sooz_app=r/sooz_audit}' then
    raise exception 'audit_log ACL was not restored exactly; aborting the reset';
  end if;
end $$;

set local session_replication_role = origin;

insert into audit_log (table_name, row_id, op, actor_id, before, after)
select 'journal_entries', 'go-live-reset', 'DELETE', null,
       jsonb_build_object(
         'event', 'Clean start before go-live, approved by the owner on 2026-09-18',
         'removed_entry_nos', s.entry_nos,
         'removed_entries', s.entries,
         'removed_lines', s.lines,
         'journal_numbering_was', s.seq_before,
         'audit_rows_before', s.audit_before,
         'reason', 'Unit tests had run against the live project, burning journal numbers and filling the audit log with test fixtures; they now run on a disposable local database.',
         'record', 'docs/operations/2026-09-18-go-live-reset.sql'),
       null
  from reset_summary s;

alter sequence journal_entry_number_seq restart with 1;

select s.entries as entries_removed, s.lines as lines_removed, s.audit_before,
       (select count(*) from audit_log) as audit_after,
       (select count(*) from journal_entries) as entries_now,
       (select count(*) from bank_transactions where status = 'categorized' and journal_entry_id is null) as ready_to_repost,
       (select count(*) from bank_transactions where status = 'unreviewed') as still_awaiting_owner
  from reset_summary s;

commit;

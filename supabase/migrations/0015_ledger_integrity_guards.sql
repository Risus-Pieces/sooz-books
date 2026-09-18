-- Sooz Books — closes three ways round the ledger's own invariants.
--
-- 1. A line could leave a posted entry. The posted-line guard and the deferred balance check
--    both looked only at NEW.entry_id, so `update journal_lines set entry_id = <a draft>` on a
--    line of a posted entry passed both: the guard saw a draft, the balance check skipped the
--    draft, and nothing ever looked at the posted entry the line had left. A line now belongs to
--    its entry for life, and the balance check re-judges every entry a statement touched.
--    The posted-entry guard is tightened the same way: it compared a hand-picked list of columns,
--    so a posted entry's posted_by, posted_at, created_by or id could still be rewritten. Now the
--    whole row is frozen, and the one permitted change — linking the reversal — is only accepted
--    once, and only to an entry that really does reverse this one.
--
-- 2. A rollup could be posted to. A rollup (an account other accounts name as their parent) is a
--    report header; its total is the sum of its children, so a balance of its own makes the
--    statement's parent/child sums stop tying. The flip to 'posted' now refuses a line on one.
--    A reversal is the exception: it mirrors an entry that was accepted when its account was
--    still a leaf, and refusing it would leave that entry impossible to correct.
--
-- 3. The audit trail could be rewritten. `audit_log` is owned by sooz_app, the role the
--    application and every script connect as, and that role (and anon, authenticated and
--    service_role) held UPDATE, DELETE and TRUNCATE on it with nothing to stop them. The table is
--    now append-only by trigger, and those privileges are revoked, so a stray statement from a
--    bug, a script or a compromised code path is refused twice over. What this migration cannot
--    do from sooz_app is take the table away from its owner; 0016 does that and has to be run as
--    `postgres`.

-- ---------------------------------------------------------------------------
-- 1. Lines stay with their entry; posted entries are frozen whole
-- ---------------------------------------------------------------------------
create or replace function guard_posted_lines() returns trigger
language plpgsql as $$
declare st je_status;
begin
  if tg_op = 'UPDATE' and new.entry_id is distinct from old.entry_id then
    raise exception 'a journal line cannot be moved to another entry'
      using errcode = 'check_violation';
  end if;

  -- With entry_id fixed, OLD and NEW name the same entry on an UPDATE.
  if tg_op = 'DELETE' then
    select status into st from journal_entries where id = old.entry_id;
  else
    select status into st from journal_entries where id = new.entry_id;
  end if;
  if st = 'posted' then
    raise exception 'lines of a posted journal entry cannot be changed'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

-- Belt and braces behind the guard above: whatever a statement did to a line, every entry it
-- touched is judged again at COMMIT, the one it left as well as the one it joined.
create or replace function check_line_balanced() returns trigger
language plpgsql as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform assert_entry_balanced(old.entry_id);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.entry_id is distinct from old.entry_id) then
    perform assert_entry_balanced(new.entry_id);
  end if;
  return null;
end $$;

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
    if (to_jsonb(new) - 'reversed_by_id') is distinct from (to_jsonb(old) - 'reversed_by_id') then
      raise exception 'posted journal entry % is immutable', old.entry_no
        using errcode = 'check_violation';
    end if;

    if new.reversed_by_id is distinct from old.reversed_by_id then
      if old.reversed_by_id is not null then
        raise exception 'posted journal entry % is already linked to its reversal', old.entry_no
          using errcode = 'check_violation';
      end if;
      if not exists (
        select 1 from journal_entries r
         where r.id = new.reversed_by_id
           and r.reverses_id = old.id
      ) then
        raise exception 'posted journal entry % can only be linked to an entry that reverses it', old.entry_no
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Nothing posts to a rollup
-- ---------------------------------------------------------------------------
create or replace function guard_rollup_postings() returns trigger
language plpgsql as $$
declare bad record;
begin
  if new.status <> 'posted' or (tg_op = 'UPDATE' and old.status = 'posted') then
    return new;
  end if;

  -- Lines are in place by now: the only legal sequence inserts them while the entry is a draft,
  -- and a posted entry refuses new ones.
  select a.code, a.name into bad
    from journal_lines l
    join accounts a on a.id = l.account_id
   where l.entry_id = new.id
     and l.account_id in (select c.parent_id from accounts c where c.parent_id is not null)
     and not (
       new.reverses_id is not null
       and exists (
         select 1 from journal_lines o
          where o.entry_id = new.reverses_id
            and o.account_id = l.account_id
       )
     )
   order by l.line_no
   limit 1;

  if found then
    raise exception 'account % % is a rollup; post to one of the accounts under it', bad.code, bad.name
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists je_postable_accounts on journal_entries;
create trigger je_postable_accounts
  before insert or update on journal_entries
  for each row execute function guard_rollup_postings();

-- ---------------------------------------------------------------------------
-- 3. audit_log is append-only
-- ---------------------------------------------------------------------------
create or replace function guard_audit_log() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists audit_log_append_only on audit_log;
create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function guard_audit_log();

drop trigger if exists audit_log_no_truncate on audit_log;
create trigger audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function guard_audit_log();

-- write_audit() is SECURITY DEFINER, so the audit triggers keep inserting whoever fires them;
-- nobody needs to write to this table directly.
revoke update, delete, truncate on audit_log from public, anon, authenticated, service_role, sooz_app;
revoke insert, references, trigger on audit_log from public, anon, authenticated, service_role;

-- plpgsql resolves record fields at runtime per statement, so a CASE expression naming
-- new.entry_id fails when the trigger fires on journal_entries, where that field does not
-- exist. Split the balance check into one shared assertion plus thin per-table triggers,
-- and stop dereferencing `new` on DELETE in the posted-line guard.

create or replace function assert_entry_balanced(eid uuid) returns void
language plpgsql as $$
declare st je_status; d bigint; c bigint; n int;
begin
  if eid is null then return; end if;
  select status into st from journal_entries where id = eid;
  if st is null or st <> 'posted' then return; end if;

  select coalesce(sum(debit_cents),0), coalesce(sum(credit_cents),0), count(*)
    into d, c, n from journal_lines where entry_id = eid;

  if n < 2 then
    raise exception 'journal entry % must have at least two lines to post', eid using errcode = 'check_violation';
  end if;
  if d <> c then
    raise exception 'journal entry % is out of balance: debits % <> credits %', eid, d, c using errcode = 'check_violation';
  end if;
  if d = 0 then
    raise exception 'journal entry % has no amounts', eid using errcode = 'check_violation';
  end if;
end $$;

create or replace function check_entry_balanced() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform assert_entry_balanced(old.id);
  else
    perform assert_entry_balanced(new.id);
  end if;
  return null;
end $$;

create or replace function check_line_balanced() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform assert_entry_balanced(old.entry_id);
  else
    perform assert_entry_balanced(new.entry_id);
  end if;
  return null;
end $$;

drop trigger if exists jl_balanced on journal_lines;
create constraint trigger jl_balanced
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function check_line_balanced();

create or replace function guard_posted_lines() returns trigger
language plpgsql as $$
declare st je_status; eid uuid;
begin
  if tg_op = 'DELETE' then eid := old.entry_id; else eid := new.entry_id; end if;
  select status into st from journal_entries where id = eid;
  if st = 'posted' then
    raise exception 'lines of a posted journal entry cannot be changed'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

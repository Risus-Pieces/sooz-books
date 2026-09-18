-- 0041 — a module's entry is reversed only by that module.
--
-- A bank row points at the entry it posted, a receipt at its receipt entry, a
-- settlement at its settlement entry. Reversing one of those from the ledger
-- screen undid the money while the owning record still said "posted": the bank
-- row stayed in the Posted tab and could never be unposted (its entry was
-- already reversed), a matched invoice stayed paid.
--
-- From here a reversal (a journal entry with reverses_id set) of an entry whose
-- source is not ledger-reversible is refused unless the transaction has named
-- the owning module in app.reversal_owner — which only that module's code does,
-- next to the update of its own record. A reversal of a reversal is judged by
-- the entry at the root of the chain.
--
-- The ledger-reversible list matches LEDGER_REVERSIBLE_SOURCES in
-- src/lib/ledger/ownership.ts.

create or replace function guard_owned_entry_reversal()
returns trigger
language plpgsql
as $$
declare
  v_source   text;
  v_next     uuid;
  v_root     text;
  v_entry_no bigint;
  v_hops     int := 0;
begin
  if new.reverses_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.reverses_id is not distinct from old.reverses_id then
    return new;
  end if;

  select e.source_type, e.reverses_id, e.entry_no
    into v_source, v_next, v_entry_no
    from journal_entries e
   where e.id = new.reverses_id;
  if not found then
    return new;
  end if;

  v_root := v_source;
  while v_root = 'reversal' and v_next is not null and v_hops < 64 loop
    select e.source_type, e.reverses_id into v_root, v_next
      from journal_entries e
     where e.id = v_next;
    exit when not found;
    v_hops := v_hops + 1;
  end loop;

  if v_root in ('manual', 'recurring', 'opening_balance', 'inventory') then
    return new;
  end if;
  if v_source <> 'reversal'
     and coalesce(current_setting('app.reversal_owner', true), '') = v_source then
    return new;
  end if;

  raise exception 'journal entry #% is a % entry; reverse it through the module that owns it', v_entry_no, v_root
    using errcode = 'check_violation';
end $$;

drop trigger if exists je_owned_reversal_guard on journal_entries;
create trigger je_owned_reversal_guard
  before insert or update of reverses_id on journal_entries
  for each row execute function guard_owned_entry_reversal();

-- Keep the audit trail to events that change something.
--
-- Before go-live the audit log held 50,190 rows, and after removing fixtures that no longer
-- existed ~11,500 were still noise of two kinds this migration stops at the source:
--   * updates that changed nothing (idempotent re-seeds, a re-import re-writing a row with the
--     values it already had) — 574 of them;
--   * a categorization rule's hit_count / last_hit_at ticking on every import — 10,984 of them
--     for 37 rules. Those counters are statistics, not configuration; a change to a rule's
--     conditions, target account or auto_post flag is still recorded in full.
-- The audit log stays append-only and owned by sooz_audit; only its writer changes.
--
-- Applied as postgres (write_audit belongs to sooz_audit, which the app role cannot act as).

set role sooz_audit;

create or replace function write_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare rid text;
begin
  -- An update that leaves the row as it was is not an event.
  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then
    return null;
  end if;

  rid := case tg_op when 'DELETE' then (to_jsonb(old) ->> 'id') else (to_jsonb(new) ->> 'id') end;
  insert into audit_log (table_name, row_id, op, actor_id, before, after)
  values (
    tg_table_name, rid, tg_op, acting_user_id(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;

reset role;

drop trigger if exists audit_categorization_rules on categorization_rules;

create trigger audit_categorization_rules
  after insert or delete on categorization_rules
  for each row execute function write_audit();

create trigger audit_categorization_rules_update
  after update on categorization_rules
  for each row
  when ((to_jsonb(old) - 'hit_count' - 'last_hit_at') is distinct from (to_jsonb(new) - 'hit_count' - 'last_hit_at'))
  execute function write_audit();

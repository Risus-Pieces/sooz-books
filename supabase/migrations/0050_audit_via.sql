-- Say how a change was made, not only who made it.
--
-- `actor_id` names the person. Some changes are made for a person by something unattended: the
-- nightly bank sync, or an agent holding one of their scoped API keys. `via` records that, from the
-- transaction setting `app.via` (set by `withActor(..., { via })`), e.g. `cron:bank-sync` or
-- `key:Mo's nightly sync`. Null means the person did it themselves.
--
-- Applied as postgres: audit_log and write_audit belong to sooz_audit (see 0016, 0043).

set role sooz_audit;

alter table audit_log add column via text;

create or replace function write_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare rid text;
begin
  -- An update that leaves the row as it was is not an event.
  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then
    return null;
  end if;

  rid := case tg_op when 'DELETE' then (to_jsonb(old) ->> 'id') else (to_jsonb(new) ->> 'id') end;
  insert into audit_log (table_name, row_id, op, actor_id, via, before, after)
  values (
    tg_table_name, rid, tg_op, acting_user_id(),
    nullif(current_setting('app.via', true), ''),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;

reset role;

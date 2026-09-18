-- Sooz Books — inventory costing: the columns and guards the costing engine
-- (src/lib/inventory/) needs on top of 0009.
--
--  * landed_costs.source_account_id — the account a landed cost is relieved FROM when the
--    run is costed. For a bill line it is the line's own account (ingredients billed to
--    1320, packaging to 1330, tolling to 2160, ...); for material consumed out of stock it is
--    the inventory account the material sat in. Costing posts Dr 1310 / Cr this account.
--  * production_runs.cost_entry_id — the reclassification entry costRun posted.
--  * production_runs.rounding_variance_cents — total landed cost minus unit cost x good units,
--    booked to 5050 at costing so that Finished Goods holds exactly unit cost x units.
--  * inventory_adjustments.inventory_account_id / stage — which inventory account moved.
--  * inventory_tieouts.snapshot_import_id / snapshot_date / by_stage — which Peasy snapshot
--    was compared and the per-stage detail behind the single variance figure.
--
-- Guards:
--  * a landed cost can only be added, changed or removed while its run is 'open';
--  * the landed costs drawn from one bill line can never exceed that bill line (checked at
--    COMMIT, so an allocation that writes several shares in one transaction is judged whole).

alter table landed_costs
  add column source_account_id uuid references accounts (id);

alter table production_runs
  add column cost_entry_id uuid references journal_entries (id),
  add column rounding_variance_cents bigint not null default 0;

alter table production_runs
  add constraint production_runs_status_check check (status in ('open', 'costed', 'closed'));

alter table inventory_adjustments
  add column inventory_account_id uuid references accounts (id),
  add column stage text not null default 'finished'
    check (stage in ('raw', 'packaging', 'wip', 'finished', 'in_transit'));

alter table inventory_tieouts
  add column snapshot_import_id uuid references inventory_imports (id) on delete set null,
  add column snapshot_date date,
  add column by_stage jsonb not null default '[]'::jsonb;

alter table cogs_batches
  add constraint cogs_batches_status_check check (status in ('draft', 'posted', 'reversed'));

-- ---------------------------------------------------------------------------
-- A costed run's landed costs are frozen.
-- ---------------------------------------------------------------------------
create or replace function guard_landed_cost_run() returns trigger
language plpgsql as $$
declare
  v_run uuid;
  v_status text;
begin
  v_run := case when tg_op = 'DELETE' then old.production_run_id else new.production_run_id end;
  select status into v_status from production_runs where id = v_run;
  -- A cascade from a deleted run leaves no parent to consult.
  if v_status is not null and v_status <> 'open' then
    raise exception 'production run % is %; its landed costs are frozen. Reopen the run first.',
      v_run, v_status using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.production_run_id <> new.production_run_id then
    select status into v_status from production_runs where id = old.production_run_id;
    if v_status is not null and v_status <> 'open' then
      raise exception 'production run % is %; its landed costs are frozen.',
        old.production_run_id, v_status using errcode = 'check_violation';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger landed_costs_run_open
  before insert or update or delete on landed_costs
  for each row execute function guard_landed_cost_run();

-- ---------------------------------------------------------------------------
-- One bill line can be spread over several runs, never over-spent.
-- ---------------------------------------------------------------------------
create or replace function check_landed_cost_allocation() returns trigger
language plpgsql as $$
declare
  v_line uuid;
  v_allocated bigint;
  v_amount bigint;
begin
  v_line := case when tg_op = 'DELETE' then old.bill_line_id else new.bill_line_id end;
  if v_line is null then
    return null;
  end if;
  select amount_cents into v_amount from bill_lines where id = v_line;
  select coalesce(sum(amount_cents), 0) into v_allocated from landed_costs where bill_line_id = v_line;
  if v_amount is not null and abs(v_allocated) > abs(v_amount) then
    raise exception 'bill line % is over-allocated: % cents allocated to production runs against a line of % cents',
      v_line, v_allocated, v_amount using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger landed_costs_allocation
  after insert or update on landed_costs
  deferrable initially deferred
  for each row execute function check_landed_cost_allocation();

-- A costed run cannot be deleted out from under the entry and the unit cost it produced.
create or replace function guard_production_run_delete() returns trigger
language plpgsql as $$
begin
  if old.status <> 'open' then
    raise exception 'production run % is %; it cannot be deleted.', old.run_no, old.status
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

create trigger production_runs_no_delete_costed
  before delete on production_runs
  for each row execute function guard_production_run_delete();

-- The unit cost row itself, breakdown included, for a product on a date.
create or replace function product_cost_at(p_product uuid, p_date date)
returns table (unit_cost_cents bigint, breakdown jsonb, effective_date date, production_run_id uuid)
language sql stable as $$
  select pc.unit_cost_cents, pc.breakdown, pc.effective_date, pc.production_run_id
    from product_costs pc
   where pc.product_id = p_product and pc.effective_date <= p_date
   order by pc.effective_date desc
   limit 1
$$;

grant execute on function product_cost_at(uuid, date) to sooz_app;

-- Banking engine: posting reviewed bank transactions and reconciling them.
--
-- 1. A card refund can name the charge it reverses, so approving the refund can default to
--    the charge's account and the pair nets to zero.
-- 2. A general-ledger line is cleared by at most one reconciliation, ever. Abandoning a
--    reconciliation deletes its items, so every item left belongs to an in-progress or a
--    completed reconciliation, and a plain unique index expresses the rule.
-- 3. One reconciliation in progress per bank account at a time.
-- 4. A completed reconciliation is locked: its items cannot change and it cannot be deleted
--    until an owner undoes it (which sets it back to in_progress).
-- 5. An entry whose bank line was cleared by a completed reconciliation cannot be reversed.
--    The existing guard_reconciled_txn trigger keeps the bank row pointing at its entry;
--    this keeps the entry itself from being undone underneath it.

alter table bank_transactions
  add column refund_of_txn_id uuid references bank_transactions(id);

alter table bank_transactions
  add constraint bank_txn_refund_not_self check (refund_of_txn_id is null or refund_of_txn_id <> id);

create index bank_txn_refund_of_idx on bank_transactions (refund_of_txn_id)
  where refund_of_txn_id is not null;

create index bank_txn_journal_entry_idx on bank_transactions (journal_entry_id)
  where journal_entry_id is not null;

create unique index reconciliation_items_journal_line_uidx
  on reconciliation_items (journal_line_id)
  where journal_line_id is not null;

create unique index recon_one_in_progress_idx
  on reconciliations (bank_account_id)
  where status = 'in_progress';

create or replace function guard_completed_reconciliation_items()
returns trigger
language plpgsql
as $$
declare
  recon_id uuid;
begin
  recon_id := case when tg_op = 'DELETE' then old.reconciliation_id else new.reconciliation_id end;
  if exists (select 1 from reconciliations r where r.id = recon_id and r.status = 'completed') then
    raise exception 'reconciliation % is completed and locked; undo it before changing what it cleared', recon_id
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.reconciliation_id is distinct from new.reconciliation_id then
    if exists (select 1 from reconciliations r where r.id = old.reconciliation_id and r.status = 'completed') then
      raise exception 'reconciliation % is completed and locked; undo it before changing what it cleared', old.reconciliation_id
        using errcode = 'check_violation';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger recon_items_completed_guard
  before insert or update or delete on reconciliation_items
  for each row execute function guard_completed_reconciliation_items();

create or replace function guard_completed_reconciliation_delete()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'completed' then
    raise exception 'reconciliation % is completed and cannot be deleted; undo it first', old.id
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

create trigger recon_completed_delete_guard
  before delete on reconciliations
  for each row execute function guard_completed_reconciliation_delete();

create or replace function guard_reversal_of_reconciled()
returns trigger
language plpgsql
as $$
begin
  if new.reverses_id is not null and exists (
    select 1
      from journal_lines jl
      join reconciliation_items ri on ri.journal_line_id = jl.id
      join reconciliations r on r.id = ri.reconciliation_id
     where jl.entry_id = new.reverses_id
       and r.status = 'completed'
  ) then
    raise exception 'journal entry % was cleared by a completed bank reconciliation; undo the reconciliation before reversing it', new.reverses_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger je_reversal_reconciled_guard
  before insert on journal_entries
  for each row execute function guard_reversal_of_reconciled();

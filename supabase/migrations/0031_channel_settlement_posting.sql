-- Sooz Books — posting channel settlements, and the sales tax they carry.
--
-- 0007 created payout_imports / payout_lines / sales_tax_entries / sales_tax_filings. This migration
-- adds the guards that make a posted settlement and a filed return trustworthy. No column changes:
-- src/db/schema mirrors the tables as they stand.
--
-- 1. A payout posts once. One journal entry per settlement, and one settlement per entry.
-- 2. A posted payout is frozen. Its lines, its totals and its clearing account cannot change while
--    its entry stands; the only way back is to reverse the entry, after which the link may be cleared.
-- 3. A filed sales tax entry is frozen. What a return reported cannot be edited or deleted under it.
--    A filing that has been paid (it carries a journal entry) cannot be deleted.

create unique index if not exists payout_journal_entry_uidx
  on payout_imports (journal_entry_id)
  where journal_entry_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Posted payouts are immutable.
-- ---------------------------------------------------------------------------
create or replace function guard_posted_payout()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.journal_entry_id is not null then
      raise exception 'payout % is posted to the ledger (entry %) and cannot be deleted; reverse the entry first',
        old.id, old.journal_entry_id
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.journal_entry_id is null then
    return new;
  end if;

  if new.journal_entry_id is distinct from old.journal_entry_id then
    -- The link may only be cleared once the entry it points at has been reversed.
    if new.journal_entry_id is not null or not exists (
      select 1 from journal_entries r where r.reverses_id = old.journal_entry_id and r.status = 'posted'
    ) then
      raise exception 'payout % is posted to the ledger (entry %); reverse the entry before unlinking it',
        old.id, old.journal_entry_id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.provider             is distinct from old.provider
     or new.channel_id           is distinct from old.channel_id
     or new.external_id          is distinct from old.external_id
     or new.reported_total_cents is distinct from old.reported_total_cents
     or new.computed_total_cents is distinct from old.computed_total_cents
     or new.gross_cents          is distinct from old.gross_cents
     or new.fees_cents           is distinct from old.fees_cents
     or new.net_cents            is distinct from old.net_cents
     or new.clearing_account_id  is distinct from old.clearing_account_id
     or new.period_start         is distinct from old.period_start
     or new.period_end           is distinct from old.period_end then
    raise exception 'payout % is posted to the ledger (entry %); its amounts, dates and accounts are frozen',
      old.id, old.journal_entry_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists payout_posted_guard on payout_imports;
create trigger payout_posted_guard
  before update or delete on payout_imports
  for each row execute function guard_posted_payout();

create or replace function guard_posted_payout_lines()
returns trigger
language plpgsql
as $$
declare
  parent uuid;
begin
  parent := case when tg_op = 'DELETE' then old.payout_import_id else new.payout_import_id end;
  if exists (select 1 from payout_imports p where p.id = parent and p.journal_entry_id is not null) then
    raise exception 'payout % is posted to the ledger; its lines cannot be added, changed or removed', parent
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.payout_import_id is distinct from new.payout_import_id
     and exists (select 1 from payout_imports p where p.id = old.payout_import_id and p.journal_entry_id is not null) then
    raise exception 'payout % is posted to the ledger; its lines cannot be moved', old.payout_import_id
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists payout_lines_posted_guard on payout_lines;
create trigger payout_lines_posted_guard
  before insert or update or delete on payout_lines
  for each row execute function guard_posted_payout_lines();

-- ---------------------------------------------------------------------------
-- 3. Filed sales tax is immutable; a paid filing cannot be deleted.
-- ---------------------------------------------------------------------------
create or replace function guard_filed_sales_tax_entry()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.filing_id is not null then
      raise exception 'sales tax entry % was reported on filing % and cannot be deleted', old.id, old.filing_id
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.filing_id is null then
    return new;
  end if;

  -- Deleting an unpaid filing sets filing_id to null (on delete set null); that is the one change allowed.
  if new.filing_id is null
     and not exists (select 1 from sales_tax_filings f where f.id = old.filing_id) then
    return new;
  end if;

  if new.filing_id    is distinct from old.filing_id
     or new.tax_date     is distinct from old.tax_date
     or new.state        is distinct from old.state
     or new.taxable_cents is distinct from old.taxable_cents
     or new.exempt_cents is distinct from old.exempt_cents
     or new.tax_cents    is distinct from old.tax_cents
     or new.facilitator_remitted is distinct from old.facilitator_remitted
     or new.source_type  is distinct from old.source_type
     or new.source_id    is distinct from old.source_id then
    raise exception 'sales tax entry % was reported on filing % and is frozen', old.id, old.filing_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists sales_tax_entry_filed_guard on sales_tax_entries;
create trigger sales_tax_entry_filed_guard
  before update or delete on sales_tax_entries
  for each row execute function guard_filed_sales_tax_entry();

create or replace function guard_paid_sales_tax_filing()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.journal_entry_id is not null then
      raise exception 'sales tax filing % has been paid (entry %) and cannot be deleted', old.id, old.journal_entry_id
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.journal_entry_id is not null and (
       new.journal_entry_id is distinct from old.journal_entry_id
       or new.state          is distinct from old.state
       or new.period_start   is distinct from old.period_start
       or new.period_end     is distinct from old.period_end
       or new.tax_due_cents  is distinct from old.tax_due_cents
       or new.tax_paid_cents is distinct from old.tax_paid_cents) then
    raise exception 'sales tax filing % has been paid (entry %) and is frozen', old.id, old.journal_entry_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists sales_tax_filing_paid_guard on sales_tax_filings;
create trigger sales_tax_filing_paid_guard
  before update or delete on sales_tax_filings
  for each row execute function guard_paid_sales_tax_filing();

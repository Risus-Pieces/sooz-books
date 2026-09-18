-- Sooz Books — trade engine: the columns the remittance importer and the
-- deduction workbench need on top of 0008_trade.sql.
--
-- Spec: docs/formats/distributor-deductions.md.
--
--  * Reason codes are scoped to the source that issued them. KeHE's `C` (case
--    cuts), UNFI's `01` (shortage) and X12's `01` (pricing error) are different
--    things, so `deduction_reason_codes.code` becomes a namespaced key
--    ('KEHE:C', 'UNFI:01', 'X12:01', 'GEN:MCB') and the verbatim code is kept
--    in `source_code`.
--  * `deduction_treatment` gains the dispositions of §9: charged against an
--    accrual, a billing correction to gross sales, a recovery, and suspense for
--    a code nobody has mapped yet.
--  * A remittance is identified by its payment (§5.2 level 2), not by its file:
--    one export can carry several payments, so the file-hash unique index goes.
--  * `deduction_aging` only lists deductions that still have money open.
--
-- The enum values are added here and first used by 0036, because a value added
-- by ALTER TYPE cannot be used in the transaction that added it.

alter type deduction_treatment add value if not exists 'accrual';
alter type deduction_treatment add value if not exists 'billing_correction';
alter type deduction_treatment add value if not exists 'recovery';
alter type deduction_treatment add value if not exists 'suspense';

-- ---------------------------------------------------------------------------
-- Reason codes
-- ---------------------------------------------------------------------------
alter table deduction_reason_codes
  add column source_system text not null default 'GEN',
  add column source_code text,
  add column is_trade_spend boolean not null default true,
  add constraint deduction_reason_codes_source_check
    check (source_system in ('GEN', 'X12', 'KEHE', 'UNFI', 'DPI'));

create unique index deduction_reason_codes_source_idx
  on deduction_reason_codes (source_system, source_code)
  where source_code is not null;

-- ---------------------------------------------------------------------------
-- Remittances: the payment identity and the entry that booked it
-- ---------------------------------------------------------------------------
drop index if exists remittance_hash_idx;
create index remittance_hash_idx on remittances (customer_id, file_hash) where file_hash is not null;

alter table remittances
  add column source_system text,
  add column payment_number text,
  add column region_dc text,
  add column payment_method text,
  add column advice_number text,
  add column repayments_cents bigint not null default 0,
  add column journal_entry_id uuid references journal_entries (id),
  add constraint remittances_source_check
    check (source_system is null or source_system in ('UNFI', 'KEHE', 'DPI'));

-- §5.2 level 2: (source_system, region_dc_or_null, payment_number).
create unique index remittances_payment_key_idx
  on remittances (source_system, coalesce(region_dc, ''), payment_number)
  where payment_number is not null;

alter table remittance_lines
  add column line_type text not null default 'INVOICE',
  add column document_number text,
  add column source_reason_code text,
  add column deal_number text,
  add column invoice_date date,
  add column source_row_number int,
  add constraint remittance_lines_line_type_check
    check (line_type in ('INVOICE', 'DEDUCTION', 'CREDIT', 'DISCOUNT', 'REPAYMENT', 'UNAPPLIED'));

-- ---------------------------------------------------------------------------
-- Deductions: the verbatim code, the deal, the invoice date, the account
-- ---------------------------------------------------------------------------
alter table deductions
  add column source_reason_code text,
  add column deal_number text,
  add column invoice_date date,
  add column account_id uuid references accounts (id);

-- ---------------------------------------------------------------------------
-- Accruals: one planned accrual per promotion per month, so re-running the
-- month-end accrual is harmless.
-- ---------------------------------------------------------------------------
create unique index trade_accruals_promotion_period_idx
  on trade_accruals (promotion_id, period_year, period_month)
  where promotion_id is not null and basis = 'planned';

-- ---------------------------------------------------------------------------
-- Aging lists only what is still open
-- ---------------------------------------------------------------------------
create or replace view deduction_aging as
  select d.id, d.deduction_no, d.customer_id, c.name as customer_name,
         d.deduction_date, d.reason_code, rc.label as reason_label, rc.category,
         d.amount_cents, d.recovered_cents, d.written_off_cents,
         (d.amount_cents - d.recovered_cents - d.written_off_cents) as open_cents,
         d.status, d.dispute_deadline,
         (current_date - d.deduction_date) as days_outstanding,
         case when d.dispute_deadline is not null
              then (d.dispute_deadline - current_date) end as days_to_deadline
    from deductions d
    join customers c on c.id = d.customer_id
    left join deduction_reason_codes rc on rc.code = d.reason_code
   where d.status in ('open', 'disputed', 'partially_recovered')
     and d.amount_cents - d.recovered_cents - d.written_off_cents > 0;

grant all privileges on all tables in schema public to sooz_app;

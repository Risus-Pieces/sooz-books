-- Sooz Books — AR/AP engine support.
--
-- 1. Document numbering. Invoices, receipts, credit memos, bill payments and vendor
--    credits take their number from a counter row updated inside the transaction that
--    creates the document. The row lock serialises concurrent creators, and a rolled-back
--    transaction rolls its increment back too, so committed numbers are sequential and a
--    number is never issued twice. (A Postgres sequence would leave gaps on rollback and
--    could not be reset by mistake either; the counter gives both properties we want.)
--
-- 2. Over-application guards. The engine refuses to apply more than a document's open
--    balance; these constraints make the database refuse it too, so a second writer that
--    bypasses the engine cannot drive a balance negative.
--
-- 3. The ar_open_items / ap_open_items views computed days_past_due from current_date,
--    which is the database's UTC date: from 6pm or 7pm Houston time it is already
--    tomorrow. They now read "today" on the books' calendar (app_settings.books_time_zone).
--    Point-in-time aging is computed by src/lib/arap/aging.ts with an explicit as-of date.

create table arap_number_series (
  kind       text primary key,
  prefix     text not null,
  next_no    bigint not null check (next_no > 0),
  pad_width  int not null default 4 check (pad_width between 1 and 12),
  updated_at timestamptz not null default now()
);

insert into arap_number_series (kind, prefix, next_no) values
  ('invoice',       'INV-',  1001),
  ('receipt',       'RCPT-', 1001),
  ('credit_memo',   'CM-',   1001),
  ('bill_payment',  'BPMT-', 1001),
  ('vendor_credit', 'VC-',   1001);

select attach_audit('arap_number_series');
alter table arap_number_series enable row level security;

alter table invoices
  add constraint invoice_not_overapplied
  check (total_cents - paid_cents - credited_cents - deducted_cents >= 0);

alter table bills
  add constraint bill_not_overapplied
  check (total_cents - paid_cents - credited_cents >= 0);

alter table receipts
  add constraint receipt_applied_within_amount check (applied_cents between 0 and amount_cents);

alter table credit_memos
  add constraint credit_memo_applied_within_amount check (applied_cents between 0 and amount_cents);

alter table bill_payments
  add constraint bill_payment_applied_within_amount check (applied_cents between 0 and amount_cents);

alter table vendor_credits
  add constraint vendor_credit_applied_within_amount check (applied_cents between 0 and amount_cents);

-- "Today" on the books' calendar, never the server's UTC date.
create or replace function books_today() returns date
language sql stable as $$
  select (now() at time zone coalesce(
            (select s.books_time_zone from app_settings s limit 1),
            'America/Chicago'))::date
$$;

create or replace view ar_open_items as
  select i.id as invoice_id, i.invoice_no, i.customer_id, c.name as customer_name,
         i.channel_id, i.invoice_date, i.due_date, i.total_cents,
         i.paid_cents, i.credited_cents, i.deducted_cents,
         (i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents) as balance_cents,
         (books_today() - i.due_date) as days_past_due
    from invoices i
    join customers c on c.id = i.customer_id
   where i.status in ('open', 'partial')
     and (i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents) <> 0;

create or replace view ap_open_items as
  select b.id as bill_id, b.bill_no, b.vendor_id, v.name as vendor_name,
         b.bill_date, b.due_date, b.total_cents, b.paid_cents, b.credited_cents,
         (b.total_cents - b.paid_cents - b.credited_cents) as balance_cents,
         (books_today() - b.due_date) as days_past_due
    from bills b
    join vendors v on v.id = b.vendor_id
   where b.status in ('open', 'partial')
     and (b.total_cents - b.paid_cents - b.credited_cents) <> 0;

grant all privileges on arap_number_series to sooz_app;
grant execute on function books_today() to sooz_app;

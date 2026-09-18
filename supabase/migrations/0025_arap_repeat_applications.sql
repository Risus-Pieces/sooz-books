-- An application is a dated event, not a pairing. A customer's unapplied payment can settle
-- part of an invoice on the day it arrives and more of the same invoice a month later; a
-- vendor prepayment can be applied to one bill in two steps. Point-in-time aging reads each
-- application at its own date, so the two steps must stay two rows — merging them into one
-- would backdate the second. The unique (document, target) keys from 0005 forbade that.
alter table receipt_applications       drop constraint if exists receipt_applications_receipt_id_invoice_id_key;
alter table credit_memo_applications   drop constraint if exists credit_memo_applications_credit_memo_id_invoice_id_key;
alter table bill_payment_applications  drop constraint if exists bill_payment_applications_payment_id_bill_id_key;
alter table vendor_credit_applications drop constraint if exists vendor_credit_applications_credit_id_bill_id_key;

-- The unique keys doubled as the lookup index from the paying document; keep one.
create index if not exists receipt_apps_receipt_idx        on receipt_applications (receipt_id);
create index if not exists credit_memo_apps_memo_idx       on credit_memo_applications (credit_memo_id);
create index if not exists credit_memo_apps_invoice_idx    on credit_memo_applications (invoice_id);
create index if not exists bill_payment_apps_payment_idx   on bill_payment_applications (payment_id);
create index if not exists vendor_credit_apps_credit_idx   on vendor_credit_applications (credit_id);
create index if not exists vendor_credit_apps_bill_idx     on vendor_credit_applications (bill_id);

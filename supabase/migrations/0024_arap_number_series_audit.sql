-- 0023 attached the audit trigger to arap_number_series, but write_audit() records the row's
-- uuid `id`, and the counter table is keyed by its text `kind`: every increment failed the
-- audit_log.row_id not-null check. The counter needs no audit trail of its own — each number
-- it issues is audited on the invoice, receipt, credit memo, payment or credit that took it.
drop trigger if exists audit_arap_number_series on arap_number_series;

-- Sooz Books — a skipped close task must say why.
--
-- A blocking task that is skipped lets the period lock without the check having
-- passed. That is sometimes right (a clearing account legitimately carrying a payout
-- in transit over month end) but it must never be silent: the reason is the audit
-- trail for the decision.

alter table close_tasks
  add constraint close_tasks_skip_needs_reason
  check (status <> 'skipped' or nullif(btrim(coalesce(notes, '')), '') is not null);

alter table close_checklists
  add constraint close_checklists_status_check
  check (status in ('open', 'in_progress', 'complete'));

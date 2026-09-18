-- Sooz Books — take the audit trail out of the application role's hands.
--
-- RUN AS `postgres` (the Supabase SQL editor or the management API), NOT through DATABASE_URL.
-- sooz_app can neither create a role nor give away a table it owns, which is the point: a
-- trail the application's own role can rewrite is not evidence of anything.
--
-- 0015 made audit_log append-only by trigger and revoked UPDATE, DELETE and TRUNCATE. That
-- stops a stray statement, but sooz_app still owns the table, and an owner can grant itself
-- those privileges back or drop the trigger. Here the table, its id sequence, and the two
-- functions that write and guard it move to sooz_audit, a role nobody can log in as.
-- sooz_app keeps SELECT, which the audit screen and the tests need, and nothing else. The
-- audit triggers on every financial table keep working: write_audit() is SECURITY DEFINER,
-- so it inserts as sooz_audit, the table's owner, whoever fired it.

begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sooz_audit') then
    create role sooz_audit nologin;
  end if;
end $$;

-- ALTER ... OWNER TO requires membership in the new owner; a role's creator holds only ADMIN
-- on it. (postgres is already a member of sooz_app, the current owner.)
grant sooz_audit to postgres;

-- ALTER ... OWNER also requires the new owner to hold CREATE on the table's schema.
-- sooz_audit cannot log in, so this grant cannot be used to create anything.
grant usage, create on schema public to sooz_audit;

alter table audit_log owner to sooz_audit;           -- carries audit_log_id_seq with it
alter function write_audit() owner to sooz_audit;
alter function guard_audit_log() owner to sooz_audit;

-- Ownership moved every existing grant under sooz_audit, so these revokes are the owner's own.
revoke all on audit_log from public, sooz_app, anon, authenticated, service_role;
revoke all on sequence audit_log_id_seq from public, sooz_app, anon, authenticated, service_role;
grant select on audit_log to sooz_app;

commit;

-- Verify, still as postgres:
--   set role sooz_app;
--   delete from audit_log where id = (select max(id) from audit_log);  -- permission denied
--   alter table audit_log disable trigger all;                        -- must be owner
--   reset role;

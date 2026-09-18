-- ---------------------------------------------------------------------------
-- 0013 — private storage for uploaded bank statements
--
-- Every imported file is archived beside its `import_batches` row, and
-- `import_batches.storage_path` points at it. Two reasons, both of which only
-- bite years later:
--
--   * Fingerprint recipes change. Recomputing historical deduplication keys has
--     to be a migration over the archived files, not a request that the owner
--     re-download nine months of statements from a bank portal that retains
--     ninety days.
--   * A committed import must be auditable back to the bytes it came from. The
--     file hash proves a file is unchanged; only the file itself proves what it
--     said.
--
-- The bucket is private. These are a real company's bank statements: a public
-- bucket would put every transaction the business has ever made behind a URL
-- that needs no credential at all.
--
-- This migration touches the `storage` schema, which on Supabase is owned by
-- `supabase_admin`. The application role `sooz_app` has no rights there, so
-- unlike migrations 0001-0012 this one is applied with an elevated role rather
-- than through `psql "$DATABASE_URL"`. It is idempotent either way.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bank-statements',
  'bank-statements',
  false,
  -- 25 MB. The largest real Relay export is 1.4 KB; the ceiling is here to stop
  -- an accidental upload of something that is not a statement at all.
  26214400,
  array[
    'text/csv',
    'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
)
on conflict (id) do update
   set public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- Row level security on storage.objects is already enabled by Supabase. Without
-- a policy the bucket is reachable only by the service role, which is the
-- correct default: the importer writes through a service-role client.
--
-- These four policies additionally let a signed-in user of the application read
-- and write statements, so an upload made from a server action carrying the
-- caller's session works without handing that session the service-role key.
-- Everyone who can sign in to Sooz Books is a bookkeeper for this one company,
-- so the grant is per-bucket rather than per-row.

drop policy if exists "bank statements readable by authenticated" on storage.objects;
create policy "bank statements readable by authenticated"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'bank-statements');

drop policy if exists "bank statements writable by authenticated" on storage.objects;
create policy "bank statements writable by authenticated"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'bank-statements');

drop policy if exists "bank statements updatable by authenticated" on storage.objects;
create policy "bank statements updatable by authenticated"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'bank-statements')
  with check (bucket_id = 'bank-statements');

-- Deliberately no delete policy. A statement that has been imported is evidence
-- for the entries it produced; removing it is an administrative act through the
-- service role, not something the application offers.

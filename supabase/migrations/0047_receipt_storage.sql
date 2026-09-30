-- The private bucket receipts are stored in.
--
-- This migration touches the `storage` schema, which on Supabase is owned by `supabase_admin`.
-- The application role `sooz_app` has no rights there, so, like 0013, this is applied with an
-- elevated role (the Supabase MCP `execute_sql`, or the SQL editor) rather than through
-- `psql "$DATABASE_URL"`. It is idempotent either way.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  -- 10 MB. A phone photo is 1-4 MB; the ceiling stops an accidental video or archive.
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
)
on conflict (id) do update
   set public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- Row level security on storage.objects is already enabled by Supabase. With no policy the
-- bucket is reachable only by the service role, which is the correct default: the upload route
-- writes through a service-role client and the viewer route hands out short-lived signed URLs.

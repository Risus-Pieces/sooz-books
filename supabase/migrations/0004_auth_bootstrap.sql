-- Sooz Books — auth bootstrap
--
-- `app_users.id` is a foreign key onto `auth.users`, so an application row cannot exist
-- before Supabase Auth has created the identity. Everything about who someone is therefore
-- has to be decided at the moment the auth row appears, which is what the trigger below does:
--
--   * the first identity to exist becomes the owner — there is nobody else to grant it;
--   * an identity whose address matches a pending invite takes the role that invite named;
--   * anyone else starts as a viewer and an owner promotes them.
--
-- PRIVILEGES. The public-schema objects are created as `sooz_app`, the role the application
-- connects with, so it owns them outright; the trigger function is SECURITY DEFINER and so
-- runs as `sooz_app` however it is reached. The trigger itself hangs off `auth.users`, which
-- belongs to Supabase, so the final section needs a role with rights there (`postgres`, i.e.
-- the Supabase SQL editor or the management API) — `sooz_app` is refused at the auth schema.

set role sooz_app;

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
-- An invitation is a promise about a role, redeemed when the invited address signs up.
-- It cannot be an `app_users` row: that table's primary key is an auth identity that does
-- not exist yet.
create table if not exists app_invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  role        app_role not null default 'viewer',
  invited_by  uuid references app_users (id),
  invited_at  timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references app_users (id)
);

-- One live invitation per address; spent ones are kept as a record of who let whom in.
create unique index if not exists app_invites_open_email_idx
  on app_invites (lower(email)) where accepted_at is null;

create index if not exists app_invites_email_idx on app_invites (lower(email));

alter table app_invites enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgrelid = 'app_invites'::regclass and tgname = 'audit_app_invites'
  ) then
    perform attach_audit('app_invites');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Identity -> application user
-- ---------------------------------------------------------------------------
create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  invite   app_invites%rowtype;
  assigned app_role;
  addr     text := lower(coalesce(new.email, ''));
  name     text;
begin
  select * into invite
    from app_invites
   where accepted_at is null
     and lower(email) = addr
     and addr <> ''
   order by invited_at desc
   limit 1;

  if not exists (select 1 from app_users) then
    assigned := 'owner';
  elsif invite.id is not null then
    assigned := invite.role;
  else
    assigned := 'viewer';
  end if;

  -- Supabase carries whatever the sign-up form passed in raw_user_meta_data; both spellings
  -- are in the wild (the dashboard's invite form writes `name`).
  name := nullif(btrim(coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    '')), '');

  insert into app_users (id, email, full_name, role)
  values (new.id, coalesce(new.email, addr), name, assigned)
  on conflict (id) do update
     set email     = excluded.email,
         full_name = coalesce(app_users.full_name, excluded.full_name);

  if invite.id is not null then
    update app_invites
       set accepted_at = now(),
           accepted_by = new.id
     where id = invite.id;
  end if;

  return new;
end $$;

-- The insert into auth.users runs as supabase_auth_admin, which has to be able to reach the
-- function even though the body then executes with the definer's rights.
grant execute on function handle_new_auth_user() to supabase_auth_admin;

reset role;

-- ---------------------------------------------------------------------------
-- The trigger on Supabase's identity table (privileged role required)
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

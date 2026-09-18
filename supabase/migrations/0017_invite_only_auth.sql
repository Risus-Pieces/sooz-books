-- Sooz Books — invite-only sign-up, with the owner named explicitly.
--
-- 0004 made the first account ever created the owner and every later uninvited sign-up
-- a viewer. On a hosted deployment that is two holes at once: whoever reaches the URL
-- before the founder becomes owner of the books, and any stranger can register and read
-- every financial report. Here the owner is named by email, invitations are the only
-- other way in, and every other sign-up is refused inside the same transaction that
-- would have created the account, so no auth.users row survives it.

create table if not exists app_settings (
  id           boolean primary key default true check (id),   -- exactly one row
  owner_email  text not null,
  company_name text not null default 'Sooz Beverage LLC',
  books_time_zone text not null default 'America/Chicago',
  updated_at   timestamptz not null default now()
);
alter table app_settings enable row level security;

insert into app_settings (owner_email)
values ('boxuanzhao1128@gmail.com')
on conflict (id) do nothing;

select attach_audit('app_settings');

create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  invite   app_invites%rowtype;
  assigned app_role;
  addr     text := lower(btrim(coalesce(new.email, '')));
  owner    text;
  name     text;
begin
  select lower(btrim(owner_email)) into owner from app_settings where id;

  select * into invite
    from app_invites
   where accepted_at is null
     and lower(email) = addr
     and addr <> ''
   order by invited_at desc
   limit 1;

  if addr <> '' and addr = owner then
    assigned := 'owner';
  elsif invite.id is not null then
    assigned := invite.role;
  else
    -- Raising here aborts the auth.users insert as well: the account is never created.
    raise exception 'Sign-up is by invitation only. Ask the owner of these books to invite %.', addr
      using errcode = 'insufficient_privilege';
  end if;

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

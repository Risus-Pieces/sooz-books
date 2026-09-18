-- Invitations are claimed with a secret, single-use link, never by knowing an address.
--
-- 0017 let any sign-up whose email matched an open invitation take that invitation's role,
-- at the moment the auth.users row was inserted, before the address was confirmed. An
-- adversarial review found the consequence: anyone who guessed an invited address (a first
-- name at the company's domain) could sign up first with a password of their own, consume
-- an OWNER invitation, lock the real invitee out, and wait for a manual confirmation that
-- would hand them the books. Supabase's public sign-up endpoint makes the address alone
-- sufficient whatever the app's own forms do.
--
-- Now each invitation carries the SHA-256 of a random token and an expiry. The token travels
-- only in the link the owner sends. The trigger that creates app_users accepts an invited
-- sign-up only when raw_user_meta_data.invite_token hashes to an open, unexpired invitation
-- for that exact address — so the database stays the gatekeeper, and the public endpoint is
-- useless without the link. Invitations that predate this migration have no token and can no
-- longer be claimed; they must be reissued.

alter table app_invites
  add column if not exists token_hash text,
  add column if not exists expires_at timestamptz;

create unique index if not exists app_invites_token_hash_idx
  on app_invites (token_hash) where token_hash is not null;

create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  invite   app_invites%rowtype;
  assigned app_role;
  addr     text := lower(btrim(coalesce(new.email, '')));
  owner    text;
  token    text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'invite_token', '')), '');
  name     text;
begin
  select lower(btrim(owner_email)) into owner from app_settings where id;

  if addr <> '' and addr = owner then
    assigned := 'owner';
  else
    if token is not null then
      select * into invite
        from app_invites
       where accepted_at is null
         and lower(btrim(email)) = addr
         and token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
         and expires_at > now()
       for update;
    end if;

    if invite.id is null then
      -- Raising here aborts the auth.users insert as well: the account is never created.
      raise exception 'Sign-up is by invitation only. Use the invitation link the owner sent you.'
        using errcode = 'insufficient_privilege';
    end if;
    assigned := invite.role;
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

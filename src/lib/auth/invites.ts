import { createHash, randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { LedgerDb } from '@/lib/ledger/post';
import type { AppRole } from '@/lib/types';

/**
 * Invitations are claimed with a secret, single-use link — never by knowing an address.
 *
 * The owner creates an invitation and gets a link carrying a random token; only the token's
 * SHA-256 is stored. The token travels in the link's fragment (`#invite=…`), which browsers
 * never send to a server, so it cannot land in request logs. Opening the link lets the invitee
 * choose a password; the account is then created already confirmed through Supabase's admin API
 * (no email is needed, and Supabase's default mailer cannot reach addresses outside the team).
 *
 * The database stays the gatekeeper: the trigger on auth.users (migration 0044) accepts an
 * invited account only when the token in its metadata hashes to an open, unexpired invitation
 * for that exact address. Knowing the address, or calling Supabase's public sign-up endpoint,
 * gets nobody in.
 */

export const INVITE_TTL_DAYS = 7;

/** 32 random bytes, URL-safe: long enough that guessing is not a strategy. */
export function issueInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}

/** Must equal Postgres `encode(sha256(convert_to(token, 'UTF8')), 'hex')`, which the trigger computes. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The link the owner sends. The token rides in the fragment so it never reaches a server log. */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/login?stage=join#invite=${token}`;
}

export type OpenInvite = {
  id: string;
  email: string;
  role: AppRole;
  expiresAt: string;
};

export interface InviteLink {
  email: string;
  role: AppRole;
  link: string;
  expiresAt: string;
}

/**
 * Creates the invitation for `email`, or re-keys the open one, returning the new link. Any link
 * issued earlier for the same address stops working, because only the latest hash is kept.
 */
export async function recordInvite(
  exec: LedgerDb,
  input: { email: string; role: AppRole; invitedBy: string; origin: string },
): Promise<InviteLink> {
  const { token, hash } = issueInviteToken();
  const [row] = await exec.execute<{ expiresAt: string }>(sql`
    insert into app_invites (email, role, invited_by, token_hash, expires_at)
    values (${input.email}, ${input.role}::app_role, ${input.invitedBy}, ${hash},
            now() + make_interval(days => ${INVITE_TTL_DAYS}))
    on conflict (lower(email)) where accepted_at is null
    do update set role = excluded.role, invited_by = excluded.invited_by, invited_at = now(),
                  token_hash = excluded.token_hash, expires_at = excluded.expires_at
    returning to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "expiresAt"`);
  return { email: input.email, role: input.role, link: inviteLink(input.origin, token), expiresAt: row.expiresAt };
}

/** A fresh link for an open invitation; the previous link stops working. Null if none is open. */
export async function reissueInvite(
  exec: LedgerDb,
  input: { inviteId: string; origin: string },
): Promise<InviteLink | null> {
  const { token, hash } = issueInviteToken();
  const [row] = await exec.execute<{ email: string; role: AppRole; expiresAt: string }>(sql`
    update app_invites
       set token_hash = ${hash},
           expires_at = now() + make_interval(days => ${INVITE_TTL_DAYS}),
           invited_at = now()
     where id = ${input.inviteId} and accepted_at is null
    returning email, role,
              to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "expiresAt"`);
  if (!row) return null;
  return { email: row.email, role: row.role, link: inviteLink(input.origin, token), expiresAt: row.expiresAt };
}

/** The open, unexpired invitation a token belongs to, or null. */
export async function findOpenInvite(exec: LedgerDb, token: string): Promise<OpenInvite | null> {
  const trimmed = token.trim();
  if (trimmed.length < 20 || trimmed.length > 200) return null;
  const [row] = await exec.execute<OpenInvite>(sql`
    select id, lower(btrim(email)) as email, role,
           to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "expiresAt"
      from app_invites
     where token_hash = ${hashInviteToken(trimmed)}
       and accepted_at is null
       and expires_at > now()`);
  return row ?? null;
}

/**
 * What a token opens: an open invitation, one that was already used to create an account (so the
 * invitee should just sign in), or nothing.
 */
export async function inviteStatus(
  exec: LedgerDb,
  token: string,
): Promise<{ state: 'open'; invite: OpenInvite } | { state: 'used' } | { state: 'invalid' }> {
  const open = await findOpenInvite(exec, token);
  if (open) return { state: 'open', invite: open };
  const trimmed = token.trim();
  if (trimmed.length < 20 || trimmed.length > 200) return { state: 'invalid' };
  const [used] = await exec.execute<{ used: boolean }>(sql`
    select exists (
      select 1 from app_invites where token_hash = ${hashInviteToken(trimmed)} and accepted_at is not null
    ) as used`);
  return used?.used === true ? { state: 'used' } : { state: 'invalid' };
}

/** What Supabase's admin API has to offer for creating an account; stubbed in tests. */
export interface AdminAuth {
  createUser(attrs: {
    email: string;
    password: string;
    email_confirm: boolean;
    user_metadata: Record<string, unknown>;
  }): Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>;
  updateUserById(
    id: string,
    attrs: { user_metadata: Record<string, unknown> },
  ): Promise<{ error: { message: string } | null }>;
}

export type JoinOutcome =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid_link' | 'already_registered' | 'failed'; message?: string };

/**
 * Creates the invitee's account, already confirmed, with the password they chose. The trigger
 * re-checks the token inside the insert, so a link that expired or was re-keyed between the
 * lookup and this call is still refused.
 */
export async function createInvitedAccount(
  exec: LedgerDb,
  admin: AdminAuth,
  input: { token: string; fullName: string; password: string },
): Promise<JoinOutcome> {
  const status = await inviteStatus(exec, input.token);
  // A join that created the account but never reached sign-in leaves the invitation spent:
  // the invitee should sign in, not ask the owner for a link that can no longer be made.
  if (status.state === 'used') return { ok: false, reason: 'already_registered' };
  if (status.state !== 'open') return { ok: false, reason: 'invalid_link' };
  const invite = status.invite;

  const { data, error } = await admin.createUser({
    email: invite.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName, invite_token: input.token.trim() },
  });
  if (error || !data.user) {
    const message = error?.message ?? 'no user returned';
    if (/already (been )?registered|already exists/i.test(message)) return { ok: false, reason: 'already_registered' };
    if (/database error/i.test(message)) return { ok: false, reason: 'invalid_link' };
    return { ok: false, reason: 'failed', message };
  }

  // The token has done its job; keep it out of the metadata the user's session carries.
  // Best effort: a spent token no longer opens anything, so a failure here must not undo a
  // join that has already created the account.
  try {
    await admin.updateUserById(data.user.id, { user_metadata: { invite_token: null } });
  } catch {
    // ignored on purpose; see above
  }

  return { ok: true, email: invite.email };
}

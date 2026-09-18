'use server';

import { and, eq, ne, sql as sqlTag } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import * as z from 'zod';

import { db, withActor } from '@/db/client';
import { appUsers } from '@/db/schema';
import {
  createInvitedAccount,
  inviteStatus,
  recordInvite,
  reissueInvite,
  type InviteLink,
} from '@/lib/auth/invites';
import { booksAreUnclaimed } from '@/lib/auth/owner';
import { isForbiddenError, type Capability } from '@/lib/auth/roles';
import { requireCapability, type AuthedUser } from '@/lib/auth/session';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { APP_ROLES, err, ok, type AppRole, type Result } from '@/lib/types';

/**
 * Every mutation that touches identity or access.
 *
 * The ones a form drives — sign in, ask for a link, open the books, join from an invitation — take the
 * `useActionState` shape and hand back a `Result` the form renders. The administrative ones
 * take plain arguments, guard on `users.manage`, and write through `withActor`, so `audit_log`
 * records who granted what.
 */

/** `null` is the initial state: nothing attempted yet. */
export type AuthFormState = Result<string, string> | null;

const emailSchema = z.email('Enter a valid email address.');

const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.'),
});

const newPasswordSchema = z
  .object({
    fullName: z.string().trim().max(120).optional(),
    password: z.string().min(10, 'Use at least 10 characters.'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    error: 'The two passwords do not match.',
    path: ['confirm'],
  });

const signUpSchema = z.object({
  fullName: z.string().trim().min(1, 'Enter your name.').max(120),
  email: emailSchema,
  password: z.string().min(10, 'Use at least 10 characters.'),
});

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return err(firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) return err(signInMessage(error.message));

  redirect(safeNext(formData.get('next')) ?? '/dashboard');
}

export async function signInWithOtp(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = emailSchema.safeParse(formData.get('email'));
  if (!parsed.success) return err(firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: {
      // Accounts are created by invitation, never by asking for a link.
      shouldCreateUser: false,
      emailRedirectTo: await callbackUrl(safeNext(formData.get('next')) ?? '/dashboard'),
    },
  });
  if (error) return err(signInMessage(error.message));

  return ok(`A sign-in link is on its way to ${parsed.data}. It is good for one hour.`);
}

export async function signOut(): Promise<never> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

/**
 * Opens the books. Only offered until the owner named in app_settings has an account; the
 * trigger on `auth.users` accepts that address as owner and refuses every uninvited one.
 */
export async function signUpFirstOwner(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!(await booksAreUnclaimed())) {
    return err('These books already have an owner. Ask them to invite you.');
  }

  const parsed = signUpSchema.safeParse({
    fullName: formData.get('fullName'),
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return err(firstIssue(parsed.error));

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: await callbackUrl('/dashboard'),
    },
  });
  if (error) {
    // The invite-only trigger refuses any address but the owner's; Supabase surfaces that as
    // "Database error saving new user", which tells a person nothing.
    if (/database error saving new user/i.test(error.message)) {
      return err('Only the owner of these books can create the first account. Anyone else needs an invitation from the owner.');
    }
    return err(error.message);
  }

  // With email confirmation switched on there is no session yet; the identity — and so the
  // owner row — only appears once the address is confirmed.
  if (!data.session) {
    return ok(`Account created. Confirm ${parsed.data.email} from the email just sent, then sign in.`);
  }

  redirect('/dashboard');
}

const joinSchema = z
  .object({
    token: z.string().trim().min(20, 'This invitation link is incomplete.').max(200),
    fullName: z.string().trim().min(1, 'Enter your name.').max(120),
    password: z.string().min(10, 'Use at least 10 characters.'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    error: 'The two passwords do not match.',
    path: ['confirm'],
  });

const INVALID_LINK =
  'This invitation link is no longer valid: it was replaced or has expired. Ask the owner for a new one.';

const ALREADY_JOINED = 'This invitation was already used to create your account. Sign in with the password you chose.';

const LINKS_OFF =
  'Invitations are not switched on yet: the server needs its Supabase service key. Tell the owner.';

export type InviteLookupState = Result<{ email: string; role: AppRole; expiresAt: string }, string>;

/**
 * Who an invitation link is for. The token arrives in the POST body from the page's fragment,
 * never in a URL, so it does not reach a request log.
 */
export async function lookupInvite(token: string): Promise<InviteLookupState> {
  const status = await inviteStatus(db, String(token ?? ''));
  if (status.state === 'used') return err(ALREADY_JOINED);
  if (status.state !== 'open') return err(INVALID_LINK);
  // Say so before the invitee chooses a password, not after.
  if (!createAdminClient()) return err(LINKS_OFF);
  const { invite } = status;
  return ok({ email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
}

/**
 * Creates an invitee's account from their link, already confirmed, then signs them in.
 * The invitation link is the proof of invitation; see src/lib/auth/invites.ts for why no email
 * confirmation is involved and why the database, not this action, is the gatekeeper.
 */
export async function joinWithInvite(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = joinSchema.safeParse({
    token: formData.get('token'),
    fullName: formData.get('fullName'),
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  });
  if (!parsed.success) return err(firstIssue(parsed.error));

  const admin = createAdminClient();
  if (!admin) return err(LINKS_OFF);

  const outcome = await createInvitedAccount(db, admin.auth.admin, {
    token: parsed.data.token,
    fullName: parsed.data.fullName,
    password: parsed.data.password,
  });
  if (!outcome.ok) {
    if (outcome.reason === 'already_registered') return err(ALREADY_JOINED);
    if (outcome.reason === 'invalid_link') return err(INVALID_LINK);
    return err('The account could not be created. Try again in a minute.');
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: outcome.email,
    password: parsed.data.password,
  });
  if (error) return ok('Your account is ready. Sign in with your email and the password you chose.');

  redirect('/dashboard');
}

/**
 * Sets a new password for whoever is signed in through an emailed link (a password recovery).
 * Invitations no longer come this way; they use a link the owner sends (see joinWithInvite).
 */
export async function setPassword(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = newPasswordSchema.safeParse({
    fullName: formData.get('fullName') ?? undefined,
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  });
  if (!parsed.success) return err(firstIssue(parsed.error));

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return err('This link has expired. Ask for a new one.');

  // Only a session that has just come through an emailed link may set a password without the
  // old one. Otherwise anyone at an unlocked, signed-in browser could lock the owner out.
  if (!(await signedInByLinkRecently(supabase))) {
    return err('For your security, open a fresh password-reset link, then choose your password.');
  }

  const fullName = parsed.data.fullName?.trim() || null;
  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
    ...(fullName ? { data: { full_name: fullName } } : {}),
  });
  if (error) return err(error.message);

  if (fullName) {
    const userId = data.user.id;
    await withActor(userId, (tx) =>
      tx.update(appUsers).set({ fullName }).where(eq(appUsers.id, userId)),
    );
  }

  redirect('/dashboard');
}

// ---------------------------------------------------------------------------
// Administration — owner only
// ---------------------------------------------------------------------------

export type InviteLinkState = Result<InviteLink, string> | null;

/**
 * Invites an address with a role and returns the single-use link to send them. No email is
 * sent: Supabase's default mailer cannot reach addresses outside the Supabase team, and the link
 * itself is the proof of invitation. Inviting an address again re-keys its open invitation.
 */
export async function inviteUser(email: string, role: AppRole): Promise<Result<InviteLink, string>> {
  const guard = await actorFor('users.manage');
  if (!guard.ok) return guard;
  const actor = guard.value;

  const parsed = emailSchema.safeParse(String(email ?? '').trim());
  if (!parsed.success) return err(firstIssue(parsed.error));
  if (!isAppRole(role)) return err('Choose a role.');

  const address = parsed.data.toLowerCase();

  const [existing] = await db
    .select({ active: appUsers.active })
    .from(appUsers)
    .where(sqlTag`lower(${appUsers.email}) = ${address}`)
    .limit(1);
  if (existing) {
    return err(
      existing.active
        ? `${address} already has access.`
        : `${address} already has an account here — switch it back on instead of inviting it again.`,
    );
  }

  const origin = await requestOrigin();
  const link = await withActor(actor.id, (tx) =>
    recordInvite(tx, { email: address, role, invitedBy: actor.id, origin }),
  );
  revalidatePath('/settings/users');
  return ok(link);
}

/** A fresh link for an open invitation; the old link stops working at once. */
export async function reissueInviteLink(inviteId: string): Promise<Result<InviteLink, string>> {
  const guard = await actorFor('users.manage');
  if (!guard.ok) return guard;
  if (!z.uuid().safeParse(inviteId).success) return err('That invitation was already used or withdrawn.');

  const origin = await requestOrigin();
  const link = await withActor(guard.value.id, (tx) =>
    reissueInvite(tx, { inviteId: String(inviteId ?? ''), origin }),
  );
  if (!link) return err('That invitation was already used or withdrawn.');
  revalidatePath('/settings/users');
  return ok(link);
}

/** Form adapters for the invite sheets, which show the returned link once. */
export async function inviteFromForm(_prev: InviteLinkState, formData: FormData): Promise<InviteLinkState> {
  return inviteUser(String(formData.get('email') ?? ''), String(formData.get('role') ?? 'viewer') as AppRole);
}

export async function reissueFromForm(_prev: InviteLinkState, formData: FormData): Promise<InviteLinkState> {
  return reissueInviteLink(String(formData.get('inviteId') ?? ''));
}

export async function updateUserRole(
  userId: string,
  role: AppRole,
): Promise<Result<string, string>> {
  const guard = await actorFor('users.manage');
  if (!guard.ok) return guard;
  if (!isAppRole(role)) return err('Choose a role.');

  const target = await findUser(userId);
  if (!target) return err('That user no longer exists.');
  if (target.role === role) return ok(`${describe(target)} is already ${role}.`);

  if (target.role === 'owner' && (await otherActiveOwners(userId)) === 0) {
    return err('These books need an owner. Make someone else an owner first.');
  }

  await withActor(guard.value.id, (tx) =>
    tx.update(appUsers).set({ role }).where(eq(appUsers.id, userId)),
  );

  revalidatePath('/settings/users');
  return ok(`${describe(target)} is now ${role}.`);
}

export async function deactivateUser(userId: string): Promise<Result<string, string>> {
  const guard = await actorFor('users.manage');
  if (!guard.ok) return guard;
  if (userId === guard.value.id) return err('You cannot switch off your own access.');

  const target = await findUser(userId);
  if (!target) return err('That user no longer exists.');
  if (!target.active) return ok(`${describe(target)} is already switched off.`);
  if (target.role === 'owner' && (await otherActiveOwners(userId)) === 0) {
    return err('These books need an active owner.');
  }

  await setActive(guard.value.id, userId, false);
  revalidatePath('/settings/users');
  return ok(`${describe(target)} can no longer sign in.`);
}

export async function reactivateUser(userId: string): Promise<Result<string, string>> {
  const guard = await actorFor('users.manage');
  if (!guard.ok) return guard;

  const target = await findUser(userId);
  if (!target) return err('That user no longer exists.');
  if (target.active) return ok(`${describe(target)} already has access.`);

  await setActive(guard.value.id, userId, true);
  revalidatePath('/settings/users');
  return ok(`${describe(target)} can sign in again.`);
}

export async function revokeInvite(inviteId: string): Promise<Result<string, string>> {
  const guard = await actorFor('users.manage');
  if (!guard.ok) return guard;
  if (!z.uuid().safeParse(inviteId).success) return err('That invitation no longer exists.');

  const removed = await withActor(guard.value.id, (tx) =>
    tx.execute(sqlTag`
      delete from app_invites where id = ${inviteId} and accepted_at is null returning id
    `),
  );

  revalidatePath('/settings/users');
  return removed.length === 0 ? err('That invitation is already gone.') : ok('Invitation withdrawn.');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The capability guard, as a value rather than an exception: a refusal is an ordinary answer
 * for an action and belongs in the return type. Anything that is not a refusal — including the
 * redirect `requireUser` throws when the session has gone — travels on untouched.
 */
async function actorFor(cap: Capability): Promise<Result<AuthedUser, string>> {
  try {
    return ok(await requireCapability(cap));
  } catch (error) {
    if (isForbiddenError(error)) return err(error.message);
    throw error;
  }
}

interface TargetUser {
  id: string;
  email: string;
  fullName: string | null;
  role: AppRole;
  active: boolean;
}

async function findUser(userId: string): Promise<TargetUser | null> {
  if (!z.uuid().safeParse(userId).success) return null;

  const [row] = await db
    .select({
      id: appUsers.id,
      email: appUsers.email,
      fullName: appUsers.fullName,
      role: appUsers.role,
      active: appUsers.active,
    })
    .from(appUsers)
    .where(eq(appUsers.id, userId))
    .limit(1);

  return row ?? null;
}

/** How many active owners would remain if `userId` stopped being one. */
async function otherActiveOwners(userId: string): Promise<number> {
  const rows = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(and(eq(appUsers.role, 'owner'), eq(appUsers.active, true), ne(appUsers.id, userId)));
  return rows.length;
}

async function setActive(actorId: string, userId: string, active: boolean): Promise<void> {
  await withActor(actorId, (tx) =>
    tx.update(appUsers).set({ active }).where(eq(appUsers.id, userId)),
  );
}

function describe(user: TargetUser): string {
  return user.fullName ?? user.email;
}

function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'That does not look right.';
}

/** Supabase words its errors for developers; these are the ones a bookkeeper should read. */
function signInMessage(message: string): string {
  const text = message.toLowerCase();
  if (text.includes('invalid login credentials')) {
    return 'That email and password do not match an account.';
  }
  if (text.includes('email not confirmed')) {
    return 'Confirm your email address first — the link is in your inbox.';
  }
  if (text.includes('signups not allowed') || text.includes('user not found')) {
    return 'No account here uses that address. Ask an owner to invite you.';
  }
  if (text.includes('rate limit') || text.includes('too many')) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  return message;
}

/**
 * Where Supabase sends people after they follow an emailed link. Derived from the request
 * rather than from configuration, so localhost and preview deployments both work.
 */
async function callbackUrl(next: string): Promise<string> {
  return `${await requestOrigin()}/auth/callback?next=${encodeURIComponent(next)}`;
}

/** The site origin, from the request, so links work on localhost, previews and production alike. */
async function requestOrigin(): Promise<string> {
  const store = await headers();
  return (
    store.get('origin') ??
    inferOrigin(store.get('x-forwarded-host') ?? store.get('host'), store.get('x-forwarded-proto'))
  );
}

function inferOrigin(host: string | null, proto: string | null): string {
  if (!host) throw new Error('Cannot determine the site origin: the request carries no Host header.');
  const local = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  return `${proto ?? (local ? 'http' : 'https')}://${host}`;
}

/** How recently an emailed-link sign-in must have happened for setPassword to accept it. */
const LINK_SIGN_IN_WINDOW_SECONDS = 15 * 60;

/**
 * True when the current session was established through an emailed link (a recovery, magic link
 * or invitation) within the last few minutes, read from the session's authentication methods.
 */
async function signedInByLinkRecently(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  const now = Math.floor(Date.now() / 1000);
  return data.currentAuthenticationMethods.some(
    (m) =>
      // A bare string entry carries no time, so it cannot prove the sign-in was recent.
      typeof m !== 'string' &&
      (m.method === 'recovery' || m.method === 'otp' || m.method === 'magiclink' || m.method === 'invite') &&
      now - m.timestamp <= LINK_SIGN_IN_WINDOW_SECONDS,
  );
}

/** Only a path on this origin may be redirected to; `src/proxy.ts` applies the same rule. */
function safeNext(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

'use server';

import { and, eq, ne, sql as sqlTag } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import * as z from 'zod';

import { db, withActor } from '@/db/client';
import { appUsers } from '@/db/schema';
import { isForbiddenError, type Capability } from '@/lib/auth/roles';
import { requireCapability, type AuthedUser } from '@/lib/auth/session';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { APP_ROLES, err, ok, type AppRole, type Result } from '@/lib/types';

/**
 * Every mutation that touches identity or access.
 *
 * The four a form drives — sign in, ask for a link, open the books, set a password — take the
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
 * Opens the books. Only works while `app_users` is empty — the trigger on `auth.users` makes
 * whoever that is the owner, and this refuses to serve anyone arriving afterwards.
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
  if (error) return err(error.message);

  // With email confirmation switched on there is no session yet; the identity — and so the
  // owner row — only appears once the address is confirmed.
  if (!data.session) {
    return ok(`Account created. Confirm ${parsed.data.email} from the email just sent, then sign in.`);
  }

  redirect('/dashboard');
}

/** Sets the password on an account that arrived through an invitation link. */
export async function acceptInvite(
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
  if (!data.user) return err('This invitation link has expired. Ask for a new one.');

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

export async function inviteUser(email: string, role: AppRole): Promise<Result<string, string>> {
  const guard = await actorFor('users.manage');
  if (!guard.ok) return guard;
  const actor = guard.value;

  const parsed = emailSchema.safeParse(email);
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

  // The invitation is what the sign-up trigger reads to decide the new account's role, so it
  // is recorded whether or not an email can be sent.
  await withActor(actor.id, (tx) =>
    tx.execute(sqlTag`
      insert into app_invites (email, role, invited_by)
      values (${address}, ${role}::app_role, ${actor.id})
      on conflict (lower(email)) where accepted_at is null
      do update set role = excluded.role, invited_by = excluded.invited_by, invited_at = now()
    `),
  );

  revalidatePath('/settings/users');

  const admin = createAdminClient();
  if (!admin) {
    return ok(
      `${address} is invited as ${role}. No SUPABASE_SERVICE_ROLE_KEY is configured, so no email ` +
        'was sent — ask them to sign up with exactly that address and the role will be applied.',
    );
  }

  const { error } = await admin.auth.admin.inviteUserByEmail(address, {
    redirectTo: await callbackUrl('/login?stage=invite'),
  });
  if (error) {
    return ok(
      `${address} is invited as ${role}, but the email could not be sent (${error.message}). ` +
        'They can sign up with that address and the role will still be applied.',
    );
  }

  return ok(`Invitation sent to ${address} as ${role}.`);
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

async function booksAreUnclaimed(): Promise<boolean> {
  const rows = await db.select({ id: appUsers.id }).from(appUsers).limit(1);
  return rows.length === 0;
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
  const store = await headers();
  const origin = store.get('origin');
  const base =
    origin ??
    inferOrigin(store.get('x-forwarded-host') ?? store.get('host'), store.get('x-forwarded-proto'));
  return `${base}/auth/callback?next=${encodeURIComponent(next)}`;
}

function inferOrigin(host: string | null, proto: string | null): string {
  if (!host) throw new Error('Cannot determine the site origin: the request carries no Host header.');
  const local = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  return `${proto ?? (local ? 'http' : 'https')}://${host}`;
}

/** Only a path on this origin may be redirected to; `src/proxy.ts` applies the same rule. */
function safeNext(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

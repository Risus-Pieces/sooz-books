import { cache } from 'react';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { db } from '@/db/client';
import { appUsers } from '@/db/schema';
import { requireCapability as assertRole, type Capability } from '@/lib/auth/roles';
import { createClient } from '@/lib/supabase/server';
import type { AppRole } from '@/lib/types';

/**
 * Who is asking, and what they are allowed to do.
 *
 * The identity comes from Supabase Auth; the role comes from `app_users`, which is the
 * application's own record and the only thing authorisation reads. Both lookups are wrapped in
 * React's `cache`, so a page that guards its shell, its header and three server actions pays
 * for one round trip to the auth server and one query, not five of each.
 */

export interface AuthedUser {
  id: string;
  email: string;
  fullName: string | null;
  role: AppRole;
  active: boolean;
  createdAt: Date;
  /** From the Supabase identity, not `app_users` — null when the identity has never signed in. */
  lastSignInAt: string | null;
}

export interface AuthSession {
  user: User;
}

/**
 * The verified Supabase session for this request, or null.
 *
 * `getUser()` rather than `getSession()`: the latter reports whatever the cookie says without
 * checking it, which is fine for deciding what to paint and useless for deciding what to allow.
 */
export const getSession = cache(async (): Promise<AuthSession | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { user: data.user };
});

/**
 * The application user behind this request: the auth identity joined to its `app_users` row.
 *
 * Returns null when there is no session, when the identity has no `app_users` row (the
 * bootstrap trigger creates one for every sign-up, so this means the row was removed), or when
 * the account has been deactivated. A deactivated account is refused here rather than at the
 * guard, so no caller can accidentally treat one as signed in.
 */
export const getAppUser = cache(async (): Promise<AuthedUser | null> => {
  const session = await getSession();
  if (!session) return null;

  const [row] = await db
    .select({
      id: appUsers.id,
      email: appUsers.email,
      fullName: appUsers.fullName,
      role: appUsers.role,
      active: appUsers.active,
      createdAt: appUsers.createdAt,
    })
    .from(appUsers)
    .where(eq(appUsers.id, session.user.id))
    .limit(1);

  if (!row || !row.active) return null;

  return { ...row, lastSignInAt: session.user.last_sign_in_at ?? null };
});

/**
 * The guard every authenticated surface begins with. Redirects rather than throwing, because a
 * missing session is an ordinary state and a 500 page is not an answer to it.
 *
 * `next` carries the page they were trying to reach so they land there after signing in.
 */
export async function requireUser(next?: string): Promise<AuthedUser> {
  const session = await getSession();
  if (!session) redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');

  const user = await getAppUser();
  if (!user) {
    // Signed in as an identity the books no longer recognise or have switched off. The login
    // screen explains it and offers the only useful action, which is to sign out.
    redirect('/login?stage=disabled');
  }

  return user;
}

/**
 * The guard a server action begins with: resolves the session, then checks the capability.
 * Throws `ForbiddenError` when the role falls short — actions catch it and return the message,
 * pages let it surface as an error boundary.
 */
export async function requireCapability(cap: Capability): Promise<AuthedUser> {
  const user = await requireUser();
  assertRole(user.role, cap);
  return user;
}

/** Non-redirecting variant, for deciding whether to render a control at all. */
export async function currentUser(): Promise<AuthedUser | null> {
  return getAppUser();
}

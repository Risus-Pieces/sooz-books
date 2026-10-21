'use server';

/**
 * Making and revoking the scoped keys unattended agents use.
 *
 * Each one checks `users.manage` — a key acts for a person, so making one is granting access —
 * hands the work to `@/lib/feeds/keys`, and answers `{ ok, value }` or `{ ok: false, error }`. The
 * token comes back exactly once, in the answer to `createAgentKey`; only its hash is kept.
 */

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';

import { isForbiddenError } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { isQueryError, postgresErrorOf } from '@/lib/db-errors';
import { ApiKeyError, createApiKey, revokeApiKey } from '@/lib/feeds/keys';
import type { ActionFailure, ActionResult } from '@/components/ledger/types';

import { isUuid } from '../_components/feeds-format';

export interface NewKey {
  name: string;
  prefix: string;
  /** Shown once, then gone: only its hash is stored. */
  token: string;
}

function failure(error: unknown): ActionFailure {
  if (error instanceof ApiKeyError) return { code: 'invalid', message: error.message };
  if (isForbiddenError(error)) return { code: 'forbidden', message: error.message };
  const pg = postgresErrorOf(error);
  if (pg !== null) return { code: 'unexpected', message: `The database refused this change: ${pg.message}` };
  if (isQueryError(error)) return { code: 'unexpected', message: 'The database could not complete this request.' };
  if (error instanceof Error) return { code: 'unexpected', message: error.message };
  return { code: 'unexpected', message: 'Something went wrong.' };
}

function ok<T>(value: T): ActionResult<T> {
  return { ok: true, value };
}

function fail<T>(error: unknown): ActionResult<T> {
  // A redirect thrown by `requireUser` (an expired session) must reach Next, not become a toast.
  unstable_rethrow(error);
  return { ok: false, error: failure(error) };
}

function invalid<T>(message: string): ActionResult<T> {
  return { ok: false, error: { code: 'invalid', message } };
}

export async function createAgentKey(input: { name: string; userId: string }): Promise<ActionResult<NewKey>> {
  try {
    const actor = await requireCapability('users.manage');
    if (typeof input?.name !== 'string') return invalid('Give the key a name.');
    if (!isUuid(input.userId)) return invalid('Choose who the key acts for.');
    const name = input.name.trim();
    const key = await createApiKey(actor, { name, userId: input.userId });
    revalidatePath('/settings/keys');
    return ok({ name, prefix: key.prefix, token: key.token });
  } catch (error) {
    return fail(error);
  }
}

/** Stops a key at once: its next request is refused. */
export async function revokeAgentKey(keyId: string): Promise<ActionResult<null>> {
  try {
    const actor = await requireCapability('users.manage');
    if (!isUuid(keyId)) return invalid('That key is not valid.');
    await revokeApiKey(actor, keyId);
    revalidatePath('/settings/keys');
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

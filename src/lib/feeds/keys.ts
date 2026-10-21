/**
 * Scoped keys for unattended agents.
 *
 * A key acts for one person, limited to its scopes, and is used where a person's sign-in cannot be:
 * an agent that runs at night. The token is shown once; only its sha256 is stored, so the table alone
 * cannot be used to act. Only someone who may manage users creates or revokes keys.
 *
 * A key can never stage or commit a change. Its scopes are reading the books, running the bank sync
 * and running the auto-post rules an owner already approved — nothing that decides what an entry is.
 */
import { createHash, randomBytes } from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';

import { db, withActor } from '@/db/client';
import { API_KEY_SCOPES, type ApiKeyScope, apiKeys, appUsers } from '@/db/schema';
import { requireCapability } from '@/lib/auth/roles';
import type { LedgerDb } from '@/lib/ledger/post';
import type { AppRole } from '@/lib/types';

export const KEY_PREFIX = 'sbk_';

export class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

export function hashKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function looksLikeKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX);
}

export interface KeyCtx {
  tx?: LedgerDb;
}

export interface CreatedKey {
  id: string;
  /** Shown once. */
  token: string;
  prefix: string;
}

export async function createApiKey(
  actor: { id: string; role: AppRole },
  input: { name: string; userId: string; scopes?: readonly ApiKeyScope[] },
  ctx: KeyCtx = {},
): Promise<CreatedKey> {
  requireCapability(actor.role, 'users.manage');
  const name = input.name.trim();
  if (name === '' || name.length > 60) throw new ApiKeyError('Give the key a name of up to 60 characters, such as "Mo\'s nightly sync".');
  const scopes = [...new Set(input.scopes ?? API_KEY_SCOPES)];
  if (scopes.length === 0 || scopes.some((scope) => !(API_KEY_SCOPES as readonly string[]).includes(scope))) {
    throw new ApiKeyError('Unknown key scope.');
  }

  const token = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const work = async (tx: LedgerDb) => {
    const [user] = await tx.select({ active: appUsers.active }).from(appUsers).where(eq(appUsers.id, input.userId));
    if (user === undefined || !user.active) throw new ApiKeyError('A key can only act for an active Sooz Books user.');
    const [row] = await tx
      .insert(apiKeys)
      .values({ name, userId: input.userId, tokenHash: hashKey(token), prefix: token.slice(0, 10), scopes, createdBy: actor.id })
      .returning({ id: apiKeys.id, prefix: apiKeys.prefix });
    return row;
  };
  const row = ctx.tx ? await work(ctx.tx) : await withActor(actor.id, work);
  return { id: row.id, token, prefix: row.prefix };
}

export async function revokeApiKey(actor: { id: string; role: AppRole }, keyId: string, ctx: KeyCtx = {}): Promise<void> {
  requireCapability(actor.role, 'users.manage');
  const work = (tx: LedgerDb) =>
    tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)));
  if (ctx.tx) await work(ctx.tx);
  else await withActor(actor.id, work);
}

export interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  userEmail: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function listApiKeys(exec: LedgerDb = db): Promise<KeyRow[]> {
  return exec
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      userEmail: appUsers.email,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .innerJoin(appUsers, eq(appUsers.id, apiKeys.userId))
    .orderBy(desc(apiKeys.createdAt));
}

export interface KeyHolder {
  keyId: string;
  keyName: string;
  scopes: ApiKeyScope[];
  user: { id: string; email: string; fullName: string | null; role: AppRole };
}

/** The live key behind a token, for an active user, or null. Records the use. */
export async function authenticateKey(token: string, exec: LedgerDb = db): Promise<KeyHolder | null> {
  if (!looksLikeKey(token)) return null;
  const [row] = await exec
    .select({
      keyId: apiKeys.id,
      keyName: apiKeys.name,
      scopes: apiKeys.scopes,
      id: appUsers.id,
      email: appUsers.email,
      fullName: appUsers.fullName,
      role: appUsers.role,
      active: appUsers.active,
    })
    .from(apiKeys)
    .innerJoin(appUsers, eq(appUsers.id, apiKeys.userId))
    .where(and(eq(apiKeys.tokenHash, hashKey(token)), isNull(apiKeys.revokedAt)));
  if (row === undefined || !row.active) return null;
  await exec.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId));
  return {
    keyId: row.keyId,
    keyName: row.keyName,
    scopes: row.scopes,
    user: { id: row.id, email: row.email, fullName: row.fullName, role: row.role },
  };
}

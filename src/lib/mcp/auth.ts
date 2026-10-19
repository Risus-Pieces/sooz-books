/**
 * Who is calling `/mcp`.
 *
 * The authorization server is Supabase Auth's OAuth 2.1 server: it signs the person in, shows them
 * the consent screen, and issues an access token. This module is the resource-server half. A token
 * is accepted only if Supabase says it is valid right now (`getUser` asks the auth server, so a
 * revoked or expired token fails at once), and only if it belongs to an active `app_users` row. The
 * role is read from that row on every request, never from the token, so changing someone's role or
 * switching them off takes effect on their next tool call.
 */
import { createClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { appUsers } from '@/db/schema';
import type { LedgerDb } from '@/lib/ledger/post';
import { supabaseEnv } from '@/lib/supabase/server';

import type { McpUser } from './types';

export interface VerifiedToken {
  userId: string;
  clientId: string | null;
}

export type TokenVerifier = (token: string) => Promise<VerifiedToken | null>;

/** The OAuth client named in the token, for the record only: nothing is authorised on it. */
export function clientIdOf(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { client_id?: unknown };
    return typeof payload.client_id === 'string' ? payload.client_id : null;
  } catch {
    return null;
  }
}

export const verifyWithSupabase: TokenVerifier = async (token) => {
  const { url, anonKey } = supabaseEnv();
  const supabase = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, clientId: clientIdOf(token) };
};

export interface AuthDeps {
  verify?: TokenVerifier;
  exec?: LedgerDb;
}

export type AuthResult =
  | { ok: true; user: McpUser }
  | { ok: false; status: 401 | 403; error: 'invalid_token' | 'forbidden'; message: string };

export function bearerOf(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? null : match[1];
}

export async function authenticate(request: Request, deps: AuthDeps = {}): Promise<AuthResult> {
  const token = bearerOf(request);
  if (token === null) {
    return { ok: false, status: 401, error: 'invalid_token', message: 'Sign in to Sooz Books to use this connection.' };
  }
  const verified = await (deps.verify ?? verifyWithSupabase)(token);
  if (verified === null) {
    return { ok: false, status: 401, error: 'invalid_token', message: 'That sign-in is not valid or has expired.' };
  }

  const [row] = await (deps.exec ?? db)
    .select({ id: appUsers.id, email: appUsers.email, fullName: appUsers.fullName, role: appUsers.role, active: appUsers.active })
    .from(appUsers)
    .where(eq(appUsers.id, verified.userId))
    .limit(1);
  if (row === undefined || !row.active) {
    return { ok: false, status: 403, error: 'forbidden', message: 'This Sooz Books account does not have access.' };
  }
  return { ok: true, user: { id: row.id, email: row.email, fullName: row.fullName, role: row.role, clientId: verified.clientId } };
}

/** The address people reach the app at, which behind Vercel's proxy is not `request.url`'s host. */
export function publicOrigin(request: Request): string {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? new URL(request.url).protocol.replace(':', '');
  return `${proto}://${host}`;
}

/** Where a client learns which authorization server to use (RFC 9728). */
export function resourceMetadataUrl(request: Request): string {
  return `${publicOrigin(request)}/.well-known/oauth-protected-resource/mcp`;
}

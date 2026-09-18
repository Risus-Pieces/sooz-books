import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase clients for server code: React Server Components, route handlers and server actions.
 *
 * Auth state lives in cookies, and only some of those contexts may write them. A Server
 * Component cannot — Next has already begun streaming by the time React calls it — so `setAll`
 * swallows the failure there and leaves the refresh to the proxy, which runs before rendering
 * and can set headers. Actions and route handlers write normally.
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

export function supabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set. Copy .env.example to .env.local.',
    );
  }

  return { url, anonKey };
}

/** A request-scoped client. Never cache or share one: it closes over this request's cookies. */
export async function createClient(): Promise<SupabaseClient> {
  const { url, anonKey } = supabaseEnv();
  const store = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            store.set(name, value, options);
          }
        } catch {
          // Read-only cookie store: a Server Component is rendering. The proxy refreshed the
          // session on the way in, so the tokens on the request are already current.
        }
      },
    },
  });
}

/**
 * A client bound to the service role key, which bypasses RLS and unlocks the admin auth API
 * (inviting people, listing identities, reading last sign-in).
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is optional: the application is fully usable without it, and
 * everything that needs it degrades to a documented fallback rather than failing. Returns null
 * when it is absent so callers are forced by the type to handle that case.
 */
export function createAdminClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;

  const { url } = supabaseEnv();

  // No cookie store at all: this client must never adopt or overwrite the caller's session.
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function hasAdminAccess(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

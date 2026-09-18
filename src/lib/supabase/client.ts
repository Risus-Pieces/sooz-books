'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The browser client. It persists the session to cookies rather than local storage, which is
 * what lets the proxy and every Server Component read the same session the tab is holding.
 *
 * `createBrowserClient` is a singleton by default, so calling this from several components
 * hands back the same instance and there is only ever one token refresh in flight.
 */
export function createClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.');
  }

  return createBrowserClient(url, anonKey);
}

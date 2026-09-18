import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

import { supabaseEnv } from '@/lib/supabase/server';

/**
 * Session refresh for the request proxy.
 *
 * Access tokens are short-lived and nothing downstream of this file can mint a new one — a
 * Server Component may read cookies but not write them — so the refresh happens here, before
 * rendering starts, and the new tokens are written onto both the request (so this render sees
 * them) and the response (so the browser keeps them).
 *
 * Every redirect the proxy issues therefore has to carry the cookies this refresh produced,
 * which is what `redirectWithSession` is for. Returning a bare `NextResponse.redirect` would
 * silently drop a rotated refresh token and sign people out at random.
 */
export interface SessionRefresh {
  /** Pass-through response holding any refreshed auth cookies. */
  response: NextResponse;
  /** The verified user, or null when the request carries no usable session. */
  user: User | null;
  /**
   * No-store headers Supabase asks for whenever it writes auth cookies, kept apart from
   * `response.headers` because those also carry Next's internal proxy headers, which must not
   * be copied onto a redirect.
   */
  authHeaders: Readonly<Record<string, string>>;
}

export async function updateSession(request: NextRequest): Promise<SessionRefresh> {
  const { url, anonKey } = supabaseEnv();

  let response = NextResponse.next({ request });
  const authHeaders: Record<string, string> = {};

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // A response that sets auth cookies must never be cached by a CDN, or one person's
        // tokens get served to the next visitor.
        for (const [key, headerValue] of Object.entries(headers)) {
          authHeaders[key] = headerValue;
          response.headers.set(key, headerValue);
        }
      },
    },
  });

  // getUser() validates the token against the auth server. getSession() only decodes whatever
  // the cookie claims, which is not something authorisation may rest on.
  const { data, error } = await supabase.auth.getUser();

  return { response, user: error ? null : data.user, authHeaders };
}

/** A redirect carrying the refreshed auth cookies and their no-cache headers. */
export function redirectWithSession(refresh: SessionRefresh, url: URL): NextResponse {
  const redirect = NextResponse.redirect(url);

  for (const cookie of refresh.response.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  for (const [key, value] of Object.entries(refresh.authHeaders)) {
    redirect.headers.set(key, value);
  }

  return redirect;
}

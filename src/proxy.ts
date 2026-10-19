import type { NextRequest, NextResponse } from 'next/server';

import { redirectWithSession, updateSession } from '@/lib/supabase/middleware';

/**
 * Runs before every page render. Two jobs, in this order:
 *
 *  1. refresh the Supabase session, because this is the only place in the request that can
 *     write cookies before rendering begins;
 *  2. decide, cheaply, whether the request is allowed to reach a render at all.
 *
 * Step 2 is a coarse gate, not the authorisation boundary. It knows whether someone is signed
 * in, nothing more. Whether they are still an active user, and what their role permits, is
 * settled against the database in `@/lib/auth/session` where the answer can be trusted.
 *
 * Next 16 renamed this file convention from `middleware` to `proxy`; the helper it calls still
 * lives at `@/lib/supabase/middleware`, which is what Supabase's own guides call it.
 */

/**
 * The only paths that may be reached without a browser session. `/mcp` and the discovery documents
 * under `/.well-known/` are called by Claude, not by a browser: `/mcp` checks its own bearer token
 * (see `@/lib/mcp/auth`) and answers 401 with the way to sign in, which a redirect to /login would
 * hide. The OAuth consent screen is deliberately not here: it needs a signed-in person.
 */
const PUBLIC_PREFIXES = ['/login', '/auth/', '/mcp', '/.well-known/'] as const;

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const refresh = await updateSession(request);
  const { pathname, search } = request.nextUrl;

  const isPublic = PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );

  if (!refresh.user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    // Where to land once they are back: kept whole, path and query, so a deep link survives.
    url.searchParams.set('next', `${pathname}${search}`);
    return redirectWithSession(refresh, url);
  }

  // A signed-in person has no use for the login screen — unless they are there to finish
  // setting up an invited account, or to be told their access has been switched off, which is
  // what `stage` marks. Bouncing those two would loop.
  if (refresh.user && pathname === '/login' && !request.nextUrl.searchParams.has('stage')) {
    const next = safeNext(request.nextUrl.searchParams.get('next'));
    return redirectWithSession(refresh, new URL(next ?? '/dashboard', request.nextUrl.origin));
  }

  return refresh.response;
}

/**
 * `?next=` comes from the URL bar, so it is treated as hostile. Only a path on this origin is
 * allowed through: `//evil.example` is a protocol-relative URL that a browser reads as another
 * host, and a backslash is normalised to a slash by some of them.
 */
function safeNext(value: string | null): string | null {
  if (!value || !value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

export const config = {
  matcher: [
    /*
     * Everything except the static surface — build output, images, fonts and the like. Those
     * never carry a session, and running a token refresh against each one would multiply every
     * page load into a dozen calls to the auth server.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf|otf|txt|xml|webmanifest)$).*)',
  ],
};

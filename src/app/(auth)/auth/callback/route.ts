import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';

/**
 * Where every emailed link lands: magic sign-in links, invitations, and email confirmations.
 *
 * Two shapes arrive here. A link this application asked for carries `code`, the PKCE
 * authorisation code, redeemed with `exchangeCodeForSession`. A link Supabase generated from a
 * template carries `token_hash` and `type`, verified with `verifyOtp`. Both end with the
 * session written to cookies by the client's `setAll`, which a route handler is allowed to do.
 *
 * Nothing here trusts `next`: it is a query parameter, so it may only be a path on this origin.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const params = url.searchParams;
  const origin = request.nextUrl.origin;

  const failure = params.get('error_description') ?? params.get('error');
  if (failure) return NextResponse.redirect(loginUrl(origin, failure));

  const code = params.get('code');
  const tokenHash = params.get('token_hash');
  const type = params.get('type');
  const next = safeNext(params.get('next')) ?? defaultNext(type);

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(loginUrl(origin, expired(error.message)));
    return NextResponse.redirect(new URL(next, origin));
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    });
    if (error) return NextResponse.redirect(loginUrl(origin, expired(error.message)));
    return NextResponse.redirect(new URL(next, origin));
  }

  return NextResponse.redirect(
    loginUrl(origin, 'That link is incomplete. Ask for a new one and open it directly from the email.'),
  );
}

/** An invitation or a password recovery has to set a password before it is any use. */
function defaultNext(type: string | null): string {
  return type === 'invite' || type === 'recovery' ? '/login?stage=invite' : '/dashboard';
}

function loginUrl(origin: string, message: string): URL {
  const url = new URL('/login', origin);
  url.searchParams.set('error', message);
  return url;
}

function expired(message: string): string {
  return /expired|invalid/i.test(message)
    ? 'That link has expired or has already been used. Ask for a new one.'
    : message;
}

function safeNext(value: string | null): string | null {
  if (!value || !value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

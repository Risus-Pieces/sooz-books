import { NextResponse } from 'next/server';

import { getAppUser } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Records the person's answer on the consent screen and sends them back to the app that asked.
 *
 * A form post from a signed-in browser, so it refuses anything not submitted from this site, and it
 * acts only if the signed-in person is an active Sooz Books user.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  const sentFrom = request.headers.get('origin');
  const forwardedHost = request.headers.get('x-forwarded-host');
  if (sentFrom !== null && new URL(sentFrom).host !== (forwardedHost ?? new URL(origin).host)) {
    return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  }

  const user = await getAppUser();
  if (user === null) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const form = await request.formData();
  const authorizationId = form.get('authorization_id');
  const decision = form.get('decision');
  if (typeof authorizationId !== 'string' || authorizationId === '') {
    return NextResponse.json({ error: 'Missing authorization_id.' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } =
    decision === 'approve'
      ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
      : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
  if (error || !data) return NextResponse.json({ error: 'That request is no longer valid.' }, { status: 400 });

  return NextResponse.redirect(data.redirect_url, 303);
}

import { NextResponse } from 'next/server';

import { getAppUser } from '@/lib/auth/session';
import { isTrustedRedirect } from '@/lib/mcp/redirects';
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
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  }
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

  // The consent screen hides Allow for an address that is not Claude, but a form post can be made by
  // hand, so the same rule is applied here, where it counts.
  let approve = decision === 'approve';
  if (approve) {
    const details = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
    if (details.error || !details.data) return NextResponse.json({ error: 'That request is no longer valid.' }, { status: 400 });
    if ('authorization_id' in details.data && !isTrustedRedirect(details.data.redirect_uri)) approve = false;
  }
  const { data, error } =
    approve
      ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
      : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
  if (error || !data) return NextResponse.json({ error: 'That request is no longer valid.' }, { status: 400 });

  return NextResponse.redirect(data.redirect_url, 303);
}

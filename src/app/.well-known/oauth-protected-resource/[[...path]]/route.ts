import { publicOrigin } from '@/lib/mcp/auth';
import { supabaseEnv } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Protected resource metadata (RFC 9728). A client that gets a 401 from `/mcp` reads this to learn
 * who issues tokens for it: Supabase Auth, whose OAuth server does the sign-in and the consent.
 */
export async function GET(request: Request): Promise<Response> {
  const origin = publicOrigin(request);
  const { url } = supabaseEnv();
  return Response.json(
    {
      resource: `${origin}/mcp`,
      authorization_servers: [`${url}/auth/v1`],
      bearer_methods_supported: ['header'],
      resource_name: 'Sooz Books',
    },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}

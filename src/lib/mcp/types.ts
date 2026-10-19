import type { AppRole } from '@/lib/types';

/**
 * Who is on the other end of the connection: a signed-in Sooz Books user, reached through an OAuth
 * client (Claude's connector). Authorisation reads `role`, exactly as the web app does.
 */
export interface McpUser {
  id: string;
  email: string;
  fullName: string | null;
  role: AppRole;
  /** The OAuth client the access token was issued to, when the token says. */
  clientId: string | null;
}

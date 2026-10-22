import type { ApiKeyScope } from '@/db/schema';
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
  /**
   * Set when the caller is an unattended agent holding one of this person's scoped keys rather than
   * the person signed in. Within its scopes a key can read, sync, run auto-post rules and stage changes
   * for the person to confirm later; it can never confirm (commit) one.
   */
  key?: { id: string; name: string; scopes: readonly ApiKeyScope[] } | null;
}

/** How this caller's writes are recorded in the audit log, or null for the person themselves. */
export function viaOf(user: McpUser): string | null {
  return keyClientId(user);
}

/** A key's name is for people and need not be unique; the short id makes it so. */
export function keyClientId(user: McpUser): string | null {
  return user.key ? `key:${user.key.name}#${user.key.id.slice(0, 8)}` : null;
}

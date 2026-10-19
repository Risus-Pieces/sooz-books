/**
 * Where the consent screen may send a person once they have said yes.
 *
 * Supabase's OAuth server lets any program register itself as a client, with any redirect address
 * and any display name. Without a check, someone could register a client called "Claude" that sends
 * the signed-in owner's approval to their own server. So Sooz Books only completes a connection to
 * Claude itself: its hosted apps, or the person's own machine (Claude Code listens on loopback).
 */
const CLAUDE_HOSTS = new Set(['claude.ai', 'www.claude.ai', 'claude.com', 'www.claude.com']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isTrustedRedirect(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:' && CLAUDE_HOSTS.has(url.hostname.toLowerCase())) return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

import { describe, expect, it } from 'vitest';

import { isTrustedRedirect } from './redirects';

describe('isTrustedRedirect', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://www.claude.ai/callback',
    'http://localhost:54321/callback',
    'http://127.0.0.1:8080/callback',
    'http://[::1]:8080/callback',
  ])('trusts %s', (uri) => expect(isTrustedRedirect(uri)).toBe(true));

  it.each([
    'https://evil.example/callback',
    'https://claude.ai.evil.example/callback',
    'https://evilclaude.ai/callback',
    'https://claude.ai@evil.example/callback',
    'http://claude.ai/callback',
    'https://localhost/callback',
    'http://localhost.evil.example/callback',
    'javascript:alert(1)',
    'claude://callback',
    'not a url',
    '',
  ])('refuses %s', (uri) => expect(isTrustedRedirect(uri)).toBe(false));
});

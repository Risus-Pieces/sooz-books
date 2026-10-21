import { describe, expect, it } from 'vitest';

import { decryptToken, encryptToken } from './crypto';
import { PlaidError, createPlaidClient, plaidConfig } from './plaid-client';

const CONFIG = { clientId: 'cid', secret: 'sec', env: 'sandbox' as const };

function fakeFetch(status: number, body: string, seen: { url?: string; body?: string } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = String(init?.body);
    return new Response(body, { status });
  }) as typeof fetch;
}

describe('the Plaid client', () => {
  it('keeps amounts as the exact text Plaid sent', async () => {
    const body = '{"added":[{"transaction_id":"t1","account_id":"a1","amount":0.1,"date":"2026-10-01","name":"X","merchant_name":null,"pending":false,"iso_currency_code":"USD"},{"transaction_id":"t2","account_id":"a1","amount":-1250.50,"date":"2026-10-01","name":"Y","merchant_name":null,"pending":false,"iso_currency_code":"USD"}],"modified":[],"removed":[],"next_cursor":"c2","has_more":false}';
    const page = await createPlaidClient(CONFIG, fakeFetch(200, body)).syncTransactions('tok', 'c1');
    expect(page.added.map((t) => t.amount)).toEqual(['0.1', '-1250.50']);
    expect(page.next_cursor).toBe('c2');
  });

  it('sends credentials in the body to the right environment and passes the cursor', async () => {
    const seen: { url?: string; body?: string } = {};
    await createPlaidClient(CONFIG, fakeFetch(200, '{"added":[],"modified":[],"removed":[],"next_cursor":"x","has_more":false}', seen)).syncTransactions('tok', 'c1');
    expect(seen.url).toBe('https://sandbox.plaid.com/transactions/sync');
    expect(JSON.parse(seen.body!)).toMatchObject({ client_id: 'cid', secret: 'sec', access_token: 'tok', cursor: 'c1' });
  });

  it("turns Plaid's error into a typed error with its display message", async () => {
    const client = createPlaidClient(CONFIG, fakeFetch(400, '{"error_code":"ITEM_LOGIN_REQUIRED","error_message":"x","display_message":"Sign in to the bank again."}'));
    await expect(client.syncTransactions('tok', null)).rejects.toEqual(new PlaidError('ITEM_LOGIN_REQUIRED', 'Sign in to the bank again.'));
  });

  it('is off unless both keys are set, and defaults to the sandbox', () => {
    expect(plaidConfig({})).toBeNull();
    expect(plaidConfig({ PLAID_CLIENT_ID: 'a' })).toBeNull();
    expect(plaidConfig({ PLAID_CLIENT_ID: 'a', PLAID_SECRET: 'b' })?.env).toBe('sandbox');
    expect(plaidConfig({ PLAID_CLIENT_ID: 'a', PLAID_SECRET: 'b', PLAID_ENV: 'production' })?.env).toBe('production');
  });
});

describe('access token encryption', () => {
  const env = { PLAID_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64') };

  it('round-trips, and never stores the token in plain text', () => {
    const sealed = encryptToken('access-sandbox-123', env);
    expect(sealed).not.toContain('access-sandbox-123');
    expect(decryptToken(sealed, env)).toBe('access-sandbox-123');
    expect(encryptToken('access-sandbox-123', env)).not.toBe(sealed);
  });

  it('refuses a tampered token, a wrong key and a missing key', () => {
    const sealed = encryptToken('secret', env);
    const parts = sealed.split(':');
    parts[3] = Buffer.from('tampered!').toString('base64');
    expect(() => decryptToken(parts.join(':'), env)).toThrow();
    expect(() => decryptToken(sealed, { PLAID_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64') })).toThrow();
    expect(() => encryptToken('x', {})).toThrow(/PLAID_TOKEN_KEY/);
    expect(() => encryptToken('x', { PLAID_TOKEN_KEY: 'short' })).toThrow(/32 bytes/);
  });
});

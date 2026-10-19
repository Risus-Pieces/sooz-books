import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { eq } from 'drizzle-orm';

import { appUsers } from '@/db/schema';

import { bearerOf, clientIdOf } from './auth';
import { handleMcpRequest } from './http';
import { seededUserId } from './test-support';

afterAll(closeTestDb);

const ENDPOINT = 'https://books.example/mcp';
const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function rpc(method: string, params: unknown, token?: string, id = 1): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { ...HEADERS, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

describe('bearer parsing', () => {
  it('reads a bearer token and nothing else', () => {
    const req = (value?: string) => new Request(ENDPOINT, { headers: value === undefined ? {} : { authorization: value } });
    expect(bearerOf(req('Bearer abc.def'))).toBe('abc.def');
    expect(bearerOf(req('bearer abc'))).toBe('abc');
    expect(bearerOf(req('Basic abc'))).toBeNull();
    expect(bearerOf(req('Bearer'))).toBeNull();
    expect(bearerOf(req())).toBeNull();
  });

  it('reads the client id out of a token, and shrugs at junk', () => {
    const payload = Buffer.from(JSON.stringify({ client_id: 'abc-123' })).toString('base64url');
    expect(clientIdOf(`x.${payload}.y`)).toBe('abc-123');
    expect(clientIdOf('not-a-jwt')).toBeNull();
    expect(clientIdOf('x.!!!.y')).toBeNull();
  });
});

describe('/mcp without a valid sign-in', () => {
  it('answers 401 and says where to sign in', async () => {
    const response = await handleMcpRequest(rpc('tools/list', {}));

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://books.example/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('answers 401 to a token the auth server does not recognise', async () => {
    const response = await handleMcpRequest(rpc('tools/list', {}, 'bogus'), { verify: async () => null });
    expect(response.status).toBe(401);
  });

  it('uses the public host behind a proxy, not the internal one', async () => {
    const request = new Request('http://localhost:3000/mcp', {
      method: 'POST',
      headers: { 'x-forwarded-host': 'sooz-books.vercel.app', 'x-forwarded-proto': 'https' },
    });
    const response = await handleMcpRequest(request);
    expect(response.headers.get('www-authenticate')).toContain('https://sooz-books.vercel.app/.well-known/');
  });

  it('refuses anything but POST', async () => {
    const response = await handleMcpRequest(new Request(ENDPOINT, { method: 'GET' }));
    expect(response.status).toBe(405);
  });
});

describe.skipIf(!hasDatabase)('/mcp with a valid sign-in', () => {
  it('lists the tools, with the changing ones behind stage and commit', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);
      const response = await handleMcpRequest(rpc('tools/list', {}, 'good'), {
        verify: async () => ({ userId, clientId: 'claude' }),
        exec: tx,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: { tools: { name: string; inputSchema: { properties: object } }[] } };
      const names = body.result.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        'commit_staged',
        'get_journal_entry',
        'list_accounts',
        'list_bank_accounts',
        'list_journal_entries',
        'review_queue',
        'run_report',
        'stage_bank_decisions',
        'stage_journal_entry',
        'stage_new_account',
        'whoami',
      ]);
      // No tool takes an account or an amount along with a commit: the only way to post is a stage id.
      const commit = body.result.tools.find((tool) => tool.name === 'commit_staged');
      expect(Object.keys(commit?.inputSchema.properties ?? {})).toEqual(['stage_id']);
    });
  });

  it("runs a tool as the signed-in person, with their role", async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);
      await tx.update(appUsers).set({ role: 'viewer' }).where(eq(appUsers.id, userId));
      const response = await handleMcpRequest(rpc('tools/call', { name: 'whoami', arguments: {} }, 'good'), {
        verify: async () => ({ userId, clientId: 'claude' }),
        exec: tx,
      });

      const body = (await response.json()) as { result: { content: { text: string }[] } };
      expect(body.result.content[0].text).toContain('role: viewer');
      expect(body.result.content[0].text).toContain('read reports');
      expect(body.result.content[0].text).not.toContain('post journal entries');
    });
  });

  it('turns away an account that has been switched off', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);
      await tx.update(appUsers).set({ active: false }).where(eq(appUsers.id, userId));
      const response = await handleMcpRequest(rpc('tools/list', {}, 'good'), {
        verify: async () => ({ userId, clientId: null }),
        exec: tx,
      });
      expect(response.status).toBe(403);
    });
  });

  it('turns away a valid sign-in that is not a Sooz Books user', async () => {
    const response = await handleMcpRequest(rpc('tools/list', {}, 'good'), {
      verify: async () => ({ userId: '00000000-0000-4000-8000-0000000000aa', clientId: null }),
    });
    expect(response.status).toBe(403);
  });
});

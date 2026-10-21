/**
 * The `/mcp` endpoint, as a plain function of a `Request`.
 *
 * Streamable HTTP in stateless mode: every request carries its own bearer token and gets its own
 * server and transport, so nothing about a connection lives in memory between calls (serverless
 * instances come and go) and a deactivated account stops working on its next call.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { type AuthDeps, authenticate, resourceMetadataUrl } from './auth';
import { actingVia } from '@/db/client';

import { createMcpServer } from './server';
import { viaOf } from './types';

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export async function handleMcpRequest(request: Request, deps: AuthDeps = {}): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST JSON-RPC to this endpoint.' }, id: null }, 405, { allow: 'POST' });
  }

  const auth = await authenticate(request, deps);
  if (!auth.ok) {
    const challenge = `Bearer error="${auth.error}", error_description="${auth.message}", resource_metadata="${resourceMetadataUrl(request)}"`;
    return json({ error: auth.error, error_description: auth.message }, auth.status, { 'www-authenticate': challenge });
  }

  const user = auth.user;
  const serve = async (): Promise<Response> => {
    const server = createMcpServer(user);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
    }
  };
  // Every write a key's call makes is recorded in the audit log as made through that key.
  const via = viaOf(user);
  return via === null ? serve() : actingVia(via, serve);
}

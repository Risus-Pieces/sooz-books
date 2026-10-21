import { handleMcpRequest } from '@/lib/mcp/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A bank sync started from the connector reads Plaid and imports; the ceiling allows a slow night.
export const maxDuration = 300;

/** The Sooz Books MCP endpoint. See `src/lib/mcp/http.ts`. */
export async function POST(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export async function GET(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

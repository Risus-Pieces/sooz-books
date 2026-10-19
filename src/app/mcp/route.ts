import { handleMcpRequest } from '@/lib/mcp/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A batch of fifty bank decisions stages and posts in well under this; the ceiling is for a slow database.
export const maxDuration = 60;

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

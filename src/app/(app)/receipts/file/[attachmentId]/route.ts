import { NextResponse, type NextRequest } from 'next/server';

import { db } from '@/db/client';
import { can } from '@/lib/auth/roles';
import { getAppUser } from '@/lib/auth/session';
import { receiptFilePath } from '@/lib/receipts/file-access';
import { createReceiptStorage } from '@/lib/receipts/storage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens a stored receipt. The bucket is private, so this checks who is asking and then redirects
 * to a signed URL that works for one minute. Only files that belong to a receipt are reachable.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> },
): Promise<NextResponse> {
  const user = await getAppUser();
  if (user === null) return NextResponse.json({ error: 'Sign in again.' }, { status: 401 });
  if (!can(user.role, 'reports.view')) return NextResponse.json({ error: 'Your role cannot open this.' }, { status: 403 });

  const { attachmentId } = await params;
  if (!UUID.test(attachmentId)) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const path = await receiptFilePath(db, attachmentId);
  if (path === null) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const storage = createReceiptStorage();
  if (storage === null) return NextResponse.json({ error: 'File storage is not set up.' }, { status: 503 });

  const response = NextResponse.redirect(await storage.signedUrl(path, 60));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

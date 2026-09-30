import { NextResponse, type NextRequest } from 'next/server';

import { can } from '@/lib/auth/roles';
import { getAppUser } from '@/lib/auth/session';
import { resolveReceiptExtractor } from '@/lib/receipts/extractor';
import { MAX_RECEIPT_BYTES } from '@/lib/receipts/files';
import { ingestReceipt } from '@/lib/receipts/ingest';
import { createReceiptStorage } from '@/lib/receipts/storage';

/** Reading a receipt takes a few seconds, occasionally tens: the model is the slow part. */
export const maxDuration = 120;

const json = (body: unknown, status = 200): NextResponse => NextResponse.json(body, { status });

/**
 * One receipt in, one proposal out.
 *
 * A route handler and not a server action, because files are large. It follows the action rules
 * all the same: it checks the capability first, and it never returns the text of an unexpected
 * failure. The browser sends one file per request so each card can show its own progress.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAppUser();
  if (user === null) return json({ error: 'Sign in again to upload receipts.' }, 401);
  if (!can(user.role, 'ledger.post')) return json({ error: 'Your role cannot post to the ledger.' }, 403);

  const storage = createReceiptStorage();
  if (storage === null) {
    return json({ error: 'File storage is not set up, so receipts cannot be saved right now.' }, 503);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'That upload could not be read. Try again.' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return json({ error: 'Choose a receipt to upload.' }, 400);
  if (file.size > MAX_RECEIPT_BYTES) return json({ error: 'That file is over 10 MB. Try a smaller photo or a PDF.' }, 413);

  try {
    const result = await ingestReceipt(
      { userId: user.id, filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
      { storage, extractor: resolveReceiptExtractor() },
    );
    if (!result.ok) return json({ error: result.message }, 422);
    return json({ proposal: result.proposal, alreadyFiled: result.alreadyFiled });
  } catch (error) {
    console.error('receipt upload failed', error);
    return json({ error: 'Could not read this receipt. Try again.' }, 500);
  }
}

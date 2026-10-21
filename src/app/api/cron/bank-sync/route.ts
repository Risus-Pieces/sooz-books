import { timingSafeEqual } from 'node:crypto';

import { actingVia } from '@/db/client';
import { syncAllFeeds } from '@/lib/feeds/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * The nightly bank sync, called by Vercel Cron with `Authorization: Bearer $CRON_SECRET`. Pulls new
 * bank lines into the review queue and runs the owner-approved auto-post rules. Every write is
 * recorded in the audit log as made through `cron:bank-sync`.
 */
export async function GET(request: Request): Promise<Response> {
  if (!authorised(request)) return Response.json({ error: 'Not allowed.' }, { status: 401 });
  const run = await actingVia('cron:bank-sync', () => syncAllFeeds());
  return Response.json({
    items: run.items.map((item) => ({
      institution: item.institution,
      error: item.error,
      accounts: item.accounts.map((a) => ({ name: a.bankAccountName, inserted: a.inserted, duplicates: a.duplicates })),
      ignored: item.ignored,
      changedLater: item.changedLater,
    })),
    autoPosted: run.autoPost.posted.length,
    autoPostFailed: run.autoPost.failed.length,
  });
}

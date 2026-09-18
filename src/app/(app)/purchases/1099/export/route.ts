/**
 * 1099-NEC workpaper download. Same year and threshold as the screen, so the
 * file is by construction what the reader was looking at.
 */

import { form1099Csv } from '@/components/arap/form-1099-csv';
import { form1099Report } from '@/lib/arap';
import { isForbiddenError } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';

import { read1099Params } from '../params';

export async function GET(request: Request): Promise<Response> {
  try {
    await requireCapability('reports.view');
  } catch (error) {
    if (isForbiddenError(error)) return new Response(error.message, { status: 403 });
    throw error;
  }

  const url = new URL(request.url);
  const { year, thresholdCents } = read1099Params(Object.fromEntries(url.searchParams.entries()));
  const report = await form1099Report(year, thresholdCents === null ? {} : { thresholdCents });
  const csv = form1099Csv(report.year, report.thresholdCents, [...report.vendors, ...report.candidates]);

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="sooz-1099-nec-${report.year}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

import { sql } from 'drizzle-orm';

import type { CalendarDate } from '@/lib/dates';
import type { LedgerDb } from '@/lib/ledger/post';

/** A posted receipt from the same vendor, on the same date, for the same total. */
export async function findPossibleDuplicate(
  exec: LedgerDb,
  input: { vendorId: string | null; vendorName: string | null; date: CalendarDate; totalCents: number },
): Promise<{ entryNo: number } | null> {
  const rows = await exec.execute<{ entry_no: string | number }>(sql`
    select e.entry_no
      from receipt_proposals rp
      join journal_entries e on e.id = rp.entry_id
     where rp.status = 'posted'
       and rp.receipt_date = ${input.date}::date
       and rp.total_cents = ${input.totalCents}
       and (
         (${input.vendorId}::uuid is not null and rp.vendor_id = ${input.vendorId}::uuid)
         or lower(rp.vendor_name) = lower(${input.vendorName ?? ''})
       )
     order by e.entry_no desc
     limit 1`);
  return rows[0] === undefined ? null : { entryNo: Number(rows[0].entry_no) };
}

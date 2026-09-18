/**
 * Document numbers: INV-1001, RCPT-1001, CM-1001, BPMT-1001, VC-1001.
 *
 * Each number comes from a counter row in `arap_number_series`, incremented
 * inside the transaction that creates the document. The row lock queues
 * concurrent creators behind one another, and a rolled-back transaction takes
 * its increment with it, so committed numbers run in order without gaps and
 * none is ever handed out twice. Documents are voided, never deleted, so a
 * number once used stays used.
 */

import { sql } from 'drizzle-orm';

import type { LedgerDb } from './common';
import { ArapError } from './errors';

export type NumberedDocument = 'invoice' | 'receipt' | 'credit_memo' | 'bill_payment' | 'vendor_credit';

const TARGET: Readonly<Record<NumberedDocument, { table: string; column: string }>> = {
  invoice: { table: 'invoices', column: 'invoice_no' },
  receipt: { table: 'receipts', column: 'receipt_no' },
  credit_memo: { table: 'credit_memos', column: 'memo_no' },
  bill_payment: { table: 'bill_payments', column: 'payment_no' },
  vendor_credit: { table: 'vendor_credits', column: 'credit_no' },
};

interface SeriesRow extends Record<string, unknown> {
  prefix: string;
  issued: string | number;
  pad_width: number;
}

/** A number no document has, issued in order. Must run inside the creating transaction. */
export async function nextDocumentNumber(tx: LedgerDb, kind: NumberedDocument): Promise<string> {
  const target = TARGET[kind];
  // A document imported with a number of its own could already hold the next
  // value in the series; skip past it rather than fail the unique constraint.
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const [row] = await tx.execute<SeriesRow>(sql`
      update arap_number_series
         set next_no = next_no + 1, updated_at = now()
       where kind = ${kind}
      returning prefix, next_no - 1 as issued, pad_width
    `);
    if (row === undefined) {
      throw new ArapError('invalid_state', `No number series is configured for ${kind} documents.`);
    }
    const number = `${row.prefix}${String(row.issued).padStart(row.pad_width, '0')}`;
    const taken = await tx.execute<{ taken: boolean }>(sql`
      select exists (
        select 1 from ${sql.identifier(target.table)} where ${sql.identifier(target.column)} = ${number}
      ) as taken
    `);
    if (taken[0]?.taken !== true) return number;
  }
  throw new ArapError('invalid_state', `Could not find a free ${kind} number.`);
}

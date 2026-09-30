import { bigint, date, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import type { ExtractedReceipt, ProposalLine, ProposalStatus, ReceiptWarning } from '@/lib/receipts/types';

import { vendors } from './arap';
import { appUsers, journalEntries } from './ledger';
import { attachments } from './planning';

/**
 * A receipt the assistant has read and a person has not yet posted or skipped.
 *
 * Mirrors `supabase/migrations/0046_receipt_proposals.sql`. Nothing here is a ledger entry:
 * `entryId` is set only when the entry posts.
 */
export const receiptProposals = pgTable('receipt_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  attachmentId: uuid('attachment_id')
    .notNull()
    .unique('receipt_proposals_attachment_id_key')
    .references(() => attachments.id),
  uploadedBy: uuid('uploaded_by')
    .notNull()
    .references(() => appUsers.id),
  payerId: uuid('payer_id').references(() => appUsers.id),
  status: text('status').$type<ProposalStatus>().notNull().default('proposed'),
  vendorId: uuid('vendor_id').references(() => vendors.id),
  vendorName: text('vendor_name'),
  receiptDate: date('receipt_date', { mode: 'string' }),
  totalCents: bigint('total_cents', { mode: 'number' }),
  extracted: jsonb('extracted').$type<ExtractedReceipt | null>(),
  error: text('error'),
  lines: jsonb('lines').$type<ProposalLine[]>().notNull().default([]),
  warnings: jsonb('warnings').$type<ReceiptWarning[]>().notNull().default([]),
  entryId: uuid('entry_id').references(() => journalEntries.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ReceiptProposal = typeof receiptProposals.$inferSelect;
export type NewReceiptProposal = typeof receiptProposals.$inferInsert;

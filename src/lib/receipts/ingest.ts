import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { attachments, receiptProposals } from '@/db/schema';
import { loadVendorIndex, resolveVendor } from '@/lib/banking/vendors';
import { type CalendarDate, today as booksToday } from '@/lib/dates';
import type { LedgerDb } from '@/lib/ledger/post';

import { loadAllowedAccounts, vendorHistoryAccount } from './accounts';
import { ExtractionError, type ReceiptExtractor } from './extractor';
import { findPossibleDuplicate } from './duplicates';
import { checkReceiptFile, safeFilename } from './files';
import { defaultPayer, listPayers } from './payers';
import { buildProposalLines, recomputeWarnings } from './propose';
import { loadProposalView } from './queries';
import { type ReceiptStorage, receiptStoragePath } from './storage';
import { inReceiptTx, readerOf } from './tx';
import type { ExtractedReceipt, ProposalView, ReceiptWarning } from './types';

export interface IngestDeps {
  storage: ReceiptStorage;
  extractor: ReceiptExtractor;
  /** Run inside this transaction (tests). Without it, ingest opens its own through `withActor`. */
  tx?: LedgerDb;
  /** Pinned in tests so date warnings do not depend on the day the suite runs. */
  today?: () => CalendarDate;
}

export interface IngestInput {
  userId: string;
  filename: string;
  bytes: Uint8Array;
}

export type IngestResult =
  | { ok: true; proposal: ProposalView; alreadyFiled: boolean }
  | { ok: false; message: string };

// A type alias so it can be the row type of `execute<T>` (see `AllowedAccount`).
type FiledReceipt = {
  id: string;
  /**
   * Nothing usable came of it (the read failed, the model found it illegible) or the member skipped
   * it: choosing the same file again reads it again rather than saying "already filed".
   */
  retryable: boolean;
};

async function findProposalByHash(exec: LedgerDb, sha256: string): Promise<FiledReceipt | null> {
  const rows = await exec.execute<FiledReceipt>(sql`
    select rp.id,
           (rp.status = 'skipped'
            or (rp.status = 'proposed'
                and (rp.error is not null or rp.warnings @> '[{"code":"unreadable"}]'::jsonb))) as retryable
      from receipt_proposals rp
      join attachments a on a.id = rp.attachment_id
     where a.sha256 = ${sha256}
     limit 1`);
  return rows[0] ?? null;
}

/**
 * A file in, a proposal out.
 *
 * Order matters. The file is checked and hashed first, so a repeat is recognised before anything
 * is spent. It is stored before it is read, so a receipt the model cannot read is still kept, and
 * choosing that same file again reads it again instead of calling it filed.
 * The model is called outside any transaction, because it is slow; the writes that follow are one
 * short transaction under an advisory lock on the file's hash, so two identical uploads racing
 * each other still make one proposal.
 */
export async function ingestReceipt(input: IngestInput, deps: IngestDeps): Promise<IngestResult> {
  const check = checkReceiptFile(input.bytes);
  if (!check.ok) return { ok: false, message: check.message };

  const ctx = { userId: input.userId, tx: deps.tx };
  const reader = await readerOf(ctx);

  const filed = await findProposalByHash(reader, check.sha256);
  if (filed !== null && !filed.retryable) {
    const proposal = await loadProposalView(reader, filed.id);
    if (proposal !== null) return { ok: true, proposal, alreadyFiled: true };
  }

  const path = receiptStoragePath(check.sha256, input.filename, check.extension);
  // A retry's file is already stored under its original path; a new name would leave an orphan.
  if (!filed?.retryable) await deps.storage.put(path, input.bytes, check.mediaType);

  // Sequential on purpose: the connection pool this app shares is small.
  const allowed = await loadAllowedAccounts(reader);
  const payers = await listPayers(reader);
  // `loadVendorIndex` wants the caller's transaction when there is one (a second pooled connection
  // while holding the first deadlocks a small pool); a test's `tx` is one, typed more loosely.
  const vendorIndex = await loadVendorIndex(deps.tx === undefined ? {} : { tx: deps.tx as Tx });

  let extracted: ExtractedReceipt | null = null;
  let error: string | null = null;
  const notes: ReceiptWarning[] = [];
  try {
    extracted = await deps.extractor.extract({
      bytes: input.bytes,
      mediaType: check.mediaType,
      accounts: allowed.map((a) => ({ code: a.code, name: a.name, description: a.description })),
    });
  } catch (caught) {
    if (!(caught instanceof ExtractionError)) throw caught;
    error = caught.message;
    notes.push({ code: caught.kind === 'no_model' ? 'no_model' : 'unreadable', message: caught.message, blocking: true });
  }

  const match = extracted?.vendorName ? resolveVendor(extracted.vendorName, vendorIndex) : null;
  const allowedIds = new Set(allowed.map((a) => a.id));
  let vendorAccountId =
    match?.defaultExpenseAccountId && allowedIds.has(match.defaultExpenseAccountId) ? match.defaultExpenseAccountId : null;
  if (vendorAccountId === null && match !== null) {
    vendorAccountId = await vendorHistoryAccount(reader, match.vendorId, [...allowedIds]);
  }

  const built =
    extracted === null
      ? { lines: [], notes: [] }
      : buildProposalLines({
          extracted,
          idByCode: new Map(allowed.map((a) => [a.code, a.id])),
          vendorAccountId,
        });
  notes.push(...built.notes);

  if (extracted !== null && extracted.totalCents !== null && extracted.date !== null) {
    const duplicate = await findPossibleDuplicate(reader, {
      vendorId: match?.vendorId ?? null,
      vendorName: extracted.vendorName,
      date: extracted.date,
      totalCents: extracted.totalCents,
    });
    if (duplicate !== null) {
      notes.push({
        code: 'possible_duplicate',
        message: `This looks like a receipt already posted as entry #${duplicate.entryNo}.`,
        blocking: false,
      });
    }
  }

  const payerId = defaultPayer(payers, input.userId);
  const warnings = recomputeWarnings(
    notes,
    { payerId, date: extracted?.date ?? null, totalCents: extracted?.totalCents ?? null, lines: built.lines },
    (deps.today ?? booksToday)(),
  );

  // What the proposal says, for a new one and for a retry of one whose last reading failed.
  const fields = {
    payerId,
    vendorId: match?.vendorId ?? null,
    vendorName: match?.vendorName ?? extracted?.vendorName ?? null,
    receiptDate: extracted?.date ?? null,
    totalCents: extracted?.totalCents ?? null,
    extracted,
    error,
    lines: built.lines,
    warnings,
  };

  const proposalId = randomUUID();
  const outcome = await inReceiptTx(ctx, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${check.sha256}))`);
    const now = await findProposalByHash(tx, check.sha256);
    if (now !== null && !now.retryable) return { proposalId: now.id, alreadyFiled: true };
    if (now !== null) {
      await tx
        .update(receiptProposals)
        .set({ ...fields, status: 'proposed', updatedAt: new Date() })
        .where(eq(receiptProposals.id, now.id));
      return { proposalId: now.id, alreadyFiled: false };
    }

    const [attachment] = await tx
      .insert(attachments)
      .values({
        entityType: 'receipt_proposal',
        entityId: proposalId,
        filename: safeFilename(input.filename, `receipt.${check.extension}`),
        storagePath: path,
        mimeType: check.mediaType,
        sizeBytes: input.bytes.byteLength,
        sha256: check.sha256,
        uploadedBy: input.userId,
      })
      .returning({ id: attachments.id });

    await tx.insert(receiptProposals).values({
      id: proposalId,
      attachmentId: attachment.id,
      uploadedBy: input.userId,
      status: 'proposed',
      ...fields,
    });
    return { proposalId, alreadyFiled: false };
  });

  const proposal = await loadProposalView(reader, outcome.proposalId);
  if (proposal === null) return { ok: false, message: 'The receipt was saved but could not be loaded. Reload the page.' };
  return { ok: true, proposal, alreadyFiled: outcome.alreadyFiled };
}

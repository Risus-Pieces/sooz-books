/**
 * Reversals. A posted entry is immutable, so the only way to undo one is to post
 * its mirror image and link the two together. Every correction in the product
 * goes through here: there is no edit and no delete.
 */

import { and, asc, eq } from 'drizzle-orm';

import { withActor } from '@/db/client';
import { journalEntries, journalLines } from '@/db/schema';
import { type CalendarDate, isCalendarDate, periodOf } from '@/lib/dates';

import {
  AlreadyReversedError,
  EntryNotFoundError,
  EntryNotPostedError,
  InvalidDateError,
} from './errors';
import { earliestOpenPeriod, isPeriodOpen, periodStart } from './periods';
import { type DraftLine, type LedgerDb, postJournalEntry } from './post';

export interface ReverseOptions {
  /** Defaults to the original entry's own date. */
  date?: CalendarDate;
  memo?: string;
  userId: string | null;
  tx?: LedgerDb;
}

export interface ReversalResult {
  entryId: string;
  entryNo: number;
  date: CalendarDate;
  /** The date asked for, when a closed period forced the reversal to move. */
  requestedDate: CalendarDate | null;
  reversedEntryId: string;
  reversedEntryNo: number;
  /**
   * Whether `reversed_by_id` could be stamped on the original. False when the
   * original sits in a closed period, where the database refuses every update to
   * a posted entry. The reversal's own `reverses_id` still records the pair.
   */
  linked: boolean;
}

function reversalMemo(entryNo: number, originalMemo: string | null, given: string | undefined): string {
  if (given !== undefined && given.trim() !== '') return given.trim();
  const tail = originalMemo === null || originalMemo === '' ? '' : ` — ${originalMemo}`;
  return `Reversal of #${entryNo}${tail}`;
}

/**
 * Posts the mirror of `entryId`: same accounts, same dimensions, debits and
 * credits swapped, `reverses_id` pointing back at the original, and the original
 * marked as reversed.
 *
 * If the requested date falls in a closed period the reversal is dated on the
 * first day of the earliest open period after it, and says so in its memo — a
 * closed month cannot be reopened just to carry a correction, and a reversal
 * that silently vanished would be worse than one that moves.
 *
 * @throws {EntryNotFoundError} no such entry
 * @throws {EntryNotPostedError} the entry is still a draft; delete it instead
 * @throws {AlreadyReversedError} the entry has already been reversed
 */
export async function reverseEntry(
  entryId: string,
  options: ReverseOptions,
): Promise<ReversalResult> {
  if (options.date !== undefined && !isCalendarDate(options.date)) {
    throw new InvalidDateError(String(options.date));
  }

  const work = async (tx: LedgerDb): Promise<ReversalResult> => {
    // The lock is what makes "reverse once" true under concurrency: a second
    // caller waits here and then sees reversed_by_id already set.
    const [original] = await tx
      .select({
        id: journalEntries.id,
        entryNo: journalEntries.entryNo,
        entryDate: journalEntries.entryDate,
        memo: journalEntries.memo,
        status: journalEntries.status,
        sourceId: journalEntries.sourceId,
        reversedById: journalEntries.reversedById,
      })
      .from(journalEntries)
      .where(eq(journalEntries.id, entryId))
      .for('update');

    if (original === undefined) throw new EntryNotFoundError(entryId);
    if (original.status !== 'posted') throw new EntryNotPostedError(entryId, original.status);

    // `reverses_id` on the mirror is the authoritative record of the pair: it is
    // written when the reversal is inserted and can never change afterwards.
    // `reversed_by_id` on the original is a convenience back-pointer that a
    // closed period can prevent being written, so it cannot be the only check.
    const [existing] = await tx
      .select({ id: journalEntries.id, entryNo: journalEntries.entryNo })
      .from(journalEntries)
      .where(eq(journalEntries.reversesId, entryId))
      .limit(1);
    if (existing !== undefined || original.reversedById !== null) {
      throw new AlreadyReversedError(entryId, original.entryNo, existing?.entryNo ?? null);
    }

    const lines = await tx
      .select({
        accountId: journalLines.accountId,
        debitCents: journalLines.debitCents,
        creditCents: journalLines.creditCents,
        memo: journalLines.memo,
        channelId: journalLines.channelId,
        customerId: journalLines.customerId,
        vendorId: journalLines.vendorId,
        productId: journalLines.productId,
      })
      .from(journalLines)
      .where(eq(journalLines.entryId, entryId))
      .orderBy(asc(journalLines.lineNo));

    const requested = options.date ?? original.entryDate;
    const open = await isPeriodOpen(requested, tx);
    const originalPeriodOpen =
      requested === original.entryDate ? open : await isPeriodOpen(original.entryDate, tx);
    let date = requested;
    let movedFrom: CalendarDate | null = null;
    if (!open) {
      const target = await earliestOpenPeriod(requested, tx);
      date = periodStart(target.year, target.month);
      movedFrom = requested;
    }

    const closedNote =
      movedFrom === null
        ? ''
        : ` (${movedFrom} is in closed period ${String(periodOf(movedFrom).year)}-${String(
            periodOf(movedFrom).month,
          ).padStart(2, '0')}; posted to the first open period instead)`;

    const mirrored: DraftLine[] = lines.map((line) => ({
      accountId: line.accountId,
      // The swap is the whole point: every debit becomes a credit and back.
      debitCents: line.creditCents,
      creditCents: line.debitCents,
      ...(line.memo === null ? {} : { memo: line.memo }),
      channelId: line.channelId,
      customerId: line.customerId,
      vendorId: line.vendorId,
      productId: line.productId,
    }));

    const posted = await postJournalEntry(
      {
        date,
        memo: `${reversalMemo(original.entryNo, original.memo, options.memo)}${closedNote}`,
        sourceType: 'reversal',
        sourceId: original.sourceId,
        reversesId: original.id,
        lines: mirrored,
      },
      { userId: options.userId, tx },
    );

    // Linking the reversal is the one field the immutability trigger lets
    // through — but only while the original's own period is still open, because
    // a separate trigger refuses every update to a posted entry dated in a
    // closed one. The mirror's `reverses_id` already records the pair, so the
    // back-pointer is skipped rather than the reversal refused.
    if (originalPeriodOpen) {
      await tx
        .update(journalEntries)
        .set({ reversedById: posted.entryId })
        .where(and(eq(journalEntries.id, original.id), eq(journalEntries.status, 'posted')));
    }

    return {
      entryId: posted.entryId,
      entryNo: posted.entryNo,
      date,
      requestedDate: movedFrom,
      reversedEntryId: original.id,
      reversedEntryNo: original.entryNo,
      linked: originalPeriodOpen,
    };
  };

  return options.tx ? work(options.tx) : withActor(options.userId, work);
}

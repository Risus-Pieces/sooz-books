import { and, eq, sql } from 'drizzle-orm';

import { appUsers, attachments, receiptProposals, vendors } from '@/db/schema';
import { createVendor } from '@/lib/arap/parties';
import { type CalendarDate, today as booksToday } from '@/lib/dates';
import { isLedgerError } from '@/lib/ledger/errors';
import { type DraftLine, postJournalEntry, translateLedgerDbError } from '@/lib/ledger/post';

import { loadAllowedAccounts } from './accounts';
import { findPossibleDuplicate } from './duplicates';
import { recomputeWarnings } from './propose';
import { loadProposalViews } from './queries';
import { type ReceiptCtx, inReceiptTx, readerOf } from './tx';

export type ReceiptErrorCode = 'not_found' | 'not_proposed' | 'blocked' | 'duplicate' | 'payer' | 'accounts';

/** A refusal with words a member can read. `code` is for code that branches. */
export class ReceiptError extends Error {
  constructor(
    readonly code: ReceiptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReceiptError';
  }
}

export function isReceiptError(error: unknown): error is ReceiptError {
  return error instanceof ReceiptError;
}

export interface PostOptions extends ReceiptCtx {
  /** The member has seen the possible duplicate and says this is a different purchase. */
  confirmedNew?: boolean;
  /** Pinned in tests. */
  today?: () => CalendarDate;
}

export interface PostedReceipt {
  entryId: string;
  entryNo: number;
}

const GENERIC_FAILURE = 'Could not post this receipt. Try again.';

/**
 * The words to show for anything these functions throw. A refusal made to be read (ours, or the
 * ledger's) is shown as written; anything else, such as a database error, is not, because its text
 * is for a developer.
 */
export function receiptFailureMessage(error: unknown): string {
  if (isReceiptError(error) || isLedgerError(error)) return error.message;
  return GENERIC_FAILURE;
}

/**
 * Posts one proposal. The only code in this feature that touches the ledger, and it is reached
 * only from a person's tap.
 *
 * Everything is checked again here, inside the transaction and under a row lock, because the
 * card the member tapped may be minutes old: the period may have closed, the account may have
 * become a header, the member may have lost their account. The entry goes through
 * `postJournalEntry`, the only writer of journal lines.
 */
export async function postReceiptProposal(proposalId: string, ctx: PostOptions): Promise<PostedReceipt> {
  try {
    return await inReceiptTx(ctx, async (tx) => {
      const [proposal] = await tx
        .select()
        .from(receiptProposals)
        .where(eq(receiptProposals.id, proposalId))
        .for('update');
      if (proposal === undefined) throw new ReceiptError('not_found', 'That receipt is no longer here.');
      if (proposal.status !== 'proposed') {
        throw new ReceiptError(
          'not_proposed',
          proposal.status === 'posted' ? 'That receipt is already posted.' : 'That receipt was skipped.',
        );
      }

      const warnings = recomputeWarnings(
        proposal.warnings,
        {
          payerId: proposal.payerId,
          date: proposal.receiptDate,
          totalCents: proposal.totalCents,
          lines: proposal.lines,
        },
        (ctx.today ?? booksToday)(),
      );
      const blocking = warnings.filter((w) => w.blocking);
      if (blocking.length > 0) throw new ReceiptError('blocked', blocking.map((w) => w.message).join(' '));
      const duplicate = warnings.find((w) => w.code === 'possible_duplicate');
      if (duplicate !== undefined && ctx.confirmedNew !== true) {
        throw new ReceiptError('duplicate', `${duplicate.message} Post it anyway if this is a different purchase.`);
      }
      // Blocking warnings cover these, but the compiler cannot see that.
      if (proposal.payerId === null || proposal.receiptDate === null || proposal.totalCents === null) {
        throw new ReceiptError('blocked', 'This receipt is missing something. Check the card.');
      }

      // The stored warning only knows about receipts posted before this one was read. A lookalike
      // that was still waiting then may have been posted since, so ask again, under the lock.
      if (ctx.confirmedNew !== true) {
        // Two lookalikes posted at the same instant, in separate transactions, would each miss the
        // other. Serialise them on the (date, total) pair; the lock is released at commit.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${proposal.receiptDate} || ':' || ${proposal.totalCents}::text))`,
        );
        const posted = await findPossibleDuplicate(tx, {
          vendorId: proposal.vendorId,
          vendorName: proposal.vendorName,
          date: proposal.receiptDate,
          totalCents: proposal.totalCents,
        });
        if (posted !== null) {
          throw new ReceiptError(
            'duplicate',
            `This looks like a receipt already posted as entry #${posted.entryNo}. Post it anyway if this is a different purchase.`,
          );
        }
      }

      const allowed = new Set((await loadAllowedAccounts(tx)).map((a) => a.id));
      if (proposal.lines.some((line) => line.accountId === null || !allowed.has(line.accountId))) {
        throw new ReceiptError('accounts', 'A line is on an account a receipt can no longer post to. Choose another.');
      }

      const [payer] = await tx
        .select({
          name: appUsers.fullName,
          email: appUsers.email,
          account: appUsers.contributionsAccountId,
          active: appUsers.active,
        })
        .from(appUsers)
        .where(eq(appUsers.id, proposal.payerId));
      if (payer === undefined || !payer.active || payer.account === null) {
        throw new ReceiptError('payer', 'That member no longer has a contributions account. Choose who paid again.');
      }

      let vendorId = proposal.vendorId;
      if (vendorId === null && proposal.vendorName !== null) {
        const [found] = await tx
          .select({ id: vendors.id })
          .from(vendors)
          .where(sql`lower(${vendors.name}) = lower(${proposal.vendorName})`)
          .limit(1);
        vendorId = found?.id ?? (await createVendor({ name: proposal.vendorName }, { userId: ctx.userId, tx })).id;
      }

      // One line per account: a receipt with three carton lines is one debit to packaging.
      const byAccount = new Map<string, { cents: number; descriptions: string[] }>();
      for (const line of proposal.lines) {
        const group = byAccount.get(line.accountId as string) ?? { cents: 0, descriptions: [] };
        group.cents += line.cents;
        group.descriptions.push(line.description);
        byAccount.set(line.accountId as string, group);
      }
      const memoOf = (descriptions: string[]): string => [...new Set(descriptions)].join('; ').slice(0, 120);

      const lines: DraftLine[] = [];
      for (const [accountId, group] of byAccount) {
        if (group.cents > 0) lines.push({ accountId, debitCents: group.cents, vendorId, memo: memoOf(group.descriptions) });
        else if (group.cents < 0) lines.push({ accountId, creditCents: -group.cents, vendorId, memo: memoOf(group.descriptions) });
      }
      lines.push({
        accountId: payer.account,
        creditCents: proposal.totalCents,
        memo: `Paid personally by ${payer.name ?? payer.email}`,
      });

      const posted = await postJournalEntry(
        {
          date: proposal.receiptDate,
          memo: `Receipt — ${proposal.vendorName ?? 'purchase'}`,
          sourceType: 'purchase_receipt',
          sourceId: proposal.id,
          lines,
        },
        { userId: ctx.userId, tx },
      );

      // The stored file belongs to the entry now, so it opens from the entry.
      await tx
        .update(attachments)
        .set({ entityType: 'journal_entry', entityId: posted.entryId })
        .where(eq(attachments.id, proposal.attachmentId));
      await tx
        .update(receiptProposals)
        .set({ status: 'posted', entryId: posted.entryId, vendorId, updatedAt: new Date() })
        .where(eq(receiptProposals.id, proposal.id));

      return { entryId: posted.entryId, entryNo: posted.entryNo };
    });
  } catch (error) {
    if (isReceiptError(error)) throw error;
    throw translateLedgerDbError(error);
  }
}

export interface PostAllResult {
  posted: Array<{ id: string; entryId: string; entryNo: number }>;
  failed: Array<{ id: string; message: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Posts every proposal that has nothing at all to check, one transaction each, so one refusal
 * does not sink the rest. A card with any warning, even a gentle one, is left for a person.
 */
export async function postAllReceiptProposals(ids: readonly string[], ctx: PostOptions): Promise<PostAllResult> {
  const result: PostAllResult = { posted: [], failed: [], skipped: [] };
  const views = await loadProposalViews(await readerOf(ctx), ids);

  for (const view of views) {
    if (view.warnings.length > 0 || !view.canPost) {
      result.skipped.push({ id: view.id, reason: view.warnings[0]?.message ?? 'This one needs a look first.' });
      continue;
    }
    try {
      const posted = await postReceiptProposal(view.id, { ...ctx, confirmedNew: false });
      result.posted.push({ id: view.id, entryId: posted.entryId, entryNo: posted.entryNo });
    } catch (error) {
      result.failed.push({ id: view.id, message: receiptFailureMessage(error) });
    }
  }
  return result;
}

export async function skipReceiptProposal(id: string, ctx: ReceiptCtx): Promise<void> {
  await inReceiptTx(ctx, async (tx) => {
    const updated = await tx
      .update(receiptProposals)
      .set({ status: 'skipped', updatedAt: new Date() })
      .where(and(eq(receiptProposals.id, id), eq(receiptProposals.status, 'proposed')))
      .returning({ id: receiptProposals.id });
    if (updated.length === 0) throw new ReceiptError('not_proposed', 'That receipt is already posted or skipped.');
  });
}

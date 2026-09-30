import { eq } from 'drizzle-orm';

import { receiptProposals } from '@/db/schema';
import { loadVendorIndex } from '@/lib/banking/vendors';
import { type CalendarDate, today as booksToday } from '@/lib/dates';

import { loadAllowedAccounts } from './accounts';
import { type Edit, type EditContext, type EditableProposal, applyEdit } from './edits';
import { listPayers } from './payers';
import { loadProposalView } from './queries';
import { type ReceiptCtx, inReceiptTx, readerOf } from './tx';
import type { ProposalView } from './types';

export type ApplyEditsResult = { ok: true; view: ProposalView; notes: string[] } | { ok: false; message: string };

/**
 * Applies edits to a waiting proposal, all or nothing. Each is checked by `applyEdit` against the
 * card as the earlier ones left it; if any is refused, nothing is saved and the member is told
 * why in the refusal's own words.
 */
export async function applyProposalEdits(
  proposalId: string,
  edits: readonly Edit[],
  ctx: ReceiptCtx & { today?: () => CalendarDate },
): Promise<ApplyEditsResult> {
  const outcome = await inReceiptTx(ctx, async (tx): Promise<{ ok: true; notes: string[] } | { ok: false; message: string }> => {
    const [row] = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, proposalId)).for('update');
    if (row === undefined) return { ok: false, message: 'That receipt is no longer here.' };
    if (row.status !== 'proposed') {
      return { ok: false, message: row.status === 'posted' ? 'That receipt is already posted.' : 'That receipt was skipped.' };
    }

    const editContext: EditContext = {
      allowed: await loadAllowedAccounts(tx),
      payers: await listPayers(tx),
      vendorIndex: await loadVendorIndex({ tx }),
      today: (ctx.today ?? booksToday)(),
    };

    let state: EditableProposal = {
      vendorId: row.vendorId,
      vendorName: row.vendorName,
      date: row.receiptDate,
      totalCents: row.totalCents,
      payerId: row.payerId,
      lines: row.lines,
      warnings: row.warnings,
    };
    const notes: string[] = [];
    let skipped = false;

    for (const edit of edits) {
      const result = applyEdit(state, edit, editContext);
      if (!result.ok) return { ok: false, message: result.message };
      notes.push(result.note);
      if ('skip' in result) {
        skipped = true;
        break;
      }
      state = result.state;
    }

    await tx
      .update(receiptProposals)
      .set({
        status: skipped ? 'skipped' : 'proposed',
        vendorId: state.vendorId,
        vendorName: state.vendorName,
        receiptDate: state.date,
        payerId: state.payerId,
        lines: state.lines,
        warnings: state.warnings,
        updatedAt: new Date(),
      })
      .where(eq(receiptProposals.id, proposalId));
    return { ok: true, notes };
  });

  if (!outcome.ok) return outcome;
  const view = await loadProposalView(await readerOf(ctx), proposalId);
  if (view === null) return { ok: false, message: 'That receipt is no longer here.' };
  return { ok: true, view, notes: outcome.notes };
}

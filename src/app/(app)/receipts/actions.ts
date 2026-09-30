'use server';

/**
 * Every mutation the Assistant can make.
 *
 * Each does the same things in the same order: check the capability, hand the work to
 * `@/lib/receipts`, turn a refusal into the `{ ok: false, error }` the client shows, and
 * revalidate what a posting moved. Nothing here decides for anyone: a receipt posts only when a
 * person presses Post, and the model, which reads receipts and understands typed corrections,
 * has no route to the ledger.
 */

import { revalidatePath } from 'next/cache';

import type { ActionResult, PayerOption } from '@/components/receipts/types';
import { db } from '@/db/client';
import { requireCapability } from '@/lib/auth/session';
import { loadAllowedAccounts } from '@/lib/receipts/accounts';
import { editSchema } from '@/lib/receipts/edits';
import { toActionFailure } from '@/lib/receipts/failure';
import { interpretMessage } from '@/lib/receipts/interpret';
import { listPayers } from '@/lib/receipts/payers';
import { type PostAllResult, postAllReceiptProposals, postReceiptProposal, skipReceiptProposal } from '@/lib/receipts/post';
import { listWaitingViews, loadProposalView } from '@/lib/receipts/queries';
import { cardSnapshot } from '@/lib/receipts/snapshot';
import { applyProposalEdits } from '@/lib/receipts/store';
import type { ProposalView } from '@/lib/receipts/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE = 500;
const MAX_POST_ALL = 20;

const ok = <T>(value: T): ActionResult<T> => ({ ok: true, value });
const fail = <T>(error: unknown): ActionResult<T> => ({ ok: false, error: toActionFailure(error) });
const invalid = <T>(message: string): ActionResult<T> => ({ ok: false, error: { code: 'invalid', message } });

/** What a posting moves: the journal and the dashboard's founder card. */
function refresh(): void {
  revalidatePath('/ledger');
  revalidatePath('/dashboard');
}

export async function listWaitingReceipts(): Promise<ActionResult<{ proposals: ProposalView[]; payers: PayerOption[] }>> {
  try {
    await requireCapability('ledger.post');
    // Sequential on purpose: the connection pool this app shares is small.
    const proposals = await listWaitingViews(db);
    const payers = await listPayers(db);
    return ok({ proposals, payers: payers.map((p) => ({ userId: p.userId, name: p.name })) });
  } catch (error) {
    return fail(error);
  }
}

export async function postProposal(
  proposalId: string,
  confirmedNew = false,
): Promise<ActionResult<{ entryId: string; entryNo: number }>> {
  try {
    const user = await requireCapability('ledger.post');
    if (!UUID.test(proposalId)) return invalid('That receipt reference is not valid.');
    const posted = await postReceiptProposal(proposalId, { userId: user.id, confirmedNew });
    refresh();
    return ok(posted);
  } catch (error) {
    return fail(error);
  }
}

export async function postAllProposals(ids: string[]): Promise<ActionResult<PostAllResult>> {
  try {
    const user = await requireCapability('ledger.post');
    if (ids.length === 0 || ids.length > MAX_POST_ALL || !ids.every((id) => UUID.test(id))) {
      return invalid('Those receipts could not be posted together.');
    }
    const result = await postAllReceiptProposals(ids, { userId: user.id });
    if (result.posted.length > 0) refresh();
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export async function skipProposal(proposalId: string): Promise<ActionResult<null>> {
  try {
    const user = await requireCapability('ledger.post');
    if (!UUID.test(proposalId)) return invalid('That receipt reference is not valid.');
    await skipReceiptProposal(proposalId, { userId: user.id });
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

/** A change made with a control (the Paid by menu): the same edit the model would propose, without the model. */
export async function editProposal(
  proposalId: string,
  edit: unknown,
): Promise<ActionResult<{ view: ProposalView; notes: string[] }>> {
  try {
    const user = await requireCapability('ledger.post');
    if (!UUID.test(proposalId)) return invalid('That receipt reference is not valid.');
    const parsed = editSchema.safeParse(edit);
    if (!parsed.success) return invalid('That is not a change I can make.');
    const applied = await applyProposalEdits(proposalId, [parsed.data], { userId: user.id });
    if (!applied.ok) return invalid(applied.message);
    return ok({ view: applied.view, notes: applied.notes });
  } catch (error) {
    return fail(error);
  }
}

/**
 * A typed correction. The model turns the message into edits; code validates and applies them.
 * A refusal, or a message the model could not understand, is an answer and not a failure: the
 * card is returned unchanged with the reason.
 */
export async function sendChatMessage(
  proposalId: string,
  text: string,
): Promise<ActionResult<{ view: ProposalView; replies: string[] }>> {
  try {
    const user = await requireCapability('ledger.post');
    if (!UUID.test(proposalId)) return invalid('That receipt reference is not valid.');
    const message = text.trim().slice(0, MAX_MESSAGE);
    if (message === '') return invalid('Type what you want to change.');

    const view = await loadProposalView(db, proposalId);
    if (view === null || view.status !== 'proposed') return invalid('That receipt is no longer waiting.');

    const allowed = await loadAllowedAccounts(db);
    const payers = await listPayers(db);
    const interpreted = await interpretMessage(message, cardSnapshot(view, payers), {
      accounts: allowed,
      members: payers,
    });
    if (interpreted.edits.length === 0) {
      return ok({
        view,
        replies: [interpreted.unclear ?? 'I could not turn that into a change. Try naming the line and the account.'],
      });
    }

    const applied = await applyProposalEdits(proposalId, interpreted.edits, { userId: user.id });
    if (!applied.ok) return ok({ view, replies: [applied.message] });
    return ok({ view: applied.view, replies: applied.notes });
  } catch (error) {
    return fail(error);
  }
}

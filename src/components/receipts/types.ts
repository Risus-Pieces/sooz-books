/** Types the receipt screens share with the server actions. Nothing here imports server code. */

import type { ProposalView } from '@/lib/receipts/types';

export interface ActionFailure {
  code: string;
  message: string;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionFailure };

/** A member who can be credited, as the Paid by menu lists them. */
export interface PayerOption {
  userId: string;
  name: string;
}

/**
 * One card in the sheet. An upload is a card from the moment the file is chosen, so the member
 * sees progress on each receipt instead of a spinner over the lot.
 */
export type CardState =
  | { key: string; kind: 'uploading'; filename: string }
  | { key: string; kind: 'failed'; filename: string; message: string }
  | { key: string; kind: 'proposal'; proposal: ProposalView };

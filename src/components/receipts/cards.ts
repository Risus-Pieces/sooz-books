import type { ProposalView } from '@/lib/receipts/types';

import type { CardState } from './types';

let counter = 0;
/** A key for a card that has no proposal yet. */
export function nextCardKey(): string {
  counter += 1;
  return `upload-${counter}`;
}

/** Adds proposals that are not on screen yet; what is already there stays where it is. */
export function mergeWaiting(current: readonly CardState[], proposals: readonly ProposalView[]): CardState[] {
  const have = new Set(current.flatMap((c) => (c.kind === 'proposal' ? [c.proposal.id] : [])));
  const added = proposals.filter((p) => !have.has(p.id)).map((proposal): CardState => ({ key: proposal.id, kind: 'proposal', proposal }));
  return [...current, ...added];
}

/** What "Post all" would post: waiting, nothing blocking, and nothing to check at all. */
export function postableProposals(cards: readonly CardState[]): ProposalView[] {
  return cards.flatMap((c) =>
    c.kind === 'proposal' && c.proposal.status === 'proposed' && c.proposal.canPost && c.proposal.warnings.length === 0
      ? [c.proposal]
      : [],
  );
}

export function markPosted(
  cards: readonly CardState[],
  posted: ReadonlyArray<{ id: string; entryId: string; entryNo: number }>,
): CardState[] {
  return cards.map((c) => {
    if (c.kind !== 'proposal') return c;
    const hit = posted.find((p) => p.id === c.proposal.id);
    if (hit === undefined) return c;
    return {
      ...c,
      proposal: { ...c.proposal, status: 'posted', entryId: hit.entryId, entryNo: hit.entryNo, canPost: false },
    };
  });
}

export function replaceProposal(cards: readonly CardState[], id: string, next: ProposalView): CardState[] {
  return cards.map((c) => (c.kind === 'proposal' && c.proposal.id === id ? { ...c, proposal: next } : c));
}

/**
 * The end of one upload. A proposal replaces the placeholder (and is keyed by its own id from
 * then on); a receipt already on screen just drops the placeholder; an error becomes a failed card.
 */
export function settleUpload(
  cards: readonly CardState[],
  key: string,
  filename: string,
  outcome: { proposal: ProposalView } | { error: string },
): CardState[] {
  if ('error' in outcome) {
    return cards.map((c): CardState => (c.key === key ? { key, kind: 'failed', filename, message: outcome.error } : c));
  }
  const { proposal } = outcome;
  if (cards.some((c) => c.kind === 'proposal' && c.proposal.id === proposal.id)) {
    return cards.filter((c) => c.key !== key);
  }
  return cards.map((c): CardState => (c.key === key ? { key: proposal.id, kind: 'proposal', proposal } : c));
}

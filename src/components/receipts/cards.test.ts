import { describe, expect, it } from 'vitest';

import type { ProposalView } from '@/lib/receipts/types';

import {
  markPosted,
  mergeWaiting,
  nextCardKey,
  postableProposals,
  replaceProposal,
  settleUpload,
} from './cards';
import type { CardState } from './types';

function proposal(id: string, overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id,
    status: 'proposed',
    attachmentId: `att-${id}`,
    filename: `${id}.pdf`,
    vendorName: 'Pack Supply Co',
    vendorIsNew: false,
    date: '2026-09-15',
    totalCents: 4110,
    payerId: 'u1',
    lines: [{ description: 'Cartons', cents: 4110, accountId: 'a1', accountLabel: 'Packaging Materials (1330)' }],
    warnings: [],
    error: null,
    entryId: null,
    entryNo: null,
    needsConfirmation: false,
    canPost: true,
    ...overrides,
  };
}

const card = (p: ProposalView): CardState => ({ key: p.id, kind: 'proposal', proposal: p });
const ids = (cards: readonly CardState[]) => cards.map((c) => c.key);

describe('nextCardKey', () => {
  it('never repeats', () => {
    expect(nextCardKey()).not.toBe(nextCardKey());
  });
});

describe('mergeWaiting', () => {
  it('adds proposals it does not have, keeping what is on screen where it is', () => {
    const current: CardState[] = [{ key: 'k1', kind: 'uploading', filename: 'a.pdf' }, card(proposal('p1'))];

    const merged = mergeWaiting(current, [proposal('p1'), proposal('p2')]);

    expect(ids(merged)).toEqual(['k1', 'p1', 'p2']);
  });

  it('keeps the card already on screen rather than replacing it with the loaded copy', () => {
    const onScreen = proposal('p1', { totalCents: 1 });

    const merged = mergeWaiting([card(onScreen)], [proposal('p1', { totalCents: 999 })]);

    expect(merged[0]).toEqual(card(onScreen));
  });
});

describe('postableProposals', () => {
  it('is the waiting ones with nothing to check at all', () => {
    const clean = proposal('clean');
    const cards = [
      card(clean),
      card(proposal('warned', { warnings: [{ code: 'total_mismatch', message: 'x', blocking: false }] })),
      card(proposal('blocked', { canPost: false })),
      card(proposal('done', { status: 'posted', canPost: false })),
      { key: 'u', kind: 'uploading', filename: 'a.pdf' } as CardState,
    ];

    expect(postableProposals(cards)).toEqual([clean]);
  });
});

describe('markPosted', () => {
  it('turns the posted cards into posted proposals with their entry, and leaves the rest', () => {
    const cards = [card(proposal('p1')), card(proposal('p2'))];

    const next = markPosted(cards, [{ id: 'p1', entryId: 'e1', entryNo: 42 }]);

    expect(next[0]).toMatchObject({
      kind: 'proposal',
      proposal: { id: 'p1', status: 'posted', entryId: 'e1', entryNo: 42, canPost: false },
    });
    expect(next[1]).toEqual(cards[1]);
  });
});

describe('replaceProposal', () => {
  it('swaps one proposal for a newer copy of it', () => {
    const cards = [card(proposal('p1')), card(proposal('p2'))];

    const next = replaceProposal(cards, 'p2', proposal('p2', { totalCents: 5 }));

    expect(next[1]).toMatchObject({ proposal: { id: 'p2', totalCents: 5 } });
    expect(next[0]).toEqual(cards[0]);
  });
});

describe('replaceProposal and a posted card', () => {
  it('never takes a posted card back to proposed (a stale reply arriving after the post)', () => {
    const posted = proposal('p1', { status: 'posted', entryId: 'e1', entryNo: 7, canPost: false });
    const cards = [card(posted)];

    const next = replaceProposal(cards, 'p1', proposal('p1', { status: 'proposed' }));

    expect(next).toEqual(cards);
  });

  it('still lets a newer posted copy through', () => {
    const cards = [card(proposal('p1'))];
    const posted = proposal('p1', { status: 'posted', entryId: 'e1', entryNo: 7, canPost: false });

    expect(replaceProposal(cards, 'p1', posted)[0]).toEqual(card(posted));
  });
});

describe('settleUpload', () => {
  const placeholder: CardState = { key: 'k1', kind: 'uploading', filename: 'a.pdf' };

  it('turns the placeholder into the proposal, keyed by the proposal so it stays put', () => {
    const next = settleUpload([placeholder], 'k1', 'a.pdf', { proposal: proposal('p1') });

    expect(next).toEqual([card(proposal('p1'))]);
  });

  it('drops the placeholder when the receipt is already on screen (a repeat upload)', () => {
    const next = settleUpload([placeholder, card(proposal('p1'))], 'k1', 'a.pdf', { proposal: proposal('p1') });

    expect(ids(next)).toEqual(['p1']);
  });

  it('shows the returned state on the card already on screen, so a revived card is no longer "Skipped"', () => {
    const skipped = card(proposal('p1', { status: 'skipped', canPost: false }));

    const next = settleUpload([placeholder, skipped], 'k1', 'a.pdf', { proposal: proposal('p1', { status: 'proposed' }) });

    expect(ids(next)).toEqual(['p1']);
    expect(next[0]).toMatchObject({ kind: 'proposal', proposal: { id: 'p1', status: 'proposed', canPost: true } });
  });

  it('turns the placeholder into a failed card carrying the reason', () => {
    const next = settleUpload([placeholder], 'k1', 'a.pdf', { error: 'That file is empty.' });

    expect(next).toEqual([{ key: 'k1', kind: 'failed', filename: 'a.pdf', message: 'That file is empty.' }]);
  });
});

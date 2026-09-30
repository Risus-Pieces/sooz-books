import { describe, expect, it } from 'vitest';

import type { Payer } from './payers';
import { cardSnapshot } from './snapshot';
import type { ProposalView } from './types';

const view: ProposalView = {
  id: 'p1',
  status: 'proposed',
  attachmentId: 'att',
  filename: 'r.pdf',
  vendorName: 'Pack Supply Co',
  vendorIsNew: false,
  date: '2026-09-15',
  totalCents: 4110,
  payerId: 'u-mo',
  lines: [
    { description: 'Cartons', cents: 3000, accountId: 'a1', accountLabel: 'Packaging Materials (1330)' },
    { description: 'Sugar', cents: 1110, accountId: null, accountLabel: null },
  ],
  warnings: [],
  error: null,
  entryId: null,
  entryNo: null,
  needsConfirmation: false,
  canPost: false,
};

const payers: Payer[] = [{ userId: 'u-mo', name: 'Mo Chen', email: 'mo@x.test', contributionsAccountId: 'c2' }];

describe('cardSnapshot', () => {
  it('describes the card in plain data, with the payer by name', () => {
    expect(cardSnapshot(view, payers)).toEqual({
      vendorName: 'Pack Supply Co',
      date: '2026-09-15',
      totalCents: 4110,
      payerName: 'Mo Chen',
      lines: [
        { description: 'Cartons', cents: 3000, accountLabel: 'Packaging Materials (1330)' },
        { description: 'Sugar', cents: 1110, accountLabel: null },
      ],
    });
  });

  it('has no payer name when nobody is chosen or the member is not listed', () => {
    expect(cardSnapshot({ ...view, payerId: null }, payers).payerName).toBeNull();
    expect(cardSnapshot({ ...view, payerId: 'u-gone' }, payers).payerName).toBeNull();
  });
});

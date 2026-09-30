import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ProposalView } from '@/lib/receipts/types';

import { ReceiptCard } from './receipt-card';

const proposal: ProposalView = {
  id: 'p1',
  status: 'proposed',
  attachmentId: 'att-123',
  filename: 'IMG_0042.jpg',
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
};

describe('ReceiptCard', () => {
  it('links the filename to the stored receipt, so the member can check it against the reading', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      <ReceiptCard
        card={{ key: 'p1', kind: 'proposal', proposal }}
        payers={[]}
        selected={false}
        busy={false}
        onSelect={noop}
        onPost={noop}
        onSkip={noop}
        onPayer={noop}
        onDismiss={noop}
      />,
    );

    expect(html).toContain('href="/receipts/file/att-123"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('aria-label="Open receipt IMG_0042.jpg"');
    // The region is still named for the vendor.
    expect(html).toContain('aria-label="Pack Supply Co"');
  });
});

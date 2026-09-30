import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { type ProposalRow, listWaitingViews, loadProposalView, toView } from './queries';
import { accountIdOf, insertProposal, seededUserId } from './test-support';
import type { ProposalLine, ReceiptWarning } from './types';

afterAll(closeTestDb);

function row(overrides: Partial<ProposalRow> = {}): ProposalRow {
  const lines: ProposalLine[] = [{ description: 'Cartons', cents: 4110, accountId: 'a1' }];
  return {
    id: 'p1',
    status: 'proposed',
    attachment_id: 'att1',
    filename: 'receipt.pdf',
    vendor_id: 'v1',
    vendor_name: 'Pack Supply Co',
    receipt_date: '2026-09-15',
    total_cents: '4110', // postgres.js returns bigint as text
    payer_id: 'u1',
    lines,
    warnings: [],
    error: null,
    entry_id: null,
    entry_no: null,
    ...overrides,
  };
}

const LABELS = new Map([['a1', 'Packaging Materials (1330)']]);

describe('toView', () => {
  it('shapes a complete proposal, turning text bigints into numbers and ids into labels', () => {
    const view = toView(row(), LABELS);

    expect(view).toMatchObject({
      id: 'p1',
      totalCents: 4110,
      vendorIsNew: false,
      needsConfirmation: false,
      canPost: true,
      lines: [{ description: 'Cartons', cents: 4110, accountId: 'a1', accountLabel: 'Packaging Materials (1330)' }],
    });
  });

  it('reads lines and warnings that arrive as JSON text', () => {
    const view = toView(
      row({ lines: JSON.stringify(row().lines) as unknown as ProposalLine[], warnings: '[]' as unknown as ReceiptWarning[] }),
      LABELS,
    );

    expect(view.lines).toHaveLength(1);
    expect(view.warnings).toEqual([]);
  });

  it('calls a vendor new when it has a name but no id', () => {
    expect(toView(row({ vendor_id: null }), LABELS).vendorIsNew).toBe(true);
    expect(toView(row({ vendor_id: null, vendor_name: null }), LABELS).vendorIsNew).toBe(false);
  });

  it.each([
    ['a blocking warning', { warnings: [{ code: 'no_account', message: 'x', blocking: true }] as ReceiptWarning[] }],
    ['no payer', { payer_id: null }],
    ['a line with no account', { lines: [{ description: 'x', cents: 4110, accountId: null }] }],
    ['no lines', { lines: [] }],
    ['no total', { total_cents: null }],
    ['a zero total', { total_cents: '0' }],
    ['no date', { receipt_date: null }],
    ['a status that is not proposed', { status: 'skipped' as const }],
  ])('cannot post with %s', (_name, overrides) => {
    expect(toView(row(overrides), LABELS).canPost).toBe(false);
  });

  it('asks for confirmation when a possible duplicate is present, but still allows posting', () => {
    const view = toView(row({ warnings: [{ code: 'possible_duplicate', message: 'dup', blocking: false }] }), LABELS);

    expect(view.needsConfirmation).toBe(true);
    expect(view.canPost).toBe(true);
  });

  it('carries the entry number of a posted proposal', () => {
    const view = toView(row({ status: 'posted', entry_id: 'e1', entry_no: '42' }), LABELS);

    expect(view).toMatchObject({ status: 'posted', entryId: 'e1', entryNo: 42, canPost: false });
  });
});

describe.skipIf(!hasDatabase)('loading proposals', () => {
  it('loads a stored proposal with its account label and filename', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);
      const packaging = await accountIdOf(tx, '1330');
      const { id } = await insertProposal(tx, userId, {
        vendorName: 'Pack Supply Co',
        receiptDate: '2026-09-15',
        totalCents: 4110,
        payerId: userId,
        lines: [{ description: 'Cartons', cents: 4110, accountId: packaging }],
      });

      const view = await loadProposalView(tx, id);

      expect(view).toMatchObject({
        id,
        filename: 'receipt.pdf',
        vendorName: 'Pack Supply Co',
        date: '2026-09-15',
        totalCents: 4110,
        canPost: true,
      });
      expect(view?.lines[0].accountLabel).toContain('1330');
    });
  });

  it('returns null for a proposal that does not exist', async () => {
    await withRollback(async (tx) => {
      expect(await loadProposalView(tx, '00000000-0000-4000-8000-00000000dead')).toBeNull();
    });
  });

  it('lists only proposals still waiting, oldest first', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);
      // Inside one transaction `now()` is constant, so `created_at` would tie and the order would be
      // decided by random ids. Real proposals come from separate requests; give each its own time.
      const first = await insertProposal(tx, userId, { vendorName: 'First', createdAt: new Date('2031-01-01T00:00:00Z') });
      const second = await insertProposal(tx, userId, { vendorName: 'Second', createdAt: new Date('2031-01-02T00:00:00Z') });
      await insertProposal(tx, userId, { vendorName: 'Skipped', status: 'skipped' });

      const ids = (await listWaitingViews(tx)).map((v) => v.id);

      expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
      expect((await listWaitingViews(tx)).map((v) => v.vendorName)).not.toContain('Skipped');
    });
  });
});

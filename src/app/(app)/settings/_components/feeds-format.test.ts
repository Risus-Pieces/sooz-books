import { describe, expect, it } from 'vitest';

import type { ItemSyncReport, SyncRunReport } from '@/lib/feeds/sync';

import {
  DONT_SYNC,
  accountLabel,
  feedErrorText,
  parseMappingValue,
  scopeLabel,
  syncSummary,
} from './feeds-format';

const BANK = '0b6c3c1e-8d4f-4c55-9a51-2f1f0c6a7e10';

function item(over: Partial<ItemSyncReport> = {}): ItemSyncReport {
  return {
    plaidItemId: 'item',
    institution: 'Relay',
    accounts: [],
    ignored: { pending: 0, unmapped: 0, beforeStart: 0, notUsd: 0 },
    changedLater: 0,
    error: null,
    ...over,
  };
}

function posted(n: number): SyncRunReport['autoPost']['posted'] {
  return Array.from({ length: n }, (_, i) => ({ txnId: `t${i}`, entryId: `e${i}`, entryNo: i + 1, accountIds: [] }));
}

describe('parseMappingValue', () => {
  it('reads "Don\'t sync" as no bank account', () => {
    expect(parseMappingValue(DONT_SYNC)).toBeNull();
  });
  it('passes a uuid through and refuses anything else', () => {
    expect(parseMappingValue(BANK)).toBe(BANK);
    expect(parseMappingValue('')).toBeUndefined();
    expect(parseMappingValue("1' or 1=1")).toBeUndefined();
  });
});

describe('labels', () => {
  it('puts the last four after the name', () => {
    expect(accountLabel('Operating', '4521')).toBe('Operating ••4521');
    expect(accountLabel('Savings', null)).toBe('Savings');
  });
  it('names every scope and leaves an unknown one as it is', () => {
    expect(scopeLabel('bank.sync')).toBe('Bank sync');
    expect(scopeLabel('stage')).toBe('Stage changes');
    expect(scopeLabel('future.scope')).toBe('future.scope');
  });
});

describe('feedErrorText', () => {
  it('never shows the text of a failed query', () => {
    const text = feedErrorText('Failed query: insert into bank_transactions ... params: 123,abc');
    expect(text).not.toMatch(/insert|params/);
  });
  it('shows a bank-side message as it is, and nothing for no error', () => {
    expect(feedErrorText('the login details of this item have changed')).toBe('the login details of this item have changed');
    expect(feedErrorText(null)).toBeNull();
    expect(feedErrorText('  ')).toBeNull();
  });
});

describe('syncSummary', () => {
  it('says so when no bank is connected', () => {
    expect(syncSummary({ items: [], autoPost: { posted: [], failed: [] } }).title).toBe('Nothing to sync');
  });

  it('counts new lines across accounts and what the rules posted', () => {
    const run: SyncRunReport = {
      items: [
        item({
          accounts: [
            { bankAccountId: BANK, bankAccountName: 'Operating', inserted: 9, duplicates: 1 },
            { bankAccountId: BANK, bankAccountName: 'Card', inserted: 3, duplicates: 0 },
          ],
        }),
      ],
      autoPost: { posted: posted(4), failed: [] },
    };
    expect(syncSummary(run)).toEqual({
      tone: 'success',
      title: '12 new bank lines',
      description: '4 lines auto-posted by your rules · the rest wait in Review.',
    });
  });

  it('is quiet when nothing came in', () => {
    const summary = syncSummary({ items: [item()], autoPost: { posted: [], failed: [] } });
    expect(summary).toEqual({ tone: 'success', title: 'No new bank lines', description: 'Every connected account is up to date.' });
  });

  it('warns and names the bank that failed', () => {
    const summary = syncSummary({
      items: [item({ error: 'ITEM_LOGIN_REQUIRED' })],
      autoPost: { posted: [], failed: [{ txnId: 't', error: 'closed', code: 'period_closed' }] },
    });
    expect(summary.tone).toBe('warning');
    expect(summary.description).toContain('Relay: ITEM_LOGIN_REQUIRED');
    expect(summary.description).toContain('1 rule match could not post');
  });
});

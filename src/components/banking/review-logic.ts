/**
 * The review queue's pure logic: filtering, totals, payee groups and range selection.
 * Kept apart from the component so each rule can be tested without a browser.
 */

import type { QueueRow, QueueSource } from './types';

export interface QueueFilter {
  /** Payee, reference or description text; an amount like 12.34 matches ±$12.34. */
  search: string;
  /** `YYYY-MM`, or '' for every month. */
  month: string;
  source: QueueSource | '';
  bankAccountId: string;
  flaggedOnly: boolean;
}

export const EMPTY_FILTER: QueueFilter = {
  search: '',
  month: '',
  source: '',
  bankAccountId: '',
  flaggedOnly: false,
};

export function isFilterActive(filter: QueueFilter): boolean {
  return (
    filter.search.trim() !== '' ||
    filter.month !== '' ||
    filter.source !== '' ||
    filter.bankAccountId !== '' ||
    filter.flaggedOnly
  );
}

/** The display payee: the bank's counterparty, else its description. */
export function payeeOf(row: Pick<QueueRow, 'payee' | 'description'>): string {
  const payee = (row.payee ?? '').trim();
  return payee === '' ? row.description.trim() : payee;
}

/** Whole cents from a typed amount, or null when the text is not one. Integer maths only. */
export function amountQuery(text: string): number | null {
  const match = /^\$?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/^[-+]/, ''));
  if (match === null) return null;
  const dollars = Number(match[1].replace(/,/g, ''));
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return dollars * 100 + Number(fraction);
}

export function matchesFilter(row: QueueRow, filter: QueueFilter): boolean {
  if (filter.month !== '' && !row.txnDate.startsWith(filter.month)) return false;
  if (filter.bankAccountId !== '' && row.bankAccountId !== filter.bankAccountId) return false;
  if (filter.source !== '') {
    const source = row.suggestion.source ?? 'none';
    if (source !== filter.source) return false;
  }
  if (filter.flaggedOnly && row.flags.length === 0) return false;
  const text = filter.search.trim().toLowerCase();
  if (text !== '') {
    const haystack = [row.payee, row.description, row.reference, row.notes, row.suggestion.account?.name]
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
      .toLowerCase();
    const cents = amountQuery(text);
    const amountHit = cents !== null && cents > 0 && Math.abs(row.amountCents) === cents;
    if (!haystack.includes(text) && !amountHit) return false;
  }
  return true;
}

export interface QueueTotals {
  count: number;
  inCents: number;
  outCents: number;
  flagged: number;
}

export function totalsOf(rows: readonly QueueRow[]): QueueTotals {
  let inCents = 0;
  let outCents = 0;
  let flagged = 0;
  for (const row of rows) {
    if (row.amountCents > 0) inCents += row.amountCents;
    else outCents += -row.amountCents;
    if (row.flags.length > 0) flagged += 1;
  }
  return { count: rows.length, inCents, outCents, flagged };
}

/** The key identical payees share: case, spacing and trailing store numbers ignored. */
export function payeeKey(row: Pick<QueueRow, 'payee' | 'description'>): string {
  return payeeOf(row)
    .toLowerCase()
    .replace(/[#*]\s*\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PayeeGroup {
  key: string;
  payee: string;
  rows: QueueRow[];
  /** Signed sum: positive is net money in. */
  netCents: number;
  /** Rows that "accept as suggested" can post: a suggestion or a linked charge, and not a transfer leg. */
  acceptable: QueueRow[];
  acceptableNetCents: number;
  /** The suggested accounts in this group, most common first. */
  accounts: { label: string; count: number }[];
  flagged: number;
}

/** True when accepting the row as suggested has an account to post to. */
export function canAcceptAsSuggested(row: QueueRow): boolean {
  if (row.status === 'transfer' || row.status === 'matched' || row.stage === 'posted' || row.stage === 'excluded') {
    return false;
  }
  return row.suggestion.account !== null || row.refundOriginal?.account != null;
}

export function groupByPayee(rows: readonly QueueRow[]): PayeeGroup[] {
  const map = new Map<string, QueueRow[]>();
  for (const row of rows) {
    const key = payeeKey(row);
    const bucket = map.get(key);
    if (bucket === undefined) map.set(key, [row]);
    else bucket.push(row);
  }
  const groups: PayeeGroup[] = [];
  for (const [key, members] of map) {
    const acceptable = members.filter(canAcceptAsSuggested);
    const counts = new Map<string, number>();
    for (const row of members) {
      const account = row.suggestion.account;
      const label = account === null ? 'No suggestion' : `${account.code} ${account.name}`;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    groups.push({
      key,
      payee: payeeOf(members[0]),
      rows: members,
      netCents: members.reduce((sum, row) => sum + row.amountCents, 0),
      acceptable,
      acceptableNetCents: acceptable.reduce((sum, row) => sum + row.amountCents, 0),
      accounts: [...counts]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      flagged: members.filter((row) => row.flags.length > 0).length,
    });
  }
  return groups.sort((a, b) => b.rows.length - a.rows.length || a.payee.localeCompare(b.payee));
}

/** The ids between two positions of a list, inclusive, in list order. */
export function rangeIds(ids: readonly string[], fromId: string, toId: string): string[] {
  const a = ids.indexOf(fromId);
  const b = ids.indexOf(toId);
  if (a === -1 || b === -1) return b === -1 ? [] : [toId];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return ids.slice(lo, hi + 1);
}

/** After rows leave the list, the row focus should land on: the next survivor, else the previous. */
export function nextFocus(ids: readonly string[], leaving: ReadonlySet<string>, current: string | null): string | null {
  if (current === null) return ids.find((id) => !leaving.has(id)) ?? null;
  const at = ids.indexOf(current);
  if (at === -1) return ids.find((id) => !leaving.has(id)) ?? null;
  for (let i = at; i < ids.length; i += 1) if (!leaving.has(ids[i])) return ids[i];
  for (let i = at - 1; i >= 0; i -= 1) if (!leaving.has(ids[i])) return ids[i];
  return null;
}

export const SOURCE_LABEL: Record<QueueSource, string> = {
  rule: 'Rule',
  ai: 'AI',
  history: 'History',
  match: 'Match',
  none: 'None',
};

export const FLAG_LABEL = {
  mixed_use: 'Mixed use',
  low_confidence: 'Low confidence',
  no_suggestion: 'No suggestion',
  ask_accountant: 'Ask accountant',
  already_booked: 'Already booked',
  open_document: 'Open invoice/bill',
} as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-03` → `Mar 2026`. */
export function monthLabel(month: string): string {
  const [year, m] = month.split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${year}`;
}

/** `2026-03-07` → `Mar 7`, a register's date column. No Date object: no time zone to drift. */
export function shortDate(date: string): string {
  const [, m, d] = date.split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`;
}

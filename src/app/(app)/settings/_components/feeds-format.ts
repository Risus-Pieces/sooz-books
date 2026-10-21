/**
 * The words the Bank Feeds and API Keys panes put on screen, kept apart from the components so
 * they can be tested without rendering anything. Type imports only: this module also travels into
 * client components.
 */
import type { ApiKeyScope } from '@/db/schema';
import type { SyncRunReport } from '@/lib/feeds/sync';

/** The select's value for a Plaid account that feeds nothing. A Radix select cannot hold "". */
export const DONT_SYNC = 'none';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** The select's value back to a bank account id, null for "Don't sync", undefined for anything else. */
export function parseMappingValue(value: string): string | null | undefined {
  if (value === DONT_SYNC) return null;
  return isUuid(value) ? value : undefined;
}

/** "Operating ••4521": the name a bank gives an account, and its last four digits. */
export function accountLabel(name: string, mask: string | null): string {
  return mask ? `${name} ••${mask}` : name;
}

export const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  read: 'Read the books',
  'bank.sync': 'Bank sync',
  'bank.autopost': 'Auto-post rules',
  stage: 'Stage changes',
};

export function scopeLabel(scope: string): string {
  return (SCOPE_LABELS as Record<string, string | undefined>)[scope] ?? scope;
}

/**
 * A bank connection's last failure, fit to show. The sync records whatever message it caught, and
 * a failed query's message carries its SQL and every bound value, which never reaches a screen.
 */
export function feedErrorText(lastError: string | null): string | null {
  if (lastError === null || lastError.trim() === '') return null;
  if (/^failed query/i.test(lastError.trim())) return 'The books could not save what the bank sent. The next sync tries again.';
  return lastError;
}

export interface SyncSummary {
  tone: 'success' | 'warning';
  title: string;
  description: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** The toast after "Sync now": what came in, what the rules posted, and what went wrong. */
export function syncSummary(run: SyncRunReport): SyncSummary {
  if (run.items.length === 0) {
    return { tone: 'warning', title: 'Nothing to sync', description: 'No bank is connected yet.' };
  }
  const inserted = run.items.reduce((sum, item) => sum + item.accounts.reduce((s, a) => s + a.inserted, 0), 0);
  const posted = run.autoPost.posted.length;
  const failed = run.items.filter((item) => item.error !== null);

  const parts: string[] = [];
  if (inserted > 0 || posted > 0) parts.push(`${plural(posted, 'line', 'lines')} auto-posted by your rules`);
  if (inserted > posted) parts.push('the rest wait in Review');
  for (const item of failed) parts.push(`${item.institution ?? 'A bank'}: ${feedErrorText(item.error)}`);
  if (run.autoPost.failed.length > 0) {
    parts.push(`${plural(run.autoPost.failed.length, 'rule match', 'rule matches')} could not post`);
  }
  if (parts.length === 0) parts.push('Every connected account is up to date');

  return {
    tone: failed.length > 0 || run.autoPost.failed.length > 0 ? 'warning' : 'success',
    title: inserted === 0 ? 'No new bank lines' : `${plural(inserted, 'new bank line', 'new bank lines')}`,
    description: `${parts.join(' · ')}.`,
  };
}

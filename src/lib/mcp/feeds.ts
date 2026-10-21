/**
 * The bank-feed tools: run the sync now, and run the owner-approved auto-post rules now.
 *
 * Neither decides what any entry is. The sync only brings bank lines into the review queue; the
 * auto-post rules were each approved by an owner in the app. Available to a signed-in person with the
 * capability, and to a scoped key with the matching scope.
 */
import { requireCapability } from '@/lib/auth/roles';
import { postAutoPostMatches } from '@/lib/banking/post';
import { syncAllFeeds } from '@/lib/feeds/sync';

import { McpInputError } from './errors';
import type { McpUser } from './types';

function assertScope(user: McpUser, scope: 'bank.sync' | 'bank.autopost'): void {
  if (user.key && !user.key.scopes.includes(scope)) throw new McpInputError(`The key "${user.key.name}" is not allowed to do that.`);
}

export async function syncBankFeedsText(user: McpUser): Promise<string> {
  assertScope(user, 'bank.sync');
  requireCapability(user.role, 'bank.import');
  const run = await syncAllFeeds();
  if (run.items.length === 0) return 'No bank feed is connected. An owner connects Relay in Settings → Bank feeds.';
  const lines = run.items.flatMap((item) => [
    `${item.institution ?? 'Bank'}: ${item.error === null ? 'synced' : `FAILED — ${item.error}`}`,
    ...item.accounts.map((a) => `  ${a.bankAccountName}: ${a.inserted} new, ${a.duplicates} already in the books`),
    item.changedLater > 0 ? `  ${item.changedLater} transaction(s) changed or withdrawn by the bank since; noted on the row for a person.` : '',
  ]);
  return [
    ...lines.filter(Boolean),
    `Auto-post rules posted ${run.autoPost.posted.length} line(s); ${run.autoPost.failed.length} could not post.`,
    'Everything else is in the review queue for a person.',
  ].join('\n');
}

export async function runAutoPostText(user: McpUser): Promise<string> {
  assertScope(user, 'bank.autopost');
  requireCapability(user.role, 'bank.approve');
  const report = await postAutoPostMatches({ userId: user.id });
  return [
    `Auto-post rules posted ${report.posted.length} line(s).`,
    ...report.posted.map((p) => `- entry #${p.entryNo}`),
    ...report.failed.map((f) => `- could not post txn ${f.txnId}: ${f.error}`),
    report.posted.length === 0 && report.failed.length === 0 ? 'Nothing was waiting that an auto-post rule matches.' : '',
  ].filter(Boolean).join('\n');
}


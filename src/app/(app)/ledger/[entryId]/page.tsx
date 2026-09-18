import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EntryDetail } from '@/components/ledger/entry-detail';
import { JournalEntryForm } from '@/components/ledger/entry-form';
import { sourceLabel, type EntrySeedLine } from '@/components/ledger/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import {
  accountOptions,
  channelOptions,
  closedPeriodKeys,
  entryDetail,
  productOptions,
} from '../queries';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ entryId: string }>;
}): Promise<Metadata> {
  const { entryId } = await params;
  const detail = await entryDetail(entryId);
  return { title: detail === null ? 'Entry' : `Entry #${detail.entry.entryNo}` };
}

/**
 * One entry.
 *
 * A draft opens in the entry form, because a draft is still being written. A
 * posted entry opens read-only with its history, because the database will not
 * let it be anything else — the correction for a posted entry is a reversal.
 */
export default async function EntryPage({ params }: { params: Promise<{ entryId: string }> }) {
  const [user, { entryId }] = await Promise.all([requireUser(), params]);
  const detail = await entryDetail(entryId);
  if (detail === null) notFound();

  const { entry, lines, audit } = detail;
  const canPost = can(user.role, 'ledger.post');

  if (entry.status === 'draft') {
    const [accounts, channels, products, closedPeriods] = await Promise.all([
      accountOptions(),
      channelOptions(),
      productOptions(),
      closedPeriodKeys(),
    ]);

    const seed: EntrySeedLine[] = lines.map((line) => ({
      accountId: line.accountId,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      memo: line.memo ?? '',
      channelId: line.channelId,
      productId: line.productId,
    }));

    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          eyebrow="Books"
          title={`Draft #${entry.entryNo}`}
          description="Unposted, so it counts for nothing until it balances and is posted."
          meta={<Badge tone="warning">Draft</Badge>}
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/ledger">Back to the journal</Link>
            </Button>
          }
        />
        <JournalEntryForm
          accounts={accounts}
          channels={channels}
          products={products}
          draftId={entry.id}
          draftEntryNo={entry.entryNo}
          initialDate={entry.date}
          initialMemo={entry.memo ?? ''}
          initialLines={seed}
          closedPeriods={closedPeriods}
          canPost={canPost}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Books"
        title={`Entry #${entry.entryNo}`}
        description={`${sourceLabel(entry.sourceType)} · ${entry.date}`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/ledger">Back to the journal</Link>
          </Button>
        }
      />
      <EntryDetail entry={entry} lines={lines} audit={audit} canPost={canPost} />
    </div>
  );
}

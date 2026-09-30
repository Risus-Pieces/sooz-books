import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EntryActions } from '@/components/ledger/entry-actions';
import { EntryDetail } from '@/components/ledger/entry-detail';
import { JournalEntryForm } from '@/components/ledger/entry-form';
import type { EntrySeedLine } from '@/components/ledger/types';
import { ReceiptLink } from '@/components/receipts/receipt-link';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Pill } from '@/components/ui/pill';
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
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar
          title={`Draft #${entry.entryNo}`}
          back={{ href: '/ledger', label: 'Journal' }}
          phoneTitleRow
          subtitle={
            <Pill tone="orange" glyph="pencil">
              Draft
            </Pill>
          }
          info={<p>Unposted, so it counts for nothing until it balances and is posted.</p>}
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
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={`Entry #${entry.entryNo}`}
        back={{ href: '/ledger', label: 'Journal' }}
        phoneTitleRow
        info={
          <p>
            A posted entry never changes. To correct it, reverse it: that posts its mirror image and links the two.
          </p>
        }
        actions={
          <EntryActions
            entryId={entry.id}
            entryNo={entry.entryNo}
            date={entry.date}
            sourceType={entry.sourceType}
            status={entry.status}
            reversed={entry.reversedById !== null}
            canPost={canPost}
          />
        }
      />
      <ReceiptLink entryId={entry.id} />
      <EntryDetail entry={entry} lines={lines} audit={audit} />
    </div>
  );
}

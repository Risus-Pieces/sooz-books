import type { Metadata } from 'next';
import Link from 'next/link';
import { ShieldOff } from 'lucide-react';

import { JournalEntryForm } from '@/components/ledger/entry-form';
import type { EntrySeedLine } from '@/components/ledger/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { today } from '@/lib/dates';

import {
  accountOptions,
  channelOptions,
  closedPeriodKeys,
  entryDetail,
  productOptions,
} from '../queries';

export const metadata: Metadata = {
  title: 'New journal entry',
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/**
 * A new manual entry, optionally seeded from an existing one.
 *
 * Duplicating copies the lines and the memo but never the date or the entry
 * number: the duplicate is a new event, and dating it on the original is the
 * most common way to post something into the wrong month.
 */
export default async function NewEntryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [user, raw] = await Promise.all([requireUser('/ledger/new'), searchParams]);

  if (!can(user.role, 'ledger.post')) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Books" title="New journal entry" />
        <Card>
          <EmptyState
            icon={<ShieldOff />}
            title="Your role may not post to the ledger"
            description="A viewer can read every report but cannot write an entry. Ask an owner to change your role."
            action={
              <Button asChild variant="secondary" size="sm">
                <Link href="/ledger">Back to the journal</Link>
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const fromId = first(raw.from);

  const [accounts, channels, products, closedPeriods, source] = await Promise.all([
    accountOptions(),
    channelOptions(),
    productOptions(),
    closedPeriodKeys(),
    fromId === null ? Promise.resolve(null) : entryDetail(fromId),
  ]);

  const seed: EntrySeedLine[] =
    source === null
      ? []
      : source.lines.map((line) => ({
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
        title="New journal entry"
        description={
          source === null
            ? 'Tab across the grid, Enter for another line. Nothing posts until it balances.'
            : `Copied from entry #${source.entry.entryNo}. Check the date before posting.`
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/ledger">Cancel</Link>
          </Button>
        }
      />

      <JournalEntryForm
        accounts={accounts}
        channels={channels}
        products={products}
        draftId={null}
        draftEntryNo={null}
        initialDate={today()}
        initialMemo={source === null ? '' : (source.entry.memo ?? '')}
        initialLines={seed}
        closedPeriods={closedPeriods}
        canPost
      />
    </div>
  );
}

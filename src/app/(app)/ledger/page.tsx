import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';

import { JournalList } from '@/components/ledger/journal-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { SOURCE_TYPES } from '@/lib/ledger/post';

import { JOURNAL_PAGE_SIZE, accountOptions, journalPage, readJournalFilters } from './queries';

export const metadata: Metadata = {
  title: 'Journal',
};

type SearchParams = Record<string, string | string[] | undefined>;

function toParams(input: SearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) params.set(key, value[0]);
  }
  return params;
}

/**
 * The journal register. Every filter lives in the URL, so a narrowed view is
 * something that can be bookmarked, shared with the accountant, or linked to
 * from an account row — and so paging is a plain server round trip rather than
 * a client-side cache of a table that will run to five figures of rows.
 */
export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [user, raw] = await Promise.all([requireUser('/ledger'), searchParams]);
  const params = toParams(raw);
  const filters = readJournalFilters(params);
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const [result, accounts] = await Promise.all([
    journalPage(filters, page),
    accountOptions(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Books"
        title="Journal"
        description="Every entry in the ledger, however it got there."
        meta={
          <Badge tone="neutral">
            {result.total} {result.total === 1 ? 'entry' : 'entries'}
          </Badge>
        }
        actions={
          can(user.role, 'ledger.post') ? (
            <Button asChild size="sm">
              <Link href="/ledger/new">
                <Plus />
                New entry
              </Link>
            </Button>
          ) : null
        }
      />

      <JournalList
        // Remounting on a new query is what keeps the filter panel honest: it is
        // seeded from these filters and never has to be synced back to them.
        key={params.toString()}
        rows={result.rows}
        lines={result.lines}
        filters={filters}
        accounts={accounts}
        sourceTypes={SOURCE_TYPES}
        page={page}
        pageSize={JOURNAL_PAGE_SIZE}
        total={result.total}
        totalDebitCents={result.totalDebitCents}
      />
    </div>
  );
}

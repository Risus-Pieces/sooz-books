import type { Metadata } from 'next';
import Link from 'next/link';

import { JournalFilterButton } from '@/components/ledger/journal-filters';
import { JournalList } from '@/components/ledger/journal-list';
import { journalQuery } from '@/components/ledger/journal-query';
import { sourceLabel, type AccountOption, type JournalFilters } from '@/components/ledger/types';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Glyph } from '@/components/ui/glyph';
import { Pill } from '@/components/ui/pill';
import { SearchField } from '@/components/ui/search-field';
import { ToolbarGroup, ToolbarLink } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { today } from '@/lib/dates';
import { SOURCE_TYPES } from '@/lib/ledger/post';
import { shortDate } from '@/lib/ui/format';

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

/** The filters in force, as capsules: each one removes itself. */
function activeFilters(filters: JournalFilters, accounts: readonly AccountOption[]) {
  const chips: Array<{ key: string; label: string; without: Partial<JournalFilters> }> = [];
  if (filters.from !== '' || filters.to !== '') {
    const from = filters.from === '' ? '…' : shortDate(filters.from);
    const to = filters.to === '' ? '…' : shortDate(filters.to);
    chips.push({ key: 'dates', label: `${from} – ${to}`, without: { from: '', to: '' } });
  }
  if (filters.status !== '') {
    chips.push({ key: 'status', label: filters.status === 'draft' ? 'Drafts' : 'Posted', without: { status: '' } });
  }
  if (filters.sourceType !== '') {
    chips.push({ key: 'source', label: sourceLabel(filters.sourceType), without: { sourceType: '' } });
  }
  if (filters.accountId !== '') {
    const account = accounts.find((a) => a.id === filters.accountId);
    chips.push({ key: 'account', label: account ? `${account.code} ${account.name}` : 'Account', without: { accountId: '' } });
  }
  if (filters.minAmount !== '' || filters.maxAmount !== '') {
    chips.push({
      key: 'amount',
      label: `$${filters.minAmount === '' ? '0' : filters.minAmount} – ${filters.maxAmount === '' ? '…' : `$${filters.maxAmount}`}`,
      without: { minAmount: '', maxAmount: '' },
    });
  }
  if (filters.q !== '') chips.push({ key: 'q', label: `“${filters.q}”`, without: { q: '' } });
  return chips;
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
  const selectedId = params.get('entry');

  const [result, accounts] = await Promise.all([journalPage(filters, page), accountOptions()]);
  const canPost = can(user.role, 'ledger.post');
  const chips = activeFilters(filters, accounts);

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Journal"
        phoneTitleRow
        subtitle={<span className="num">{result.total}</span>}
        info={
          <p>
            Every entry in the ledger, however it got there: bank lines approved in review, invoices, bills, payouts
            and entries written by hand. Posted entries never change; a correction is a reversal.
          </p>
        }
        search={
          <form method="get" action="/ledger" role="search" className="max-md:w-full">
            {Object.entries(filters).map(([key, value]) =>
              key === 'q' || value === '' ? null : <input key={key} type="hidden" name={key} value={value} />,
            )}
            <SearchField appearance="toolbar" name="q" defaultValue={filters.q} aria-label="Search memos" />
          </form>
        }
        actions={
          <>
            <ToolbarGroup>
              <JournalFilterButton
                key={params.toString()}
                filters={filters}
                accounts={accounts}
                sourceTypes={SOURCE_TYPES}
              />
              {canPost ? <ToolbarLink href="/ledger/new" glyph="plus" label="New entry" /> : null}
            </ToolbarGroup>
            <ToolbarGroup>
              <ToolbarLink href="/ledger/accounts" glyph="list" label="Chart of accounts" />
              <ToolbarLink href="/ledger/audit" glyph="clock" label="Audit trail" />
            </ToolbarGroup>
          </>
        }
      />

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Link
              key={chip.key}
              href={`/ledger?${journalQuery({ ...filters, ...chip.without })}`}
              aria-label={`Remove filter ${chip.label}`}
              className="rounded-full"
            >
              <Pill tone="blue" className="max-sm:h-9">
                {chip.label}
                <Glyph name="xmark" size={10} weight={2.4} />
              </Pill>
            </Link>
          ))}
        </div>
      ) : null}

      <JournalList
        rows={result.rows}
        lines={result.lines}
        filters={filters}
        page={page}
        pageSize={JOURNAL_PAGE_SIZE}
        total={result.total}
        totalDebitCents={result.totalDebitCents}
        selectedId={selectedId}
        canPost={canPost}
        currentYear={Number(today().slice(0, 4))}
      />
    </div>
  );
}

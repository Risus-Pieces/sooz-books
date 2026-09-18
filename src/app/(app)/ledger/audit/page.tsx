import type { Metadata } from 'next';
import Link from 'next/link';

import { AuditFilterButton } from '@/components/ledger/audit-table';
import { AuditTimeline } from '@/components/ledger/audit-timeline';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Glyph } from '@/components/ui/glyph';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { requireUser } from '@/lib/auth/session';

import { AUDIT_PAGE_SIZE, auditPage, readAuditFilters } from '../queries';

export const metadata: Metadata = {
  title: 'Audit trail',
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
 * Every write to a financial table, attributed and diffed.
 *
 * The trail is written by database triggers rather than by application code, so
 * it records what actually happened to the rows — including anything that
 * reached the database another way.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [, raw] = await Promise.all([requireUser('/ledger/audit'), searchParams]);
  const params = toParams(raw);
  const filters = readAuditFilters(params);
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const result = await auditPage(filters, page);
  const active = Object.values(filters).some((value) => value !== '');
  const lastPage = Math.max(1, Math.ceil(result.total / AUDIT_PAGE_SIZE));
  const pageHref = (target: number) => {
    const next = new URLSearchParams(params);
    if (target > 1) next.set('page', String(target));
    else next.delete('page');
    const query = next.toString();
    return query === '' ? '/ledger/audit' : `/ledger/audit?${query}`;
  };

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Audit trail"
        back={{ href: '/ledger', label: 'Journal' }}
        phoneTitleRow
        subtitle={<span className="num">{result.total}</span>}
        info={
          <p>
            Who changed what, and what it was before. Every insert, update and delete on a financial table lands here,
            written by the database itself rather than by the application.
          </p>
        }
        actions={
          <ToolbarGroup>
            <AuditFilterButton key={params.toString()} filters={filters} tables={result.tables} actors={result.actors} />
          </ToolbarGroup>
        }
      />

      {result.rows.length === 0 ? (
        <div className="rounded-2xl bg-card shadow-card">
          <EmptyState
            glyph="clock"
            title={active ? 'No matching changes' : 'Nothing recorded yet'}
            action={
              active ? (
                <Button asChild variant="secondary">
                  <Link href="/ledger/audit">Clear filters</Link>
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-[860px]">
          <AuditTimeline rows={result.rows} />
          <div className="flex items-center justify-between gap-3 px-1 py-4 text-xs text-label2">
            <span className="num">
              {(page - 1) * AUDIT_PAGE_SIZE + 1}–{Math.min(page * AUDIT_PAGE_SIZE, result.total)} of {result.total}
            </span>
            {lastPage > 1 ? (
              <span className="flex items-center gap-1.5">
                <Button asChild variant="secondary" size="sm">
                  <Link
                    href={pageHref(Math.max(1, page - 1))}
                    aria-label="Newer"
                    aria-disabled={page <= 1}
                    className={page <= 1 ? 'pointer-events-none opacity-45' : undefined}
                  >
                    <Glyph name="chevron-left" size={13} />
                  </Link>
                </Button>
                <span className="num">
                  {page} / {lastPage}
                </span>
                <Button asChild variant="secondary" size="sm">
                  <Link
                    href={pageHref(Math.min(lastPage, page + 1))}
                    aria-label="Older"
                    aria-disabled={page >= lastPage}
                    className={page >= lastPage ? 'pointer-events-none opacity-45' : undefined}
                  >
                    <Glyph name="chevron-right" size={13} />
                  </Link>
                </Button>
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

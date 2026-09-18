import type { Metadata } from 'next';

import { AuditTable } from '@/components/ledger/audit-table';
import { PageHeader } from '@/components/ui/page-header';
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

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Books"
        title="Audit trail"
        description="Who changed what, and what it was before. Written by the database, not by the application."
      />
      <AuditTable
        key={params.toString()}
        rows={result.rows}
        filters={filters}
        tables={result.tables}
        actors={result.actors}
        page={page}
        pageSize={AUDIT_PAGE_SIZE}
        total={result.total}
      />
    </div>
  );
}

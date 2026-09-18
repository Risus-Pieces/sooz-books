import type { Metadata } from 'next';
import Link from 'next/link';

import { AgingReport } from '@/components/arap/aging-report';
import { Button } from '@/components/ui/button';
import { arAging } from '@/lib/arap';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { isCalendarDate, today } from '@/lib/dates';

export const metadata: Metadata = { title: 'AR aging' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AgingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/sales/aging'), searchParams]);
  const now = today();
  const asOf = typeof raw.asOf === 'string' && isCalendarDate(raw.asOf) ? raw.asOf : now;
  const aging = await arAging(asOf);
  const canCreate = can(user.role, 'ar.manage');

  return (
    <AgingReport
      data={aging}
      action="/sales/aging"
      today={now}
      title="Receivables aging"
      back={{ href: '/sales', label: 'Sales' }}
      createHref={canCreate ? '/sales/invoices/new' : undefined}
      createLabel="New invoice"
      emptyAction={
        canCreate ? (
          <Button asChild>
            <Link href="/sales/invoices/new">New invoice</Link>
          </Button>
        ) : undefined
      }
    />
  );
}

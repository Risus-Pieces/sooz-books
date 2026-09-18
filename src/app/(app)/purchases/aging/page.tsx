import type { Metadata } from 'next';
import Link from 'next/link';

import { AgingReport } from '@/components/arap/aging-report';
import { Button } from '@/components/ui/button';
import { apAging } from '@/lib/arap';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { isCalendarDate, today } from '@/lib/dates';

export const metadata: Metadata = { title: 'AP aging' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AgingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/purchases/aging'), searchParams]);
  const now = today();
  const asOf = typeof raw.asOf === 'string' && isCalendarDate(raw.asOf) ? raw.asOf : now;
  const aging = await apAging(asOf);
  const canCreate = can(user.role, 'ap.manage');

  return (
    <AgingReport
      data={aging}
      action="/purchases/aging"
      today={now}
      title="Payables aging"
      back={{ href: '/purchases', label: 'Purchases' }}
      createHref={canCreate ? '/purchases/bills/new' : undefined}
      createLabel="New bill"
      emptyAction={
        canCreate ? (
          <Button asChild>
            <Link href="/purchases/bills/new">New bill</Link>
          </Button>
        ) : undefined
      }
    />
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';

import { AgingReport } from '@/components/arap/aging-report';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { arAging } from '@/lib/arap';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { isCalendarDate, today } from '@/lib/dates';

export const metadata: Metadata = { title: 'AR aging' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ArAgingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/sales/aging'), searchParams]);
  const now = today();
  const asOf = typeof raw.asOf === 'string' && isCalendarDate(raw.asOf) ? raw.asOf : now;
  const aging = await arAging(asOf);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sales"
        title="Receivables aging"
        description="What each customer owes, by how late it is. Pick any past date to see the aging exactly as it stood then."
      />
      <AgingReport
        data={aging}
        action="/sales/aging"
        today={now}
        emptyAction={
          can(user.role, 'ar.manage') ? (
            <Button asChild size="sm">
              <Link href="/sales/invoices/new">
                <Plus />
                New invoice
              </Link>
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

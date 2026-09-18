import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';

import { AgingReport } from '@/components/arap/aging-report';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { apAging } from '@/lib/arap';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { isCalendarDate, today } from '@/lib/dates';

export const metadata: Metadata = { title: 'AP aging' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ApAgingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/purchases/aging'), searchParams]);
  const now = today();
  const asOf = typeof raw.asOf === 'string' && isCalendarDate(raw.asOf) ? raw.asOf : now;
  const aging = await apAging(asOf);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Purchases"
        title="Payables aging"
        description="What Sooz owes each vendor, by how late it is. Pick any past date to see the aging exactly as it stood then."
      />
      <AgingReport
        data={aging}
        action="/purchases/aging"
        today={now}
        emptyAction={
          can(user.role, 'ap.manage') ? (
            <Button asChild size="sm">
              <Link href="/purchases/bills/new">
                <Plus />
                New bill
              </Link>
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

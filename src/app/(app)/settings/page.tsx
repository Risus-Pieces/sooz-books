import type { Metadata } from 'next';
import Link from 'next/link';
import { ListTree, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { can, type Capability } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

export const metadata: Metadata = {
  title: 'Settings',
};

interface SettingsArea {
  href: string;
  title: string;
  description: string;
  icon: typeof Users;
  /** The capability that lets a viewer change what the area shows. */
  manage: Capability;
}

const AREAS: readonly SettingsArea[] = [
  {
    href: '/settings/users',
    title: 'Users',
    description:
      'Who can open these books and what each person may do: invite, change a role, switch access off.',
    icon: Users,
    manage: 'users.manage',
  },
  {
    href: '/ledger/accounts',
    title: 'Chart of accounts',
    description:
      'The accounts the ledger posts to, nested as they read on a statement. Adding or reshaping one is a settings change.',
    icon: ListTree,
    manage: 'settings.manage',
  },
];

export default async function SettingsIndexPage() {
  const viewer = await requireUser('/settings');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        description="How these books are set up and who can reach them."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {AREAS.map((area) => {
          const Icon = area.icon;
          return (
            <Card key={area.href} className="transition-colors hover:border-border-strong">
              <Link href={area.href} className="flex flex-col gap-2 p-4">
                <div className="flex items-center gap-2">
                  <span className="flex size-7 items-center justify-center rounded-sm border border-border bg-muted text-muted-foreground [&_svg]:size-4">
                    <Icon aria-hidden />
                  </span>
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">
                    {area.title}
                  </h2>
                  {can(viewer.role, area.manage) ? null : <Badge tone="neutral">View only</Badge>}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{area.description}</p>
              </Link>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

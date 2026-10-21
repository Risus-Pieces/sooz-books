import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { asc, eq } from 'drizzle-orm';
import { formatDistanceToNowStrict } from 'date-fns';

import { db, sql } from '@/db/client';
import { appUsers } from '@/db/schema';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { calendarDateAt } from '@/lib/dates';
import { listApiKeys } from '@/lib/feeds/keys';
import { publicOrigin } from '@/lib/mcp/auth';
import { mediumDate } from '@/lib/ui/format';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { EmptyState } from '@/components/ui/empty-state';
import { Glyph } from '@/components/ui/glyph';
import { InfoButton } from '@/components/ui/info-button';
import { InsetGroup } from '@/components/ui/inset-group';
import { ToolbarGroup } from '@/components/ui/toolbar';

import { scopeLabel } from '../_components/feeds-format';
import { KeyRow, NewKeySheet, type KeyView } from '../_components/keys-ui';
import { PaneBody, SettingsSplit, paneFor } from '../_components/settings-split';

export const metadata: Metadata = {
  title: 'API Keys',
};

export default async function ApiKeysSettingsPage() {
  const viewer = await requireUser('/settings/keys');
  const pane = paneFor('keys');
  const company = await companyName();

  if (!can(viewer.role, 'users.manage')) {
    return (
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar title={pane.label} back={{ href: '/settings', label: 'Settings' }} phoneTitleRow />
        <SettingsSplit current="keys" paneOpen companyName={company}>
          <EmptyState
            glyph="lock"
            title="Owners only"
            description="A key acts for a person, so only an owner can make or revoke one. Ask an owner of these books."
            className="py-24"
          />
        </SettingsSplit>
      </div>
    );
  }

  // Sequential on purpose: the connection pool this app shares is small.
  const keys = await listApiKeys();
  const people = await db
    .select({ id: appUsers.id, email: appUsers.email })
    .from(appUsers)
    .where(eq(appUsers.active, true))
    .orderBy(asc(appUsers.email));
  const connectorUrl = `${publicOrigin(new Request('http://internal', { headers: await headers() }))}/mcp`;

  const views: KeyView[] = keys.map((key) => ({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    userEmail: key.userEmail,
    scopes: key.scopes.map(scopeLabel),
    created: mediumDate(calendarDateAt(key.createdAt)),
    lastUsed: key.lastUsedAt ? `${formatDistanceToNowStrict(key.lastUsedAt)} ago` : 'never',
    revoked: key.revokedAt ? mediumDate(calendarDateAt(key.revokedAt)) : null,
  }));
  const live = views.filter((key) => key.revoked === null).length;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={pane.label}
        subtitle={`${live} ${live === 1 ? 'active key' : 'active keys'}`}
        back={{ href: '/settings', label: 'Settings' }}
        phoneTitleRow
        info="Keys let an agent work while nobody is signed in. Each acts for one person, limited to its scopes, and can never post on its own."
        actions={
          <ToolbarGroup>
            <NewKeySheet
              people={people.map((person) => ({ value: person.id, label: person.email }))}
              defaultUserId={viewer.id}
              connectorUrl={connectorUrl}
            />
          </ToolbarGroup>
        }
      />

      <SettingsSplit current="keys" paneOpen companyName={company} extras={{ keys: live > 0 ? String(live) : undefined }}>
        <PaneBody>
          <InsetGroup
            header="Keys"
            separatorInset={63}
            headerAccessory={
              <InfoButton label="About keys">
                The token is shown once, when the key is made; only a fingerprint of it is kept. An agent with a key can
                read the books, run the bank sync and the auto-post rules, and stage changes that wait up to 36 hours for
                the person to confirm.
              </InfoButton>
            }
          >
            {views.length === 0 ? (
              <div className="flex min-h-[64px] items-center justify-center gap-2 px-4 text-sm text-label2">
                <Glyph name="key" size={16} className="text-label3" />
                No keys yet
              </div>
            ) : (
              views.map((key) => <KeyRow key={key.id} apiKey={key} />)
            )}
          </InsetGroup>
        </PaneBody>
      </SettingsSplit>
    </div>
  );
}

async function companyName(): Promise<string> {
  const rows = await sql<Array<{ companyName: string }>>`select company_name as "companyName" from app_settings limit 1`;
  return rows[0]?.companyName ?? 'Sooz Beverage LLC';
}

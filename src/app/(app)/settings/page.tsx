import type { Metadata } from 'next';
import { headers } from 'next/headers';

import { sql } from '@/db/client';
import { ROLE_LABELS, can, type Capability } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { publicOrigin } from '@/lib/mcp/auth';
import type { GlyphName } from '@/lib/ui/glyphs';
import type { Tint } from '@/lib/ui/tints';
import { CompanyAvatar } from '@/components/shell/account-menu';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { IconBadge } from '@/components/ui/icon-badge';
import { InfoButton } from '@/components/ui/info-button';
import { GroupRow, InsetGroup, ListRow } from '@/components/ui/inset-group';

import { Pill } from '@/components/ui/pill';

import { AppearancePicker } from './_components/appearance-picker';
import { PaneBody, ROLE_TONE, SettingsSplit, isPaneKey, paneFor, type SettingsPaneKey } from './_components/settings-split';

export const metadata: Metadata = {
  title: 'Settings',
};

type SearchParams = Record<string, string | string[] | undefined>;

interface CompanyFacts {
  companyName: string;
  ownerEmail: string;
  timeZone: string;
}

interface DataCounts {
  accounts: number;
  entries: number;
  transactions: number;
  imports: number;
  auditEvents: number;
  closedPeriods: number;
}

export default async function SettingsIndexPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [viewer, params] = await Promise.all([requireUser('/settings'), searchParams]);
  const requested = first(params.pane);
  const paneOpen = isPaneKey(requested) && requested !== 'users';
  const current: SettingsPaneKey = paneOpen && isPaneKey(requested) ? requested : 'company';
  const pane = paneFor(current);

  // Sequential on purpose: the connection pool this app shares is small.
  const company = await companyFacts();
  const connectorUrl = `${publicOrigin(new Request('http://internal', { headers: await headers() }))}/mcp`;
  const counts = current === 'data' ? await dataCounts() : null;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={paneOpen ? pane.label : 'Settings'}
        back={paneOpen ? { href: '/settings', label: 'Settings' } : undefined}
        phoneTitleRow={paneOpen}
        info="How these books are set up and who can reach them."
      />

      <SettingsSplit current={current} paneOpen={paneOpen} companyName={company.companyName}>
        {current === 'company' ? (
          <PaneBody>
            <div className="flex flex-col items-center gap-1 pt-4 pb-1 text-center">
              <span className="mb-2">
                <CompanyAvatar size={72} />
              </span>
              <h2 className="text-xl font-bold tracking-[-0.02em]">{company.companyName}</h2>
              <p className="text-sm text-label2">{pane.label}</p>
            </div>
            <InsetGroup header="Details">
              <GroupRow label="Owner">
                <span className="truncate">{company.ownerEmail}</span>
              </GroupRow>
              <GroupRow label="Time zone">{company.timeZone}</GroupRow>
            </InsetGroup>
            <InsetGroup header="You">
              <GroupRow label="Signed in">
                <span className="truncate">{viewer.email}</span>
              </GroupRow>
              <GroupRow label="Role">
                <Pill tone={ROLE_TONE[viewer.role]}>{ROLE_LABELS[viewer.role]}</Pill>
              </GroupRow>
            </InsetGroup>
            <InsetGroup
              header="Claude"
              footer="In Claude, add a custom connector with this address, then sign in with your Sooz Books login. Claude acts as you and can do only what your role allows; nothing is posted until you confirm it in the chat."
            >
              <GroupRow label="Connector address">
                <span className="truncate font-mono text-xs">{connectorUrl}</span>
              </GroupRow>
            </InsetGroup>
          </PaneBody>
        ) : current === 'appearance' ? (
          <PaneBody>
            <InsetGroup
              header="Appearance"
              headerAccessory={
                <InfoButton label="About appearance">
                  Auto follows the system. The choice is kept on this device; the toolbar&apos;s appearance button
                  changes it too.
                </InfoButton>
              }
            >
              <AppearancePicker />
            </InsetGroup>
          </PaneBody>
        ) : (
          <PaneBody>
            <InsetGroup header="Books" separatorInset={57}>
              {DATA_ROWS.map((row) => (
                <ListRow
                  key={row.href}
                  href={row.href}
                  chevron
                  leading={<IconBadge glyph={row.glyph} tint={row.tint} size="lg" />}
                  title={row.label}
                  trailing={
                    counts ? (
                      <span className="num text-sm font-medium text-label2">
                        {counts[row.count].toLocaleString('en-US')}
                      </span>
                    ) : undefined
                  }
                  subtitle={
                    row.manage && !can(viewer.role, row.manage) ? (
                      <Pill tone="neutral" className="h-5 px-2 text-2xs">
                        View only
                      </Pill>
                    ) : (
                      row.unit
                    )
                  }
                />
              ))}
            </InsetGroup>
          </PaneBody>
        )}
      </SettingsSplit>
    </div>
  );
}

const DATA_ROWS: ReadonlyArray<{
  label: string;
  unit: string;
  href: string;
  glyph: GlyphName;
  tint: Tint;
  count: keyof DataCounts;
  /** The capability that lets a viewer change what the page shows. */
  manage?: Capability;
}> = [
  { label: 'Chart of Accounts', unit: 'Accounts', href: '/ledger/accounts', glyph: 'list', tint: 'indigo', count: 'accounts', manage: 'settings.manage' },
  { label: 'Journal', unit: 'Posted entries', href: '/ledger', glyph: 'book', tint: 'indigo', count: 'entries' },
  { label: 'Bank activity', unit: 'Transactions', href: '/banking', glyph: 'bank', tint: 'green', count: 'transactions' },
  { label: 'Imports', unit: 'Files', href: '/banking/import', glyph: 'import', tint: 'blue', count: 'imports' },
  { label: 'Audit', unit: 'Events', href: '/ledger/audit', glyph: 'shield', tint: 'gray', count: 'auditEvents' },
  { label: 'Close', unit: 'Closed periods', href: '/close', glyph: 'lock', tint: 'gray', count: 'closedPeriods' },
];

async function companyFacts(): Promise<CompanyFacts> {
  const rows = await sql<CompanyFacts[]>`
    select company_name as "companyName", owner_email as "ownerEmail", books_time_zone as "timeZone"
      from app_settings
     limit 1
  `;
  return rows[0] ?? { companyName: 'Sooz Beverage LLC', ownerEmail: '—', timeZone: 'America/Chicago' };
}

async function dataCounts(): Promise<DataCounts> {
  const rows = await sql<Array<Record<keyof DataCounts, string>>>`
    select (select count(*) from accounts where active)                  as accounts,
           (select count(*) from journal_entries where status = 'posted') as entries,
           (select count(*) from bank_transactions)                      as transactions,
           (select count(*) from import_batches)                         as imports,
           (select count(*) from audit_log)                              as "auditEvents",
           (select count(*) from periods where status = 'closed')        as "closedPeriods"
  `;
  const r = rows[0];
  return {
    accounts: Number(r?.accounts ?? 0),
    entries: Number(r?.entries ?? 0),
    transactions: Number(r?.transactions ?? 0),
    imports: Number(r?.imports ?? 0),
    auditEvents: Number(r?.auditEvents ?? 0),
    closedPeriods: Number(r?.closedPeriods ?? 0),
  };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

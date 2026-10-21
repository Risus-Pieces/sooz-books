import type { Metadata } from 'next';
import { asc, isNotNull } from 'drizzle-orm';
import { formatDistanceToNowStrict } from 'date-fns';

import { db, sql } from '@/db/client';
import { bankAccounts, plaidAccounts } from '@/db/schema';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { feedsConfigured, listFeeds } from '@/lib/feeds/connect';
import { mediumDate } from '@/lib/ui/format';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { EmptyState } from '@/components/ui/empty-state';
import { Glyph } from '@/components/ui/glyph';
import { InfoButton } from '@/components/ui/info-button';
import { InsetGroup } from '@/components/ui/inset-group';
import { ToolbarGroup } from '@/components/ui/toolbar';

import { accountLabel, feedErrorText } from '../_components/feeds-format';
import {
  ConnectBankButton,
  FeedItemGroup,
  SyncNowButton,
  type BankAccountChoice,
  type FeedItemView,
} from '../_components/feeds-ui';
import { PaneBody, SettingsSplit, paneFor } from '../_components/settings-split';

export const metadata: Metadata = {
  title: 'Bank Feeds',
};

const ENV_VARS = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_TOKEN_KEY'] as const;

export default async function BankFeedsSettingsPage() {
  const viewer = await requireUser('/settings/feeds');
  const pane = paneFor('feeds');
  const company = await companyName();

  if (!can(viewer.role, 'settings.manage')) {
    return (
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar title={pane.label} back={{ href: '/settings', label: 'Settings' }} phoneTitleRow />
        <SettingsSplit current="feeds" paneOpen companyName={company}>
          <EmptyState
            glyph="lock"
            title="Owners only"
            description="Only an owner can connect a bank or change where its accounts sync. Ask an owner of these books."
            className="py-24"
          />
        </SettingsSplit>
      </div>
    );
  }

  if (!feedsConfigured()) {
    return (
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar title={pane.label} back={{ href: '/settings', label: 'Settings' }} phoneTitleRow />
        <SettingsSplit current="feeds" paneOpen companyName={company}>
          <PaneBody>
            <InsetGroup header="Not set up" footer="Add them in Vercel → Settings → Environment Variables, then redeploy.">
              <div className="flex flex-col gap-3 px-4 py-3.5 text-sm text-label">
                <p className="flex items-start gap-2.5">
                  <Glyph name="info" size={16} className="mt-px shrink-0 text-tint-blue" />
                  The bank feed brings in transactions every night through Plaid. The server needs three settings
                  before it can connect a bank:
                </p>
                <ul className="flex flex-wrap gap-1.5 pl-[26px]">
                  {ENV_VARS.map((name) => (
                    <li key={name} className="rounded-[6px] bg-fill2 px-1.5 py-0.5 font-mono text-xs break-all">
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            </InsetGroup>
          </PaneBody>
        </SettingsSplit>
      </div>
    );
  }

  // Sequential on purpose: the connection pool this app shares is small.
  const feeds = await listFeeds();
  const banks = await db
    .select({ id: bankAccounts.id, name: bankAccounts.name, mask: bankAccounts.mask, active: bankAccounts.active })
    .from(bankAccounts)
    .orderBy(asc(bankAccounts.name));
  // Every mapping, a disconnected login's included: the database allows one feed per bank account.
  const mapped = await db
    .select({ id: plaidAccounts.id, bankAccountId: plaidAccounts.bankAccountId })
    .from(plaidAccounts)
    .where(isNotNull(plaidAccounts.bankAccountId));
  const takenBy = new Map(mapped.map((row) => [row.bankAccountId, row.id]));

  const choices: BankAccountChoice[] = banks.map((bank) => ({
    id: bank.id,
    label: accountLabel(bank.name, bank.mask),
    takenBy: takenBy.get(bank.id) ?? null,
    active: bank.active,
  }));
  const items: FeedItemView[] = feeds.map((feed) => ({
    id: feed.id,
    institution: feed.institution ?? 'Bank',
    lastSynced: feed.lastSyncedAt ? `${formatDistanceToNowStrict(feed.lastSyncedAt)} ago` : null,
    lastError: feedErrorText(feed.lastError),
    accounts: feed.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      mask: account.mask,
      bankAccountId: account.bankAccountId,
      syncFrom: account.syncFrom ? mediumDate(account.syncFrom) : null,
    })),
  }));
  const syncing = items.reduce((n, item) => n + item.accounts.filter((a) => a.bankAccountId !== null).length, 0);

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={pane.label}
        subtitle={items.length === 0 ? undefined : `${syncing} ${syncing === 1 ? 'account' : 'accounts'} syncing`}
        back={{ href: '/settings', label: 'Settings' }}
        phoneTitleRow
        info="Each night the feed brings new bank transactions into Review. Only rules you marked auto-post post on their own; everything else waits for a person."
        actions={
          items.length === 0 ? undefined : (
            <ToolbarGroup>
              <SyncNowButton />
            </ToolbarGroup>
          )
        }
      />

      <SettingsSplit current="feeds" paneOpen companyName={company} extras={{ feeds: items.length > 0 ? String(items.length) : undefined }}>
        <PaneBody>
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 pt-6 pb-2 text-center">
              <span className="grid size-14 place-items-center rounded-full bg-tint-green/14 text-tint-green">
                <Glyph name="bank" size={26} />
              </span>
              <h2 className="text-lg font-semibold tracking-[-0.01em]">No bank connected</h2>
              <p className="max-w-sm text-sm text-label2">
                Connect Relay to bring its transactions in every night, matched to your bank accounts by their last four
                digits.
              </p>
            </div>
          ) : (
            items.map((item) => <FeedItemGroup key={item.id} item={item} bankAccounts={choices} />)
          )}

          <div className="flex flex-col items-stretch gap-1.5 pt-1 sm:items-center">
            <ConnectBankButton />
            <p className="flex items-center justify-center gap-1 px-4 text-center text-xs text-label2">
              You sign in to the bank in Plaid&apos;s window; Sooz Books never sees the password.
              <InfoButton label="About the bank feed">
                Plaid hands back a read-only connection, kept encrypted. Disconnect it here at any time; what it already
                brought in stays in the books.
              </InfoButton>
            </p>
          </div>
        </PaneBody>
      </SettingsSplit>
    </div>
  );
}

async function companyName(): Promise<string> {
  const rows = await sql<Array<{ companyName: string }>>`select company_name as "companyName" from app_settings limit 1`;
  return rows[0]?.companyName ?? 'Sooz Beverage LLC';
}

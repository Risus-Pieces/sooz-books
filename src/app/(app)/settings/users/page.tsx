import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { asc } from 'drizzle-orm';
import { formatDistanceToNowStrict } from 'date-fns';

import { db, sql } from '@/db/client';
import { appUsers } from '@/db/schema';
import {
  deactivateUser,
  reactivateUser,
  revokeInvite,
  updateUserRole,
} from '@/lib/auth/actions';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { hasAdminAccess, createAdminClient } from '@/lib/supabase/server';
import { APP_ROLES, type AppRole, type Result } from '@/lib/types';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Glyph } from '@/components/ui/glyph';
import { InfoButton } from '@/components/ui/info-button';
import { InsetGroup, ListRow } from '@/components/ui/inset-group';
import { Monogram } from '@/components/ui/monogram';
import { Pill } from '@/components/ui/pill';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { cn } from '@/lib/cn';

import { PaneBody, ROLE_TONE, SettingsSplit, paneFor } from '../_components/settings-split';
import { InviteSheet, NewLinkSheet, PersonRow, type PersonView } from '../_components/users-ui';

export const metadata: Metadata = {
  title: 'Users',
};

type SearchParams = Record<string, string | string[] | undefined>;

const ROLE_OPTIONS = APP_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }));

export default async function UsersSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [viewer, params] = await Promise.all([requireUser(), searchParams]);
  const pane = paneFor('users');

  if (!can(viewer.role, 'users.manage')) {
    return (
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar title={pane.label} back={{ href: '/settings', label: 'Settings' }} phoneTitleRow />
        <SettingsSplit current="users" paneOpen companyName={await companyName()}>
          <EmptyState
            glyph="lock"
            title="Owners only"
            description="Only an owner can invite someone or change a role. Ask an owner of these books."
            className="py-24"
          />
        </SettingsSplit>
      </div>
    );
  }

  const [people, invites, lastSignIn] = await Promise.all([
    db
      .select({
        id: appUsers.id,
        email: appUsers.email,
        fullName: appUsers.fullName,
        role: appUsers.role,
        active: appUsers.active,
        createdAt: appUsers.createdAt,
      })
      .from(appUsers)
      .orderBy(asc(appUsers.email)),
    pendingInvites(),
    lastSignInByUser(),
  ]);
  const company = await companyName();

  const activeOwners = people.filter((p) => p.role === 'owner' && p.active).length;
  const activeCount = people.filter((p) => p.active).length;
  const ok = first(params.ok);
  const error = first(params.error);
  // A new answer remounts the rows and the invite sheet, which closes whichever sheet sent it.
  const noticeKey = ok ?? error ?? '';

  const views: PersonView[] = people.map((person) => ({
    id: person.id,
    name: person.fullName ?? person.email,
    email: person.email,
    role: person.role,
    roleLabel: ROLE_LABELS[person.role],
    active: person.active,
    isYou: person.id === viewer.id,
    isLastOwner: person.role === 'owner' && person.active && activeOwners === 1,
    lastSignIn: lastSignIn === null ? '—' : since(lastSignIn.get(person.id) ?? null),
    added: person.createdAt.toISOString().slice(0, 10),
  }));

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={pane.label}
        subtitle={`${people.length} ${people.length === 1 ? 'account' : 'accounts'}`}
        back={{ href: '/settings', label: 'Settings' }}
        phoneTitleRow
        info="Who can open these books, and what each of them may do. A role takes effect on the next request; nobody has to sign in again."
        actions={
          <ToolbarGroup>
            <InviteSheet key={`invite-${noticeKey}`} roleOptions={ROLE_OPTIONS} linksWork={hasAdminAccess()} />
          </ToolbarGroup>
        }
      />

      <SettingsSplit current="users" paneOpen companyName={company} extras={{ users: String(activeCount) }}>
        <PaneBody>
          <Notice ok={ok} error={error} />

          <RoleBar people={views} />

          <InsetGroup
            header="People"
            separatorInset={63}
            headerAccessory={
              <InfoButton label="About roles" title="Roles">
                {APP_ROLES.map((role) => (
                  <p key={role}>
                    <span className="font-semibold">{ROLE_LABELS[role]}</span> · {ROLE_DESCRIPTIONS[role]}
                  </p>
                ))}
              </InfoButton>
            }
          >
            {views.map((person) => (
              <PersonRow
                key={`${person.id}-${noticeKey}`}
                person={person}
                roleOptions={ROLE_OPTIONS}
                changeRole={changeRole}
                switchOff={switchOff}
                switchOn={switchOn}
              />
            ))}
          </InsetGroup>

          <InsetGroup
            header="Invites"
            separatorInset={63}
            headerAccessory={
              <InfoButton label="About invites">
                Each invite is a single-use link for one address that expires after a week. Make a new link if one is
                lost; the old one stops working.
              </InfoButton>
            }
          >
            {invites.length === 0 ? (
              <div className="flex min-h-[64px] items-center justify-center gap-2 px-4 text-sm text-label2">
                <Glyph name="mail" size={16} className="text-label3" />
                No open invites
              </div>
            ) : (
              invites.map((pending) => (
                <ListRow
                  key={pending.id}
                  leading={<Monogram name={pending.email} className="opacity-70" />}
                  title={pending.email}
                  subtitle={
                    <>
                      <Glyph name="clock" size={12} />
                      {pending.hasLink ? `expires ${until(pending.expiresAt)}` : 'needs a new link'}
                      {pending.invitedByEmail ? ` · ${pending.invitedByEmail}` : ''}
                    </>
                  }
                  trailing={
                    <span className="flex items-center gap-2">
                      <Pill tone={ROLE_TONE[pending.role]}>{ROLE_LABELS[pending.role]}</Pill>
                      <NewLinkSheet
                        key={`${pending.id}-${noticeKey}`}
                        inviteId={pending.id}
                        email={pending.email}
                        roleLabel={ROLE_LABELS[pending.role]}
                        linksWork={hasAdminAccess()}
                      />
                      <form action={withdrawInvite}>
                        <input type="hidden" name="inviteId" value={pending.id} />
                        <Button type="submit" variant="ghost" size="sm" aria-label={`Withdraw invite for ${pending.email}`}>
                          Withdraw
                        </Button>
                      </form>
                    </span>
                  }
                />
              ))
            )}
          </InsetGroup>
        </PaneBody>
      </SettingsSplit>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mutations. Each one calls the shared action, then reloads the page carrying its answer —
// the page stays a Server Component and the whole screen works without JavaScript.
// ---------------------------------------------------------------------------

async function changeRole(formData: FormData): Promise<void> {
  'use server';
  const result = await updateUserRole(
    String(formData.get('userId') ?? ''),
    String(formData.get('role') ?? '') as AppRole,
  );
  redirect(noticeUrl(result));
}

async function switchOff(formData: FormData): Promise<void> {
  'use server';
  redirect(noticeUrl(await deactivateUser(String(formData.get('userId') ?? ''))));
}

async function switchOn(formData: FormData): Promise<void> {
  'use server';
  redirect(noticeUrl(await reactivateUser(String(formData.get('userId') ?? ''))));
}

async function withdrawInvite(formData: FormData): Promise<void> {
  'use server';
  redirect(noticeUrl(await revokeInvite(String(formData.get('inviteId') ?? ''))));
}

function noticeUrl(result: Result<string, string>): string {
  const key = result.ok ? 'ok' : 'error';
  const message = result.ok ? result.value : result.error;
  return `/settings/users?${key}=${encodeURIComponent(message)}`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface PendingInvite {
  id: string;
  email: string;
  role: AppRole;
  /** Formatted in SQL as UTC ISO-8601, so nothing here depends on the driver's date parsing. */
  invitedAt: string;
  /** False for an invitation made before links existed: it cannot be claimed until re-keyed. */
  hasLink: boolean;
  expiresAt: string | null;
  invitedByEmail: string | null;
}

async function companyName(): Promise<string> {
  const rows = await sql<Array<{ companyName: string }>>`select company_name as "companyName" from app_settings limit 1`;
  return rows[0]?.companyName ?? 'Sooz Beverage LLC';
}

async function pendingInvites(): Promise<PendingInvite[]> {
  const rows = await sql<PendingInvite[]>`
    select i.id,
           i.email,
           i.role,
           to_char(i.invited_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "invitedAt",
           (i.token_hash is not null and i.expires_at > now()) as "hasLink",
           to_char(i.expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "expiresAt",
           u.email as "invitedByEmail"
      from app_invites i
      left join app_users u on u.id = i.invited_by
     where i.accepted_at is null
     order by i.invited_at desc
  `;
  return [...rows];
}

/**
 * Sign-in times live in Supabase's `auth.users`, which the application's database role cannot
 * read — only the admin API can. Returns null when no service role key is configured, which
 * the table renders as an em dash rather than pretending nobody has ever signed in.
 */
async function lastSignInByUser(): Promise<Map<string, string | null> | null> {
  if (!hasAdminAccess()) return null;
  const admin = createAdminClient();
  if (!admin) return null;

  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return null;

  return new Map(data.users.map((user) => [user.id, user.last_sign_in_at ?? null]));
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** The team at a glance: one segment per active person, coloured by role. */
function RoleBar({ people }: { people: PersonView[] }) {
  const active = people.filter((p) => p.active);
  const counts = APP_ROLES.map((role) => ({ role, count: active.filter((p) => p.role === role).length })).filter(
    (r) => r.count > 0,
  );
  if (active.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-[14px] bg-card px-4 py-3.5 shadow-card">
      <div className="flex h-2 gap-[3px] overflow-hidden rounded-full" role="img" aria-label={counts.map((r) => `${r.count} ${ROLE_LABELS[r.role]}`).join(', ')}>
        {counts.map((r) => (
          <span key={r.role} className={cn('h-full rounded-full', ROLE_BAR[r.role])} style={{ flexGrow: r.count }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {counts.map((r) => (
          <span key={r.role} className="inline-flex items-center gap-1.5 text-xs font-medium text-label2">
            <span aria-hidden className={cn('size-2 rounded-[2.5px]', ROLE_BAR[r.role])} />
            {ROLE_LABELS[r.role]}
            <span className="num font-semibold text-label">{r.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const ROLE_BAR: Record<AppRole, string> = {
  owner: 'bg-tint-purple',
  bookkeeper: 'bg-tint-blue',
  approver: 'bg-tint-orange',
  viewer: 'bg-tint-gray',
};

function Notice({ ok, error }: { ok?: string; error?: string }) {
  const message = ok ?? error;
  if (!message) return null;
  const positive = Boolean(ok);
  return (
    <p
      role="status"
      className="flex items-center gap-2.5 rounded-[12px] bg-card px-4 py-3 text-sm font-medium shadow-card"
    >
      <Glyph
        name={positive ? 'check-circle' : 'warning'}
        size={18}
        className={cn('shrink-0', positive ? 'text-tint-green' : 'text-tint-red')}
      />
      {message}
    </p>
  );
}

function until(iso: string | null): string {
  if (!iso) return 'never';
  return `in ${formatDistanceToNowStrict(new Date(iso))}`;
}

function since(iso: string | null): string {
  if (!iso) return 'never';
  return `${formatDistanceToNowStrict(new Date(iso))} ago`;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

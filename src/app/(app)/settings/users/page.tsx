import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { asc } from 'drizzle-orm';
import { formatDistanceToNowStrict } from 'date-fns';
import { AlertCircle, CheckCircle2, ShieldOff, UserPlus } from 'lucide-react';

import { db, sql } from '@/db/client';
import { appUsers } from '@/db/schema';
import {
  deactivateUser,
  inviteUser,
  reactivateUser,
  revokeInvite,
  updateUserRole,
} from '@/lib/auth/actions';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { hasAdminAccess, createAdminClient } from '@/lib/supabase/server';
import { APP_ROLES, type AppRole, type Result } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, inputBase } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/cn';

export const metadata: Metadata = {
  title: 'Users',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function UsersSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [viewer, params] = await Promise.all([requireUser(), searchParams]);

  if (!can(viewer.role, 'users.manage')) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Settings" title="Users" />
        <Card>
          <EmptyState
            icon={<ShieldOff />}
            title="Only an owner can manage access"
            description="Ask an owner of these books to invite someone or change a role."
          />
        </Card>
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

  const activeOwners = people.filter((p) => p.role === 'owner' && p.active).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Users"
        description="Who can open these books, and what each of them may do."
        meta={
          <Badge tone="neutral">
            {people.length} {people.length === 1 ? 'account' : 'accounts'}
          </Badge>
        }
      />

      <Notice ok={first(params.ok)} error={first(params.error)} />

      <InviteCard />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Accounts</CardTitle>
            <CardDescription>
              A role takes effect on the next request — nobody has to sign in again.
            </CardDescription>
          </div>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full min-w-3xl border-collapse text-sm">
            <thead>
              <tr className="rule-head text-left">
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>Last sign-in</Th>
                <Th>Added</Th>
                <Th className="text-right">Access</Th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => {
                const isLastOwner = person.role === 'owner' && person.active && activeOwners === 1;
                return (
                  <tr key={person.id} className="rule-row align-middle">
                    <Td>
                      <div className="flex flex-col leading-tight">
                        <span className="font-medium text-foreground">
                          {person.fullName ?? person.email}
                          {person.id === viewer.id ? (
                            <span className="ml-1.5 text-2xs font-normal text-muted-foreground">
                              (you)
                            </span>
                          ) : null}
                        </span>
                        <span className="text-xs text-muted-foreground">{person.email}</span>
                      </div>
                    </Td>
                    <Td>
                      <form action={changeRole} className="flex items-center gap-1.5">
                        <input type="hidden" name="userId" value={person.id} />
                        <RoleSelect name="role" defaultValue={person.role} />
                        <Button type="submit" variant="secondary" size="sm">
                          Save
                        </Button>
                      </form>
                      {isLastOwner ? (
                        <p className="mt-1 text-2xs text-muted-foreground">
                          The only owner — promote someone else first.
                        </p>
                      ) : null}
                    </Td>
                    <Td className="num text-xs text-muted-foreground">
                      {lastSignIn === null ? (
                        <span title="Requires SUPABASE_SERVICE_ROLE_KEY">—</span>
                      ) : (
                        since(lastSignIn.get(person.id) ?? null)
                      )}
                    </Td>
                    <Td className="num text-xs text-muted-foreground">
                      {person.createdAt.toISOString().slice(0, 10)}
                    </Td>
                    <Td className="text-right">
                      {person.active ? (
                        <form action={switchOff} className="inline-flex items-center gap-2">
                          <input type="hidden" name="userId" value={person.id} />
                          <Badge tone="positive">Active</Badge>
                          <Button
                            type="submit"
                            variant="danger-quiet"
                            size="sm"
                            disabled={person.id === viewer.id || isLastOwner}
                          >
                            Switch off
                          </Button>
                        </form>
                      ) : (
                        <form action={switchOn} className="inline-flex items-center gap-2">
                          <input type="hidden" name="userId" value={person.id} />
                          <Badge tone="neutral">Off</Badge>
                          <Button type="submit" variant="secondary" size="sm">
                            Switch on
                          </Button>
                        </form>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {invites.length > 0 ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Invitations not yet accepted</CardTitle>
              <CardDescription>
                The role is applied the moment that address signs up.
              </CardDescription>
            </div>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-xl border-collapse text-sm">
              <thead>
                <tr className="rule-head text-left">
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Invited</Th>
                  <Th className="text-right" />
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <tr key={invite.id} className="rule-row align-middle">
                    <Td className="font-medium text-foreground">{invite.email}</Td>
                    <Td>
                      <Badge tone="outline">{ROLE_LABELS[invite.role]}</Badge>
                    </Td>
                    <Td className="num text-xs text-muted-foreground">
                      {since(invite.invitedAt)}
                      {invite.invitedByEmail ? ` · by ${invite.invitedByEmail}` : ''}
                    </Td>
                    <Td className="text-right">
                      <form action={withdrawInvite}>
                        <input type="hidden" name="inviteId" value={invite.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          Withdraw
                        </Button>
                      </form>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>What each role may do</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {APP_ROLES.map((role) => (
            <div key={role} className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-foreground">{ROLE_LABELS[role]}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {ROLE_DESCRIPTIONS[role]}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mutations. Each one calls the shared action, then reloads the page carrying its answer —
// the page stays a Server Component and the whole screen works without JavaScript.
// ---------------------------------------------------------------------------

async function invite(formData: FormData): Promise<void> {
  'use server';
  const result = await inviteUser(
    String(formData.get('email') ?? ''),
    String(formData.get('role') ?? 'viewer') as AppRole,
  );
  redirect(noticeUrl(result));
}

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
  invitedByEmail: string | null;
}

async function pendingInvites(): Promise<PendingInvite[]> {
  const rows = await sql<PendingInvite[]>`
    select i.id,
           i.email,
           i.role,
           to_char(i.invited_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "invitedAt",
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

function InviteCard() {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Invite someone</CardTitle>
          <CardDescription>
            {hasAdminAccess()
              ? 'They receive an email, set a password, and arrive with the role you choose.'
              : 'No SUPABASE_SERVICE_ROLE_KEY is set, so no email goes out — they sign up with this address and the role is applied for them.'}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form action={invite} className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="invite-email" required>
              Email
            </Label>
            <Input
              id="invite-email"
              name="email"
              type="email"
              required
              placeholder="name@example.com"
            />
          </div>
          <div className="flex w-44 flex-col gap-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <RoleSelect id="invite-role" name="role" defaultValue="viewer" />
          </div>
          <Button type="submit">
            <UserPlus />
            Send invitation
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function RoleSelect({
  id,
  name,
  defaultValue,
}: {
  id?: string;
  name: string;
  defaultValue: AppRole;
}) {
  // A native select, so the page needs no client JavaScript at all.
  return (
    <select id={id} name={name} defaultValue={defaultValue} className={cn(inputBase, 'pr-1.5')}>
      {APP_ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}

function Notice({ ok, error }: { ok?: string; error?: string }) {
  const message = ok ?? error;
  if (!message) return null;

  const positive = Boolean(ok);
  const Icon = positive ? CheckCircle2 : AlertCircle;

  return (
    <p
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-sm border px-3 py-2 text-xs leading-relaxed',
        positive
          ? 'border-positive/35 bg-positive/8 text-foreground'
          : 'border-negative/35 bg-negative/8 text-foreground',
      )}
    >
      <Icon className={cn('mt-px size-3.5 shrink-0', positive ? 'text-positive' : 'text-negative')} />
      {message}
    </p>
  );
}

function Th({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th scope="col" className={cn('px-4 py-2 text-2xs font-semibold tracking-wide text-muted-foreground uppercase', className)}>
      {children}
    </th>
  );
}

function Td({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={cn('px-4 py-3', className)}>{children}</td>;
}

function since(iso: string | null): string {
  if (!iso) return 'never';
  return `${formatDistanceToNowStrict(new Date(iso))} ago`;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

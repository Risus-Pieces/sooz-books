import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { getAppUser } from '@/lib/auth/session';
import { CAPABILITIES, ROLE_LABELS } from '@/lib/auth/roles';
import { CONNECTOR_CAPABILITIES } from '@/lib/mcp/capabilities';
import { isTrustedRedirect } from '@/lib/mcp/redirects';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Connect to Sooz Books' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const CAN_DO: Record<string, string> = {
  'reports.view': 'read the ledger and every report',
  'bank.import': 'see the bank accounts and the review queue',
  'bank.approve': 'propose and, once you confirm each one, post bank decisions',
  'ledger.post': 'propose and, once you confirm, post journal entries',
  'settings.manage': 'propose and, once you confirm, add accounts to the chart',
};

/**
 * The page Supabase's OAuth server sends a person to when an app (Claude) asks to act as them.
 * Reached with `?authorization_id=…`; the proxy has already made them sign in.
 */
export default async function ConsentPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const authorizationId = first((await searchParams).authorization_id);
  if (authorizationId === undefined) return <Problem message="This page is opened by an app asking for access. Nothing was asked." />;

  const user = await getAppUser();
  if (user === null) redirect('/login?stage=disabled');

  const supabase = await createClient();
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !data) return <Problem message="That request is no longer valid. Start the connection again from Claude." />;
  // They approved this app before: Supabase sends them straight back.
  if (!('authorization_id' in data)) redirect(data.redirect_url);

  let destination = data.redirect_uri;
  try {
    destination = new URL(data.redirect_uri).host;
  } catch {
    // Show whatever it was.
  }
  if (!isTrustedRedirect(data.redirect_uri)) {
    return (
      <Problem message={`Sooz Books only connects to Claude. This request would send you to ${destination}, so it was not offered. If you did not start it, ignore it.`} />
    );
  }
  const allowed = CONNECTOR_CAPABILITIES.filter((cap) => CAPABILITIES[user.role].includes(cap));

  return (
    <div className="flex flex-col items-center">
      <span
        aria-hidden
        className="grid size-16 place-items-center rounded-[18px] bg-[linear-gradient(135deg,#ff9f0a,#ff375f)] text-[1.875rem] font-bold text-white shadow-[0_8px_24px_-8px_rgba(255,55,95,0.55)]"
      >
        S
      </span>
      <p className="mt-4 text-sm font-semibold text-label2">Sooz Books</p>
      <h1 className="mt-0.5 text-center text-2xl font-bold tracking-[-0.022em] text-label">
        Let {data.client.name} use your books?
      </h1>
      <p className="mt-1 max-w-xs text-center text-sm text-label2">
        Signed in as {user.fullName ?? user.email} · {ROLE_LABELS[user.role]}
      </p>

      <div className="mt-6 w-full rounded-2xl bg-card p-5 shadow-card max-sm:rounded-[22px]">
        <p className="text-sm font-semibold text-label">It will be able to:</p>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-label2">
          {allowed.length === 0 ? (
            <li>Nothing — your role cannot use this connection.</li>
          ) : (
            allowed.map((cap) => <li key={cap}>{CAN_DO[cap]}</li>)
          )}
        </ul>
        <p className="mt-3 text-xs text-label2">
          Nothing is posted until you say yes to the exact entry in your chat with Claude. It cannot close
          periods, delete or reverse entries, or change who has access.
        </p>
        <p className="mt-3 rounded-lg bg-bg p-2.5 text-xs text-label2">
          Only approve if you just started this from Claude. It will return to <strong className="text-label">{destination}</strong>.
        </p>

        <form action="/oauth/decision" method="post" className="mt-4 flex flex-col gap-2">
          <input type="hidden" name="authorization_id" value={authorizationId} />
          <Button type="submit" name="decision" value="approve" size="lg" disabled={allowed.length === 0}>
            Allow
          </Button>
          <Button type="submit" name="decision" value="deny" size="lg" variant="ghost">
            Don’t allow
          </Button>
        </form>
      </div>
    </div>
  );
}

function Problem({ message }: { message: string }) {
  return <p className="rounded-2xl bg-card p-5 text-center text-sm text-label2 shadow-card">{message}</p>;
}

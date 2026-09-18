import type { Metadata } from 'next';

import { LoginForm, type LoginStage } from '@/app/(auth)/login/login-form';
import { booksAreUnclaimed } from '@/lib/auth/owner';

export const metadata: Metadata = {
  title: 'Sign in',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const stage = readStage(first(params.stage));
  // Only worth asking while nobody is signed in, and it settles whether this screen offers a
  // sign-in or the owner's one-time chance to create their account.
  const unclaimed = stage === 'sign-in' && (await booksAreUnclaimed());

  return (
    <LoginForm
      stage={stage}
      next={safeNext(first(params.next))}
      notice={first(params.error) ?? null}
      unclaimed={unclaimed}
    />
  );
}

function readStage(value: string | undefined): LoginStage {
  return value === 'invite' || value === 'disabled' ? value : 'sign-in';
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The same rule the proxy applies: a path on this origin, never an absolute URL. */
function safeNext(value: string | undefined): string | null {
  if (!value || !value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

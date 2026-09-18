'use client';

import * as React from 'react';
import { useActionState } from 'react';

import {
  joinWithInvite,
  lookupInvite,
  setPassword,
  signIn,
  signInWithOtp,
  signOut,
  signUpFirstOwner,
  type AuthFormState,
  type InviteLookupState,
} from '@/lib/auth/actions';
import { ROLE_LABELS } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Glyph, type GlyphName } from '@/components/ui/glyph';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';

/**
 * Which of the three things the login screen can be asked to do. The stage arrives as a query
 * parameter because it is set by a redirect — from the invitation callback, or from the guard
 * that found a deactivated account.
 */
export type LoginStage = 'sign-in' | 'join' | 'invite' | 'disabled';

export interface LoginFormProps {
  stage: LoginStage;
  /** Where to land after signing in; already validated on the server. */
  next: string | null;
  /** A message the redirect that landed here wanted shown. */
  notice: string | null;
  /** True while `app_users` is empty: the first person through creates the owner account. */
  unclaimed: boolean;
}

export function LoginForm({ stage, next, notice, unclaimed }: LoginFormProps) {
  if (stage === 'disabled') return <DisabledPanel />;
  if (stage === 'invite') return <AcceptInvitePanel />;
  if (stage === 'join') return <JoinPanel />;
  if (unclaimed) return <FirstOwnerPanel notice={notice} />;
  return <SignInPanel next={next} notice={notice} />;
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

function SignInPanel({ next, notice }: { next: string | null; notice: string | null }) {
  const [method, setMethod] = React.useState<'password' | 'link'>('password');

  const [passwordState, passwordAction, passwordPending] = useActionState<AuthFormState, FormData>(
    signIn,
    null,
  );
  const [linkState, linkAction, linkPending] = useActionState<AuthFormState, FormData>(
    signInWithOtp,
    null,
  );

  const state = method === 'password' ? passwordState : linkState;

  return (
    <Panel title="Sign in" subtitle="The books are closed to everyone but Sooz.">
      <MethodSwitch method={method} onChange={setMethod} />

      {method === 'password' ? (
        <form action={passwordAction} className="flex flex-col gap-3.5">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <Field label="Email" name="email" type="email" autoComplete="username" autoFocus required />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Notice notice={notice} state={state} />
          <Button type="submit" size="lg" disabled={passwordPending}>
            {passwordPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      ) : (
        <form action={linkAction} className="flex flex-col gap-3.5">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            hint="We send a link that signs you in on this device."
          />
          <Notice notice={notice} state={state} />
          <Button type="submit" size="lg" disabled={linkPending}>
            {linkPending ? 'Sending…' : 'Email me a link'}
          </Button>
        </form>
      )}
    </Panel>
  );
}

function MethodSwitch({
  method,
  onChange,
}: {
  method: 'password' | 'link';
  onChange: (next: 'password' | 'link') => void;
}) {
  const options: Array<{ value: 'password' | 'link'; label: string; glyph: GlyphName }> = [
    { value: 'password', label: 'Password', glyph: 'key' },
    { value: 'link', label: 'Email link', glyph: 'mail' },
  ];

  return (
    <div role="tablist" aria-label="How to sign in" className="mb-5 flex gap-0.5 rounded-[8px] bg-fill2 p-0.5">
      {options.map(({ value, label, glyph }) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={method === value}
          onClick={() => onChange(value)}
          className={cn(
            'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[6px] text-xs font-medium transition-[background-color,box-shadow] duration-150 max-sm:h-9 max-sm:text-sm',
            method === value ? 'bg-ctl font-semibold text-label shadow-ctl' : 'text-label hover:bg-fill2',
          )}
        >
          <Glyph name={glyph} size={14} />
          {label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

function FirstOwnerPanel({ notice }: { notice: string | null }) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(signUpFirstOwner, null);

  return (
    <Panel
      title="Open the books"
      subtitle="Nobody has an account yet. The first one becomes the owner."
    >
      <form action={action} className="flex flex-col gap-3.5">
        <Field label="Your name" name="fullName" autoComplete="name" autoFocus required />
        <Field label="Email" name="email" type="email" autoComplete="username" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          hint="At least 10 characters."
        />
        <Notice notice={notice} state={state} />
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? 'Opening…' : 'Create the owner account'}
        </Button>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Invitations and closed accounts
// ---------------------------------------------------------------------------

/** Where the token waits for this tab once it has been lifted out of the address bar. */
const INVITE_KEY = 'sooz-invite-token';

/**
 * Reads the invitation token from the link's fragment, which never reaches a server log, or
 * from this tab's session storage once the fragment has been cleared from the address bar.
 */
function tokenFromHash(): string | null {
  const match = /(?:^|[#&])invite=([A-Za-z0-9_-]{20,200})/.exec(window.location.hash);
  if (match) return match[1];
  try {
    return window.sessionStorage.getItem(INVITE_KEY);
  } catch {
    return null;
  }
}


function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function JoinPanel() {
  // The fragment exists only in the browser: on the server there is no token yet.
  const token = React.useSyncExternalStore(subscribeToHash, tokenFromHash, () => null);
  const hydrated = React.useSyncExternalStore(subscribeToHash, () => true, () => false);
  const [lookup, setLookup] = React.useState<{ token: string; result: InviteLookupState } | null>(null);
  const [state, action, pending] = useActionState<AuthFormState, FormData>(joinWithInvite, null);

  React.useEffect(() => {
    if (!token) return;
    // Keep the token for this tab only, and take it out of the address bar and history so it
    // is not left behind in a screenshot, a shared screen or the browser's history.
    try {
      window.sessionStorage.setItem(INVITE_KEY, token);
    } catch {
      // storage unavailable: the fragment stays until the page is left
    }
    if (window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
    let live = true;
    lookupInvite(token)
      .then((result) => {
        // The token stays in this tab's storage even when it is refused: the fragment is already
        // gone from the address bar, so forgetting it here would replace the refusal's reason
        // with "open the invitation link". A new link carries its own fragment and wins.
        if (live) setLookup({ token, result });
      })
      .catch(() => {
        if (live) {
          setLookup({ token, result: { ok: false, error: 'Could not check your invitation. Reload the page to try again.' } });
        }
      });
    return () => {
      live = false;
    };
  }, [token]);

  if (hydrated && !token) {
    return (
      <Panel title="Join Sooz Books" subtitle="Open the invitation link the owner sent you.">
        <a href="/login" className="block text-center text-sm text-ink-blue hover:underline focus-ring">
          Go to sign in
        </a>
      </Panel>
    );
  }

  if (!token || lookup === null || lookup.token !== token) {
    return <Panel title="Join Sooz Books" subtitle="Checking your invitation…">{null}</Panel>;
  }

  if (!lookup.result.ok) {
    return (
      <Panel title="Join Sooz Books" subtitle={lookup.result.error}>
        <a href="/login" className="block text-center text-sm text-ink-blue hover:underline focus-ring">
          Go to sign in
        </a>
      </Panel>
    );
  }

  const invite = lookup.result.value;
  const created = state?.ok === true;

  return (
    <Panel title="Join Sooz Books" subtitle={`Invited as ${ROLE_LABELS[invite.role]}.`}>
      {created ? (
        <div className="flex flex-col gap-3.5">
          <Notice notice={null} state={state} />
          <a href="/login" className="text-center text-sm text-ink-blue hover:underline focus-ring">
            Go to sign in
          </a>
        </div>
      ) : (
        <form action={action} className="flex flex-col gap-3.5">
          <input type="hidden" name="token" value={token} />
          <Field label="Email" name="email" type="email" value={invite.email} readOnly autoComplete="username" />
          <Field label="Your name" name="fullName" autoComplete="name" autoFocus required />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            hint="At least 10 characters."
          />
          <Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" required />
          <Notice notice={null} state={state} />
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? 'Creating…' : 'Create account'}
          </Button>
        </form>
      )}
    </Panel>
  );
}

function AcceptInvitePanel() {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(setPassword, null);

  return (
    <Panel title="Set your password" subtitle="Choose the password you will sign in with.">
      <form action={action} className="flex flex-col gap-3.5">
        <Field label="Your name" name="fullName" autoComplete="name" autoFocus />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          hint="At least 10 characters."
        />
        <Field
          label="Confirm password"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
        />
        <Notice notice={null} state={state} />
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? 'Saving…' : 'Save and continue'}
        </Button>
      </form>
    </Panel>
  );
}

function DisabledPanel() {
  return (
    <Panel
      title="Access switched off"
      subtitle="This account can no longer open the books. An owner can turn it back on."
    >
      <form action={signOut}>
        <Button type="submit" variant="secondary" size="lg" className="w-full">
          Sign out
        </Button>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center">
      <span
        aria-hidden
        className="grid size-16 place-items-center rounded-[18px] bg-[linear-gradient(135deg,#ff9f0a,#ff375f)] text-[1.875rem] font-bold text-white shadow-[0_8px_24px_-8px_rgba(255,55,95,0.55)]"
      >
        S
      </span>
      <p className="mt-4 text-sm font-semibold text-label2">Sooz Books</p>
      <h1 className="mt-0.5 text-2xl font-bold tracking-[-0.022em] text-label">{title}</h1>
      <p className="mt-1 max-w-xs text-center text-sm text-label2">{subtitle}</p>
      <div className="mt-6 w-full rounded-2xl bg-card p-5 shadow-card max-sm:rounded-[22px]">{children}</div>
    </div>
  );
}

interface FieldProps extends React.ComponentPropsWithoutRef<'input'> {
  label: string;
  name: string;
  hint?: string;
}

function Field({ label, name, hint, ...props }: FieldProps) {
  const id = `field-${name}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} className="h-9" {...props} />
      {hint ? <p className="text-xs text-label2">{hint}</p> : null}
    </div>
  );
}

/** One slot for both the message a redirect carried in and whatever the action answered. */
function Notice({ notice, state }: { notice: string | null; state: AuthFormState }) {
  if (state) {
    return state.ok ? (
      <Callout tone="positive">{state.value}</Callout>
    ) : (
      <Callout tone="negative">{state.error}</Callout>
    );
  }
  if (notice) return <Callout tone="negative">{notice}</Callout>;
  return null;
}

function Callout({ tone, children }: { tone: 'positive' | 'negative'; children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-[10px] px-3 py-2.5 text-sm leading-snug',
        tone === 'positive' ? 'bg-tint-green/10 text-ink-green' : 'bg-tint-red/10 text-ink-red',
      )}
    >
      <Glyph name={tone === 'positive' ? 'check-circle' : 'warning'} size={16} className="mt-px" />
      <span className="text-label">{children}</span>
    </p>
  );
}

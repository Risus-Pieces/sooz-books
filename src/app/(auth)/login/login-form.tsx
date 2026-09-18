'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { AlertCircle, CheckCircle2, KeyRound, Mail } from 'lucide-react';

import {
  acceptInvite,
  signIn,
  signInWithOtp,
  signOut,
  signUpFirstOwner,
  type AuthFormState,
} from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';

/**
 * Which of the three things the login screen can be asked to do. The stage arrives as a query
 * parameter because it is set by a redirect — from the invitation callback, or from the guard
 * that found a deactivated account.
 */
export type LoginStage = 'sign-in' | 'invite' | 'disabled';

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
  const options = [
    { value: 'password' as const, label: 'Password', icon: KeyRound },
    { value: 'link' as const, label: 'Email link', icon: Mail },
  ];

  return (
    <div role="tablist" aria-label="How to sign in" className="mb-5 flex gap-1 rounded-sm bg-muted p-1">
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={method === value}
          onClick={() => onChange(value)}
          className={cn(
            'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-xs text-xs font-medium transition-colors',
            method === value
              ? 'bg-surface-raised text-foreground shadow-raised'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" />
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

function AcceptInvitePanel() {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(acceptInvite, null);

  return (
    <Panel title="Set your password" subtitle="Your invitation is accepted. Choose how you sign in.">
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
    <div className="rounded-md border border-border bg-surface shadow-raised">
      <div className="rule-head px-6 pt-6 pb-4">
        <p className="eyebrow">Sooz Books</p>
        <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
      </div>
      <div className="px-6 pt-5 pb-6">{children}</div>
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
      {hint ? <p className="text-2xs text-muted-foreground">{hint}</p> : null}
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
  const Icon = tone === 'positive' ? CheckCircle2 : AlertCircle;
  return (
    <p
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-sm border px-2.5 py-2 text-xs leading-relaxed',
        tone === 'positive'
          ? 'border-positive/35 bg-positive/8 text-positive'
          : 'border-negative/35 bg-negative/8 text-negative',
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="text-foreground/90">{children}</span>
    </p>
  );
}

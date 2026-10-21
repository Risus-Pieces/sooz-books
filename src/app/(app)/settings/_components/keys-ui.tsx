'use client';

import * as React from 'react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Glyph } from '@/components/ui/glyph';
import { IconBadge } from '@/components/ui/icon-badge';
import { InfoButton } from '@/components/ui/info-button';
import { Input } from '@/components/ui/input';
import { GroupRow, InsetGroup, ListRow } from '@/components/ui/inset-group';
import { Pill } from '@/components/ui/pill';
import { PopUpButton, type PopUpOption } from '@/components/ui/pop-up-button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { ToolbarButton } from '@/components/ui/toolbar';

import { createAgentKey, revokeAgentKey, type NewKey } from '../keys/actions';

export interface KeyView {
  id: string;
  name: string;
  prefix: string;
  userEmail: string;
  /** Labels, in the order the key holds them. */
  scopes: string[];
  created: string;
  lastUsed: string;
  /** When it was revoked ("Oct 3, 2026"), or null while it works. */
  revoked: string | null;
}

/** A key in the list; choosing the row opens its sheet: who it acts for, what it may do, revoke. */
export function KeyRow({ apiKey }: { apiKey: KeyView }) {
  const [open, setOpen] = React.useState(false);
  const live = apiKey.revoked === null;

  return (
    <>
      <ListRow
        onClick={() => setOpen(true)}
        leading={<IconBadge glyph="key" tint={live ? 'orange' : 'gray'} size="lg" className={cn(!live && 'opacity-60')} />}
        title={apiKey.name}
        subtitle={
          <>
            <span className="font-mono">{apiKey.prefix}…</span>
            <span className="truncate">· {apiKey.userEmail}</span>
          </>
        }
        detail={live ? `used ${apiKey.lastUsed}` : undefined}
        trailing={
          live ? (
            <Pill tone="green">Active</Pill>
          ) : (
            <Pill tone="neutral" glyph="xmark-circle">
              Revoked
            </Pill>
          )
        }
        chevron
        rowProps={{ 'aria-haspopup': 'dialog', 'data-key': apiKey.prefix }}
      />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent title={apiKey.name} hideTitle width="sm">
          <div className="flex flex-col items-center gap-1 pb-1 text-center">
            <span
              className={cn(
                'mb-1.5 grid size-[72px] place-items-center rounded-full',
                live ? 'bg-tint-orange/14 text-tint-orange' : 'bg-fill2 text-label3',
              )}
            >
              <Glyph name="key" size={32} />
            </span>
            <p className="text-xl font-bold tracking-[-0.02em] break-words">{apiKey.name}</p>
            <p className="font-mono text-sm text-label2">{apiKey.prefix}…</p>
          </div>

          <InsetGroup header="Acts for" footer="It can do only what this person's role allows, and only within its scopes.">
            <GroupRow label="Person">
              <span className="truncate">{apiKey.userEmail}</span>
            </GroupRow>
          </InsetGroup>

          <InsetGroup header="Scopes">
            <div className="flex flex-wrap gap-1.5 px-4 py-3">
              {apiKey.scopes.map((scope) => (
                <Pill key={scope} tone="blue">
                  {scope}
                </Pill>
              ))}
            </div>
          </InsetGroup>

          <InsetGroup header="Activity">
            <GroupRow label="Created">
              <span className="num">{apiKey.created}</span>
            </GroupRow>
            <GroupRow label="Last used">{apiKey.lastUsed}</GroupRow>
          </InsetGroup>

          <InsetGroup header="Access">
            <GroupRow label="Status">
              {live ? (
                <Pill tone="green" glyph="check-circle">
                  Active
                </Pill>
              ) : (
                <Pill tone="neutral" glyph="xmark-circle">
                  Revoked {apiKey.revoked}
                </Pill>
              )}
            </GroupRow>
            {live ? <RevokeButton keyId={apiKey.id} name={apiKey.name} onRevoked={() => setOpen(false)} /> : null}
          </InsetGroup>
        </SheetContent>
      </Sheet>
    </>
  );
}

function RevokeButton({ keyId, name, onRevoked }: { keyId: string; name: string; onRevoked: () => void }) {
  const [confirming, setConfirming] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const revoke = () => {
    startTransition(async () => {
      const result = await revokeAgentKey(keyId);
      if (!result.ok) {
        toast.error('Not revoked', { description: result.error.message });
        return;
      }
      setConfirming(false);
      onRevoked();
      toast.success(`${name} revoked`, { description: 'Its next request is refused.' });
    });
  };

  return (
    <>
      <div className="hairline-t">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="flex min-h-[46px] w-full items-center justify-center px-4 text-sm font-medium text-ink-red outline-none focus-ring-inset transition-colors hover:bg-fill2 focus-visible:bg-fill2 max-sm:min-h-11 max-sm:text-lg"
        >
          Revoke key
        </button>
      </div>
      <Dialog open={confirming} onOpenChange={(next) => (pending ? undefined : setConfirming(next))}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Revoke {name}?</DialogTitle>
            <DialogDescription>
              Any agent using it is refused from its next request on. This cannot be undone; make a new key if it is
              needed again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={pending} onClick={revoke}>
              {pending ? 'Revoking…' : 'Revoke'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The toolbar's New key button and its sheet: a name and a person in, a token out — once. */
export function NewKeySheet({
  people,
  defaultUserId,
  connectorUrl,
}: {
  people: PopUpOption[];
  defaultUserId: string;
  connectorUrl: string;
}) {
  // Each round of the form starts empty, and a closed sheet forgets the token it showed.
  const [round, setRound] = React.useState(0);

  return (
    <Sheet onOpenChange={(open) => (open ? undefined : setRound((r) => r + 1))}>
      <SheetTrigger asChild>
        <ToolbarButton glyph="plus" label="New key" />
      </SheetTrigger>
      <SheetContent title="New key" width="sm">
        <NewKeyRound key={round} people={people} defaultUserId={defaultUserId} connectorUrl={connectorUrl} />
      </SheetContent>
    </Sheet>
  );
}

function NewKeyRound({
  people,
  defaultUserId,
  connectorUrl,
}: {
  people: PopUpOption[];
  defaultUserId: string;
  connectorUrl: string;
}) {
  const [name, setName] = React.useState('');
  const [userId, setUserId] = React.useState(defaultUserId);
  const [error, setError] = React.useState<string | null>(null);
  const [made, setMade] = React.useState<NewKey | null>(null);
  const [pending, startTransition] = React.useTransition();

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await createAgentKey({ name, userId });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setError(null);
      setMade(result.value);
    });
  };

  if (made !== null) {
    return <TokenReveal made={made} actsFor={people.find((p) => p.value === userId)?.label ?? ''} connectorUrl={connectorUrl} />;
  }

  return (
    <form onSubmit={submit} className="flex flex-col">
      <div className="flex flex-col items-center gap-2 pt-3 pb-1">
        <span className="grid size-14 place-items-center rounded-full bg-tint-orange/14 text-tint-orange">
          <Glyph name="key" size={26} />
        </span>
      </div>
      <InsetGroup
        header="Key"
        headerAccessory={
          <InfoButton label="About keys">
            A key lets an agent work while nobody is signed in, such as a nightly sync. It acts for one person and can do
            only what their role allows.
          </InfoButton>
        }
      >
        <GroupRow label="Name" htmlFor="key-name">
          <Input
            id="key-name"
            name="name"
            required
            maxLength={60}
            autoComplete="off"
            placeholder="Nightly sync"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-56 max-sm:w-44"
          />
        </GroupRow>
        <GroupRow label="Acts for">
          <PopUpButton aria-label="Acts for" value={userId} onValueChange={setUserId} options={people} />
        </GroupRow>
      </InsetGroup>
      {error ? (
        <p role="alert" className="px-4 pt-2 text-sm text-ink-red">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="mt-5 self-stretch" disabled={pending || name.trim() === ''}>
        <Glyph name="key" />
        {pending ? 'Creating…' : 'Create key'}
      </Button>
    </form>
  );
}

/**
 * The token a new key produced, shown once. Only its hash is stored, so a lost token cannot be
 * shown again: revoke the key and make another.
 */
function TokenReveal({ made, actsFor, connectorUrl }: { made: NewKey; actsFor: string; connectorUrl: string }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(made.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-col items-center gap-2 pt-3 pb-1 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-tint-green/14 text-tint-green">
          <Glyph name="key" size={26} />
        </span>
        <p className="text-sm font-semibold break-words text-label">{made.name}</p>
        {actsFor ? <Pill tone="neutral">Acts for {actsFor}</Pill> : null}
      </div>
      <p role="status" className="mx-4 mt-3 flex items-start gap-2 rounded-[10px] bg-tint-orange/12 px-3 py-2.5 text-sm text-label">
        <Glyph name="warning" size={16} className="mt-px shrink-0 text-tint-orange" />
        Copy this now; it won&apos;t be shown again.
      </p>
      <InsetGroup header="Token">
        <div className="flex items-center gap-2 px-4 py-2.5">
          <Input
            readOnly
            value={made.token}
            aria-label="Key token"
            className="min-w-0 flex-1 font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button type="button" onClick={copy} size="sm">
            <Glyph name={copied ? 'check' : 'doc'} />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </InsetGroup>
      <p className="px-4 pt-2 text-xs break-words text-label2">
        Give this to the agent as a Bearer token for <span className="font-mono">{connectorUrl}</span>. It can read the
        books, run the bank sync and auto-post rules, and prepare (stage) changes that wait up to 36 hours for the person
        to confirm. It can never post on its own.
      </p>
    </div>
  );
}

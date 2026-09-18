'use client';

import * as React from 'react';

import { inviteFromForm, reissueFromForm, type InviteLinkState } from '@/lib/auth/actions';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Glyph } from '@/components/ui/glyph';
import { InfoButton } from '@/components/ui/info-button';
import { Input } from '@/components/ui/input';
import { GroupRow, InsetGroup, ListRow } from '@/components/ui/inset-group';
import { Monogram } from '@/components/ui/monogram';
import { Pill } from '@/components/ui/pill';
import { PopUpButton, type PopUpOption } from '@/components/ui/pop-up-button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { ToolbarButton } from '@/components/ui/toolbar';

import { ROLE_TONE, type RoleKey } from './settings-split';

type FormAction = (formData: FormData) => Promise<void>;

export interface PersonView {
  id: string;
  name: string;
  email: string;
  role: RoleKey;
  roleLabel: string;
  active: boolean;
  isYou: boolean;
  isLastOwner: boolean;
  lastSignIn: string;
  added: string;
}

/**
 * Remembers what had focus when a sheet opened without a trigger element (a list row), and gives
 * it back on close.
 */
function useReturnFocus() {
  const saved = React.useRef<HTMLElement | null>(null);
  return {
    remember: () => {
      saved.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    onCloseAutoFocus: (event: Event) => {
      if (saved.current) {
        event.preventDefault();
        saved.current.focus();
      }
    },
  };
}

/** A person in the list; choosing the row opens their sheet: role, access, dates. */
export function PersonRow({
  person,
  roleOptions,
  changeRole,
  switchOff,
  switchOn,
}: {
  person: PersonView;
  roleOptions: PopUpOption[];
  changeRole: FormAction;
  switchOff: FormAction;
  switchOn: FormAction;
}) {
  const [open, setOpen] = React.useState(false);
  const focus = useReturnFocus();

  return (
    <>
      <ListRow
        onClick={() => {
          focus.remember();
          setOpen(true);
        }}
        leading={<Monogram name={person.name} className={cn(!person.active && 'opacity-45')} />}
        title={
          <>
            {person.name}
            {person.isYou ? <span className="ml-1.5 text-xs font-medium text-label2">You</span> : null}
          </>
        }
        subtitle={person.email}
        trailing={
          person.active ? (
            <Pill tone={ROLE_TONE[person.role]}>{person.roleLabel}</Pill>
          ) : (
            <Pill tone="neutral" glyph="xmark-circle">
              Off
            </Pill>
          )
        }
        chevron
        rowProps={{ 'aria-haspopup': 'dialog', 'data-person': person.email }}
      />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent title={person.name} hideTitle width="sm" onCloseAutoFocus={focus.onCloseAutoFocus}>
          <div className="flex flex-col items-center gap-1 pb-1 text-center">
            <Monogram name={person.name} size="lg" className={cn('mb-1.5 size-[72px] text-2xl', !person.active && 'opacity-45')} />
            <p className="text-xl font-bold tracking-[-0.02em]">{person.name}</p>
            <p className="text-sm text-label2">{person.email}</p>
          </div>

          <form action={changeRole}>
            <input type="hidden" name="userId" value={person.id} />
            <InsetGroup footer={person.isLastOwner ? 'Only owner. Promote someone first.' : undefined}>
              <GroupRow label="Role">
                <PopUpButton aria-label="Role" name="role" defaultValue={person.role} options={roleOptions} />
                <Button type="submit" size="sm">
                  Save
                </Button>
              </GroupRow>
            </InsetGroup>
          </form>

          <InsetGroup header="Activity">
            <GroupRow label="Last sign-in">{person.lastSignIn}</GroupRow>
            <GroupRow label="Added">
              <span className="num">{person.added}</span>
            </GroupRow>
          </InsetGroup>

          <InsetGroup header="Access" footer={person.active && person.isYou ? 'This is you.' : undefined}>
            <GroupRow label="Status">
              {person.active ? (
                <Pill tone="green" glyph="check-circle">
                  Active
                </Pill>
              ) : (
                <Pill tone="neutral" glyph="xmark-circle">
                  Off
                </Pill>
              )}
            </GroupRow>
            <form action={person.active ? switchOff : switchOn} className="hairline-t">
              <input type="hidden" name="userId" value={person.id} />
              <button
                type="submit"
                disabled={person.active && (person.isYou || person.isLastOwner)}
                className={cn(
                  'flex min-h-[46px] w-full items-center justify-center px-4 text-sm font-medium outline-none focus-ring-inset transition-colors hover:bg-fill2 focus-visible:bg-fill2 disabled:pointer-events-none disabled:opacity-40 max-sm:min-h-11 max-sm:text-lg',
                  person.active ? 'text-ink-red' : 'text-ink-blue',
                )}
              >
                {person.active ? 'Switch off' : 'Switch on'}
              </button>
            </form>
          </InsetGroup>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The link an invitation produced, shown once. It is never put in a URL or stored in the clear:
 * copy it now and send it to the person yourself.
 */
function LinkReveal({ link, email, roleLabel, expiresAt }: { link: string; email: string; roleLabel: string; expiresAt: string }) {
  const [copied, setCopied] = React.useState(false);
  const expires = new Date(expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-col items-center gap-2 pt-3 pb-1">
        <span className="grid size-14 place-items-center rounded-full bg-tint-green/14 text-tint-green">
          <Glyph name="link" size={26} />
        </span>
        <p className="text-sm font-semibold text-label">{email}</p>
        <Pill tone="neutral">{roleLabel}</Pill>
      </div>
      <InsetGroup
        header="Invite link"
        headerAccessory={
          <InfoButton label="About invite links">
            Send it yourself — text or chat. It works once, for this address only, and expires {expires}. Anyone
            holding it can join as {roleLabel}, so send it only to them.
          </InfoButton>
        }
      >
        <div className="flex items-center gap-2 px-4 py-2.5">
          <Input readOnly value={link} aria-label="Invite link" className="min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" onClick={copy} size="sm">
            <Glyph name={copied ? 'check' : 'doc'} />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </InsetGroup>
      <p className="px-4 pt-1.5 text-xs text-label2">Single use · expires {expires}</p>
    </div>
  );
}

/** Shown while the server cannot redeem links: better to know before sending one. */
function LinksOffWarning() {
  return (
    <p role="status" className="mx-4 mt-3 flex items-start gap-2 rounded-[10px] bg-tint-orange/12 px-3 py-2.5 text-sm text-label">
      <Glyph name="warning" size={16} className="mt-px shrink-0 text-tint-orange" />
      Links can&apos;t be used yet: the server needs its Supabase service key.
    </p>
  );
}

/** The toolbar's Invite button and its sheet: an email and a role in, a single-use link out. */
export function InviteSheet({ roleOptions, linksWork }: { roleOptions: PopUpOption[]; linksWork: boolean }) {
  // Each round of the form gets its own action state, so a second invite starts empty.
  const [round, setRound] = React.useState(0);

  return (
    <Sheet onOpenChange={(open) => (open ? undefined : setRound((r) => r + 1))}>
      <SheetTrigger asChild>
        <ToolbarButton glyph="plus" label="Invite" />
      </SheetTrigger>
      <SheetContent title="Invite" width="sm">
        <InviteRound key={round} roleOptions={roleOptions} linksWork={linksWork} next={() => setRound((r) => r + 1)} />
      </SheetContent>
    </Sheet>
  );
}

function InviteRound({
  roleOptions,
  linksWork,
  next,
}: {
  roleOptions: PopUpOption[];
  linksWork: boolean;
  next: () => void;
}) {
  const [state, action, pending] = React.useActionState<InviteLinkState, FormData>(inviteFromForm, null);
  const roleLabel = (value: string) => roleOptions.find((o) => o.value === value)?.label ?? value;

  return state?.ok ? (
    <div className="flex flex-col">
      <LinkReveal
        link={state.value.link}
        email={state.value.email}
        roleLabel={roleLabel(state.value.role)}
        expiresAt={state.value.expiresAt}
      />
      {linksWork ? null : <LinksOffWarning />}
      <Button type="button" variant="secondary" className="mt-5 self-stretch" onClick={next}>
        <Glyph name="plus" />
        Invite someone else
      </Button>
    </div>
  ) : (
          <form action={action} className="flex flex-col">
            <div className="flex flex-col items-center gap-2 pt-3 pb-1">
              <span className="grid size-14 place-items-center rounded-full bg-tint-indigo/14 text-tint-indigo">
                <Glyph name="mail" size={26} />
              </span>
            </div>
            <InsetGroup
              header="Person"
              headerAccessory={
                <InfoButton label="About invitations">
                  You get a single-use link to send them. They choose a password and arrive with the role you pick.
                </InfoButton>
              }
            >
              <GroupRow label="Email" htmlFor="invite-email">
                <Input
                  id="invite-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="off"
                  placeholder="name@example.com"
                  className="w-56 max-sm:w-44"
                />
              </GroupRow>
              <GroupRow label="Role">
                <PopUpButton aria-label="Role" name="role" defaultValue="viewer" options={roleOptions} />
              </GroupRow>
            </InsetGroup>
            {linksWork ? null : <LinksOffWarning />}
            {state && !state.ok ? (
              <p role="alert" className="px-4 pt-2 text-sm text-ink-red">{state.error}</p>
            ) : null}
            <Button type="submit" className="mt-5 self-stretch" disabled={pending}>
              <Glyph name="link" />
              {pending ? 'Creating…' : 'Create invite link'}
            </Button>
          </form>
  );
}

/** A fresh link for a pending invitation — the old one stops working the moment this is made. */
export function NewLinkSheet({
  inviteId,
  email,
  roleLabel,
  linksWork,
}: {
  inviteId: string;
  email: string;
  roleLabel: string;
  linksWork: boolean;
}) {
  const [state, action, pending] = React.useActionState<InviteLinkState, FormData>(reissueFromForm, null);

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label={`New invite link for ${email}`}>
          New link
        </Button>
      </SheetTrigger>
      <SheetContent title="Invite link" width="sm">
        {state?.ok ? (
          <LinkReveal link={state.value.link} email={state.value.email} roleLabel={roleLabel} expiresAt={state.value.expiresAt} />
        ) : (
          <form action={action} className="flex flex-col">
            <input type="hidden" name="inviteId" value={inviteId} />
            <div className="flex flex-col items-center gap-2 pt-3 pb-1">
              <span className="grid size-14 place-items-center rounded-full bg-tint-indigo/14 text-tint-indigo">
                <Glyph name="link" size={26} />
              </span>
              <p className="text-sm font-semibold text-label">{email}</p>
              <Pill tone="neutral">{roleLabel}</Pill>
            </div>
            <p className="px-4 pt-2 text-center text-sm text-label2">Any earlier link for {email} stops working.</p>
            {linksWork ? null : <LinksOffWarning />}
            {state && !state.ok ? (
              <p role="alert" className="px-4 pt-2 text-sm text-ink-red">{state.error}</p>
            ) : null}
            <Button type="submit" className="mt-5 self-stretch" disabled={pending}>
              <Glyph name="link" />
              {pending ? 'Creating…' : 'Create new link'}
            </Button>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}

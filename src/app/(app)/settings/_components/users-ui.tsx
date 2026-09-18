'use client';

import * as React from 'react';

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

/** The toolbar's Invite button and its sheet: an email and a role. */
export function InviteSheet({
  invite,
  roleOptions,
  emailSent,
}: {
  invite: FormAction;
  roleOptions: PopUpOption[];
  /** False when no service role key is set: nobody is emailed, the role waits for their sign-up. */
  emailSent: boolean;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <ToolbarButton glyph="plus" label="Invite" />
      </SheetTrigger>
      <SheetContent title="Invite" width="sm">
        <form action={invite} className="flex flex-col">
          <div className="flex flex-col items-center gap-2 pt-3 pb-1">
            <span className="grid size-14 place-items-center rounded-full bg-tint-indigo/14 text-tint-indigo">
              <Glyph name="mail" size={26} />
            </span>
          </div>
          <InsetGroup
            header="Person"
            headerAccessory={
              <InfoButton label="About invitations">
                {emailSent
                  ? 'They receive an email, set a password, and arrive with the role you choose.'
                  : 'No SUPABASE_SERVICE_ROLE_KEY is set, so no email goes out. They sign up with this address and the role is applied for them.'}
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
          <p className="px-4 pt-1.5 text-xs text-label2">{emailSent ? 'Sends an email' : 'No email sent'}</p>
          <Button type="submit" className="mt-5 self-stretch">
            <Glyph name="mail" />
            Send invitation
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

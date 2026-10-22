'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

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
import { GroupRow, InsetGroup } from '@/components/ui/inset-group';
import { PopUpButton, type PopUpGroup } from '@/components/ui/pop-up-button';
import { toast } from '@/components/ui/toast';
import { ToolbarButton } from '@/components/ui/toolbar';

import { beginBankConnect, chooseFeedAccount, disconnectBank, finishBankConnect, syncBankFeedsNow } from '../feeds/actions';
import { DONT_SYNC, accountLabel, parseMappingValue } from './feeds-format';

export interface FeedAccountView {
  id: string;
  name: string;
  mask: string | null;
  /** The bank account it feeds, or null for "Don't sync". */
  bankAccountId: string | null;
  /** "Oct 22, 2026", or null while it feeds nothing. */
  syncFrom: string | null;
  /** False while the bank account is only proposed (matched by last four digits) and feeds nothing. */
  confirmed: boolean;
}

export interface FeedItemView {
  id: string;
  institution: string;
  /** "3 hours ago", or null before the first sync. */
  lastSynced: string | null;
  /** Already fit to show: never the text of a failed query. */
  lastError: string | null;
  accounts: FeedAccountView[];
}

export interface BankAccountChoice {
  id: string;
  label: string;
  /** Fed by a different Plaid account; the database allows one feed per bank account. */
  takenBy: string | null;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Plaid Link: Plaid's own window, loaded from Plaid's CDN the first time someone connects.
// ---------------------------------------------------------------------------

const PLAID_LINK_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

interface PlaidLinkError {
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}

interface PlaidHandler {
  open: () => void;
  destroy: () => void;
}

interface PlaidLinkFactory {
  create: (options: {
    token: string;
    onSuccess: (publicToken: string) => void;
    onExit: (error: PlaidLinkError | null) => void;
  }) => PlaidHandler;
}

type PlaidWindow = Window & { Plaid?: PlaidLinkFactory };

let plaidLoading: Promise<PlaidLinkFactory> | null = null;

/** Injects Plaid's script once; a failed load is forgotten, so the next attempt tries again. */
function loadPlaidLink(): Promise<PlaidLinkFactory> {
  const w = window as PlaidWindow;
  if (w.Plaid) return Promise.resolve(w.Plaid);
  plaidLoading ??= new Promise<PlaidLinkFactory>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_LINK_SRC}"]`);
    const script = existing ?? document.createElement('script');
    const failed = () => {
      plaidLoading = null;
      script.remove();
      reject(new Error('Plaid could not be reached. Check the connection and try again.'));
    };
    script.addEventListener('load', () => (w.Plaid ? resolve(w.Plaid) : failed()), { once: true });
    script.addEventListener('error', failed, { once: true });
    if (!existing) {
      script.src = PLAID_LINK_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return plaidLoading;
}

/**
 * Connect: a link token from the server, Plaid Link in the browser, and the public token Link hands
 * back exchanged on the server. The bank sign-in itself never touches this app.
 */
export function ConnectBankButton({ label = 'Connect Relay', className }: { label?: string; className?: string }) {
  const router = useRouter();
  const [phase, setPhase] = React.useState<'idle' | 'starting' | 'linking' | 'saving'>('idle');

  async function finish(publicToken: string) {
    setPhase('saving');
    const result = await finishBankConnect(publicToken);
    setPhase('idle');
    if (!result.ok) {
      toast.error('Bank not connected', { description: result.error.message });
      return;
    }
    const { institution, accounts, mapped } = result.value;
    toast.success(`${institution ?? 'Bank'} connected`, {
      description:
        mapped === accounts
          ? `${accounts} ${accounts === 1 ? 'account' : 'accounts'} matched by their last four digits.`
          : `${mapped} of ${accounts} accounts matched by their last four digits. Choose where the rest go.`,
    });
    React.startTransition(() => router.refresh());
  }

  async function connect() {
    setPhase('starting');
    const begun = await beginBankConnect();
    if (!begun.ok) {
      setPhase('idle');
      toast.error('Could not start', { description: begun.error.message });
      return;
    }
    let plaid: PlaidLinkFactory;
    try {
      plaid = await loadPlaidLink();
    } catch (error) {
      setPhase('idle');
      toast.error('Could not start', { description: error instanceof Error ? error.message : undefined });
      return;
    }
    setPhase('linking');
    const handler = plaid.create({
      token: begun.value.linkToken,
      onSuccess: (publicToken) => {
        handler.destroy();
        void finish(publicToken);
      },
      onExit: (error) => {
        handler.destroy();
        setPhase('idle');
        if (error) {
          toast.error('Bank not connected', { description: error.display_message ?? error.error_message ?? undefined });
        }
      },
    });
    handler.open();
  }

  const busy = phase !== 'idle';
  return (
    <Button type="button" onClick={connect} disabled={busy} className={className}>
      <Glyph name="link" />
      {phase === 'starting' ? 'Opening…' : phase === 'linking' ? 'Waiting for Plaid…' : phase === 'saving' ? 'Connecting…' : label}
    </Button>
  );
}

/** The toolbar's Sync now: the nightly run, now. */
export function SyncNowButton() {
  const [pending, startTransition] = React.useTransition();

  const sync = () => {
    startTransition(async () => {
      const id = toast.loading('Syncing bank feeds…');
      const result = await syncBankFeedsNow();
      if (!result.ok) {
        toast.error('Sync failed', { id, description: result.error.message });
        return;
      }
      const summary = result.value;
      const show = summary.tone === 'warning' ? toast.warning : toast.success;
      show(summary.title, { id, description: summary.description });
    });
  };

  return <ToolbarButton glyph="refresh" label={pending ? 'Syncing…' : 'Sync now'} showLabel disabled={pending} onClick={sync} />;
}

/** The same hairline the grouped rows draw, starting after `--sep-inset`. */
const rowSeparator =
  'relative before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[var(--sep-inset,16px)] before:border-t-[0.5px] before:border-sep first:before:hidden';

/** One connected bank: when it last synced, what went wrong, and where each of its accounts goes. */
export function FeedItemGroup({ item, bankAccounts }: { item: FeedItemView; bankAccounts: BankAccountChoice[] }) {
  return (
    <InsetGroup
      header={item.institution}
      headerAccessory={<DisconnectButton itemId={item.id} institution={item.institution} />}
      footer="Each account syncs from the day after the last transaction already in the books, so nothing is counted twice."
    >
      <GroupRow label="Last synced">{item.lastSynced ?? 'Not yet'}</GroupRow>
      {item.lastError ? (
        <div className={cn(rowSeparator, 'px-4 py-2.5')}>
          <p role="status" className="flex items-start gap-2 rounded-[10px] bg-tint-orange/12 px-3 py-2.5 text-sm text-label">
            <Glyph name="warning" size={16} className="mt-px shrink-0 text-tint-orange" />
            <span className="min-w-0 break-words">{item.lastError}</span>
          </p>
        </div>
      ) : null}
      {item.accounts.length === 0 ? (
        <div className={cn(rowSeparator, 'px-4 py-3 text-sm text-label2')}>Plaid listed no accounts for this login.</div>
      ) : (
        item.accounts.map((account) => <FeedAccountRow key={account.id} account={account} bankAccounts={bankAccounts} />)
      )}
    </InsetGroup>
  );
}

function FeedAccountRow({ account, bankAccounts }: { account: FeedAccountView; bankAccounts: BankAccountChoice[] }) {
  const [value, setValue] = React.useState(account.bankAccountId ?? DONT_SYNC);
  const [pending, startTransition] = React.useTransition();
  const label = accountLabel(account.name, account.mask);

  // A fresh answer from the server (after a save, or someone else's) wins over the local choice.
  const [seen, setSeen] = React.useState(account.bankAccountId);
  if (seen !== account.bankAccountId) {
    setSeen(account.bankAccountId);
    setValue(account.bankAccountId ?? DONT_SYNC);
  }

  const options: PopUpGroup[] = [
    { options: [{ value: DONT_SYNC, label: 'Don’t sync' }] },
    {
      label: 'Bank accounts',
      options: bankAccounts
        .filter((bank) => bank.active || bank.id === account.bankAccountId)
        .map((bank) => ({
          value: bank.id,
          label: bank.active ? bank.label : `${bank.label} (inactive)`,
          disabled: !bank.active || (bank.takenBy !== null && bank.takenBy !== account.id),
        })),
    },
  ];

  const proposed = account.bankAccountId !== null && !account.confirmed;

  const confirm = () => {
    startTransition(async () => {
      const result = await chooseFeedAccount(account.id, account.bankAccountId);
      if (!result.ok) {
        toast.error('Not confirmed', { description: result.error.message });
        return;
      }
      toast.success(`${label} will sync`);
    });
  };

  const choose = (next: string) => {
    const bankAccountId = parseMappingValue(next);
    if (bankAccountId === undefined || next === value) return;
    const previous = value;
    setValue(next);
    startTransition(async () => {
      const result = await chooseFeedAccount(account.id, bankAccountId);
      if (!result.ok) {
        setValue(previous);
        toast.error('Not changed', { description: result.error.message });
        return;
      }
      const bank = bankAccounts.find((b) => b.id === bankAccountId);
      toast.success(bank ? `${label} feeds ${bank.label}` : `${label} won’t sync`);
    });
  };

  return (
    <div className={cn(rowSeparator, 'flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5')}>
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate text-sm font-medium max-sm:text-lg max-sm:font-normal">{label}</p>
        <p className="text-xs text-label2 max-sm:text-sm">
          {proposed
            ? 'Matched by its last four digits. Not syncing until you confirm.'
            : account.syncFrom && account.bankAccountId !== null
              ? `From ${account.syncFrom}`
              : 'Not syncing'}
        </p>
      </div>
      {proposed ? (
        <Button type="button" size="sm" onClick={confirm} disabled={pending}>
          Confirm
        </Button>
      ) : null}
      <PopUpButton
        aria-label={`Bank account for ${label}`}
        value={value}
        onValueChange={choose}
        options={options}
        disabled={pending}
        className="max-w-full"
      />
    </div>
  );
}

function DisconnectButton({ itemId, institution }: { itemId: string; institution: string }) {
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const disconnect = () => {
    startTransition(async () => {
      const result = await disconnectBank(itemId);
      if (!result.ok) {
        toast.error('Not disconnected', { description: result.error.message });
        return;
      }
      setOpen(false);
      toast.success(`${institution} disconnected`);
    });
  };

  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="text-ink-red hover:text-ink-red" onClick={() => setOpen(true)}>
        Disconnect
      </Button>
      <Dialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Disconnect {institution}?</DialogTitle>
            <DialogDescription>
              The nightly sync stops for its accounts and Plaid&apos;s access is revoked. Every transaction already in the
              books stays. To bring it back, connect again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={pending} onClick={disconnect}>
              {pending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

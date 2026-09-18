"use client";

import * as React from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Glyph } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { fieldBase, fieldInvalid } from "@/components/ui/menu-styles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { categoryFor } from "@/lib/ui/categories";
import { cn } from "@/lib/cn";

import type { AccountOption } from "./types";

const RECENTS_KEY = "sooz-recent-accounts";
const RECENTS_LIMIT = 6;

/**
 * The accounts this browser has reached for lately, newest first.
 *
 * Kept in localStorage rather than on the server: it is a convenience for one
 * person at one keyboard, it is worth nothing if it is lost, and a round trip
 * for it would slow down the one control a bookkeeper touches most. Every
 * access is guarded — private windows and blocked site data both throw here.
 */
export function readRecentAccounts(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, RECENTS_LIMIT);
  } catch {
    return [];
  }
}

export function rememberAccount(accountId: string): void {
  const next = [accountId, ...readRecentAccounts().filter((id) => id !== accountId)].slice(
    0,
    RECENTS_LIMIT,
  );
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // No storage available. The picker still works, without the shortcut.
  }
}

const TYPE_ORDER = ["asset", "liability", "equity", "revenue", "expense"] as const;

const TYPE_LABEL: Record<AccountOption["type"], string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expenses",
};

export interface AccountComboboxProps {
  accounts: readonly AccountOption[];
  value: string | null;
  onChange: (accountId: string) => void;
  /** Float the accounts this browser has used lately above the chart. */
  trackRecents?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  /** The grid keeps one of these per row: Enter on a row lands on the next one. */
  triggerRef?: React.Ref<HTMLButtonElement>;
  /** Fired when the popover closes on Escape or a pick, so focus can move on. */
  onDismiss?: () => void;
}

/**
 * The account picker: search by code or name, grouped by statement section.
 * In the entry grid `trackRecents` lifts the accounts this bookkeeper actually
 * uses to the top, because the same handful come up all day; a filter that
 * picks one account leaves it off and gets the plain grouped list.
 */
export function AccountCombobox({
  accounts,
  value,
  onChange,
  trackRecents = false,
  disabled,
  invalid,
  placeholder = "Account",
  id,
  className,
  triggerRef,
  onDismiss,
}: AccountComboboxProps) {
  const [open, setOpen] = React.useState(false);
  // Read when the list opens rather than on mount: localStorage is the browser's
  // and does not exist during the server render, and an event handler is the
  // right place to reach for it.
  const [recent, setRecent] = React.useState<readonly string[]>([]);

  const byId = React.useMemo(() => {
    const map = new Map<string, AccountOption>();
    for (const account of accounts) map.set(account.id, account);
    return map;
  }, [accounts]);

  const selected = value === null ? undefined : byId.get(value);

  const postable = React.useMemo(
    () => accounts.filter((account) => account.postable && (account.active || account.id === value)),
    [accounts, value],
  );

  const recentAccounts = React.useMemo(() => {
    const seen = new Set<string>();
    const out: AccountOption[] = [];
    for (const accountId of recent) {
      const account = byId.get(accountId);
      if (account === undefined || !account.postable || !account.active) continue;
      if (seen.has(account.id)) continue;
      seen.add(account.id);
      out.push(account);
    }
    return out;
  }, [byId, recent]);

  const groups = React.useMemo(
    () =>
      TYPE_ORDER.map((type) => ({
        type,
        accounts: postable.filter((account) => account.type === type),
      })).filter((group) => group.accounts.length > 0),
    [postable],
  );

  const toggle = React.useCallback(
    (next: boolean) => {
      if (next && trackRecents) setRecent(readRecentAccounts());
      setOpen(next);
      if (!next) onDismiss?.();
    },
    [onDismiss, trackRecents],
  );

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger
        id={id}
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          fieldBase,
          "flex items-center justify-between gap-1.5 pr-1.5 text-left data-[state=open]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--blue)_45%,transparent),0_0_0_0.5px_var(--blue)]",
          className,
          invalid && fieldInvalid,
        )}
      >
        {selected ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Dot tint={categoryFor(selected).tint} size={7} />
            <span className="truncate font-medium">{selected.name}</span>
            <span className="num shrink-0 text-xs text-label2">{selected.code}</span>
          </span>
        ) : (
          <span className="text-label2">{placeholder}</span>
        )}
        <Glyph name="chevron-updown" size={13} weight={2.2} className="shrink-0 text-label2" />
      </PopoverTrigger>

      <PopoverContent className="w-[min(28rem,calc(100vw-2rem))] p-0" align="start">
        <Command
          filter={(itemValue, search) => {
            const haystack = itemValue.toLowerCase();
            return search
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean)
              .every((term) => haystack.includes(term))
              ? 1
              : 0;
          }}
        >
          <CommandInput placeholder="Search by code or name" />
          <CommandList>
            <CommandEmpty>No account matches that code or name.</CommandEmpty>

            {recentAccounts.length > 0 ? (
              <CommandGroup heading="Recent">
                {recentAccounts.map((account) => (
                  <AccountRow
                    // A recent account also appears under its section, so the key
                    // has to say which list this row belongs to.
                    key={`recent-${account.id}`}
                    account={account}
                    selected={account.id === value}
                    onPick={() => {
                      onChange(account.id);
                      toggle(false);
                    }}
                  />
                ))}
              </CommandGroup>
            ) : null}

            {groups.map((group) => (
              <CommandGroup key={group.type} heading={TYPE_LABEL[group.type]}>
                {group.accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    selected={account.id === value}
                    onPick={() => {
                      onChange(account.id);
                      toggle(false);
                    }}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AccountRow({
  account,
  selected,
  onPick,
}: {
  account: AccountOption;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <CommandItem
      value={`${account.code} ${account.name} ${account.subtype ?? ""}`}
      onSelect={onPick}
      className="gap-2"
    >
      <Dot tint={categoryFor(account).tint} size={7} />
      <span className="min-w-0 flex-1 truncate">{account.name}</span>
      {account.isControl ? <span className="text-2xs font-medium text-label2">Control</span> : null}
      {account.active ? null : <span className="text-2xs font-medium text-label2">Inactive</span>}
      <span className="num shrink-0 text-xs text-label2">{account.code}</span>
      {selected ? <Glyph name="check" size={13} weight={2.2} className="text-ink-blue" /> : null}
    </CommandItem>
  );
}

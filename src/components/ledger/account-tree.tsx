"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { PageToolbar } from "@/components/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { CategoryBadge } from "@/components/ui/icon-badge";
import { InsetGroup } from "@/components/ui/inset-group";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { SearchField } from "@/components/ui/search-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";
import { categoryFor } from "@/lib/ui/categories";
import {
  deactivateLedgerAccount,
  reactivateLedgerAccount,
} from "@/app/(app)/ledger/actions";

import { AccountDialog } from "./account-dialog";
import type { AccountTreeRow } from "./types";

export interface AccountTreeProps {
  /** Depth-first, already ordered by code within each parent. */
  accounts: readonly AccountTreeRow[];
  canManage: boolean;
}

const TYPES: ReadonlyArray<{ type: AccountTreeRow["type"]; label: string }> = [
  { type: "asset", label: "Assets" },
  { type: "liability", label: "Liabilities" },
  { type: "equity", label: "Equity" },
  { type: "revenue", label: "Revenue" },
  { type: "expense", label: "Expenses" },
];

/**
 * The chart of accounts as an outline: one group per statement section, each account under its
 * parent with its category badge and posted balance. Parents fold.
 *
 * Search keeps the shape rather than flattening it: a match drags its parents
 * along, because "6120 Meta & Google Ads" means something different depending on
 * whether it sits under Marketing or under Cost of Goods.
 */
export function AccountTree({ accounts, canManage }: AccountTreeProps) {
  const [query, setQuery] = React.useState("");
  const [showInactive, setShowInactive] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set());
  // `null` means no dialog; a row means edit it; `"new"` means create one.
  const [editing, setEditing] = React.useState<AccountTreeRow | "new" | null>(null);
  const [retiring, setRetiring] = React.useState<AccountTreeRow | null>(null);

  const byId = React.useMemo(() => {
    const map = new Map<string, AccountTreeRow>();
    for (const account of accounts) map.set(account.id, account);
    return map;
  }, [accounts]);

  const needle = query.trim().toLowerCase();

  const visible = React.useMemo(() => {
    const matches = accounts.filter((account) => {
      if (!showInactive && !account.active) return false;
      if (needle === "") return true;
      return (
        account.code.toLowerCase().includes(needle) ||
        account.name.toLowerCase().includes(needle) ||
        (account.subtype ?? "").toLowerCase().includes(needle)
      );
    });

    const keep = new Set(matches.map((account) => account.id));
    if (needle !== "") {
      // Pull in the ancestors of every match so the indent still means something.
      for (const account of matches) {
        let parentId = account.parentId;
        while (parentId !== null && !keep.has(parentId)) {
          keep.add(parentId);
          parentId = byId.get(parentId)?.parentId ?? null;
        }
      }
    }

    // A folded parent hides everything under it (never while searching).
    const hidden = (account: AccountTreeRow): boolean => {
      if (needle !== "") return false;
      let parentId = account.parentId;
      while (parentId !== null) {
        if (collapsed.has(parentId)) return true;
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      return false;
    };
    return accounts.filter((account) => keep.has(account.id) && !hidden(account));
  }, [accounts, byId, collapsed, needle, showInactive]);

  const inactiveCount = accounts.filter((account) => !account.active).length;
  const activeCount = accounts.length - inactiveCount;

  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <PageToolbar
        title="Chart of accounts"
        back={{ href: "/ledger", label: "Journal" }}
        phoneTitleRow
        subtitle={<span className="num">{activeCount}</span>}
        info={
          <p>
            Every account the ledger can post to, nested as it reads on a statement. Balances are posted, accrual, as
            of today. Accounts are retired, never deleted.
          </p>
        }
        search={
          <SearchField
            appearance="toolbar"
            value={query}
            aria-label="Filter accounts"
            onChange={(event) => setQuery(event.target.value)}
          />
        }
        actions={
          <ToolbarGroup>
            {inactiveCount > 0 ? (
              <ToolbarButton
                glyph="xmark-circle"
                label={showInactive ? `Hide inactive (${inactiveCount})` : `Show inactive (${inactiveCount})`}
                tone={showInactive ? "accent" : "default"}
                aria-pressed={showInactive}
                onClick={() => setShowInactive((value) => !value)}
              />
            ) : null}
            {canManage ? <ToolbarButton glyph="plus" label="New account" onClick={() => setEditing("new")} /> : null}
          </ToolbarGroup>
        }
      />

      {visible.length === 0 ? (
        <div className="rounded-2xl bg-card shadow-card">
          <EmptyState glyph="search" title="No matching account" />
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-[880px] flex-col">
          {TYPES.map(({ type, label }) => {
            const rows = visible.filter((account) => account.type === type);
            if (rows.length === 0) return null;
            const total = accounts
              .filter((account) => account.type === type && account.depth === 0)
              .reduce((sum, account) => sum + account.balanceCents, 0);
            return (
              <InsetGroup
                key={type}
                header={label}
                headerAccessory={<Money cents={total} currency plain className="text-sm font-semibold text-label2" />}
                separatorInset={16}
                className="min-w-0 [&>div:first-child]:max-lg:pt-3"
              >
                {rows.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    open={!collapsed.has(account.id) || needle !== ""}
                    onToggle={() => toggle(account.id)}
                    canManage={canManage}
                    onEdit={() => setEditing(account)}
                    onRetire={() => setRetiring(account)}
                  />
                ))}
              </InsetGroup>
            );
          })}
        </div>
      )}

      {/* Each dialog is mounted fresh for the row it was opened on — its fields
          are seeded once from that row rather than reset whenever it closes. */}
      {canManage && editing !== null ? (
        <AccountDialog
          key={editing === "new" ? "new" : editing.id}
          account={editing === "new" ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {canManage && retiring !== null ? (
        <RetireDialog
          key={retiring.id}
          account={retiring}
          accounts={accounts}
          onClose={() => setRetiring(null)}
        />
      ) : null}
    </>
  );
}

function AccountRow({
  account,
  open,
  onToggle,
  canManage,
  onEdit,
  onRetire,
}: {
  account: AccountTreeRow;
  open: boolean;
  onToggle: () => void;
  canManage: boolean;
  onEdit: () => void;
  onRetire: () => void;
}) {
  const category = categoryFor(account);
  const parent = account.childCount > 0;
  return (
    <div
      className={cn(
        "relative flex min-h-11 items-center gap-2 py-1.5 pr-2 pl-3",
        "before:pointer-events-none before:absolute before:top-0 before:right-0 before:border-t-[0.5px] before:border-sep first:before:hidden",
        !account.active && "opacity-60",
      )}
      style={{ paddingLeft: `${12 + account.depth * 20}px` }}
    >
      {parent ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Fold ${account.code}` : `Unfold ${account.code}`}
          onClick={onToggle}
          className="relative grid size-5 shrink-0 place-items-center rounded-[5px] text-label2 hover:bg-fill2 hover:text-label max-sm:after:absolute max-sm:after:-inset-3 max-sm:after:content-['']"
        >
          <Glyph name="chevron-right" size={11} weight={2.4} className={cn("transition-transform duration-150", open && "rotate-90")} />
        </button>
      ) : (
        <span aria-hidden className="size-5 shrink-0" />
      )}
      <Link
        href={`/ledger?accountId=${account.id}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[6px] outline-none hover:text-ink-blue focus-visible:ring-2 focus-visible:ring-tint-blue/50"
      >
        <CategoryBadge category={category} size={parent ? "md" : "sm"} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={cn("truncate text-sm max-sm:text-lg", parent ? "font-semibold" : "font-medium")}>
              {account.name}
            </span>
            <span className="num shrink-0 text-xs text-label2 max-sm:hidden">{account.code}</span>
          </span>
          <span className={cn("flex gap-1.5 text-2xs font-medium text-label2 max-sm:text-xs", !(account.isControl || account.isBank || !account.active) && "sm:hidden")}>
            <span className="num sm:hidden">{account.code}</span>
            {account.isControl ? <span>Control</span> : null}
            {account.isBank ? <span>Bank feed</span> : null}
            {account.active ? null : <span>Inactive</span>}
          </span>
        </span>
      </Link>
      <span className={cn("shrink-0 text-right text-sm", parent ? "font-semibold" : "font-medium")}>
        {account.balanceCents === 0 ? (
          <span className="text-label2">—</span>
        ) : (
          <Money cents={account.balanceCents} currency />
        )}
      </span>
      {canManage ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Actions for ${account.code}`}
            className="relative grid size-7 shrink-0 place-items-center rounded-full text-label2 hover:bg-fill2 hover:text-label data-[state=open]:bg-fill2 max-sm:size-9"
          >
            <Glyph name="ellipsis" size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <Glyph name="pencil" size={14} />
              Edit {account.code}
            </DropdownMenuItem>
            {account.active ? (
              <DropdownMenuItem onSelect={onRetire} className="text-ink-red">
                <Glyph name="xmark-circle" size={14} />
                Retire {account.code}
              </DropdownMenuItem>
            ) : (
              <ReactivateItem account={account} />
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function ReactivateItem({ account }: { account: AccountTreeRow }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  return (
    <DropdownMenuItem
      disabled={pending}
      onSelect={() =>
        startTransition(async () => {
          const result = await reactivateLedgerAccount(account.id);
          if (!result.ok) {
            toast.error("Not reactivated", { description: result.error.message });
            return;
          }
          toast.success(`${account.code} is active again`);
          router.refresh();
        })
      }
    >
      <Glyph name="undo" size={14} />
      Reactivate {account.code}
    </DropdownMenuItem>
  );
}

/**
 * Accounts are retired, never deleted: a posted line points at one forever. An
 * account that carries history also needs a successor named, so next year's
 * reader can follow the activity somewhere.
 */
function RetireDialog({
  account,
  accounts,
  onClose,
}: {
  account: AccountTreeRow;
  accounts: readonly AccountTreeRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [successor, setSuccessor] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const needsSuccessor = account.postedLineCount > 0;
  const candidates = accounts
    .filter(
      (candidate) =>
        candidate.active && candidate.type === account.type && candidate.id !== account.id,
    )
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));

  const submit = () => {
    startTransition(async () => {
      const result = await deactivateLedgerAccount(account.id, successor);
      if (!result.ok) {
        toast.error("Not retired", { description: result.error.message });
        return;
      }
      toast.success(`${account.code} retired`);
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            Retire {account.code} {account.name}
          </DialogTitle>
          <DialogDescription>
            Nothing new can be posted to a retired account. Its balance and history stay in the
            ledger.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {needsSuccessor ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="successor" required>
                Successor account
              </Label>
              <Select
                value={successor ?? ""}
                disabled={pending}
                onValueChange={(value) => setSuccessor(value)}
              >
                <SelectTrigger id="successor">
                  <SelectValue placeholder="Where this activity goes now" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.code}>
                      {candidate.code} {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-label2">
                {account.code} carries {account.postedLineCount}{" "}
                {account.postedLineCount === 1 ? "posted line" : "posted lines"}. The successor is
                written into its description so the reporting can be followed.
              </p>
            </div>
          ) : (
            <p className="text-xs text-label2">
              Nothing has ever posted to {account.code}, so it can be retired outright.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={pending || (needsSuccessor && successor === null)}
            onClick={submit}
          >
            Retire account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

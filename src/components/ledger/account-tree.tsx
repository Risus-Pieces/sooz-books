"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, RotateCcw, Search, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardToolbar } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
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

const TYPE_LABEL: Record<AccountTreeRow["type"], string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expense",
};

/**
 * The chart of accounts, nested as it reads on a statement, with the posted
 * balance beside each account.
 *
 * Search keeps the shape rather than flattening it: a match drags its parents
 * along, because "6120 Meta & Google Ads" means something different depending on
 * whether it sits under Marketing or under Cost of Goods.
 */
export function AccountTree({ accounts, canManage }: AccountTreeProps) {
  const [query, setQuery] = React.useState("");
  const [showInactive, setShowInactive] = React.useState(false);
  // `null` means no dialog; a row means edit it; `"new"` means create one.
  const [editing, setEditing] = React.useState<AccountTreeRow | "new" | null>(null);
  const [retiring, setRetiring] = React.useState<AccountTreeRow | null>(null);

  const byId = React.useMemo(() => {
    const map = new Map<string, AccountTreeRow>();
    for (const account of accounts) map.set(account.id, account);
    return map;
  }, [accounts]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = accounts.filter((account) => {
      if (!showInactive && !account.active) return false;
      if (needle === "") return true;
      return (
        account.code.toLowerCase().includes(needle) ||
        account.name.toLowerCase().includes(needle) ||
        (account.subtype ?? "").toLowerCase().includes(needle)
      );
    });

    if (needle === "") return matches;

    // Pull in the ancestors of every match so the indent still means something.
    const keep = new Set(matches.map((account) => account.id));
    for (const account of matches) {
      let parentId = account.parentId;
      while (parentId !== null && !keep.has(parentId)) {
        keep.add(parentId);
        parentId = byId.get(parentId)?.parentId ?? null;
      }
    }
    return accounts.filter((account) => keep.has(account.id));
  }, [accounts, byId, query, showInactive]);

  const inactiveCount = accounts.filter((account) => !account.active).length;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>
            {visible.length} of {accounts.length} accounts
          </CardTitle>
          <CardToolbar className="flex-wrap gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                placeholder="Filter by code or name"
                aria-label="Filter accounts"
                className="w-56 pl-7"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={showInactive}
                onCheckedChange={(checked) => setShowInactive(checked === true)}
              />
              Show inactive
              {inactiveCount > 0 ? <span className="num">({inactiveCount})</span> : null}
            </label>
            {canManage ? (
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus />
                New account
              </Button>
            ) : null}
          </CardToolbar>
        </CardHeader>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[62rem] border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Chart of accounts</caption>
            <thead>
              <tr>
                <Th className="w-20">Code</Th>
                <Th>Name</Th>
                <Th className="w-28">Type</Th>
                <Th className="w-36">Subtype</Th>
                <Th className="w-32 text-right">Balance</Th>
                <Th className="w-24 text-right">Lines</Th>
                <Th className="w-28 text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      title="No account matches"
                      description="Try a different code, name or subtype."
                    />
                  </td>
                </tr>
              ) : (
                visible.map((account) => (
                  <tr
                    key={account.id}
                    className={cn("rule-row align-middle", !account.active && "opacity-60")}
                  >
                    <Td className="num text-xs text-muted-foreground">{account.code}</Td>
                    <Td>
                      <span
                        className="inline-flex items-center gap-2"
                        style={{ paddingLeft: `${account.depth * 1.15}rem` }}
                      >
                        <Link
                          href={`/ledger?accountId=${account.id}`}
                          className={cn(
                            "hover:underline",
                            account.childCount > 0 && "font-semibold",
                          )}
                        >
                          {account.name}
                        </Link>
                        {account.isControl ? <Badge tone="info">Control</Badge> : null}
                        {account.isBank ? <Badge tone="neutral">Bank</Badge> : null}
                        {account.active ? null : <Badge tone="warning">Inactive</Badge>}
                      </span>
                    </Td>
                    <Td className="text-xs text-muted-foreground">{TYPE_LABEL[account.type]}</Td>
                    <Td className="text-xs text-muted-foreground">{account.subtype ?? "—"}</Td>
                    <Td className="text-right">
                      <Money cents={account.balanceCents} zeroDash />
                    </Td>
                    <Td className="num text-right text-xs text-muted-foreground">
                      {account.postedLineCount === 0 ? "—" : account.postedLineCount}
                    </Td>
                    <Td className="text-right">
                      {canManage ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Edit ${account.code}`}
                            onClick={() => setEditing(account)}
                          >
                            <Pencil />
                          </Button>
                          {account.active ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Retire ${account.code}`}
                              onClick={() => setRetiring(account)}
                            >
                              <XCircle />
                            </Button>
                          ) : (
                            <ReactivateButton account={account} />
                          )}
                        </div>
                      ) : null}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

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
    </div>
  );
}

function ReactivateButton({ account }: { account: AccountTreeRow }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={pending}
      aria-label={`Reactivate ${account.code}`}
      onClick={() =>
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
      <RotateCcw />
    </Button>
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
              <p className="text-xs text-muted-foreground">
                {account.code} carries {account.postedLineCount}{" "}
                {account.postedLineCount === 1 ? "posted line" : "posted lines"}. The successor is
                written into its description so the reporting can be followed.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Nothing has ever posted to {account.code}, so it can be retired outright.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
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

function Th({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={cn("px-3 py-1.5 align-middle", className)}>{children}</td>;
}

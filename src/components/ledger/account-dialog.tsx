"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import type { AccountType } from "@/db/schema";
import { createLedgerAccount, updateLedgerAccount } from "@/app/(app)/ledger/actions";

import type { AccountTreeRow } from "./types";

const NONE = "__none__";

const TYPES: Array<{ value: AccountType; label: string }> = [
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity", label: "Equity" },
  { value: "revenue", label: "Revenue" },
  { value: "expense", label: "Expense" },
];

export interface AccountDialogProps {
  /** Null for a new account. */
  account: AccountTreeRow | null;
  accounts: readonly AccountTreeRow[];
  onClose: () => void;
  /** Pre-selects a parent when the dialog is opened from a rollup's row. */
  defaultParentCode?: string | null;
}

/**
 * Create or edit an account.
 *
 * Two fields are deliberately immovable once an account exists. The code is
 * how every module in the product addresses the account — `ACCOUNTS` in
 * `@/lib/ledger/coa` is a map of codes — so renumbering one under a running
 * ledger would silently redirect everything that posts to it. The type re-signs
 * every figure the account has ever carried and moves it between statements, so
 * it is frozen the moment the account has posted history. Both say so here
 * rather than failing on submit.
 */
export function AccountDialog({
  account,
  accounts,
  onClose,
  defaultParentCode = null,
}: AccountDialogProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  // The dialog is mounted fresh for each account it is opened on, so the fields
  // are seeded once here rather than reloaded whenever the props change.
  const [code, setCode] = React.useState(account?.code ?? "");
  const [name, setName] = React.useState(account?.name ?? "");
  const [type, setType] = React.useState<AccountType>(account?.type ?? "expense");
  const [subtype, setSubtype] = React.useState(account?.subtype ?? "");
  const [parentCode, setParentCode] = React.useState<string | null>(
    account?.parentCode ?? defaultParentCode,
  );
  const [description, setDescription] = React.useState(account?.description ?? "");
  const [isBank, setIsBank] = React.useState(account?.isBank ?? false);

  const editing = account !== null;
  const typeLocked = editing && account.postedLineCount > 0;

  const parents = React.useMemo(
    () =>
      accounts
        .filter((candidate) => candidate.type === type && candidate.id !== account?.id)
        .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true })),
    [account?.id, accounts, type],
  );

  // A parent has to share the account's type, so changing the type drops a
  // parent that no longer fits. Derived rather than stored: the selection is
  // only ever wrong for as long as the type it belonged to is on screen.
  const effectiveParent =
    parentCode !== null && parents.some((candidate) => candidate.code === parentCode)
      ? parentCode
      : null;

  const submit = () => {
    startTransition(async () => {
      const payload = {
        name: name.trim(),
        type,
        subtype: subtype.trim() === "" ? null : subtype.trim(),
        parentCode: effectiveParent,
        description: description.trim() === "" ? null : description.trim(),
        isBank,
      };

      const result = editing
        ? await updateLedgerAccount(account.id, payload)
        : await createLedgerAccount({ ...payload, code: code.trim() });

      if (!result.ok) {
        toast.error(editing ? "Account not changed" : "Account not created", {
          description: result.error.message,
        });
        return;
      }

      toast.success(editing ? `${account.code} updated` : `Account ${code.trim()} created`);
      onClose();
      router.refresh();
    });
  };

  const valid = name.trim() !== "" && (editing || /^\d{3,6}$/.test(code.trim()));

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${account.code} ${account.name}` : "New account"}</DialogTitle>
          <DialogDescription>
            Numbering runs 1000 assets, 2000 liabilities, 3000 equity, 4000 revenue, 5000 cost of
            goods, 6000 operating expense, 7000 other.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-code" required>
              Code
            </Label>
            <Input
              id="account-code"
              numeric
              value={code}
              disabled={editing || pending}
              placeholder="6125"
              onChange={(event) => setCode(event.target.value)}
            />
            {editing ? (
              <Note short="Code fixed" label="Why the code is fixed">
                A code is how every module addresses this account. Renumbering one under a running
                ledger would redirect everything that posts to it, so it never changes — retire this
                account and open a new one instead.
              </Note>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-name" required>
              Name
            </Label>
            <Input
              id="account-name"
              value={name}
              disabled={pending}
              placeholder="TikTok Ads"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-type" required>
              Type
            </Label>
            <Select
              value={type}
              disabled={typeLocked || pending}
              onValueChange={(value) => setType(value as AccountType)}
            >
              <SelectTrigger id="account-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {typeLocked ? (
              <Note short="Type fixed" label="Why the type is fixed">
                {account.code} already carries {account.postedLineCount}{" "}
                {account.postedLineCount === 1 ? "posted line" : "posted lines"} as {account.type}.
                Changing the type would re-sign every one of them and move the account between
                statements, so it is fixed until that history is reversed out.
              </Note>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-parent" hint="Groups it under a report header">
              Parent
            </Label>
            <Select
              value={effectiveParent ?? NONE}
              disabled={pending}
              onValueChange={(value) => setParentCode(value === NONE ? null : value)}
            >
              <SelectTrigger id="account-parent">
                <SelectValue placeholder="No parent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No parent</SelectItem>
                {parents.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.code}>
                    {candidate.code} {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-subtype" hint="Report grouping key">
              Subtype
            </Label>
            <Input
              id="account-subtype"
              value={subtype}
              disabled={pending}
              placeholder="marketing"
              onChange={(event) => setSubtype(event.target.value)}
            />
          </div>

          <div className="flex items-center gap-2 sm:pt-6">
            <Checkbox
              id="account-bank"
              checked={isBank}
              disabled={pending}
              onCheckedChange={(checked) => setIsBank(checked === true)}
            />
            <Label htmlFor="account-bank" className="normal-case">
              Reconciled against a statement feed
            </Label>
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="account-description" hint="What belongs here, and what does not">
              Description
            </Label>
            <Textarea
              id="account-description"
              value={description}
              disabled={pending}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid || pending} onClick={submit}>
            {editing ? "Save changes" : "Create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Note({ short, label, children }: { short: string; label: string; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-label2">
      <Glyph name="lock" size={12} />
      <span>{short}</span>
      <InfoButton label={label} align="start">
        {children}
      </InfoButton>
    </p>
  );
}

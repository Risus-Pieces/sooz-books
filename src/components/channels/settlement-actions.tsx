"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
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
import { Money, formatCents } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { linkSettlementDeposits, postSettlement, unpostSettlement } from "@/app/(app)/channels/actions";

import { longDate } from "./parts";
import type { DepositCandidateView } from "./types";

/**
 * Posting a settlement. The dialog restates what is about to happen — the clearing account
 * and the net — because this is the moment a person approves the entry shown on the page.
 */
export function PostSettlementButton({
  payoutId,
  label,
  clearingCode,
  netCents,
  lineCount,
  needsTaxState,
  defaultTaxState,
  disabled,
  disabledReason,
}: {
  payoutId: string;
  label: string;
  clearingCode: string;
  netCents: number;
  lineCount: number;
  needsTaxState: boolean;
  defaultTaxState: string | null;
  disabled: boolean;
  disabledReason: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState(defaultTaxState ?? "");
  const [pending, startTransition] = React.useTransition();

  const submit = () =>
    startTransition(async () => {
      const result = await postSettlement(payoutId, needsTaxState || defaultTaxState !== null ? state : null);
      if (!result.ok) {
        toast.error("Not posted", { description: result.error.message });
        return;
      }
      setOpen(false);
      toast.success(`Posted as entry #${result.value.entryNo}`, {
        description:
          result.value.suspenseCents === 0
            ? undefined
            : `Reclassify the ${formatCents(result.value.suspenseCents, { currency: true })} in 7900 Ask My Accountant before the close.`,
      });
      router.refresh();
    });

  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={disabled} title={disabledReason ?? undefined}>
        <Glyph name="check" />
        Post
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Post {label}</DialogTitle>
            <DialogDescription>
              Posts the entry shown on this page: {lineCount} journal lines, with <Money cents={netCents} currency plain /> to{" "}
              <span className="num">{clearingCode}</span>. A posted entry cannot be edited; the correction is to unpost it,
              which reverses it.
            </DialogDescription>
          </DialogHeader>
          {needsTaxState || defaultTaxState !== null ? (
            <DialogBody className="flex flex-col gap-1.5">
              <Label htmlFor="tax-state" required={needsTaxState}>
                Tax state
              </Label>
              <Input
                id="tax-state"
                value={state}
                maxLength={20}
                onChange={(event) => setState(event.target.value.toUpperCase())}
                placeholder="TX"
                className="w-28"
                aria-describedby="tax-state-note"
                disabled={pending}
              />
              <p id="tax-state-note" className="text-xs text-label2">In-person Square sales are sourced to Texas unless they happened elsewhere.</p>
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={pending || (needsTaxState && state.trim() === "")}>
              {pending ? "Posting…" : "Post entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function UnpostSettlementButton({ payoutId, entryNo }: { payoutId: string; entryNo: number | null }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const submit = () =>
    startTransition(async () => {
      const result = await unpostSettlement(payoutId, reason);
      if (!result.ok) {
        toast.error("Not unposted", { description: result.error.message });
        return;
      }
      setOpen(false);
      toast.success(`Reversed by entry #${result.value.reversalEntryNo}`);
      router.refresh();
    });

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Glyph name="undo" />
        Unpost
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Unpost this settlement</DialogTitle>
            <DialogDescription>
              Reverses entry {entryNo === null ? "" : `#${entryNo} `}and removes its sales tax from the register. Refused if a
              filed return already reported that tax.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-1.5">
            <Label htmlFor="unpost-reason" required>
              Reason
            </Label>
            <Input id="unpost-reason" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} disabled={pending} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={submit} disabled={pending || reason.trim() === ""}>
              {pending ? "Reversing…" : "Reverse and unpost"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function LinkDepositButton({ payoutId, deposit }: { payoutId: string; deposit: DepositCandidateView }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await linkSettlementDeposits(payoutId, [deposit.id]);
          if (!result.ok) {
            toast.error("Not linked", { description: result.error.message });
            return;
          }
          toast.success(`Linked the ${longDate(deposit.date)} deposit`);
          router.refresh();
        })
      }
    >
      <Glyph name="link" />
      {pending ? "Linking…" : "Link"}
    </Button>
  );
}

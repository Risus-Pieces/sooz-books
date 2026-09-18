"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ToolbarButton, ToolbarGroup, ToolbarLink } from "@/components/ui/toolbar";
import { isLedgerReversible, ownedEntryMessage } from "@/lib/ledger/ownership";
import { reverseJournalEntry } from "@/app/(app)/ledger/actions";

/**
 * The posted entry's toolbar: duplicate it into a new entry, or reverse it — the one correction
 * a posted entry allows.
 */
export function EntryActions({
  entryId,
  entryNo,
  date,
  sourceType,
  status,
  reversed,
  canPost,
}: {
  entryId: string;
  entryNo: number;
  date: string;
  sourceType: string;
  status: "draft" | "posted";
  /** Already reversed: nothing more to undo. */
  reversed: boolean;
  canPost: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reverseDate, setReverseDate] = React.useState(date);
  const [memo, setMemo] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const ownedBy = sourceType === "reversal" || isLedgerReversible(sourceType) ? null : sourceType;
  const reversible = status === "posted" && !reversed;
  const blocked = !canPost
    ? "Your role may not post to the ledger."
    : ownedBy !== null
      ? ownedEntryMessage(entryNo, ownedBy)
      : null;

  const submit = () => {
    startTransition(async () => {
      const result = await reverseJournalEntry(entryId, reverseDate, memo === "" ? null : memo);
      if (!result.ok) {
        toast.error("Not reversed", { description: result.error.message });
        return;
      }
      setOpen(false);
      toast.success(`Entry #${entryNo} reversed by #${result.value.entryNo}`, {
        description:
          result.value.movedFrom === null
            ? undefined
            : `${result.value.movedFrom} is in a closed period, so the reversal was dated ${result.value.date}.`,
      });
      router.push(`/ledger/${result.value.entryId}`);
    });
  };

  return (
    <>
      <ToolbarGroup>
        {canPost ? <ToolbarLink href={`/ledger/new?from=${entryId}`} glyph="plus" label="Duplicate" /> : null}
        {reversible ? (
          <ToolbarButton
            glyph="undo"
            label="Reverse"
            showLabel
            onClick={() => {
              if (blocked !== null) {
                toast.info("Not reversible here", { description: blocked });
                return;
              }
              setOpen(true);
            }}
            className={blocked !== null ? "opacity-50" : undefined}
          />
        ) : null}
      </ToolbarGroup>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Reverse entry #{entryNo}</DialogTitle>
            <DialogDescription>
              Posts a new entry with every line of #{entryNo} on the opposite side, and links the two. #{entryNo}{" "}
              stays in the books. If the month is closed, the reversal moves to the first open one.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <InsetGroup>
              <GroupRow label="Date" htmlFor="reverse-date">
                <DateInput id="reverse-date" value={reverseDate} onValueChange={setReverseDate} disabled={pending} />
              </GroupRow>
              <GroupRow label="Memo" htmlFor="reverse-memo">
                <Input
                  id="reverse-memo"
                  value={memo}
                  disabled={pending}
                  placeholder={`Reversal of #${entryNo}`}
                  className="w-48"
                  onChange={(event) => setMemo(event.target.value)}
                />
              </GroupRow>
            </InsetGroup>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={pending} onClick={submit}>
              Post reversal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

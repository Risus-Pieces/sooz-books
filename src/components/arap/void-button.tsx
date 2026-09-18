"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/toolbar";
import { DateInput } from "@/components/ui/date-input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";

import type { ActionResult, DocRef } from "./types";

export interface VoidButtonProps {
  /** e.g. "Void invoice". The toast says "<docNo> voided". */
  label: string;
  docNo: string;
  /** What voiding does to the books, in a sentence. */
  consequence: string;
  /** The earliest date the void may carry: the document's own date. */
  minDate: string;
  defaultDate: string;
  /** Drafts have nothing to reverse, so they take no date. */
  needsDate: boolean;
  onVoid: (date: string | null, reason: string) => Promise<ActionResult<DocRef>>;
  /** The trigger: a red icon in a toolbar group (default) or a quiet red push button. */
  appearance?: "toolbar" | "button";
  /** The toolbar glyph: a bin for a draft that is discarded, a slashed circle for a reversal. */
  glyph?: "trash" | "exclude";
}

/**
 * Voiding is the only correction for a document that has reached the ledger:
 * it posts a reversal dated when the bookkeeper says, never before the
 * document itself, and keeps the number so the sequence has no holes.
 */
export function VoidButton({
  label,
  docNo,
  consequence,
  minDate,
  defaultDate,
  needsDate,
  onVoid,
  appearance = "toolbar",
  glyph = "exclude",
}: VoidButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(defaultDate < minDate ? minDate : defaultDate);
  const [reason, setReason] = React.useState("");
  const [pending, start] = React.useTransition();

  const submit = () => {
    start(async () => {
      const result = await onVoid(needsDate ? date : null, reason);
      if (!result.ok) {
        toast.error(`${docNo} not voided`, { description: result.error.message });
        return;
      }
      toast.success(`${docNo} voided`);
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {appearance === "toolbar" ? (
          <ToolbarButton glyph={glyph} label={label} tone="danger" />
        ) : (
          <Button variant="danger-quiet" size="sm">
            {label}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            {label} {docNo}?
          </DialogTitle>
          <DialogDescription>{consequence}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {needsDate ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="void-date" required>
                Reversal date
              </Label>
              <DateInput id="void-date" value={date} min={minDate} onValueChange={setDate} invalid={date < minDate} />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="void-reason">Reason</Label>
            <Input
              id="void-reason"
              value={reason}
              placeholder="e.g. Entered twice"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={submit}
            disabled={pending || (needsDate && (date === "" || date < minDate))}
          >
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

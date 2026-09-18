"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck, CircleSlash, Lock } from "lucide-react";

import { accruePromotionAction, closePromotionAction } from "@/app/(app)/trade/actions";
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
import { Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";

import { EntryTable, Field } from "./parts";
import type { EntryView } from "./types";

/** Posts the accrual for every month of the window that has ended and is not yet accrued. */
export function AccrueButton({ promotionId, due, through }: { promotionId: string; due: EntryView[]; through: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const total = due.reduce((s, e) => s + e.lines.reduce((t, l) => t + l.debitCents, 0), 0);

  const submit = () =>
    startTransition(async () => {
      const result = await accruePromotionAction(promotionId, through);
      if (!result.ok) {
        toast.error("Not accrued", { description: result.error.message });
        return;
      }
      setOpen(false);
      toast.success(`Accrued ${result.value.months} ${result.value.months === 1 ? "month" : "months"}`);
      router.refresh();
    });

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={due.length === 0}>
        <CalendarCheck />
        {due.length === 0 ? "Nothing to accrue" : `Accrue ${due.length} ${due.length === 1 ? "month" : "months"}`}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Accrue through {through}</DialogTitle>
            <DialogDescription>
              One entry per month that has ended, dated its last day: <Money cents={total} currency plain className="text-xs" /> in all. A month already accrued is never accrued twice.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {due.map((entry) => (
              <div key={entry.date} className="rounded-md border border-border bg-surface">
                <EntryTable entry={entry} />
              </div>
            ))}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={pending}>
              {pending ? "Posting…" : `Post ${due.length} ${due.length === 1 ? "entry" : "entries"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Closes or cancels the promotion, releasing whatever is still accrued back to contra revenue. */
export function ClosePromotionButton({
  promotionId,
  release,
  today,
  cancel,
}: {
  promotionId: string;
  release: EntryView | null;
  today: string;
  cancel: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(today);
  const [pending, startTransition] = React.useTransition();
  const verb = cancel ? "Cancel" : "Close";

  const submit = () =>
    startTransition(async () => {
      const result = await closePromotionAction(promotionId, date, cancel);
      if (!result.ok) {
        toast.error(`Not ${cancel ? "cancelled" : "closed"}`, { description: result.error.message });
        return;
      }
      setOpen(false);
      toast.success(cancel ? "Promotion cancelled" : "Promotion closed");
      router.refresh();
    });

  return (
    <>
      <Button size="sm" variant={cancel ? "danger-quiet" : "secondary"} onClick={() => setOpen(true)}>
        {cancel ? <CircleSlash /> : <Lock />}
        {verb} promotion
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{verb} this promotion</DialogTitle>
            <DialogDescription>
              {release === null
                ? "Nothing is left accrued, so no entry posts. The promotion stops accruing."
                : "What is still accrued and unclaimed is released back to contra revenue as the accrual variance, named in the memo."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <Field label="Date" htmlFor="close-date" className="max-w-44">
              <DateInput id="close-date" value={date} onValueChange={setDate} disabled={pending} />
            </Field>
            {release !== null ? (
              <div className="rounded-md border border-border bg-surface">
                <EntryTable entry={{ ...release, date }} />
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Keep it open
            </Button>
            <Button size="sm" variant={cancel ? "danger" : "default"} onClick={submit} disabled={pending}>
              {pending ? "Working…" : release === null ? `${verb} promotion` : `${verb} and release`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

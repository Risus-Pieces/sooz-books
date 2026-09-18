"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Calculator, Send, Undo2 } from "lucide-react";

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
import { formatCents } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { draftCogsAction, postCogsAction, reverseCogsAction } from "@/app/(app)/inventory/actions";

import { Field } from "./fields";

/** Drafts (or redrafts) a month's batch; nothing posts until the draft is reviewed. */
export function DraftBatchButton({
  period,
  label,
  redraft = false,
}: {
  period: string;
  label: string;
  redraft?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      size="sm"
      variant={redraft ? "ghost" : "secondary"}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await draftCogsAction(period);
          if (!result.ok) {
            toast.error(`COGS for ${label} not drafted`, {
              description: [result.error.message, ...(result.error.details ?? [])].join(" "),
            });
            return;
          }
          toast.success(`COGS for ${label} drafted — review it before posting`);
          router.push(`/inventory/cogs?batch=${result.value.batchId}`, { scroll: false });
          router.refresh();
        })
      }
    >
      <Calculator />
      {redraft ? "Redraft" : "Draft COGS"}
    </Button>
  );
}

export function PostBatchButton({ batchId, label, totalCents }: { batchId: string; label: string; totalCents: number }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const post = () =>
    startTransition(async () => {
      const result = await postCogsAction(batchId);
      if (!result.ok) {
        toast.error(`COGS for ${label} not posted`, { description: result.error.message });
        return;
      }
      toast.success(`COGS for ${label} posted as entry #${result.value.entryNo}`);
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Send />
        Post COGS
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Post COGS for {label}</DialogTitle>
            <DialogDescription>
              Relieves {formatCents(totalCents, { currency: true })} from Finished Goods into cost of goods sold, one line
              per SKU and channel, dated the last day of the month. Only one batch can be posted for a month.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={pending} onClick={post}>
              Post the entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ReverseBatchButton({ batchId, label, periodEnd }: { batchId: string; label: string; periodEnd: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(periodEnd);
  const [pending, startTransition] = React.useTransition();
  const reverse = () =>
    startTransition(async () => {
      const result = await reverseCogsAction(batchId, date);
      if (!result.ok) {
        toast.error(`COGS for ${label} not reversed`, { description: result.error.message });
        return;
      }
      toast.success(`COGS for ${label} reversed`);
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Undo2 />
        Reverse
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Reverse COGS for {label}</DialogTitle>
            <DialogDescription>
              Posts the mirror image of the batch’s entry, which puts the units back into Finished Goods at the same
              cost. The month can then be re-imported and drafted again.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field id="reverse-date" label="Reversal date" note="Must fall in an open period.">
              <DateInput id="reverse-date" value={date} onValueChange={setDate} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" disabled={pending || date === ""} onClick={reverse}>
              Reverse the batch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

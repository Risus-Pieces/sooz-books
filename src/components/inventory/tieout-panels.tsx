"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

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
import { Glyph } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";
import { mediumDate } from "@/lib/ui/format";
import { postTieoutAdjustmentAction, recordTieoutAction } from "@/app/(app)/inventory/actions";
import type { TieoutRow } from "@/app/(app)/inventory/queries";

import { EntryPreview } from "./entry-preview";
import { Field } from "./fields";

/** Records the comparison for the latest count, with an optional explanation of any difference. */
export function RecordTieoutButton({ snapshotDate, varianceCents, recorded }: { snapshotDate: string; varianceCents: number; recorded: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [explanation, setExplanation] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const submit = () =>
    startTransition(async () => {
      const result = await recordTieoutAction(explanation);
      if (!result.ok) {
        toast.error("Tie-out not recorded", { description: result.error.message });
        return;
      }
      toast.success(`Tie-out for ${snapshotDate} recorded`);
      setOpen(false);
      setExplanation("");
      router.refresh();
    });

  return (
    <>
      <ToolbarButton
        glyph="reconcile"
        label={recorded ? "Record again" : "Record tie-out"}
        showLabel={!recorded}
        tone={recorded ? "default" : "accent"}
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Record the tie-out for {snapshotDate}</DialogTitle>
            <DialogDescription>
              Saves Peasy’s count against the ledger on {snapshotDate}, stage by stage.
              {varianceCents === 0
                ? " They agree, so it is recorded as resolved."
                : " A difference stays open until it is explained or the proposed adjustment is posted."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field id="tieout-explain" label="Explanation" hint="optional">
              <Textarea
                id="tieout-explain"
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
                rows={3}
                placeholder="40 pouches in transit, received Oct 2"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={submit}>
              Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The correcting entry for a tie-out, shown in full; posting it is the human approval the tie-out
 * waits for.
 */
function ProposalDialog({ row }: { row: TieoutRow }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  if (row.proposal === null) return null;
  const proposal = row.proposal;

  const post = () =>
    startTransition(async () => {
      const result = await postTieoutAdjustmentAction(row.id);
      if (!result.ok) {
        toast.error("Adjustment not posted", { description: result.error.message });
        return;
      }
      toast.success(`Inventory adjusted to the ${row.asOfDate} count`);
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Review adjustment
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Adjust inventory to the {row.asOfDate} count</DialogTitle>
            <DialogDescription>
              Brings each inventory account to what Peasy counted, against 5060 Inventory Write-offs. Post it only once
              the difference is understood — a missed receipt or an uncosted run is better fixed at its source.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="px-0">
            <EntryPreview entry={proposal} caption="Proposed tie-out adjustment" />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={post}>
              Post the adjustment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function status(r: TieoutRow): { label: string; tone: "green" | "blue" | "orange"; tint: "green" | "blue" | "orange" } {
  if (r.adjustment) return { label: `Adjusted #${r.adjustment.entryNo}`, tone: "green", tint: "green" };
  if (r.resolved) return { label: "Ties", tone: "green", tint: "green" };
  if (r.explanation) return { label: "Explained", tone: "blue", tint: "blue" };
  return { label: "Open", tone: "orange", tint: "orange" };
}

/** Every recorded comparison, newest first: count date, the difference, and what was done about it. */
export function TieoutHistory({ rows, canManage }: { rows: readonly TieoutRow[]; canManage: boolean }) {
  return (
    <ul className="flex flex-col">
      {rows.map((r, index) => {
        const s = status(r);
        return (
          <li
            key={r.id}
            className={cn(
              "relative flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5",
              index > 0 && "before:absolute before:top-0 before:right-0 before:left-[60px] before:border-t-[0.5px] before:border-sep",
            )}
          >
            <IconBadge glyph={r.varianceCents === 0 ? "check" : "warning"} tint={s.tint} size="lg" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="num text-sm font-semibold">{mediumDate(r.asOfDate)}</span>
                {r.adjustment ? (
                  <Link href={`/ledger/${r.adjustment.id}`} className="text-xs font-semibold text-ink-green hover:underline">
                    {s.label}
                  </Link>
                ) : (
                  <Pill tone={s.tone} className="h-5 px-2 text-2xs">
                    {s.label}
                  </Pill>
                )}
              </span>
              <span className="mt-0.5 block truncate text-xs text-label2">
                Peasy <Money cents={r.snapshotValueCents} currency plain /> · Ledger <Money cents={r.ledgerValueCents} currency plain />
                {r.explanation ? ` · ${r.explanation}` : ""}
              </span>
            </span>
            <Money
              cents={r.varianceCents}
              currency
              signed
              zeroDash
              plain
              className={cn("text-sm font-semibold", r.varianceCents !== 0 && "text-ink-orange")}
            />
            {canManage && r.proposal ? (
              <span className="flex w-full justify-end sm:w-auto">
                <ProposalDialog row={r} />
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The quiet note under a tie-out whose difference is not recorded yet. */
export function UnrecordedNote() {
  return (
    <p className="flex items-center gap-2 text-sm font-medium text-ink-orange">
      <Glyph name="warning" size={15} />
      Record the tie-out to act on it
    </p>
  );
}

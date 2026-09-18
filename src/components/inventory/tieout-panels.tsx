"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardCheck, Scale } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import { Money } from "@/components/ui/money";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { postTieoutAdjustmentAction, recordTieoutAction } from "@/app/(app)/inventory/actions";
import type { TieoutRow } from "@/app/(app)/inventory/queries";

import { EntryPreview } from "./entry-preview";
import { Field } from "./fields";
import { Table, TableScroll, Td, Th } from "./table";

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
      <Button size="sm" variant={recorded ? "secondary" : "default"} onClick={() => setOpen(true)}>
        <ClipboardCheck />
        {recorded ? "Record again" : "Record the tie-out"}
      </Button>
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
                placeholder="e.g. 40 pouches in transit from the co-packer, received Oct 2"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={pending} onClick={submit}>
              Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The correcting entry for a tie-out, shown in full; posting it is the human
 * approval the tie-out waits for.
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
        <Scale />
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
          <DialogBody className="p-0">
            <EntryPreview entry={proposal} caption="Proposed tie-out adjustment" />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={pending} onClick={post}>
              Post the adjustment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function TieoutHistory({ rows, canManage }: { rows: readonly TieoutRow[]; canManage: boolean }) {
  return (
    <TableScroll>
      <Table caption="Tie-out history" className="min-w-[48rem]">
        <thead>
          <tr>
            <Th className="w-28">Count date</Th>
            <Th align="right">Peasy</Th>
            <Th align="right">Ledger</Th>
            <Th align="right">Variance</Th>
            <Th>Status</Th>
            <Th>Explanation</Th>
            <Th className="w-40" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="rule-row align-top">
              <Td className="num whitespace-nowrap">{r.asOfDate}</Td>
              <Td align="right">
                <Money cents={r.snapshotValueCents} plain />
              </Td>
              <Td align="right">
                <Money cents={r.ledgerValueCents} plain />
              </Td>
              <Td align="right">
                <Money cents={r.varianceCents} signed zeroDash plain className={r.varianceCents === 0 ? undefined : "text-warning"} />
              </Td>
              <Td>
                {r.adjustment ? (
                  <Link href={`/ledger/${r.adjustment.id}`}>
                    <Badge tone="positive">Adjusted #{r.adjustment.entryNo}</Badge>
                  </Link>
                ) : r.resolved ? (
                  <Badge tone="positive">Ties</Badge>
                ) : r.explanation ? (
                  <Badge tone="info">Explained</Badge>
                ) : (
                  <Badge tone="warning">Open</Badge>
                )}
              </Td>
              <Td className="max-w-72 text-xs text-muted-foreground">{r.explanation ?? "—"}</Td>
              <Td align="right">{canManage && r.proposal ? <ProposalDialog row={r} /> : null}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

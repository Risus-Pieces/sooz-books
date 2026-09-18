"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, LockOpen, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { closeAccountingPeriod, reopenAccountingPeriod } from "@/app/(app)/ledger/actions";

import { monthLabel, periodKey, type BlockingDraft, type PeriodRow } from "./types";

export interface PeriodTableProps {
  /** Newest month first. */
  periods: readonly PeriodRow[];
  canClose: boolean;
  canReopen: boolean;
}

/**
 * The close screen: one row a month, with what is in it and whether it is shut.
 *
 * Closing is refused while a draft is dated inside the month — a draft can never
 * be posted afterwards, so closing over one silently strands it — and the row
 * says so before anyone presses the button rather than after.
 */
export function PeriodTable({ periods, canClose, canReopen }: PeriodTableProps) {
  const [closing, setClosing] = React.useState<PeriodRow | null>(null);
  const [reopening, setReopening] = React.useState<PeriodRow | null>(null);

  return (
    <>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-3xl border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Accounting periods</caption>
            <thead>
              <tr>
                <Th className="w-40">Period</Th>
                <Th className="w-24">Status</Th>
                <Th className="w-24 text-right">Entries</Th>
                <Th className="w-24 text-right">Drafts</Th>
                <Th className="w-36 text-right">Debits posted</Th>
                <Th>Closed</Th>
                <Th className="w-32 text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => {
                const blocked = period.draftCount > 0;
                return (
                  <tr
                    key={periodKey(period.year, period.month)}
                    className={cn("rule-row align-middle", period.current && "bg-primary/5")}
                  >
                    <Td>
                      <span className="font-medium">{monthLabel(period.year, period.month)}</span>
                      {period.current ? (
                        <span className="ml-2 text-2xs tracking-wide text-muted-foreground uppercase">
                          current
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {period.status === "closed" ? (
                        <Badge tone="neutral">
                          <Lock />
                          Closed
                        </Badge>
                      ) : (
                        <Badge tone="info">Open</Badge>
                      )}
                    </Td>
                    <Td className="num text-right">
                      {period.entryCount === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Link
                          href={`/ledger?from=${period.start}&to=${period.end}`}
                          className="hover:underline"
                        >
                          {period.entryCount}
                        </Link>
                      )}
                    </Td>
                    <Td className="num text-right">
                      {period.draftCount === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Link
                          href={`/ledger?from=${period.start}&to=${period.end}&status=draft`}
                          className="text-warning hover:underline"
                        >
                          {period.draftCount}
                        </Link>
                      )}
                    </Td>
                    <Td className="text-right">
                      <Money cents={period.debitCents} zeroDash plain />
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {period.closedAtLabel === null
                        ? "—"
                        : `${period.closedAtLabel}${period.closedByLabel === null ? "" : ` · ${period.closedByLabel}`}`}
                    </Td>
                    <Td className="text-right">
                      {period.status === "closed" ? (
                        canReopen ? (
                          <Button variant="secondary" size="sm" onClick={() => setReopening(period)}>
                            <LockOpen />
                            Reopen
                          </Button>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Button variant="secondary" size="sm" disabled>
                                  <LockOpen />
                                  Reopen
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>Only an owner can reopen a closed period.</TooltipContent>
                          </Tooltip>
                        )
                      ) : canClose ? (
                        <Button
                          variant={blocked ? "secondary" : "default"}
                          size="sm"
                          onClick={() => setClosing(period)}
                        >
                          <Lock />
                          Close
                        </Button>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Mounted fresh per month, so neither dialog carries state from the last
          one it was opened on. */}
      {closing === null ? null : (
        <CloseDialog
          key={periodKey(closing.year, closing.month)}
          period={closing}
          onClose={() => setClosing(null)}
        />
      )}
      {reopening === null ? null : (
        <ReopenDialog
          key={periodKey(reopening.year, reopening.month)}
          period={reopening}
          onClose={() => setReopening(null)}
        />
      )}
    </>
  );
}

function CloseDialog({ period, onClose }: { period: PeriodRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [blocking, setBlocking] = React.useState<readonly BlockingDraft[]>([]);

  const blocked = period.draftCount > 0 || blocking.length > 0;

  const submit = () => {
    startTransition(async () => {
      const result = await closeAccountingPeriod(period.year, period.month);
      if (!result.ok) {
        setBlocking(result.error.blocking ?? []);
        toast.error("Period not closed", { description: result.error.message });
        return;
      }
      toast.success(`${monthLabel(period.year, period.month)} closed`);
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Close {monthLabel(period.year, period.month)}</DialogTitle>
          <DialogDescription>
            Nothing can be posted into a closed month. Corrections after this go into a later period
            as reversing entries.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {blocked ? (
            <div className="flex flex-col gap-2 rounded-sm border border-warning/35 bg-warning/8 p-3">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-warning">
                <TriangleAlert className="size-4" />
                {period.draftCount > 0
                  ? `${period.draftCount} draft ${period.draftCount === 1 ? "entry is" : "entries are"} dated in this month`
                  : "Drafts are standing in the way"}
              </p>
              <p className="text-xs text-muted-foreground">
                A draft dated in a closed month can never be posted. Post or delete each one first.
              </p>
              {blocking.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {blocking.map((draft) => (
                    <li key={draft.id} className="text-xs">
                      <Link href={`/ledger/${draft.id}`} className="text-primary hover:underline">
                        #{draft.entryNo}
                      </Link>{" "}
                      <span className="num text-muted-foreground">{draft.date}</span>{" "}
                      {draft.memo ?? ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <Link
                  href={`/ledger?from=${period.start}&to=${period.end}&status=draft`}
                  className="text-xs text-primary hover:underline"
                >
                  Show the drafts in this month
                </Link>
              )}
            </div>
          ) : (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="eyebrow">Entries</dt>
                <dd className="num mt-1">{period.entryCount}</dd>
              </div>
              <div>
                <dt className="eyebrow">Debits posted</dt>
                <dd className="mt-1">
                  <Money cents={period.debitCents} currency plain />
                </dd>
              </div>
            </dl>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={pending || blocked} onClick={submit}>
            Close the period
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Reopening lets figures that have already been reported move, so it asks for
 * the period to be typed back — the one confirmation that cannot be clicked
 * through by reflex — and the server checks the same string again.
 */
function ReopenDialog({ period, onClose }: { period: PeriodRow; onClose: () => void }) {
  const router = useRouter();
  const [confirmation, setConfirmation] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const expected = periodKey(period.year, period.month);

  const submit = () => {
    startTransition(async () => {
      const result = await reopenAccountingPeriod(period.year, period.month, confirmation);
      if (!result.ok) {
        toast.error("Period not reopened", { description: result.error.message });
        return;
      }
      toast.success(`${monthLabel(period.year, period.month)} reopened`);
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Reopen {monthLabel(period.year, period.month)}</DialogTitle>
          <DialogDescription>
            This month was closed
            {period.closedAtLabel === null ? "" : ` on ${period.closedAtLabel}`}
            {period.closedByLabel === null ? "" : ` by ${period.closedByLabel}`}. Anything already
            reported from it can change once it is open again.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-1.5">
          <Label htmlFor="reopen-confirm" required>
            Type <span className="num normal-case">{expected}</span> to confirm
          </Label>
          <Input
            id="reopen-confirm"
            value={confirmation}
            disabled={pending}
            autoComplete="off"
            placeholder={expected}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={pending || confirmation.trim() !== expected}
            onClick={submit}
          >
            Reopen the period
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

"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, LockOpen } from "lucide-react";

import { reopenClosedMonth } from "@/app/(app)/close/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
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
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

import type { ClosedPeriodRow } from "./types";

/** Every closed month, with who closed it, and the owner's typed-confirmation reopen. */
export function CloseHistory({ rows, canReopen }: { rows: readonly ClosedPeriodRow[]; canReopen: boolean }) {
  const [reopening, setReopening] = React.useState<ClosedPeriodRow | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Closed months</CardTitle>
        <span className="text-xs text-muted-foreground">Reopening is owner-only.</span>
      </CardHeader>
      {rows.length === 0 ? (
        <EmptyState
          icon={<Lock />}
          title="No month has been closed yet"
          description="Work the checklist above for the earliest open month; once it closes it is listed here."
        />
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-xl border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Closed months</caption>
            <thead>
              <tr>
                <Th>Month</Th>
                <Th>Closed</Th>
                <Th>How</Th>
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="rule-row">
                  <Td>
                    <Link href={`/close?month=${row.key}`} className="font-medium hover:underline">
                      {row.label}
                    </Link>
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {row.closedAtLabel ?? "—"}
                    {row.closedByLabel === null ? "" : ` · ${row.closedByLabel}`}
                  </Td>
                  <Td>
                    {row.viaChecklist ? (
                      <Badge tone="positive">Checklist</Badge>
                    ) : (
                      <Badge tone="neutral">Without checklist</Badge>
                    )}
                    {row.skippedCount > 0 ? (
                      <Badge tone="warning" className="ml-1.5">
                        {row.skippedCount} skipped
                      </Badge>
                    ) : null}
                  </Td>
                  <Td className="text-right">
                    {canReopen ? (
                      <Button variant="secondary" size="sm" onClick={() => setReopening(row)}>
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
                        <TooltipContent>Only an owner can reopen a closed month.</TooltipContent>
                      </Tooltip>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reopening === null ? null : (
        <ReopenDialog key={reopening.key} row={reopening} onClose={() => setReopening(null)} />
      )}
    </Card>
  );
}

/**
 * Reopening lets figures already reported move, so it asks for the month to be
 * typed back — the one confirmation that cannot be clicked through by reflex —
 * and the server checks the same string again.
 */
function ReopenDialog({ row, onClose }: { row: ClosedPeriodRow; onClose: () => void }) {
  const router = useRouter();
  const [confirmation, setConfirmation] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const submit = () => {
    startTransition(async () => {
      const result = await reopenClosedMonth(row.year, row.month, confirmation);
      if (!result.ok) {
        toast.error("Month not reopened", { description: result.error.message });
        return;
      }
      toast.success(`${row.label} reopened`);
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Reopen {row.label}</DialogTitle>
          <DialogDescription>
            Closed{row.closedAtLabel === null ? "" : ` on ${row.closedAtLabel}`}
            {row.closedByLabel === null ? "" : ` by ${row.closedByLabel}`}. Anything already reported from it can
            change once it is open. Its checklist goes back to in progress.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-1.5">
          <Label htmlFor="reopen-month" required>
            Type <span className="num normal-case">{row.key}</span> to confirm
          </Label>
          <Input
            id="reopen-month"
            value={confirmation}
            disabled={pending}
            autoComplete="off"
            placeholder={row.key}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" disabled={pending || confirmation.trim() !== row.key} onClick={submit}>
            Reopen the month
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

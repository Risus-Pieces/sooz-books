"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { reopenClosedMonth } from "@/app/(app)/close/actions";
import type { ClosedPeriodRow } from "@/components/planning/types";
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
import { InsetGroup } from "@/components/ui/inset-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Every closed month, who closed it and how, and the owner's typed-confirmation reopen. */
export function CloseHistory({ rows, canReopen }: { rows: readonly ClosedPeriodRow[]; canReopen: boolean }) {
  const [reopening, setReopening] = React.useState<ClosedPeriodRow | null>(null);

  return (
    <>
      <InsetGroup header="History" aria-label="History" separatorInset={56}>
        {rows.length === 0 ? (
          <div className="flex items-center gap-3 px-4 py-4 text-sm text-label2">
            <Glyph name="lock" size={20} className="text-label3" />
            No closed months
          </div>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li
                key={row.key}
                className="relative flex min-h-11 items-center gap-3 px-4 py-2.5 before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[56px] before:border-t-[0.5px] before:border-sep first:before:hidden max-sm:flex-wrap"
              >
                <IconBadge glyph="lock" tint="green" size="lg" />
                <div className="min-w-0 flex-1">
                  <Link href={`/close?month=${row.key}`} className="text-sm font-semibold hover:text-ink-blue max-sm:text-[0.9375rem]">
                    {row.label}
                  </Link>
                  <p className="truncate text-xs text-label2">
                    {row.closedAtLabel ?? "—"}
                    {row.closedByLabel === null ? "" : ` · ${row.closedByLabel}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {row.viaChecklist ? (
                    <Pill tone="green" glyph="check">
                      Checklist
                    </Pill>
                  ) : (
                    <Pill>Direct</Pill>
                  )}
                  {row.skippedCount > 0 ? <Pill tone="orange">{row.skippedCount} skipped</Pill> : null}
                  {canReopen ? (
                    <Button variant="secondary" size="sm" onClick={() => setReopening(row)}>
                      <Glyph name="unlock" size={14} />
                      Reopen
                    </Button>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button variant="secondary" size="sm" disabled>
                            <Glyph name="unlock" size={14} />
                            Reopen
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Owner only</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </InsetGroup>
      {reopening === null ? null : (
        <ReopenDialog key={reopening.key} row={reopening} onClose={() => setReopening(null)} />
      )}
    </>
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
            {row.closedByLabel === null ? "" : ` by ${row.closedByLabel}`}. Once it is open, entries can post into it
            and anything already reported from it can change. Its checklist goes back to in progress.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-1.5">
          <Label htmlFor="reopen-month" required>
            Type <span className="num">{row.key}</span> to confirm
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
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={pending || confirmation.trim() !== row.key} onClick={submit}>
            Reopen the month
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

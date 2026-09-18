"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CircleCheck, CircleX, Lock, RotateCcw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money, formatCents } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { parseMoney } from "@/lib/money";
import {
  abandonStatementReconciliation,
  completeStatementReconciliation,
  setLineCleared,
  startStatementReconciliation,
  undoStatementReconciliation,
} from "@/app/(app)/banking/actions";

import { Figure } from "./parts";
import { ConfirmDialog, type ConfirmRequest } from "./review-dialogs";
import { monthLabel, shortDate } from "./review-logic";
import type { ReconHistoryRow, ReconLineView, ReconSummaryView, StatementProposalView } from "./types";

function readCents(text: string): number | null {
  try {
    return parseMoney(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

export function MonthPicker({ months, value }: { months: readonly string[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <Select
      value={value}
      onValueChange={(month) => {
        const next = new URLSearchParams(params.toString());
        next.set("month", month);
        router.push(`${pathname}?${next.toString()}`);
      }}
    >
      <SelectTrigger aria-label="Statement month" className="w-[9.5rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {months.map((month) => (
          <SelectItem key={month} value={month}>
            {monthLabel(month)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function StartReconciliation({
  bankAccountId,
  proposal,
  postedInMonth,
  canReconcile,
}: {
  bankAccountId: string;
  proposal: StatementProposalView;
  /** Posted bank-account lines dated in the month; zero means there is nothing to clear yet. */
  postedInMonth: number;
  canReconcile: boolean;
}) {
  const [start, setStart] = React.useState(proposal.statementStartDate);
  const [end, setEnd] = React.useState(proposal.statementDate);
  const [opening, setOpening] = React.useState(
    proposal.openingBalanceCents === null ? "" : formatCents(proposal.openingBalanceCents),
  );
  const [closing, setClosing] = React.useState(
    proposal.closingBalanceCents === null ? "" : formatCents(proposal.closingBalanceCents),
  );
  const [autoClear, setAutoClear] = React.useState(true);
  const [pending, startTransition] = React.useTransition();

  const openingCents = readCents(opening);
  const closingCents = readCents(closing);
  const valid = openingCents !== null && closingCents !== null && start !== "" && end !== "" && start <= end;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Statement for {monthLabel(proposal.month)}</CardTitle>
          <CardDescription>
            {proposal.basis === "balance_chain"
              ? `Read from the running balance on ${proposal.transactionCount} imported rows. Check it against the statement PDF.`
              : proposal.basis === "carried_forward"
                ? "No transactions this month: the balance carries forward."
                : "No imported rows yet. Enter the balances from the statement."}
          </CardDescription>
        </div>
        {proposal.basis === "no_data" ? null : proposal.chainOk ? (
          <Badge tone="positive">
            <CircleCheck />
            Chain ties
          </Badge>
        ) : (
          <Badge tone="negative">
            <CircleX />
            {proposal.breaks.length} break{proposal.breaks.length === 1 ? "" : "s"}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recon-start">Statement starts</Label>
            <DateInput id="recon-start" value={start} onValueChange={setStart} className="w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recon-end">Statement ends</Label>
            <DateInput id="recon-end" value={end} onValueChange={setEnd} className="w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recon-opening">Beginning balance</Label>
            <Input
              id="recon-opening"
              numeric
              inputMode="decimal"
              value={opening}
              invalid={opening !== "" && openingCents === null}
              onChange={(event) => setOpening(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recon-closing">Ending balance</Label>
            <Input
              id="recon-closing"
              numeric
              inputMode="decimal"
              value={closing}
              invalid={closing !== "" && closingCents === null}
              onChange={(event) => setClosing(event.target.value)}
            />
          </div>
        </div>
        {proposal.breaks.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-negative">
            {proposal.breaks.map((b) => (
              <li key={b.date}>
                {shortDate(b.date)}: the rows add to <Money cents={b.expectedCents} currency plain /> but the bank printed{" "}
                <Money cents={b.actualCents} currency plain />. A statement row may be missing.
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Net change this month{" "}
          <Money cents={proposal.netChangeCents} currency signed colorPositive className="text-xs" />. The books show{" "}
          <Money cents={proposal.ledgerBalanceCents} currency plain className="text-xs" /> at month end.
          {postedInMonth === 0 ? (
            <>
              {" "}
              Nothing dated this month is posted yet, so there is nothing to clear.{" "}
              <Link href="/banking/review" className="text-primary underline decoration-primary/40 underline-offset-4">
                Post it from the review queue
              </Link>{" "}
              first.
            </>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={autoClear} onCheckedChange={(value) => setAutoClear(value === true)} />
            Clear every posted transaction dated in the statement
          </label>
          <Button
            className="ml-auto"
            disabled={!valid || pending || !canReconcile}
            onClick={() =>
              startTransition(async () => {
                if (openingCents === null || closingCents === null) return;
                const result = await startStatementReconciliation({
                  bankAccountId,
                  statementStartDate: start,
                  statementDate: end,
                  openingBalanceCents: openingCents,
                  closingBalanceCents: closingCents,
                  autoClear,
                });
                if (result.ok) toast.success("Reconciliation started");
                else toast.error(result.error.message);
              })
            }
          >
            Start reconciliation
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Working one
// ---------------------------------------------------------------------------

export function ReconcileWorkspace({
  summary,
  lines,
  canReconcile,
}: {
  summary: ReconSummaryView;
  lines: readonly ReconLineView[];
  canReconcile: boolean;
}) {
  // Local truth for the ticks, so the difference moves the instant a box is ticked; the
  // server's figure replaces it when the action returns.
  const [cleared, setCleared] = React.useState<ReadonlySet<string>>(
    () => new Set(lines.filter((line) => line.cleared).map((line) => line.journalLineId)),
  );
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const [pending, startTransition] = React.useTransition();

  const clearedSum = lines.reduce((sum, line) => (cleared.has(line.journalLineId) ? sum + line.amountCents : sum), 0);
  const clearedBalance = summary.previouslyClearedCents + clearedSum;
  const difference = summary.closingBalanceCents - clearedBalance;
  const tied = difference === 0;

  const toggle = (line: ReconLineView) => {
    const next = !cleared.has(line.journalLineId);
    setCleared((current) => {
      const copy = new Set(current);
      if (next) copy.add(line.journalLineId);
      else copy.delete(line.journalLineId);
      return copy;
    });
    void setLineCleared(summary.id, line.journalLineId, next).then((result) => {
      if (result.ok) return;
      toast.error(result.error.message);
      setCleared((current) => {
        const copy = new Set(current);
        if (next) copy.delete(line.journalLineId);
        else copy.add(line.journalLineId);
        return copy;
      });
    });
  };

  const unclearedLines = lines.filter((line) => !cleared.has(line.journalLineId));
  const clearedLines = lines.filter((line) => cleared.has(line.journalLineId));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border bg-surface shadow-raised lg:grid-cols-4">
        <Figure label={`Statement ends ${summary.statementDate}`}>
          <Money cents={summary.closingBalanceCents} currency />
        </Figure>
        <Figure label="Cleared balance" className="border-l">
          <Money cents={clearedBalance} currency />
        </Figure>
        <Figure label="Cleared this statement" className="border-t lg:border-t-0 lg:border-l">
          <span className="num">{cleared.size}</span>
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            of <span className="num">{lines.length}</span>
          </span>
        </Figure>
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1 border-t border-l border-border px-3 py-2 lg:border-t-0",
            tied ? "bg-positive/8" : "bg-negative/6",
          )}
          aria-live="polite"
        >
          <span className="eyebrow">Difference</span>
          <span className={cn("text-xl leading-none font-semibold tracking-tight", tied ? "text-positive" : "text-negative")}>
            <Money cents={difference} currency plain />
          </span>
        </div>
      </div>

      {summary.openingDifferenceCents !== 0 ? (
        <p className="rounded-sm border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning">
          The statement begins at <Money cents={summary.openingBalanceCents} currency plain className="text-xs" /> but
          the reconciled books begin at{" "}
          <Money cents={summary.previouslyClearedCents} currency plain className="text-xs" />. An earlier month is
          probably not reconciled yet.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <LineColumn
          title="Not yet cleared"
          description="Posted, but not on this statement yet — or not ticked."
          lines={unclearedLines}
          checked={false}
          disabled={!canReconcile || pending}
          onToggle={toggle}
        />
        <LineColumn
          title="Cleared"
          description="On the statement and in the books."
          lines={clearedLines}
          checked
          disabled={!canReconcile || pending}
          onToggle={toggle}
        />
      </div>

      {canReconcile ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              setConfirm({
                title: "Abandon reconciliation",
                confirmLabel: "Abandon",
                tone: "danger",
                body: <p>Throw away this reconciliation to {summary.statementDate} and everything ticked in it.</p>,
                onConfirm: () =>
                  startTransition(async () => {
                    const result = await abandonStatementReconciliation(summary.id);
                    if (result.ok) toast.success("Reconciliation abandoned");
                    else toast.error(result.error.message);
                  }),
              })
            }
          >
            <Trash2 />
            Abandon
          </Button>
          <Button
            disabled={!tied || pending}
            onClick={() =>
              startTransition(async () => {
                const result = await completeStatementReconciliation(summary.id);
                if (result.ok) toast.success(`Reconciled through ${summary.statementDate}`);
                else toast.error(result.error.message);
              })
            }
          >
            <Lock />
            {tied ? "Complete and lock" : "Difference must be $0.00"}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function LineColumn({
  title,
  description,
  lines,
  checked,
  disabled,
  onToggle,
}: {
  title: string;
  description: string;
  lines: readonly ReconLineView[];
  checked: boolean;
  disabled: boolean;
  onToggle: (line: ReconLineView) => void;
}) {
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader>
        <div>
          <CardTitle>
            {title} <span className="num text-muted-foreground">{lines.length}</span>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <Money cents={total} currency signed colorPositive />
      </CardHeader>
      {lines.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">Nothing here.</p>
      ) : (
        <ul className="relative max-h-[28rem] divide-y divide-border overflow-y-auto">
          {lines.map((line) => (
            <li key={line.journalLineId}>
              <label className="flex cursor-pointer items-center gap-3 px-4 py-1.5 hover:bg-muted/60">
                <Checkbox checked={checked} disabled={disabled} onCheckedChange={() => onToggle(line)} />
                <span className="num w-14 shrink-0 text-xs text-muted-foreground">{shortDate(line.date)}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{line.payee ?? line.memo ?? `Entry #${line.entryNo}`}</span>
                <Money cents={line.amountCents} colorPositive />
              </label>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function ReconHistory({ rows, canUndo }: { rows: readonly ReconHistoryRow[]; canUndo: boolean }) {
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const [pending, startTransition] = React.useTransition();
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
      </CardHeader>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">This account has never been reconciled.</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                {["Statement", "Ending balance", "Status", "Completed", ""].map((head, index) => (
                  <th
                    key={head || "actions"}
                    scope="col"
                    className={cn(
                      "rule-head bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase",
                      index === 1 && "text-right",
                    )}
                  >
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="rule-row num px-3 py-1.5 text-xs">
                    {row.statementStartDate} → {row.statementDate}
                  </td>
                  <td className="rule-row px-3 py-1.5 text-right">
                    <Money cents={row.closingBalanceCents} />
                  </td>
                  <td className="rule-row px-3 py-1.5">
                    <Badge tone={row.status === "completed" ? "positive" : "warning"}>
                      {row.status === "completed" ? "Reconciled" : "In progress"}
                    </Badge>
                  </td>
                  <td className="rule-row px-3 py-1.5 text-xs text-muted-foreground">
                    {row.completedAt === null ? "—" : `${row.completedAt}${row.completedBy ? ` · ${row.completedBy}` : ""}`}
                  </td>
                  <td className="rule-row px-3 py-1.5 text-right">
                    {row.undoable && canUndo ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          setConfirm({
                            title: "Undo reconciliation",
                            confirmLabel: "Undo",
                            tone: "danger",
                            body: (
                              <p>
                                Reopen the reconciliation to {row.statementDate}. Its transactions unlock and can be
                                changed again; figures already reported from this month may move.
                              </p>
                            ),
                            onConfirm: () =>
                              startTransition(async () => {
                                const result = await undoStatementReconciliation(row.id);
                                if (result.ok) toast.success("Reconciliation reopened");
                                else toast.error(result.error.message);
                              }),
                          })
                        }
                      >
                        <RotateCcw />
                        Undo
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </Card>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { Input } from "@/components/ui/input";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Monogram } from "@/components/ui/monogram";
import { Money, formatCents } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { PopUpButton } from "@/components/ui/pop-up-button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { parseMoney } from "@/lib/money";
import { mediumDate } from "@/lib/ui/format";
import {
  abandonStatementReconciliation,
  completeStatementReconciliation,
  setLineCleared,
  startStatementReconciliation,
  undoStatementReconciliation,
} from "@/app/(app)/banking/actions";

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
    <PopUpButton
      aria-label="Statement month"
      appearance="toolbar"
      value={value}
      onValueChange={(month) => {
        const next = new URLSearchParams(params.toString());
        next.set("month", month);
        router.push(`${pathname}?${next.toString()}`);
      }}
      options={months.map((month) => ({ value: month, label: monthLabel(month) }))}
    />
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
  const field = "h-[26px] w-40 max-sm:h-11 max-sm:w-36";

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <Card className="flex flex-wrap items-center gap-3 px-5 py-4 max-sm:px-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-tint-blue text-white">
          <Glyph name="doc-text" size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Statement for {monthLabel(proposal.month)}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-medium text-label2">
            <span className="num">{proposal.transactionCount} rows</span>
            <span aria-hidden className="size-[3px] rounded-full bg-label3" />
            <span className="inline-flex items-center gap-1">
              Net <Money cents={proposal.netChangeCents} currency signed colorPositive plain={proposal.netChangeCents < 0} />
            </span>
            <span aria-hidden className="size-[3px] rounded-full bg-label3" />
            <span className="inline-flex items-center gap-1">
              Books <Money cents={proposal.ledgerBalanceCents} currency plain />
            </span>
          </p>
        </div>
        {proposal.basis === "no_data" ? null : proposal.chainOk ? (
          <Pill tone="green" glyph="check-circle">
            Chain ties
          </Pill>
        ) : (
          <Pill tone="red" glyph="xmark-circle">
            {proposal.breaks.length} break{proposal.breaks.length === 1 ? "" : "s"}
          </Pill>
        )}
        <InfoButton label="About the proposed statement">
          <p>
            {proposal.basis === "balance_chain"
              ? `Read from the running balance on ${proposal.transactionCount} imported rows. Check it against the statement PDF.`
              : proposal.basis === "carried_forward"
                ? "No transactions this month: the balance carries forward."
                : "No imported rows yet. Enter the balances from the statement."}
          </p>
        </InfoButton>
      </Card>

      {proposal.breaks.length > 0 ? (
        <ul className="flex flex-col gap-1 px-4 text-xs text-ink-red">
          {proposal.breaks.map((b) => (
            <li key={b.date}>
              {shortDate(b.date)}: rows add to <Money cents={b.expectedCents} currency plain />, bank printed{" "}
              <Money cents={b.actualCents} currency plain />. A statement row may be missing.
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-2">
        <InsetGroup header="Dates">
          <GroupRow label="Starts" htmlFor="recon-start">
            <DateInput id="recon-start" value={start} onValueChange={setStart} className={field} />
          </GroupRow>
          <GroupRow label="Ends" htmlFor="recon-end">
            <DateInput id="recon-end" value={end} onValueChange={setEnd} className={field} />
          </GroupRow>
        </InsetGroup>
        <InsetGroup header="Balances">
          <GroupRow label="Beginning" htmlFor="recon-opening">
            <Input
              id="recon-opening"
              numeric
              inputMode="decimal"
              className={field}
              value={opening}
              invalid={opening !== "" && openingCents === null}
              onChange={(event) => setOpening(event.target.value)}
            />
          </GroupRow>
          <GroupRow label="Ending" htmlFor="recon-closing">
            <Input
              id="recon-closing"
              numeric
              inputMode="decimal"
              className={field}
              value={closing}
              invalid={closing !== "" && closingCents === null}
              onChange={(event) => setClosing(event.target.value)}
            />
          </GroupRow>
        </InsetGroup>
      </div>

      <InsetGroup>
        <GroupRow label="Clear posted lines" htmlFor="recon-autoclear">
          <InfoButton label="About clearing posted lines">
            <p>Ticks every posted transaction dated inside the statement, so only the exceptions are left to untick.</p>
          </InfoButton>
          <Checkbox id="recon-autoclear" checked={autoClear} onCheckedChange={(value) => setAutoClear(value === true)} />
        </GroupRow>
      </InsetGroup>

      {postedInMonth === 0 ? (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <Pill tone="orange" glyph="tray">
            Nothing posted this month
          </Pill>
          <Button asChild size="sm" variant="link">
            <Link href="/banking/review">Review</Link>
          </Button>
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button
          className="max-md:flex-1"
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
          <Glyph name="reconcile" />
          Start reconciliation
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Working one
// ---------------------------------------------------------------------------

/**
 * The difference, drawn: a ring that fills as lines are ticked, the amount left in the middle. It
 * is orange while anything is left and turns green, with a tick, at exactly $0.00.
 */
function DifferenceRing({
  difference,
  cleared,
  total,
}: {
  difference: number;
  cleared: number;
  total: number;
}) {
  const tied = difference === 0;
  const size = 196;
  const stroke = 14;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const fraction = tied ? 1 : total === 0 ? 0 : Math.min(0.97, cleared / total);
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden className="absolute inset-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tied ? "var(--green)" : "var(--orange)"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(fraction * circumference).toFixed(1)} ${circumference.toFixed(1)}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-[stroke-dasharray,stroke] duration-200 ease-out motion-reduce:transition-none"
        />
      </svg>
      <div className="relative flex flex-col items-center" aria-live="polite">
        {tied ? <Glyph name="check" size={26} weight={2.6} className="mb-0.5 text-ink-green" /> : null}
        <Money
          cents={difference}
          currency
          plain
          className={cn("text-[2rem] leading-none font-bold tracking-[-0.03em]", tied ? "text-ink-green" : "text-ink-orange")}
        />
        <span className="mt-1 text-xs font-semibold text-label2">Difference</span>
      </div>
    </div>
  );
}

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
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <Card className="grid items-center gap-5 px-5 py-5 max-sm:px-4 md:grid-cols-[auto_minmax(0,1fr)]">
        <div className="justify-self-center">
          <DifferenceRing difference={difference} cleared={cleared.size} total={lines.length} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <dl className="grid rounded-[11px] bg-inset">
            <div className="flex h-10 items-center justify-between px-3">
              <dt className="font-medium text-label2">Statement</dt>
              <dd className="font-semibold">
                <Money cents={summary.closingBalanceCents} currency plain />
              </dd>
            </div>
            <div className="flex h-10 items-center justify-between hairline-t px-3">
              <dt className="font-medium text-label2">Cleared</dt>
              <dd className="font-semibold">
                <Money cents={clearedBalance} currency plain />
              </dd>
            </div>
            <div className="flex h-10 items-center justify-between hairline-t px-3">
              <dt className="font-medium text-label2">Ticked</dt>
              <dd className="num font-semibold">
                {cleared.size} <span className="font-medium text-label2">of {lines.length}</span>
              </dd>
            </div>
            <div className="flex h-10 items-center justify-between hairline-t px-3">
              <dt className="font-medium text-label2">Ends</dt>
              <dd className="font-semibold">{mediumDate(summary.statementDate)}</dd>
            </div>
          </dl>
          {summary.openingDifferenceCents !== 0 ? (
            <div className="flex items-center gap-1.5">
              <Pill tone="orange" glyph="warning">
                Opening off by <Money cents={summary.openingDifferenceCents} currency signed plain />
              </Pill>
              <InfoButton label="About the opening difference">
                <p>
                  The statement begins at <Money cents={summary.openingBalanceCents} currency plain /> but the reconciled
                  books begin at <Money cents={summary.previouslyClearedCents} currency plain />. An earlier month is
                  probably not reconciled yet.
                </p>
              </InfoButton>
            </div>
          ) : null}
          {canReconcile ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={!tied || pending}
                className="max-md:flex-1"
                onClick={() =>
                  startTransition(async () => {
                    const result = await completeStatementReconciliation(summary.id);
                    if (result.ok) toast.success(`Reconciled through ${summary.statementDate}`);
                    else toast.error(result.error.message);
                  })
                }
              >
                <Glyph name="lock" />
                {tied ? "Complete and lock" : "Difference must be $0.00"}
              </Button>
              <Button
                variant="danger-quiet"
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
                <Glyph name="trash" />
                Abandon
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-2">
        <LineColumn
          title="Not yet cleared"
          lines={unclearedLines}
          checked={false}
          disabled={!canReconcile || pending}
          onToggle={toggle}
        />
        <LineColumn title="Cleared" lines={clearedLines} checked disabled={!canReconcile || pending} onToggle={toggle} />
      </div>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function LineColumn({
  title,
  lines,
  checked,
  disabled,
  onToggle,
}: {
  title: string;
  lines: readonly ReconLineView[];
  checked: boolean;
  disabled: boolean;
  onToggle: (line: ReconLineView) => void;
}) {
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return (
    <InsetGroup
      header={
        <>
          {title} <span className="num font-medium">{lines.length}</span>
        </>
      }
      headerAccessory={<Money cents={total} currency signed colorPositive plain={total < 0} className="text-xs font-semibold" />}
      separatorInset={88}
    >
      {lines.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm font-medium text-label2">Nothing here</p>
      ) : (
        <ul className="max-h-[28rem] overflow-y-auto">
          {lines.map((line) => {
            const name = line.payee ?? line.memo ?? `Entry #${line.entryNo}`;
            return (
              <li
                key={line.journalLineId}
                className="relative before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[88px] before:border-t-[0.5px] before:border-sep first:before:hidden"
              >
                <label className="flex min-h-11 cursor-default items-center gap-3 px-4 py-2 transition-colors hover:bg-fill2">
                  <Checkbox checked={checked} disabled={disabled} onCheckedChange={() => onToggle(line)} />
                  <Monogram name={name} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold max-sm:text-[1rem] max-sm:font-medium">{name}</span>
                    <span className="block text-xs text-label2">{shortDate(line.date)}</span>
                  </span>
                  <Money cents={line.amountCents} currency signed colorPositive plain={line.amountCents < 0} className="font-semibold" />
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </InsetGroup>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function ReconHistory({ rows, canUndo }: { rows: readonly ReconHistoryRow[]; canUndo: boolean }) {
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const [pending, startTransition] = React.useTransition();
  return (
    <InsetGroup header="History" separatorInset={52}>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm font-medium text-label2">Never reconciled</p>
      ) : (
        rows.map((row) => (
          <div
            key={row.id}
            className="relative flex min-h-[52px] items-center gap-3 px-4 py-2 before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[52px] before:border-t-[0.5px] before:border-sep first:before:hidden"
          >
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-[7px] text-white",
                row.status === "completed" ? "bg-tint-green" : "bg-tint-orange",
              )}
              aria-hidden
            >
              <Glyph name={row.status === "completed" ? "lock" : "clock"} size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {shortDate(row.statementStartDate)} – {mediumDate(row.statementDate)}
              </span>
              <span className="block truncate text-xs text-label2">
                {row.status === "completed" ? "Reconciled" : "In progress"}
                {row.completedAt === null ? "" : ` · ${row.completedAt}${row.completedBy ? ` · ${row.completedBy}` : ""}`}
              </span>
            </span>
            <Money cents={row.closingBalanceCents} currency plain className="font-semibold" />
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
                        Reopen the reconciliation to {row.statementDate}. Its transactions unlock and can be changed
                        again; figures already reported from this month may move.
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
                <Glyph name="undo" />
                Undo
              </Button>
            ) : null}
          </div>
        ))
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </InsetGroup>
  );
}

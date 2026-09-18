import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Money, formatCents } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import {
  DEDUCTION_STATUS_LABEL,
  DEDUCTION_STATUS_TONE,
  PROMO_STATUS_TONE,
  TREATMENT_LABEL,
  shortDate,
} from "./labels";
import type { DeadlineAlert, EntryView, RemittanceSplit } from "./types";

export { Callout, Fact, Table, TableScroll, Td, Th } from "@/components/inventory/table";
import { Table, TableScroll, Td, Th } from "@/components/inventory/table";

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function DeductionStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={DEDUCTION_STATUS_TONE[status] ?? "neutral"} size="sm">
      {DEDUCTION_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function TreatmentBadge({ treatment }: { treatment: string }) {
  const tone = treatment === "suspense" ? "warning" : treatment === "dispute" ? "info" : "neutral";
  return (
    <Badge tone={tone} size="sm">
      {TREATMENT_LABEL[treatment] ?? treatment}
    </Badge>
  );
}

export function PromoStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={PROMO_STATUS_TONE[status] ?? "neutral"} size="sm">
      {status}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// The dispute window
// ---------------------------------------------------------------------------

const ALERT_FILL: Record<DeadlineAlert, string> = {
  none: "bg-border-strong",
  alert: "bg-warning",
  escalate: "bg-negative",
  expired: "bg-negative",
};

/**
 * How much of a deduction's dispute window is gone. The ticks sit where the workbench alerts
 * (60 %) and escalates (80 %); past the end the bar is full and the deadline reads as missed.
 */
export function DeadlineMeter({
  deadline,
  daysToDeadline,
  burn,
  alert,
  className,
}: {
  deadline: string | null;
  daysToDeadline: number | null;
  burn: number | null;
  alert: DeadlineAlert;
  className?: string;
}) {
  if (deadline === null || burn === null) {
    return <span className={cn("text-xs text-muted-foreground", className)}>No window</span>;
  }
  const width = Math.min(1, Math.max(0, burn)) * 100;
  const left = daysToDeadline ?? 0;
  return (
    <div className={cn("flex min-w-28 flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="num text-foreground">{shortDate(deadline)}</span>
        <span className={cn("num text-2xs", alert === "none" ? "text-muted-foreground" : alert === "alert" ? "text-warning" : "text-negative")}>
          {left < 0 ? `${-left}d late` : left === 0 ? "today" : `${left}d left`}
        </span>
      </div>
      <div
        className="relative h-1 w-full rounded-full bg-muted"
        role="meter"
        aria-label="Dispute window used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
      >
        <div className={cn("absolute inset-y-0 left-0 rounded-full", ALERT_FILL[alert])} style={{ width: `${width}%` }} />
        <span aria-hidden className="absolute inset-y-[-2px] left-[60%] w-px bg-foreground/25" />
        <span aria-hidden className="absolute inset-y-[-2px] left-[80%] w-px bg-foreground/40" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// An entry, before it posts
// ---------------------------------------------------------------------------

/**
 * The journal entry an action will post, set as the ledger will hold it: debits and credits
 * either side of the gutter and a double rule under the totals. Shown before every posting on
 * these screens, so nobody approves a number without seeing where it lands.
 */
export function EntryTable({ entry, caption, className }: { entry: EntryView; caption?: string; className?: string }) {
  const debits = entry.lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = entry.lines.reduce((sum, l) => sum + l.creditCents, 0);
  const balanced = debits === credits;
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          <span className="num text-foreground">{entry.date}</span>
          {entry.memo ? <span> · {entry.memo}</span> : null}
        </p>
        <p className={cn("text-2xs font-semibold tracking-wide uppercase", balanced ? "text-positive" : "text-negative")}>
          {balanced ? "Balanced" : "Out of balance"}
        </p>
      </div>
      <TableScroll>
        <Table caption={caption ?? "Entry to be posted"} className="min-w-[20rem]">
          <thead>
            <tr>
              <Th>Account</Th>
              <Th align="right" className="w-28">
                Debit
              </Th>
              <Th align="right" className="rule-gutter w-28">
                Credit
              </Th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line, index) => (
              <tr key={`${line.accountCode}-${index}`} className="rule-row">
                <Td className={cn("min-w-48", line.creditCents > 0 && "pl-8")}>
                  <span className="num mr-2 text-muted-foreground">{line.accountCode}</span>
                  {line.accountName}
                  {line.memo ? <span className="block text-2xs leading-4 text-muted-foreground">{line.memo}</span> : null}
                </Td>
                <Td align="right">{line.debitCents > 0 ? <Money cents={line.debitCents} plain /> : null}</Td>
                <Td align="right" className="rule-gutter">
                  {line.creditCents > 0 ? <Money cents={line.creditCents} plain /> : null}
                </Td>
              </tr>
            ))}
            <tr>
              <Td className="rule-subtotal text-xs font-semibold text-muted-foreground">
                {entry.lines.length} lines
              </Td>
              <Td align="right" className="rule-subtotal rule-total font-semibold">
                <Money cents={debits} plain />
              </Td>
              <Td align="right" className="rule-subtotal rule-total rule-gutter font-semibold">
                <Money cents={credits} plain />
              </Td>
            </tr>
          </tbody>
        </Table>
      </TableScroll>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The split: where a distributor's short payment goes
// ---------------------------------------------------------------------------

interface Segment {
  key: string;
  label: string;
  account: string;
  cents: number;
  fill: string;
}

function Bar({ segments, total, label }: { segments: Segment[]; total: number; label: string }) {
  return (
    <div className="flex h-6 w-full overflow-hidden rounded-xs border border-border" role="img" aria-label={label}>
      {segments
        .filter((s) => s.cents > 0)
        .map((s) => (
          <div
            key={s.key}
            className={cn("h-full border-r border-surface last:border-r-0", s.fill)}
            style={{ width: `${total === 0 ? 0 : (s.cents / total) * 100}%` }}
            title={`${s.label}: ${formatCents(s.cents, { currency: true })}`}
          />
        ))}
    </div>
  );
}

/**
 * One payment's entry as two bars of equal length: what the debits are (cash, trade spend, the
 * claims parked in Deductions Receivable) against what they relieve (the invoices at full gross,
 * and any repayment of an earlier claim). Equal lengths are the entry balancing; the segments
 * are the answer to "where did the short-pay go".
 */
export function SplitLedger({
  split,
  depositLabel,
  contraLabel,
  className,
}: {
  split: RemittanceSplit;
  depositLabel: string;
  /** The contra-revenue accounts the entry actually uses, e.g. "4520, 4560". */
  contraLabel?: string;
  className?: string;
}) {
  const debit: Segment[] = [
    { key: "cash", label: "Cash", account: depositLabel, cents: split.cashCents, fill: "bg-positive/70" },
    { key: "accrual", label: "Trade spend · accrued", account: "2120 Accrued Trade Spend", cents: split.accrualCents, fill: "bg-primary/75" },
    { key: "contra", label: "Trade spend · contra revenue", account: contraLabel ?? "Contra revenue", cents: split.contraCents, fill: "bg-primary/40" },
    { key: "billing", label: "Billing correction", account: "40xx Gross sales", cents: split.billingCorrectionCents, fill: "bg-info/60" },
    { key: "receivable", label: "Deductions receivable", account: "1210 Deductions Receivable", cents: split.receivableCents, fill: "bg-warning/70" },
  ];
  const credit: Segment[] = [
    { key: "ar", label: "AR relieved at gross", account: "1200 Accounts Receivable", cents: split.arRelievedCents, fill: "bg-foreground/55" },
    { key: "repay", label: "Earlier claims repaid", account: "1210 Deductions Receivable", cents: split.repaymentCents, fill: "bg-info/45" },
  ];
  const debitTotal = debit.reduce((s, x) => s + x.cents, 0);
  const creditTotal = credit.reduce((s, x) => s + x.cents, 0);
  const total = Math.max(debitTotal, creditTotal);
  const rows = [...debit, ...credit].filter((s) => s.cents !== 0);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="grid grid-cols-[4.5rem_1fr] items-center gap-x-3 gap-y-1.5">
        <span className="eyebrow">Debits</span>
        <Bar segments={debit} total={total} label="Debit side of the entry" />
        <span className="eyebrow">Credits</span>
        <Bar segments={credit} total={total} label="Credit side of the entry" />
      </div>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {rows.map((s) => (
          <div key={`${s.key}-${s.account}`} className="flex items-baseline justify-between gap-3 rule-row py-1">
            <dt className="flex min-w-0 items-baseline gap-2 text-xs">
              <span aria-hidden className={cn("size-2 shrink-0 translate-y-px rounded-[1px]", s.fill)} />
              <span className="min-w-0">
                <span className="text-foreground">{s.label}</span>
                <span className="block truncate text-2xs text-muted-foreground">{s.account}</span>
              </span>
            </dt>
            <dd className="text-sm">
              <Money cents={s.cents} plain />
            </dd>
          </div>
        ))}
      </dl>
      {split.unappliedCents > 0 ? (
        <p className="text-xs text-warning">
          <Money cents={split.unappliedCents} plain /> of the cash matches no invoice in the books and stays on the customer as an unapplied credit.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function Field({
  label,
  htmlFor,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="flex items-baseline gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
        {required ? (
          <span aria-hidden className="text-negative normal-case">
            *
          </span>
        ) : null}
        {hint ? <span className="text-2xs font-normal tracking-normal normal-case opacity-80">{hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

/** A refusal list under a form: what the engine would not do, one line each. */
export function Refusals({ items, className }: { items: { key: string; label: string; message: string }[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1 rounded-md border border-warning/35 bg-warning/8 px-3 py-2", className)}>
      {items.map((item) => (
        <li key={item.key} className="text-xs text-muted-foreground">
          <span className="num mr-1.5 text-foreground">{item.label}</span>
          {item.message}
        </li>
      ))}
    </ul>
  );
}

import * as React from "react";
import Link from "next/link";

import { FlowDiagram, SplitBar } from "@/components/charts";
import type { FlowNode } from "@/components/charts";
import { Disclosure, EntryLines, entryFlow } from "@/components/channels/parts";
import { Glyph } from "@/components/ui/glyph";
import { LegendItem } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import { Pill, type PillTone } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";
import type { Tint } from "@/lib/ui/tints";

import { DEDUCTION_STATUS_LABEL, TREATMENT_LABEL, longDate, shortDate } from "./labels";
import type { DeadlineAlert, EntryView, RemittanceSplit } from "./types";

export { Disclosure, EntryLines, Table, Td, Th } from "@/components/channels/parts";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<string, PillTone> = {
  open: "orange",
  disputed: "blue",
  partially_recovered: "blue",
  validated: "neutral",
  recovered: "green",
  written_off: "red",
};

export const STATUS_TINT: Record<string, Tint> = {
  open: "orange",
  disputed: "blue",
  partially_recovered: "blue",
  validated: "gray",
  recovered: "green",
  written_off: "red",
};

export function DeductionStatusPill({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status] ?? "neutral"}>{DEDUCTION_STATUS_LABEL[status] ?? status}</Pill>;
}

export function TreatmentPill({ treatment }: { treatment: string }) {
  const tone: PillTone = treatment === "suspense" ? "orange" : treatment === "dispute" ? "blue" : "neutral";
  return <Pill tone={tone}>{TREATMENT_LABEL[treatment] ?? treatment}</Pill>;
}

const PROMO_TONE: Record<string, PillTone> = { planned: "neutral", active: "blue", completed: "green", cancelled: "red" };
export const PROMO_LABEL: Record<string, string> = { planned: "Planned", active: "Active", completed: "Completed", cancelled: "Cancelled" };

export function PromoStatusPill({ status }: { status: string }) {
  return <Pill tone={PROMO_TONE[status] ?? "neutral"}>{PROMO_LABEL[status] ?? status}</Pill>;
}

export const ALERT_TINT: Record<DeadlineAlert, Tint> = { none: "gray", alert: "orange", escalate: "red", expired: "red" };

// ---------------------------------------------------------------------------
// The dispute window
// ---------------------------------------------------------------------------

/**
 * How much of a deduction's dispute window is gone, as a short bar: ticks where the workbench
 * alerts (60%) and escalates (80%), the days left beside it.
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
    return <span className={cn("text-xs text-label2", className)}>No window</span>;
  }
  const width = Math.min(1, Math.max(0, burn)) * 100;
  const left = daysToDeadline ?? 0;
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className="relative block h-1.5 w-14 rounded-full bg-fill2"
        role="meter"
        aria-label={`Dispute window used, deadline ${longDate(deadline)}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
      >
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${width}%`, background: `var(--${ALERT_TINT[alert]})` }} />
        <span aria-hidden className="absolute -inset-y-0.5 left-[60%] w-px bg-label3" />
        <span aria-hidden className="absolute -inset-y-0.5 left-[80%] w-px bg-label3" />
      </span>
      <span className={cn("num text-xs font-semibold whitespace-nowrap", alert === "none" ? "text-label2" : alert === "alert" ? "text-ink-orange" : "text-ink-red")}>
        {left < 0 ? `${-left}d late` : left === 0 ? "Today" : `${left}d`}
      </span>
    </span>
  );
}

/**
 * One deduction's window on a line: taken, today, the deadline, with the alert (60%) and escalate
 * (80%) points marked. The filled part is the time already gone.
 */
export function WindowLine({
  taken,
  deadline,
  burn,
  alert,
  daysToDeadline,
}: {
  taken: string;
  deadline: string;
  burn: number | null;
  alert: DeadlineAlert;
  daysToDeadline: number | null;
}) {
  const used = Math.min(1, Math.max(0, burn ?? 0)) * 100;
  const tint = ALERT_TINT[alert];
  const left = daysToDeadline ?? 0;
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="sr-only">
        Taken {longDate(taken)}; dispute by {longDate(deadline)}; {left < 0 ? `${-left} days late` : `${left} days left`}.
      </figcaption>
      <div aria-hidden className="relative h-6">
        <span className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-fill2" />
        <span className="absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full" style={{ width: `${used}%`, background: `var(--${tint})` }} />
        {[60, 80].map((p) => (
          <span key={p} className="absolute top-0.5 bottom-0.5 w-px bg-label3" style={{ left: `${p}%` }} />
        ))}
        {burn !== null && burn < 1 ? (
          <span className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card shadow-ctl" style={{ left: `${used}%`, background: `var(--${tint === "gray" ? "blue" : tint})` }} />
        ) : null}
      </div>
      <div aria-hidden className="flex items-start justify-between gap-2 text-xs">
        <span>
          <span className="block font-semibold">{shortDate(taken)}</span>
          <span className="text-label2">Taken</span>
        </span>
        <span className={cn("text-center font-semibold", alert === "none" ? "text-label" : alert === "alert" ? "text-ink-orange" : "text-ink-red")}>
          <span className="num block text-lg leading-tight">{left < 0 ? -left : left}</span>
          <span className="text-2xs">{left < 0 ? "days late" : "days left"}</span>
        </span>
        <span className="text-right">
          <span className="block font-semibold">{shortDate(deadline)}</span>
          <span className="text-label2">Deadline</span>
        </span>
      </div>
    </figure>
  );
}

export interface TimelineItem {
  id: string;
  label: string;
  daysToDeadline: number;
  alert: DeadlineAlert;
  cents: number;
}

/**
 * Every open dispute window on one axis, today at the left: each deduction is a dot at its
 * deadline, coloured by how much of its window is gone. Missed deadlines gather in a "Late" well
 * before today. Dots link to the deduction.
 */
export function DeadlineTimeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  const horizon = Math.max(30, Math.ceil(Math.max(0, ...items.map((i) => i.daysToDeadline)) / 30) * 30);
  const ticks = Array.from({ length: horizon / 30 + 1 }, (_, i) => i * 30).filter((d, i, all) => all.length <= 7 || i % 2 === 0 || d === horizon);
  const late = items.filter((i) => i.daysToDeadline < 0);
  const upcoming = items.filter((i) => i.daysToDeadline >= 0).sort((a, b) => a.daysToDeadline - b.daysToDeadline);
  const max = Math.max(1, ...items.map((i) => i.cents));
  const size = (cents: number) => Math.round(9 + 9 * Math.sqrt(cents / max));
  // Stack dots that land within a few days of each other.
  const rows: number[] = [];
  const placed = upcoming.map((item) => {
    const x = (item.daysToDeadline / horizon) * 100;
    let row = 0;
    while (rows[row] !== undefined && x - rows[row] < 3.2) row += 1;
    rows[row] = x;
    return { item, x, row };
  });
  const height = Math.max(1, rows.length);

  return (
    <figure className={cn("flex flex-col gap-1.5", className)}>
      <figcaption className="sr-only">
        {items.length} open dispute windows. {late.length} past the deadline. Next:{" "}
        {upcoming[0] ? `${upcoming[0].label} in ${upcoming[0].daysToDeadline} days` : "none"}.
      </figcaption>
      <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-3">
        <div className="flex flex-col items-center justify-center gap-1 rounded-[10px] bg-tint-red/10 py-1.5" style={{ minHeight: 18 + height * 20 }}>
          <span className="num text-lg leading-none font-bold text-ink-red">{late.length}</span>
          <span className="text-2xs font-semibold text-ink-red">Late</span>
        </div>
        <div className="relative" style={{ height: 18 + height * 20 }}>
          <span aria-hidden className="absolute inset-x-0 bottom-[9px] border-t border-[var(--sep-strong)]" />
          <span aria-hidden className="absolute bottom-0 left-0 h-[18px] w-0.5 rounded-full bg-tint-blue" />
          {placed.map(({ item, x, row }) => {
            const s = size(item.cents);
            return (
              <Link
                key={item.id}
                href={`/trade/deductions/${item.id}`}
                aria-label={`${item.label}, ${item.daysToDeadline} days left, ${dollars(item.cents)}`}
                title={`${item.label} · ${item.daysToDeadline}d · ${dollars(item.cents)}`}
                className="absolute rounded-full outline-none ring-offset-2 ring-offset-card after:absolute after:-inset-2.5 after:content-[''] hover:scale-110 focus-visible:ring-2 focus-visible:ring-tint-blue"
                style={{
                  left: `${x}%`,
                  bottom: 9 + row * 20,
                  width: s,
                  height: s,
                  marginLeft: -s / 2,
                  marginBottom: -s / 2,
                  background: `var(--${ALERT_TINT[item.alert] === "gray" ? "blue" : ALERT_TINT[item.alert]})`,
                  boxShadow: "0 0 0 1.5px var(--card)",
                }}
              />
            );
          })}
        </div>
      </div>
      <div aria-hidden className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-3">
        <span />
        <div className="relative h-4">
          {ticks.map((d, i) => (
            <span
              key={d}
              className={cn(
                "absolute top-0 text-2xs font-medium whitespace-nowrap text-label2",
                d === 0 ? "" : d === horizon ? "-translate-x-full" : "-translate-x-1/2",
                i % 2 === 1 && d !== horizon && "max-sm:hidden",
              )}
              style={{ left: `${(d / horizon) * 100}%` }}
            >
              {d === 0 ? "Today" : `${d}d`}
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// An entry, before it posts
// ---------------------------------------------------------------------------

/**
 * The entry an action will post: drawn as a flow (credited account → debited accounts), with every
 * line one click away. Shown before every posting on these screens.
 */
export function EntryPreview({
  entry,
  fallbackFrom = { label: "Several accounts", glyph: "split", tint: "gray" },
  caption = "Entry to be posted",
  className,
}: {
  entry: EntryView;
  fallbackFrom?: FlowNode;
  caption?: string;
  className?: string;
}) {
  const flow = entryFlow(entry.lines, fallbackFrom);
  return (
    <div className={cn("overflow-hidden rounded-[14px] bg-card shadow-card", className)}>
      {flow.to.length > 0 ? (
        <div className="px-5 pt-[18px] pb-3 max-sm:px-4">
          <FlowDiagram from={flow.from} to={flow.to} fromCaption={flow.creditCount > 1 ? `Credit · ${flow.creditCount} accounts` : "Credit"} />
        </div>
      ) : null}
      <div className="hairline-t">
        <Disclosure
          summary={
            <>
              Lines<span className="font-normal text-label2">· {entry.lines.length}</span>
            </>
          }
        >
          <div className="pb-2">
            <p className="px-5 pb-2 text-xs text-label2 max-sm:px-4">
              <span className="num">{entry.date}</span>
              {entry.memo ? ` · ${entry.memo}` : ""}
            </p>
            <EntryLines lines={entry.lines} caption={caption} />
          </div>
        </Disclosure>
      </div>
    </div>
  );
}

/** Where a preview would be when there is no entry: a quiet well with one line. */
export function NoEntry({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "red" }) {
  return (
    <div className={cn("flex items-center gap-2.5 rounded-[14px] px-4 py-3.5 text-sm", tone === "red" ? "bg-tint-red/10 text-ink-red" : "bg-fill2 text-label2")}>
      <Glyph name={tone === "red" ? "warning" : "info"} size={16} className="shrink-0" />
      <span className="min-w-0">{children}</span>
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
  tint: Tint;
}

/**
 * One payment's entry as two bars of equal length: what the debits are (cash, trade spend, the
 * claims parked in Deductions Receivable) above what they relieve (the invoices at full gross, and
 * any repayment of an earlier claim). Equal lengths are the entry balancing; the segments answer
 * "where did the short-pay go".
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
  const paid: Segment[] = [
    { key: "cash", label: "Cash", account: depositLabel, cents: split.cashCents, tint: "blue" },
    { key: "accrual", label: "Trade · accrued", account: "2120 Accrued Trade Spend", cents: split.accrualCents, tint: "cyan" },
    { key: "contra", label: "Trade spend", account: contraLabel || "Contra revenue", cents: split.contraCents, tint: "teal" },
    { key: "billing", label: "Billing fix", account: "Gross sales", cents: split.billingCorrectionCents, tint: "gray" },
    { key: "receivable", label: "Deductions", account: "1210 Deductions Receivable", cents: split.receivableCents, tint: "orange" },
  ];
  const relieved: Segment[] = [
    { key: "ar", label: "AR relieved", account: "1200 Accounts Receivable", cents: split.arRelievedCents, tint: "green" },
    { key: "repay", label: "Repaid claims", account: "1210 Deductions Receivable", cents: split.repaymentCents, tint: "mint" },
  ];
  const paidTotal = paid.reduce((s, x) => s + x.cents, 0);
  const relievedTotal = relieved.reduce((s, x) => s + x.cents, 0);
  const total = Math.max(1, paidTotal, relievedTotal);
  const bar = (segments: Segment[], sum: number, label: string) => (
    <div style={{ width: `${(sum / total) * 100}%` }}>
      <SplitBar
        className="h-3 [&>i]:rounded-[5px]"
        label={`${label}: ${segments.filter((s) => s.cents > 0).map((s) => `${s.label} ${dollars(s.cents)}`).join(", ")}`}
        segments={segments.map((s) => ({ label: s.label, value: s.cents, tint: s.tint }))}
      />
    </div>
  );
  const shown = [...paid, ...relieved].filter((s) => s.cents !== 0);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        <span className="text-xs font-semibold text-label2">Paid as</span>
        {bar(paid, paidTotal, "Paid as")}
        <span className="text-xs font-semibold text-label2">Relieves</span>
        {bar(relieved, relievedTotal, "Relieves")}
      </div>
      <ul className="grid gap-x-6 gap-y-0 sm:grid-cols-2">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3 hairline-b py-1.5">
            <span className="min-w-0">
              <LegendItem tint={s.tint}>
                <span className="font-semibold text-label">{s.label}</span>
              </LegendItem>
              <span className="block truncate pl-[15px] text-2xs text-label2">{s.account}</span>
            </span>
            <Money cents={s.cents} currency plain className="text-sm font-semibold" />
          </li>
        ))}
      </ul>
      {split.unappliedCents > 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-ink-orange">
          <Glyph name="warning" size={13} />
          <Money cents={split.unappliedCents} currency plain /> unapplied credit
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/** A form field: a small label above its control, System Settings weight. */
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
      <label htmlFor={htmlFor} className="flex items-baseline gap-1.5 px-0.5 text-xs font-semibold text-label2">
        {label}
        {required ? (
          <span aria-hidden className="text-ink-red">
            *
          </span>
        ) : null}
        {hint ? <span className="font-normal">{hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

/** A refusal list under a form: what the engine would not do, one line each. */
export function Refusals({ items, className }: { items: { key: string; label: string; message: string }[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1 rounded-[12px] bg-tint-orange/10 px-3.5 py-2.5", className)}>
      {items.map((item) => (
        <li key={item.key} className="text-xs">
          <span className="num mr-1.5 font-semibold">{item.label}</span>
          <span className="text-label2">{item.message}</span>
        </li>
      ))}
    </ul>
  );
}

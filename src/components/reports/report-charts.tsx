import * as React from "react";

import { DivergingBars, Responsive, type DivergingColumn } from "@/components/charts";
import { axisText, zeroLine } from "@/components/charts/chart-text";
import { BalanceGauge } from "@/components/ledger/balance-gauge";
import { Glyph } from "@/components/ui/glyph";
import { Dot, LegendItem } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import type { Report } from "@/lib/reports/types";
import { categoryForCode } from "@/lib/ui/categories";
import { dollars, wholeDollars } from "@/lib/ui/format";
import { linear, round1 } from "@/lib/ui/scale";

/** The one card every report opens with: a headline, a legend or figure, and the graphic. */
export function SummaryCard({
  title,
  figure,
  legend,
  children,
}: {
  title: string;
  figure?: React.ReactNode;
  legend?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-card px-5 pt-4 pb-4 shadow-card max-sm:rounded-[22px] max-sm:px-4">
      <header className="mb-3 flex flex-wrap items-start gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-label2">{title}</h2>
          {figure ? <div className="num mt-0.5 text-3xl leading-tight font-bold tracking-[-0.028em] max-sm:text-2xl">{figure}</div> : null}
        </div>
        {legend ? <div className="flex flex-wrap items-center gap-3 pt-0.5">{legend}</div> : null}
      </header>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ P&L */

export interface PnlMonth {
  /** "Jan" */
  label: string;
  /** "January 2026" */
  name: string;
  revenueCents: number;
  expenseCents: number;
}

/** P&L: revenue above the line, everything it cost below, month by month. */
export function PnlSummary({ months, netIncomeCents }: { months: readonly PnlMonth[]; netIncomeCents: number }) {
  const columns = (compact: boolean): DivergingColumn[] =>
    months.map((m) => ({
      label: compact ? m.label.slice(0, 1) : m.label,
      name: m.name,
      up: { revenue: Math.max(0, m.revenueCents) },
      down: { expense: Math.max(0, m.expenseCents) },
    }));
  const up = [{ key: "revenue", label: "Revenue", tint: "green" as const }];
  const down = [{ key: "expense", label: "Expense", tint: "red" as const }];
  return (
    <SummaryCard
      title="Net income"
      figure={<Money cents={netIncomeCents} currency className={netIncomeCents < 0 ? "text-ink-red" : undefined} plain={netIncomeCents >= 0} />}
      legend={
        <>
          <LegendItem tint="green">Revenue</LegendItem>
          <LegendItem tint="red">Expense</LegendItem>
        </>
      }
    >
      <Responsive
        desktop={<DivergingBars columns={columns(false)} upSeries={up} downSeries={down} width={1080} stepHeight={32} title="Revenue and expense by month" />}
        phone={<DivergingBars columns={columns(true)} upSeries={up} downSeries={down} width={342} compact title="Revenue and expense by month" />}
      />
    </SummaryCard>
  );
}

/* -------------------------------------------------------- balance sheet */

function Bar({ segments, max, label }: { segments: Array<{ key: string; cents: number; tint: string }>; max: number; label: string }) {
  return (
    <div role="img" aria-label={label} className="flex h-7 w-full gap-0.5 overflow-hidden rounded-[7px] bg-fill2">
      {segments
        .filter((s) => s.cents > 0)
        .map((s) => (
          <i key={s.key} className="block h-full min-w-1" style={{ width: `${(s.cents / max) * 100}%`, background: `var(--${s.tint})` }} />
        ))}
    </div>
  );
}

/** Balance sheet: assets against liabilities plus equity, as two bars that end at the same place. */
export function BalanceSummary({
  assetsCents,
  liabilitiesCents,
  equityCents,
}: {
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
}) {
  const right = liabilitiesCents + equityCents;
  const balanced = assetsCents === right;
  const max = Math.max(Math.abs(assetsCents), Math.abs(liabilitiesCents) + Math.abs(equityCents), 1);
  return (
    <SummaryCard
      title="Assets"
      figure={<Money cents={assetsCents} currency plain />}
      legend={
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
            balanced ? "bg-tint-green/12 text-ink-green" : "bg-tint-red/12 text-ink-red",
          )}
        >
          <Glyph name={balanced ? "check" : "warning"} size={13} weight={2.2} />
          {balanced ? "Balanced" : "Out of balance"}
        </span>
      }
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        <span className="text-xs font-medium text-label2">Assets</span>
        <Bar label={`Assets ${dollars(assetsCents)}`} max={max} segments={[{ key: "assets", cents: Math.abs(assetsCents), tint: "blue" }]} />
        <span className="text-xs font-medium text-label2">Owed + owned</span>
        <Bar
          label={`Liabilities ${dollars(liabilitiesCents)}, equity ${dollars(equityCents)}`}
          max={max}
          segments={[
            { key: "liabilities", cents: Math.abs(liabilitiesCents), tint: "red" },
            { key: "equity", cents: Math.abs(equityCents), tint: "indigo" },
          ]}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs font-medium text-label2">
        <span className="inline-flex items-center gap-1.5"><Dot tint="blue" /> Assets <Money cents={assetsCents} currency plain className="text-label" /></span>
        <span className="inline-flex items-center gap-1.5"><Dot tint="red" /> Liabilities <Money cents={liabilitiesCents} currency plain className="text-label" /></span>
        <span className="inline-flex items-center gap-1.5"><Dot tint="indigo" /> Equity <Money cents={equityCents} currency plain className="text-label" /></span>
      </div>
    </SummaryCard>
  );
}

/* ------------------------------------------------------------ cash flow */

interface Step {
  label: string;
  name: string;
  cents: number;
  kind: "total" | "delta";
}

function Waterfall({ steps, width, compact }: { steps: readonly Step[]; width: number; compact: boolean }) {
  // Running level after each step; totals stand on zero.
  const bars = steps.reduce<Array<Step & { from: number; to: number }>>((out, step) => {
    const level = out.length === 0 ? 0 : out[out.length - 1].to;
    out.push(step.kind === "total" ? { ...step, from: 0, to: step.cents } : { ...step, from: level, to: level + step.cents });
    return out;
  }, []);
  const lo = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)));
  const hi = Math.max(0, ...bars.map((b) => Math.max(b.from, b.to)), 1);
  const padTop = 20;
  const plotH = compact ? 120 : 150;
  const height = padTop + plotH + 24;
  const y = linear(lo, hi, padTop + plotH, padTop);
  const band = (width - 8) / bars.length;
  const bw = Math.min(compact ? 34 : 64, band * 0.62);
  const describe = steps.map((s) => `${s.name} ${dollars(s.cents)}`).join(", ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cash flow waterfall" className="block h-auto w-full overflow-visible">
      <desc>{describe}</desc>
      <line x1={4} x2={width - 4} y1={round1(y(0))} y2={round1(y(0))} {...zeroLine} />
      {bars.map((b, i) => {
        const x = round1(4 + band * i + (band - bw) / 2);
        const top = round1(Math.min(y(b.from), y(b.to)));
        const h = Math.max(1.5, round1(Math.abs(y(b.from) - y(b.to))));
        const fill = b.kind === "total" ? "var(--blue)" : b.cents >= 0 ? "var(--green)" : "var(--red)";
        const next = bars[i + 1];
        return (
          <g key={b.name}>
            <rect x={x} y={top} width={round1(bw)} height={h} rx={4} fill={fill} opacity={b.kind === "total" ? 1 : 0.88} />
            {next ? (
              <line
                x1={round1(x + bw)}
                x2={round1(x + band)}
                y1={round1(y(b.to))}
                y2={round1(y(b.to))}
                stroke="var(--label3)"
                strokeWidth={0.8}
                strokeDasharray="2 2"
              />
            ) : null}
            <text x={round1(x + bw / 2)} y={top - 6} textAnchor="middle" {...axisText} fontWeight={600} fill="var(--label)">
              {b.kind === "delta" && b.cents > 0 ? "+" : ""}
              {wholeDollars(b.cents)}
            </text>
            <text x={round1(x + bw / 2)} y={height - 6} textAnchor="middle" {...axisText}>
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Cash flow: where the period's cash went, from the opening balance to the closing one. */
export function CashFlowSummary({
  beginningCents,
  operatingCents,
  investingCents,
  financingCents,
  endingCents,
}: {
  beginningCents: number;
  operatingCents: number;
  investingCents: number;
  financingCents: number;
  endingCents: number;
}) {
  const steps = (compact: boolean): Step[] => [
    { label: compact ? "Start" : "Start", name: "Cash at start", cents: beginningCents, kind: "total" },
    { label: compact ? "Ops" : "Operating", name: "Operating", cents: operatingCents, kind: "delta" },
    { label: compact ? "Inv" : "Investing", name: "Investing", cents: investingCents, kind: "delta" },
    { label: compact ? "Fin" : "Financing", name: "Financing", cents: financingCents, kind: "delta" },
    { label: "End", name: "Cash at end", cents: endingCents, kind: "total" },
  ];
  return (
    <SummaryCard
      title="Cash at end"
      figure={<Money cents={endingCents} currency plain />}
      legend={
        <>
          <LegendItem tint="green">In</LegendItem>
          <LegendItem tint="red">Out</LegendItem>
          <LegendItem tint="blue">Balance</LegendItem>
        </>
      }
    >
      <Responsive
        desktop={<Waterfall steps={steps(false)} width={1080} compact={false} />}
        phone={<Waterfall steps={steps(true)} width={342} compact />}
      />
    </SummaryCard>
  );
}

/* -------------------------------------------------------- trial balance */

/** Trial balance: debits against credits, with the check when they tie. */
export function TrialBalanceSummary({ debitCents, creditCents }: { debitCents: number; creditCents: number }) {
  const tied = debitCents === creditCents;
  return (
    <SummaryCard
      title={tied ? "Debits = credits" : "Debits ≠ credits"}
      figure={<Money cents={debitCents} currency plain />}
    >
      <BalanceGauge debitCents={debitCents} creditCents={creditCents} className="max-w-[560px]" />
    </SummaryCard>
  );
}

/** The debit and credit totals of a trial balance report, from its total row. */
export function trialBalanceTotals(report: Report): { debitCents: number; creditCents: number } {
  const total = report.rows.find((row) => row.id === "tb:total");
  const debitIndex = report.columns.findIndex((c) => c.key === "debit");
  const creditIndex = report.columns.findIndex((c) => c.key === "credit");
  return {
    debitCents: total?.values[debitIndex] ?? 0,
    creditCents: total?.values[creditIndex] ?? 0,
  };
}

/* ------------------------------------------------------- general ledger */

export interface LedgerSeries {
  code: string;
  name: string;
  values: number[];
  closingCents: number;
  lineCount: number;
}

/** Each account's running balance through the register: opening, every line, closing. */
export function ledgerSeries(report: Report): LedgerSeries[] {
  const balance = report.columns.findIndex((c) => c.key === "balance");
  const out: LedgerSeries[] = [];
  let current: LedgerSeries | null = null;
  for (const row of report.rows) {
    if (row.style === "section" && row.code) {
      current = { code: row.code, name: row.label, values: [], closingCents: 0, lineCount: 0 };
      out.push(current);
      continue;
    }
    if (current === null || balance === -1) continue;
    if (row.id.endsWith(":opening")) current.values.push(row.values[balance] ?? 0);
    else if (row.id.endsWith(":closing")) {
      current.closingCents = row.values[balance] ?? 0;
      current.values.push(current.closingCents);
    } else if (row.style === "detail") {
      current.values.push(row.values[balance] ?? 0);
      current.lineCount += 1;
    }
  }
  return out;
}

function Sparkline({ values, tint, width = 240, height = 44 }: { values: readonly number[]; tint: string; width?: number; height?: number }) {
  const n = values.length;
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values, 1);
  const x = (i: number) => round1(n <= 1 ? width / 2 : (i / (n - 1)) * (width - 4) + 2);
  const y = linear(lo, hi, height - 3, 3);
  const points = values.map((v, i) => `${x(i)},${round1(y(v))}`).join(" ");
  const area = `${x(0)},${round1(y(0))} ${points} ${x(n - 1)},${round1(y(0))}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden className="block h-auto w-full overflow-visible">
      <line x1={0} x2={width} y1={round1(y(0))} y2={round1(y(0))} {...zeroLine} strokeDasharray="2 3" />
      <polygon points={area} fill={`var(--${tint})`} opacity={0.12} />
      <polyline points={points} fill="none" stroke={`var(--${tint})`} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
      {n > 0 ? <circle cx={x(n - 1)} cy={round1(y(values[n - 1]))} r={2.8} fill={`var(--${tint})`} /> : null}
    </svg>
  );
}

/** General ledger: each account's running balance as a sparkline, busiest accounts first. */
export function GeneralLedgerSummary({ series }: { series: readonly LedgerSeries[] }) {
  const shown = [...series].sort((a, b) => b.lineCount - a.lineCount).slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <section
      className={cn(
        "grid gap-3.5 max-md:gap-3",
        shown.length === 1 ? "grid-cols-1" : "sm:grid-cols-2 xl:grid-cols-4",
      )}
    >
      {shown.map((s) => {
        const category = categoryForCode(s.code);
        return (
          <div key={s.code} className="flex min-w-0 flex-col gap-2 rounded-2xl bg-card px-[18px] py-4 shadow-card max-sm:rounded-[22px]">
            <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              <Dot tint={category.tint} />
              <span className="truncate">{s.name}</span>
              <span className="num ml-auto shrink-0 text-xs font-medium text-label2">{s.lineCount}</span>
            </p>
            <Money cents={s.closingCents} currency plain className="text-2xl leading-tight font-bold tracking-[-0.028em]" />
            <div role="img" aria-label={`${s.name} running balance: ${s.values.map((v) => dollars(v)).join(", ")}`}>
              <Sparkline values={s.values} tint={category.tint} width={shown.length === 1 ? 720 : 240} height={shown.length === 1 ? 70 : 44} />
            </div>
          </div>
        );
      })}
    </section>
  );
}

import * as React from "react";

import { Dot } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { dollars, shortDate } from "@/lib/ui/format";

import { StackBar, type StackSegment } from "./stack-bar";
import { Table, TableScroll, Td, Th } from "./table";
import { STAGE_STYLE, type StageKey } from "./types";

export interface StageTableRow {
  stage: StageKey;
  label: string;
  accountCode: string;
  accountName: string;
  ledgerCents: number;
  snapshotCents: number | null;
  varianceCents: number | null;
}

export interface StageTableProps {
  rows: readonly StageTableRow[];
  reserveCents: number;
  snapshotDate: string | null;
  asOf: string;
}

const ROW = "[&>td]:rule-row";

/**
 * The ledger's inventory against Peasy's count, drawn as two stacked bars on one scale: raw
 * ingredients, packaging and finished goods in their own colours, and what the bank review queue
 * will add hatched on the end of the ledger bar. Before the first count the Peasy bar is empty.
 *
 * A stage in credit (materials relieved before their purchases were approved) cannot be a length
 * on a bar that starts at zero, so the bars diverge: a zero baseline, credit stages drawn in red to
 * its left, debit stages to its right. A negative total never looks like a healthy full bar.
 */
export function StageComparison({
  rows,
  snapshotDate,
  pendingCents = 0,
}: {
  rows: readonly StageTableRow[];
  snapshotDate: string | null;
  /** Inventory purchases still in the bank review queue. */
  pendingCents?: number;
}) {
  const ledger: StackSegment[] = rows.map((r) => ({
    key: r.stage,
    label: r.label,
    cents: Math.max(0, r.ledgerCents),
    tint: STAGE_STYLE[r.stage].tint,
  }));
  if (pendingCents > 0) ledger.push({ key: "pending", label: "In review", cents: pendingCents, tint: "gray", pending: true });
  const credits = rows.filter((r) => r.ledgerCents < 0);
  const creditTotal = credits.reduce((s, r) => s - r.ledgerCents, 0);
  const counted: StackSegment[] = rows.map((r) => ({
    key: r.stage,
    label: r.label,
    cents: Math.max(0, r.snapshotCents ?? 0),
    tint: STAGE_STYLE[r.stage].tint,
  }));
  const ledgerTotal = ledger.reduce((s, x) => s + x.cents, 0);
  const countedTotal = counted.reduce((s, x) => s + x.cents, 0);
  const scale = Math.max(ledgerTotal, countedTotal, 1);
  // The share of the width left of zero.
  const negativeShare = creditTotal === 0 ? 0 : creditTotal / (creditTotal + scale);
  const netLedger = rows.reduce((s, r) => s + r.ledgerCents, 0);

  const positive = (segments: StackSegment[], label: string) => (
    <StackBar label={label} segments={segments} scale={scale} className={negativeShare > 0 ? "rounded-l-none" : undefined} />
  );

  return (
    <div className="flex flex-col gap-3">
      <BarRow
        label="Ledger"
        total={<Money cents={netLedger} currency plain className={netLedger < 0 ? "text-ink-red" : undefined} />}
      >
        {negativeShare > 0 ? (
          <Diverging share={negativeShare} credits={credits} creditTotal={creditTotal}>
            {positive(ledger, "Ledger, debit stages")}
          </Diverging>
        ) : (
          positive(ledger, "Ledger")
        )}
      </BarRow>
      <BarRow
        label="Peasy"
        caption={snapshotDate ? shortDate(snapshotDate) : undefined}
        total={snapshotDate ? <Money cents={countedTotal} currency plain /> : <span className="text-label2">No count</span>}
      >
        <div style={{ paddingLeft: `${negativeShare * 100}%` }}>{positive(counted, "Peasy count")}</div>
      </BarRow>
      <ul aria-hidden className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5 text-xs font-medium text-label2">
        {rows.map((r) => (
          <li key={r.stage} className="inline-flex items-center gap-1.5">
            <Dot tint={r.ledgerCents < 0 ? "red" : STAGE_STYLE[r.stage].tint} size={7} />
            {r.label}
            {r.ledgerCents < 0 ? <span className="text-ink-red">credit</span> : null}
          </li>
        ))}
        {pendingCents > 0 ? (
          <li className="inline-flex items-center gap-1.5">
            <span className="size-[7px] rounded-full bg-[repeating-linear-gradient(135deg,var(--gray)_0_2px,transparent_2px_4px)] shadow-[inset_0_0_0_1px_var(--gray)]" />
            In review
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** Credit stages in red to the left of a zero baseline; the debit bar (children) to its right. */
function Diverging({
  share,
  credits,
  creditTotal,
  children,
}: {
  share: number;
  credits: readonly StageTableRow[];
  creditTotal: number;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex w-full items-center">
      <div
        role="img"
        aria-label={`Ledger, credit stages: ${credits.map((c) => `${c.label} ${dollars(c.ledgerCents)}`).join(", ")}`}
        className="flex h-[10px] shrink-0 justify-end gap-[2px] rounded-l-full bg-fill2"
        style={{ width: `${share * 100}%` }}
      >
        {credits.map((c) => (
          <i
            key={c.stage}
            className="block h-full min-w-[3px] bg-tint-red first:rounded-l-full"
            style={{ flex: `${-c.ledgerCents} 1 0%`, opacity: 0.55 + 0.45 * (-c.ledgerCents / creditTotal) }}
          />
        ))}
      </div>
      <span aria-hidden className="relative z-10 -my-1 h-[18px] w-[1.5px] shrink-0 rounded-full bg-label" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function BarRow({
  label,
  caption,
  total,
  children,
}: {
  label: string;
  caption?: string;
  total: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-y-1.5">
      <p className="text-sm leading-tight font-semibold">
        {label}
        {caption ? <span className="block text-2xs font-medium text-label2">{caption}</span> : null}
      </p>
      <div className="max-sm:order-last max-sm:col-span-2">{children}</div>
      <p className="text-right text-sm font-semibold">{total}</p>
    </div>
  );
}

/** Stage by stage in figures: the ledger, the count, and the difference. */
export function StageTable({ rows, reserveCents, snapshotDate, asOf }: StageTableProps) {
  const ledgerTotal = rows.reduce((sum, r) => sum + r.ledgerCents, 0);
  const snapshotTotal = snapshotDate === null ? null : rows.reduce((sum, r) => sum + (r.snapshotCents ?? 0), 0);
  const varianceTotal = snapshotDate === null ? null : rows.reduce((sum, r) => sum + (r.varianceCents ?? 0), 0);
  const dash = <span className="text-label2">—</span>;

  return (
    <TableScroll>
      <Table caption={`Inventory by stage, ledger on ${asOf}`} className="min-w-[30rem]">
        <thead>
          <tr>
            <Th>Stage</Th>
            <Th align="right">Ledger</Th>
            <Th align="right">Peasy</Th>
            <Th align="right">Variance</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.stage} className={ROW}>
              <Td>
                <span className="flex items-center gap-2">
                  <Dot tint={STAGE_STYLE[r.stage].tint} size={8} />
                  <span className="font-medium">{r.label}</span>
                  <span className="num text-xs text-label2">{r.accountCode}</span>
                </span>
              </Td>
              <Td align="right">
                <Money cents={r.ledgerCents} zeroDash plain />
              </Td>
              <Td align="right">{r.snapshotCents === null ? dash : <Money cents={r.snapshotCents} zeroDash plain />}</Td>
              <Td align="right">
                {r.varianceCents === null ? (
                  dash
                ) : (
                  <Money
                    cents={r.varianceCents}
                    zeroDash
                    signed
                    plain
                    className={r.varianceCents === 0 ? undefined : "font-semibold text-ink-orange"}
                  />
                )}
              </Td>
            </tr>
          ))}
          {reserveCents !== 0 ? (
            <tr className={cn(ROW, "text-label2")}>
              <Td>
                <span className="pl-4">Reserve</span> <span className="num text-xs">1390</span>
              </Td>
              <Td align="right">
                <Money cents={reserveCents} plain />
              </Td>
              <Td align="right" className="text-xs">
                —
              </Td>
              <Td />
            </tr>
          ) : null}
          <tr className="font-semibold">
            <Td>Total</Td>
            <Td align="right" className="rule-total">
              <Money cents={ledgerTotal + reserveCents} currency plain />
            </Td>
            <Td align="right" className="rule-total">
              {snapshotTotal === null ? dash : <Money cents={snapshotTotal} currency plain />}
            </Td>
            <Td align="right" className="rule-total">
              {varianceTotal === null ? (
                dash
              ) : (
                <Money
                  cents={varianceTotal}
                  signed
                  zeroDash
                  currency
                  plain
                  className={varianceTotal === 0 ? undefined : "text-ink-orange"}
                />
              )}
            </Td>
          </tr>
        </tbody>
      </Table>
    </TableScroll>
  );
}

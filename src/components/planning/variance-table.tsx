import type { ReactNode } from "react";
import Link from "next/link";

import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { formatBasisPoints } from "@/lib/reports/types";

import type { VarianceRow } from "./types";

/**
 * Budget against actual on the P&L spine, Numbers-style, with the variance drawn: a bar either side
 * of a centre line, green when it helps (more revenue or profit than planned, less cost) and red
 * when it hurts, sized against the largest account variance. The figures keep their arithmetic sign
 * (actual − budget) so every total is the difference of the columns above it.
 */
export function VarianceTable({ rows }: { rows: readonly VarianceRow[] }) {
  const max = Math.max(1, ...rows.filter((r) => r.style === "account").map((r) => Math.abs(r.varianceCents)));
  return (
    <div className="relative overflow-x-auto overscroll-x-contain">
      <table className="w-full min-w-2xl border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Budget versus actual</caption>
        <thead>
          <tr>
            <Th className="pl-5 text-left max-sm:pl-4">Line</Th>
            <Th>Actual</Th>
            <Th>Budget</Th>
            <Th className="w-40 text-center">
              <span className="sr-only">Variance, drawn</span>
            </Th>
            <Th>Variance</Th>
            <Th className="pr-5 max-sm:pr-4">%</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.style === "section") {
              return (
                <tr key={row.id}>
                  <th colSpan={6} scope="colgroup" className="px-5 pt-4 pb-1 text-left text-xs font-semibold text-label2 max-sm:px-4">
                    {row.label}
                  </th>
                </tr>
              );
            }
            const favourable = row.varianceCents === 0 ? null : (row.varianceCents > 0) === row.incomeLike;
            const tone = favourable === null ? "text-label2" : favourable ? "text-ink-green" : "text-ink-red";
            const ruled = row.style === "total" ? "rule-total" : row.style === "subtotal" ? "rule-subtotal" : "rule-row";
            const strong = row.style !== "account";
            const pct = Math.min(50, (Math.abs(row.varianceCents) / max) * 50);
            return (
              <tr key={row.id}>
                <th
                  scope="row"
                  className={cn(ruled, "py-2 pr-3 text-left font-medium", strong && "font-semibold", row.style === "total" && "font-bold")}
                  style={{ paddingLeft: `${1.25 + Math.max(row.level - 1, 0) * 1}rem` }}
                >
                  {row.code !== null ? <span className="num mr-2 text-xs font-normal text-label2">{row.code}</span> : null}
                  {row.drilldownHref !== null ? (
                    <Link href={row.drilldownHref} className="hover:underline">
                      {row.label}
                    </Link>
                  ) : (
                    row.label
                  )}
                </th>
                <td className={cn(ruled, "px-3 py-2 text-right", strong && "font-semibold")}>
                  <Money cents={row.actualCents} parens zeroDash plain />
                </td>
                <td className={cn(ruled, "px-3 py-2 text-right text-label2")}>
                  <Money cents={row.budgetCents} parens zeroDash plain />
                </td>
                <td className={cn(ruled, "px-3 py-2")}>
                  {row.style === "account" && favourable !== null ? (
                    <span aria-hidden className="relative block h-2 w-36">
                      <span className="absolute inset-y-[-3px] left-1/2 w-px bg-label3" />
                      <span
                        className={cn("absolute inset-y-0 rounded-[3px]", favourable ? "bg-tint-green" : "bg-tint-red")}
                        style={
                          row.varianceCents > 0
                            ? { left: "50%", width: `${Math.max(pct, 1.5)}%` }
                            : { right: "50%", width: `${Math.max(pct, 1.5)}%` }
                        }
                      />
                    </span>
                  ) : null}
                </td>
                <td className={cn(ruled, "px-3 py-2 text-right", tone, strong && "font-semibold")}>
                  <Money cents={row.varianceCents} signed zeroDash plain />
                </td>
                <td className={cn(ruled, "num py-2 pr-5 pl-3 text-right text-xs max-sm:pr-4", tone)}>
                  {row.budgetCents === 0 ? "—" : formatBasisPoints(row.variancePctBp, { sign: true })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <th scope="col" className={cn("rule-head px-3 pt-1 pb-1.5 text-right text-xs font-semibold whitespace-nowrap text-label2", className)}>
      {children}
    </th>
  );
}

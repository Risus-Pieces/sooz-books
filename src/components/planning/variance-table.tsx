import type { ReactNode } from "react";
import Link from "next/link";

import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { formatBasisPoints } from "@/lib/reports/types";

import type { VarianceRow } from "./types";

/**
 * Budget against actual on the P&L spine. The figures keep their arithmetic
 * sign (actual − budget) so every total is the difference of the columns above
 * it; the colour says whether the variance helps: more revenue or profit than
 * planned is favourable, more cost than planned is not.
 */
export function VarianceTable({ rows }: { rows: readonly VarianceRow[] }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-2xl border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Budget versus actual</caption>
        <thead>
          <tr>
            <Th className="text-left">Line</Th>
            <Th>Actual</Th>
            <Th>Budget</Th>
            <Th>Variance</Th>
            <Th>Var %</Th>
            <Th className="w-28">
              <span className="sr-only">Spent against budget</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.style === "section") {
              return (
                <tr key={row.id}>
                  <th
                    colSpan={6}
                    scope="colgroup"
                    className="px-3 pt-3 pb-1 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase"
                  >
                    {row.label}
                  </th>
                </tr>
              );
            }
            const favourable = row.varianceCents === 0 ? null : (row.varianceCents > 0) === row.incomeLike;
            const tone = favourable === null ? "text-muted-foreground" : favourable ? "text-positive" : "text-negative";
            const ruled = row.style === "total" ? "rule-total" : row.style === "subtotal" ? "rule-subtotal" : "rule-row";
            const strong = row.style !== "account";
            const used = row.budgetCents > 0 ? Math.round((row.actualCents * 100) / row.budgetCents) : null;
            return (
              <tr key={row.id} className={cn(row.style === "total" && "bg-muted/40")}>
                <th
                  scope="row"
                  className={cn(ruled, "px-3 py-1.5 text-left font-normal", strong && "font-semibold", row.style === "total" && "text-xs tracking-wide uppercase")}
                  style={{ paddingLeft: `${0.75 + Math.max(row.level - 1, 0) * 1}rem` }}
                >
                  {row.code !== null ? <span className="num mr-2 text-xs text-muted-foreground">{row.code}</span> : null}
                  {row.drilldownHref !== null ? (
                    <Link href={row.drilldownHref} className="hover:underline">
                      {row.label}
                    </Link>
                  ) : (
                    row.label
                  )}
                </th>
                <td className={cn(ruled, "px-3 py-1.5 text-right", strong && "font-semibold")}>
                  <Money cents={row.actualCents} parens zeroDash plain />
                </td>
                <td className={cn(ruled, "px-3 py-1.5 text-right text-muted-foreground")}>
                  <Money cents={row.budgetCents} parens zeroDash plain />
                </td>
                <td className={cn(ruled, "px-3 py-1.5 text-right", tone, strong && "font-semibold")}>
                  <Money cents={row.varianceCents} signed zeroDash plain />
                </td>
                <td className={cn(ruled, "num px-3 py-1.5 text-right text-xs", tone)}>
                  {row.budgetCents === 0 ? "—" : formatBasisPoints(row.variancePctBp, { sign: true })}
                </td>
                <td className={cn(ruled, "px-3 py-1.5")}>
                  {used === null || row.style !== "account" ? null : (
                    <span className="relative block h-1.5 w-24 rounded-xs bg-muted" title={`${used}% of budget`}>
                      <span
                        className={cn("absolute inset-y-0 left-0 rounded-xs", favourable === false ? "bg-negative" : "bg-primary")}
                        style={{ width: `${Math.min(used, 100)}%` }}
                      />
                    </span>
                  )}
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
    <th
      scope="col"
      className={cn(
        "rule-head bg-surface-sunken px-3 py-1.5 text-right text-2xs font-semibold tracking-wider text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </th>
  );
}

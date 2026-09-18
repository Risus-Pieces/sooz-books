import type { ReactNode } from "react";

import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { shortDate } from "@/lib/ui/format";

import type { ForecastWeekRow } from "./types";

/** 'YYYY-MM-DD' → "Sep 22". */
export function weekLabel(date: string): string {
  return shortDate(date);
}

interface Line {
  key: string;
  label: string;
  pick: (w: ForecastWeekRow) => number;
  sign: 1 | -1;
  style?: "opening" | "closing";
}

const LINES: readonly Line[] = [
  { key: "opening", label: "Opening", pick: (w) => w.openingCents, sign: 1, style: "opening" },
  { key: "ar", label: "Invoices due", pick: (w) => w.arInflowCents, sign: 1 },
  { key: "in", label: "Expected in", pick: (w) => w.itemInflowCents, sign: 1 },
  { key: "ap", label: "Bills due", pick: (w) => w.apOutflowCents, sign: -1 },
  { key: "out", label: "Expected out", pick: (w) => w.itemOutflowCents, sign: -1 },
  { key: "closing", label: "Closing", pick: (w) => w.closingCents, sign: 1, style: "closing" },
];

/**
 * Thirteen weeks across, the cash-flow lines down, Numbers-style: hairline rows, right-aligned
 * tabular figures, the closing line bold under a double rule. The line labels stay pinned while
 * the weeks scroll inside the card. Money in is green, money out red: direction is the point here.
 */
export function ForecastTable({ weeks }: { weeks: readonly ForecastWeekRow[] }) {
  return (
    <div className="relative overflow-x-auto overscroll-x-contain">
      <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Thirteen-week cash forecast</caption>
        <thead>
          <tr>
            <Th className="sticky left-0 z-10 bg-card pl-5 text-left max-sm:pl-4">Week of</Th>
            {weeks.map((w, i) => (
              <Th key={w.weekStart}>
                <span className="block text-label">{weekLabel(w.weekStart)}</span>
                <span className="num text-2xs font-medium">W{i + 1}</span>
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {LINES.map((line) => (
            <tr key={line.key}>
              <th
                scope="row"
                className={cn(
                  "sticky left-0 z-10 bg-card px-3 py-2 pl-5 text-left text-sm font-medium whitespace-nowrap max-sm:pl-4",
                  line.style === "closing" ? "font-bold" : "rule-row",
                  line.style === "opening" && "text-label2",
                )}
              >
                {line.label}
              </th>
              {weeks.map((w) => {
                const value = line.pick(w);
                return (
                  <td
                    key={w.weekStart}
                    className={cn(
                      "px-3 py-2 text-right last:pr-5 max-sm:last:pr-4",
                      line.style === "closing" ? "rule-total font-bold" : "rule-row",
                      line.style === "opening" && "text-label2",
                    )}
                  >
                    {line.style === undefined ? (
                      <Money
                        cents={value * line.sign}
                        zeroDash
                        plain={value === 0}
                        colorPositive={line.sign > 0}
                        className={value === 0 ? "text-label2" : undefined}
                      />
                    ) : (
                      <Money cents={value} parens plain={line.style === "opening"} />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <th scope="col" className={cn("rule-head px-3 pt-1 pb-1.5 text-right text-xs font-semibold whitespace-nowrap text-label2 last:pr-5", className)}>
      {children}
    </th>
  );
}

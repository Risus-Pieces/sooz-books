import type { ReactNode } from "react";

import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import type { ForecastWeekRow } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function weekLabel(date: string): string {
  const [, m, d] = date.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

interface Line {
  key: string;
  label: string;
  pick: (w: ForecastWeekRow) => number;
  sign: 1 | -1;
  style?: "opening" | "closing";
}

const LINES: readonly Line[] = [
  { key: "opening", label: "Opening cash", pick: (w) => w.openingCents, sign: 1, style: "opening" },
  { key: "ar", label: "Customer invoices due", pick: (w) => w.arInflowCents, sign: 1 },
  { key: "in", label: "Expected money in", pick: (w) => w.itemInflowCents, sign: 1 },
  { key: "ap", label: "Bills due", pick: (w) => w.apOutflowCents, sign: -1 },
  { key: "out", label: "Expected money out", pick: (w) => w.itemOutflowCents, sign: -1 },
  { key: "closing", label: "Closing cash", pick: (w) => w.closingCents, sign: 1, style: "closing" },
];

/**
 * Thirteen weeks across, the cash-flow lines down: a treasurer's spreadsheet.
 * The line labels stay pinned while the weeks scroll inside the card.
 */
export function ForecastTable({ weeks }: { weeks: readonly ForecastWeekRow[] }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Thirteen-week cash forecast</caption>
        <thead>
          <tr>
            <Th className="sticky left-0 z-10 text-left">Week of</Th>
            {weeks.map((w, i) => (
              <Th key={w.weekStart}>
                <span className="block text-foreground">{weekLabel(w.weekStart)}</span>
                <span className="num font-normal tracking-normal normal-case">W{i + 1}</span>
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
                  "sticky left-0 z-10 bg-surface px-3 py-1.5 text-left text-sm font-normal whitespace-nowrap",
                  line.style === "closing" ? "rule-total" : "rule-row",
                  line.style !== undefined && "font-semibold",
                  line.style === "closing" && "rule-subtotal",
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
                      "px-3 py-1.5 text-right",
                      line.style === "closing" ? "rule-total rule-subtotal font-semibold" : "rule-row",
                      line.style === "opening" && "text-muted-foreground",
                    )}
                  >
                    {line.style === undefined ? (
                      <Money cents={value * line.sign} zeroDash plain={value === 0} colorPositive={line.sign > 0} />
                    ) : (
                      <Money cents={value} parens />
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

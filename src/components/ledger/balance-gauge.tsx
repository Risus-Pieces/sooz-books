import * as React from "react";

import { Glyph } from "@/components/ui/glyph";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";

/**
 * The entry's balance as one graphic: debits grow left from the middle, credits grow right, and
 * the disc between them is a green check when they meet. Out of balance, the disc turns orange
 * and names the difference.
 */
export function BalanceGauge({
  debitCents,
  creditCents,
  className,
}: {
  debitCents: number;
  creditCents: number;
  className?: string;
}) {
  const max = Math.max(debitCents, creditCents, 1);
  const difference = debitCents - creditCents;
  const empty = debitCents === 0 && creditCents === 0;
  const balanced = difference === 0 && !empty;
  const state = empty ? "empty" : balanced ? "balanced" : "out";
  const spoken = empty
    ? "No amounts yet"
    : balanced
      ? `Balanced: debits and credits are both ${dollars(debitCents)}`
      : `Out of balance by ${dollars(Math.abs(difference))}: debits ${dollars(debitCents)}, credits ${dollars(creditCents)}`;

  return (
    <div role="img" aria-label={spoken} data-state={state} className={cn("flex min-w-0 items-center gap-3", className)}>
      <div className="shrink-0 text-right leading-tight">
        <p className="text-2xs font-medium text-label2">Debits</p>
        <Money cents={debitCents} currency plain className="text-sm font-semibold" />
      </div>
      <div aria-hidden className="flex min-w-0 flex-1 items-center">
        <div className="flex h-2 flex-1 justify-end rounded-l-full bg-fill2">
          <i
            className="block h-full rounded-l-full bg-tint-blue transition-[width] duration-200 ease-out"
            style={{ width: `${(debitCents / max) * 100}%` }}
          />
        </div>
        <span
          className={cn(
            "mx-1 grid size-7 shrink-0 place-items-center rounded-full text-white transition-colors duration-200",
            state === "balanced" && "bg-tint-green",
            state === "out" && "bg-tint-orange",
            state === "empty" && "bg-fill text-label2",
          )}
        >
          <Glyph name={state === "balanced" ? "check" : state === "out" ? "warning" : "minus"} size={14} weight={2.4} />
        </span>
        <div className="flex h-2 flex-1 rounded-r-full bg-fill2">
          <i
            className="block h-full rounded-r-full bg-tint-indigo transition-[width] duration-200 ease-out"
            style={{ width: `${(creditCents / max) * 100}%` }}
          />
        </div>
      </div>
      <div className="shrink-0 leading-tight">
        <p className="text-2xs font-medium text-label2">Credits</p>
        <Money cents={creditCents} currency plain className="text-sm font-semibold" />
      </div>
    </div>
  );
}

/** The one-line verdict under the gauge: "Balanced" or "Out $12.34". */
export function BalanceVerdict({ debitCents, creditCents }: { debitCents: number; creditCents: number }) {
  const difference = debitCents - creditCents;
  if (debitCents === 0 && creditCents === 0) return <span className="text-label2">No amounts</span>;
  if (difference === 0) return <span className="font-semibold text-ink-green">Balanced</span>;
  return (
    <span className="font-semibold text-ink-orange">
      Out <Money cents={Math.abs(difference)} currency plain />
    </span>
  );
}

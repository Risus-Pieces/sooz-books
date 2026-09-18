import Link from "next/link";

import type { CloseMonthOption } from "@/components/planning/types";
import { Glyph } from "@/components/ui/glyph";
import { cn } from "@/lib/cn";
import { monthShort } from "@/lib/ui/format";

/**
 * The months of the books as a strip of capsules: a closed month carries a green lock, the month
 * the books are in a dot, the chosen one the accent. Scrolls sideways on a phone.
 */
export function MonthStrip({ months, selected }: { months: readonly CloseMonthOption[]; selected: string }) {
  return (
    <nav aria-label="Month" className="-mx-5 overflow-x-auto px-5 max-md:-mx-4 max-md:px-4">
      <ol className="flex min-w-max items-center gap-1.5">
        {months.map((m, index) => {
          const active = m.key === selected;
          const closed = m.status === "closed";
          const showYear = index === 0 || m.month === 1;
          return (
            <li key={m.key} className="flex items-center gap-1.5">
              {showYear && index > 0 ? <span className="num px-1 text-2xs font-semibold text-label2">{m.year}</span> : null}
              <Link
                href={`/close?month=${m.key}`}
                aria-current={active ? "page" : undefined}
                aria-label={`${m.label}${closed ? ", closed" : ""}${m.current ? ", current month" : ""}`}
                className={cn(
                  "relative flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-tint-blue/60 max-sm:h-11 max-sm:px-3.5",
                  active ? "bg-accent-fill font-semibold text-white" : "bg-card text-label shadow-card hover:bg-fill2",
                )}
              >
                {showYear && index === 0 ? <span className={cn("num text-2xs", active ? "text-white/85" : "text-label2")}>{m.year}</span> : null}
                {monthShort(m.month)}
                {closed ? (
                  <Glyph name="lock" size={12} weight={2} className={active ? "text-white" : "text-ink-green"} />
                ) : null}
                {m.current ? (
                  <span aria-hidden className={cn("size-1.5 rounded-full", active ? "bg-white" : "bg-tint-blue")} />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

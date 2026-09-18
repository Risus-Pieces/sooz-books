import Link from "next/link";
import { Lock } from "lucide-react";

import { cn } from "@/lib/cn";

import type { CloseMonthOption } from "./types";

const ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The months of the books as index tabs on a rule: closed months carry a lock,
 * the selected one stands on the rule. Scrolls inside itself on a phone.
 */
export function MonthRail({
  months,
  selected,
  path,
}: {
  months: readonly CloseMonthOption[];
  selected: string;
  path: string;
}) {
  return (
    <nav aria-label="Month" className="rule-head relative -mx-1 overflow-x-auto px-1">
      <ol className="flex min-w-max items-end gap-1">
        {months.map((m, index) => {
          const active = m.key === selected;
          const showYear = index === 0 || m.month === 1;
          return (
            <li key={m.key}>
              <Link
                href={`${path}?month=${m.key}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex flex-col items-start border-b-2 px-2 pt-1 pb-1.5 text-sm transition-colors",
                  active
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="num h-3.5 text-2xs text-muted-foreground">{showYear ? m.year : ""}</span>
                <span className="flex items-center gap-1">
                  {ABBR[m.month - 1]}
                  {m.status === "closed" ? <Lock className="size-3 text-positive" aria-label="closed" /> : null}
                  {m.current ? <span className="size-1.5 rounded-full bg-info" aria-label="current month" /> : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

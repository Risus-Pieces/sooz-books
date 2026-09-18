import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

export interface RunwayFacts {
  asOf: string;
  cashCents: number;
  netBurnCents: number;
  monthlyBurnCents: number;
  windowDays: number;
  burnFrom: string;
  runwayDays: number | null;
  cashOutDate: string | null;
  financingInflowCents: number;
  suggestedCents: number;
  firstNegativeWeekStart: string | null;
  lowestClosingCents: number;
  lowestWeekStart: string;
  /** Dated flows (invoices, bills, forecast items) in the 13-week window. */
  forecastFlowCount: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

/** 11 days, 6 weeks, 4 months — in the unit a person would say it in. */
export function runwayPhrase(days: number): { count: number; unit: string } {
  if (days < 21) return { count: days, unit: days === 1 ? "day" : "days" };
  if (days < 120) return { count: Math.floor(days / 7), unit: "weeks" };
  return { count: Math.floor(days / 30), unit: "months" };
}

const HORIZON_WEEKS = 26;

/**
 * How long the cash lasts, said as a sentence first and drawn second: one cell a
 * week for half a year, filled for every week the cash covers at the trailing
 * burn, with the thirteen-week forecast horizon marked. Burn excludes the
 * founder's contributions, so the answer is "how long until more has to go in".
 */
export function RunwayCallout({ facts, compact = false }: { facts: RunwayFacts; compact?: boolean }) {
  const burning = facts.runwayDays !== null;
  const coveredWeeks = facts.runwayDays === null ? HORIZON_WEEKS : Math.min(Math.floor(facts.runwayDays / 7), HORIZON_WEEKS);
  const urgent = facts.runwayDays !== null && facts.runwayDays < 91;

  return (
    <div className={cn("flex flex-col gap-3", compact ? "" : "sm:flex-row sm:items-end sm:justify-between sm:gap-8")}>
      <div className="min-w-0">
        <p className="eyebrow">Runway at the trailing {facts.windowDays}-day burn</p>
        <p className={cn("mt-1 font-semibold tracking-tight text-foreground", compact ? "text-xl" : "text-3xl")}>
          {facts.runwayDays === null ? (
            "Not burning cash"
          ) : (
            <>
              <span className={cn("num", urgent && "text-negative")}>{runwayPhrase(facts.runwayDays).count}</span>{" "}
              <span className={cn(urgent && "text-negative")}>{runwayPhrase(facts.runwayDays).unit}</span>
              <span className="text-muted-foreground"> of cash</span>
            </>
          )}
        </p>
        <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted-foreground">
          {burning ? (
            <>
              <Money cents={facts.cashCents} currency plain className="text-foreground" /> in the bank, spending a net{" "}
              <Money cents={facts.monthlyBurnCents} currency plain className="text-foreground" /> a month since{" "}
              {shortDate(facts.burnFrom)}. At that rate it runs out around{" "}
              <span className="font-medium text-foreground">{facts.cashOutDate === null ? "—" : shortDate(facts.cashOutDate)}</span>.
            </>
          ) : (
            <>
              Operating money in has covered money out since {shortDate(facts.burnFrom)}. Cash is{" "}
              <Money cents={facts.cashCents} currency plain className="text-foreground" />.
            </>
          )}{" "}
          {facts.financingInflowCents > 0 ? (
            <>
              Over the same days the founder put in{" "}
              <Money cents={facts.financingInflowCents} currency plain className="text-foreground" />, which the burn
              leaves out.
            </>
          ) : null}{" "}
          {facts.suggestedCents > 0 ? (
            <>The spending is read from bank lines still in review, by their suggested accounts.</>
          ) : null}
        </p>
      </div>

      <div className={cn("shrink-0", compact ? "w-full" : "w-full sm:w-80")}>
        <div className="flex gap-px" aria-hidden>
          {Array.from({ length: HORIZON_WEEKS }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-5 flex-1 rounded-[1px]",
                i < coveredWeeks ? (urgent ? "bg-negative/70" : "bg-primary/70") : "bg-muted",
                i === 12 && "mr-1",
              )}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-2xs text-muted-foreground">
          <span>today</span>
          <span>13 weeks</span>
          <span>26 weeks</span>
        </div>
        {!compact ? (
          <p className="mt-2 text-2xs text-muted-foreground">
            {facts.forecastFlowCount === 0 ? (
              <>Nothing is entered for the next 13 weeks yet, so the forecast only carries today&apos;s cash forward.</>
            ) : facts.firstNegativeWeekStart === null ? (
              <>
                The 13-week forecast stays above zero; lowest{" "}
                <Money cents={facts.lowestClosingCents} currency plain /> in the week of {shortDate(facts.lowestWeekStart)}.
              </>
            ) : (
              <span className="text-negative">
                The 13-week forecast goes below zero in the week of {shortDate(facts.firstNegativeWeekStart)}.
              </span>
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}

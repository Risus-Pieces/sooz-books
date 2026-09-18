import { RunwayRing, runwayTint } from "@/components/charts";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { mediumDate, shortDate as monthDay } from "@/lib/ui/format";

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

/** 'YYYY-MM-DD' → "Sep 29, 2026". */
export function shortDate(date: string): string {
  return mediumDate(date);
}

/** 11 days, 6 weeks, 4 months — in the unit a person would say it in. */
export function runwayPhrase(days: number): { count: number; unit: string } {
  if (days < 21) return { count: days, unit: days === 1 ? "day" : "days" };
  if (days < 120) return { count: Math.floor(days / 7), unit: "weeks" };
  return { count: Math.floor(days / 30), unit: "months" };
}

/**
 * How long the cash lasts, drawn: the runway ring (green → orange → red as it shortens), then the
 * three facts behind it — the burn, the cash-out date, and the forecast's lowest week. Burn leaves
 * out the founder's contributions, so the answer is "how long until more has to go in". The
 * sentences live behind the ⓘ.
 */
export function RunwayCallout({ facts }: { facts: RunwayFacts }) {
  const tint = runwayTint(facts.runwayDays);
  const ink = tint === "green" ? "text-label" : tint === "red" ? "text-ink-red" : "text-ink-orange";
  return (
    <section className="flex h-full min-w-0 flex-col rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">Runway</h2>
        <InfoButton label="About runway">
          <p>
            {facts.runwayDays === null ? (
              <>Operating money in has covered money out since {shortDate(facts.burnFrom)}.</>
            ) : (
              <>
                Days of cash left if the last {facts.windowDays} days of operating spend continue: a net{" "}
                <Money cents={facts.monthlyBurnCents} currency plain /> a month since {shortDate(facts.burnFrom)}.
              </>
            )}
          </p>
          {facts.financingInflowCents > 0 ? (
            <p>
              The founder put in <Money cents={facts.financingInflowCents} currency plain /> over the same days, which the
              burn leaves out.
            </p>
          ) : null}
          {facts.suggestedCents > 0 ? <p>The spending is read from bank lines still in review, by their suggested accounts.</p> : null}
          <p>
            {facts.forecastFlowCount === 0
              ? "Nothing is entered for the next 13 weeks yet, so the forecast only carries today’s cash forward."
              : facts.firstNegativeWeekStart === null
                ? "The 13-week forecast stays above zero."
                : `The 13-week forecast goes below zero in the week of ${shortDate(facts.firstNegativeWeekStart)}.`}
          </p>
        </InfoButton>
      </div>
      <RunwayRing days={facts.runwayDays} className="mx-auto mt-1 mb-1.5 max-md:hidden" />
      <RunwayRing days={facts.runwayDays} size={120} className="mx-auto mb-1.5 md:hidden" />
      {/* The ring is the trailing burn with nothing coming in; the forecast row says what the plan does. */}
      <p className="mb-3 text-center text-xs font-medium text-label2">At current burn</p>
      <dl className="mt-auto grid rounded-[11px] bg-inset">
        <div className="flex h-9 items-center justify-between px-3">
          <dt className="font-medium text-label2">Burn</dt>
          <dd className="font-semibold">
            <Money cents={facts.monthlyBurnCents} currency plain />
            <small className="text-xs font-medium text-label2">/mo</small>
          </dd>
        </div>
        <div className="flex h-9 items-center justify-between hairline-t px-3">
          <dt className="font-medium text-label2">Cash out at burn</dt>
          <dd className={cn("font-semibold", ink)}>{facts.cashOutDate ? monthDay(facts.cashOutDate) : "—"}</dd>
        </div>
        {facts.forecastFlowCount > 0 ? (
          <div className="flex h-9 items-center justify-between hairline-t px-3">
            <dt className="font-medium text-label2">Forecast</dt>
            <dd className={cn("inline-flex items-center gap-1 font-semibold", facts.firstNegativeWeekStart === null ? "text-ink-green" : "text-ink-red")}>
              <Glyph name={facts.firstNegativeWeekStart === null ? "check-circle" : "warning"} size={14} />
              {facts.firstNegativeWeekStart === null ? "Above $0" : `Below $0 ${monthDay(facts.firstNegativeWeekStart)}`}
            </dd>
          </div>
        ) : null}
        <div className="flex h-9 items-center justify-between hairline-t px-3">
          <dt className="font-medium text-label2">Lowest week</dt>
          <dd className={cn("font-semibold", facts.lowestClosingCents < 0 && "text-ink-red")}>
            <Money cents={facts.lowestClosingCents} currency plain />
            <small className="ml-1 text-xs font-medium text-label2">{monthDay(facts.lowestWeekStart)}</small>
          </dd>
        </div>
      </dl>
    </section>
  );
}

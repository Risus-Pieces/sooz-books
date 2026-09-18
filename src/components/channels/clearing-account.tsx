import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { dayNumber, dollars } from "@/lib/ui/format";

import { PROVIDER_BADGE, dateSpan, longDate, shortDate } from "./parts";
import { PROVIDER_GUIDE } from "./providers";
import { PROVIDER_NAME, type ChannelCardView, type ClearingDepositView, type ClearingSettlementView } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function nextMonth(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

interface Mark {
  id: string;
  date: string;
  cents: number;
  posted: boolean;
  label: string;
}

/**
 * The clearing account as two lanes on one time axis: what the channel settled (what it says it
 * owes Sooz) above, and the deposits that reached the bank below, a line joining each deposit to
 * the settlement it paid. When one half is missing, its lane is empty — the picture says which half
 * before a word is read. Hollow dots are imported or coded but not yet posted.
 */
export function ClearingLanes({
  settlements,
  deposits,
  asOf,
  className,
}: {
  settlements: readonly ClearingSettlementView[];
  deposits: readonly ClearingDepositView[];
  asOf: string;
  className?: string;
}) {
  const top: Mark[] = settlements
    .filter((s): s is ClearingSettlementView & { date: string } => s.date !== null)
    .map((s) => ({ id: s.id, date: s.date, cents: s.netCents, posted: s.posted, label: s.key ?? "Settlement" }));
  const bottom: Mark[] = deposits.map((d) => ({ id: d.id, date: d.date, cents: d.amountCents, posted: d.posted, label: d.description }));
  const dates = [...top, ...bottom].map((m) => m.date);
  const first = firstOfMonth([...dates, asOf].sort()[0]);
  const months: string[] = [];
  let cursor = first;
  while (cursor <= asOf && months.length < 24) {
    months.push(cursor);
    cursor = nextMonth(cursor);
  }
  const origin = dayNumber(first);
  const span = Math.max(1, dayNumber(cursor) - origin);
  const at = (date: string) => ((dayNumber(date) - origin + 0.5) / span) * 100;
  const max = Math.max(1, ...[...top, ...bottom].map((m) => Math.abs(m.cents)));
  const size = (cents: number) => Math.round(7 + 11 * Math.sqrt(Math.abs(cents) / max));
  const settledTotal = top.reduce((s, m) => s + m.cents, 0);
  const depositedTotal = bottom.reduce((s, m) => s + m.cents, 0);
  const pairs = deposits
    .filter((d) => d.payoutImportId !== null)
    .map((d) => {
      const s = top.find((t) => t.id === d.payoutImportId);
      return s === undefined ? null : { key: `${s.id}-${d.id}`, x1: at(s.date), x2: at(d.date) };
    })
    .filter((p): p is { key: string; x1: number; x2: number } => p !== null);

  const lane = (marks: Mark[], tint: "green" | "blue", label: string, total: number, empty: string) => (
    <div className="grid grid-cols-[4.75rem_minmax(0,1fr)_5.5rem] items-center gap-3 max-sm:grid-cols-[3.75rem_minmax(0,1fr)_4.75rem] max-sm:gap-2">
      <span className="text-xs font-semibold text-label2">{label}</span>
      <div className="relative h-7">
        <span aria-hidden className={cn("absolute inset-x-0 top-1/2 border-t", marks.length === 0 ? "border-dashed border-label3" : "border-[var(--sep-strong)]")} />
        {marks.length === 0 ? (
          <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-2xs font-semibold whitespace-nowrap text-label2">
            {empty}
          </span>
        ) : null}
        {marks.map((m) => {
          const s = size(m.cents);
          return (
            <span
              key={m.id}
              title={`${shortDate(m.date)} · ${dollars(m.cents)}${m.posted ? "" : " · not posted"}`}
              className="absolute top-1/2 rounded-full"
              style={{
                left: `${at(m.date)}%`,
                width: s,
                height: s,
                marginLeft: -s / 2,
                marginTop: -s / 2,
                background: m.posted ? `var(--${tint})` : "var(--card)",
                boxShadow: m.posted ? "0 0 0 1.5px var(--card)" : `inset 0 0 0 1.5px var(--${tint})`,
              }}
            />
          );
        })}
      </div>
      <Money cents={total} currency plain className={cn("text-right text-sm font-semibold", marks.length === 0 && "text-label2")} />
    </div>
  );

  const summary = `${top.length} settlements totalling ${dollars(settledTotal)}; ${bottom.length} deposits totalling ${dollars(depositedTotal)}.`;

  return (
    <figure className={cn("flex flex-col gap-1", className)}>
      <figcaption className="sr-only">{summary}</figcaption>
      <div aria-hidden className="relative flex flex-col gap-1">
        {lane(top, "green", "Settled", settledTotal, "None imported")}
        {pairs.length > 0 ? (
          <div className="pointer-events-none absolute inset-y-[14px] right-[6.25rem] left-[5.5rem] max-sm:right-[5.25rem] max-sm:left-[4.25rem]">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full overflow-visible">
              {pairs.map((p) => (
                <line key={p.key} x1={p.x1} y1={0} x2={p.x2} y2={100} stroke="var(--label3)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
          </div>
        ) : null}
        {lane(bottom, "blue", "Deposited", depositedTotal, "No deposit")}
        <div className="grid grid-cols-[4.75rem_minmax(0,1fr)_5.5rem] gap-3 max-sm:grid-cols-[3.75rem_minmax(0,1fr)_4.75rem] max-sm:gap-2">
          <span />
          <div className="relative h-4">
            {months.map((m, i) => (
              <span
                key={m}
                className={cn(
                  "absolute top-0 -translate-x-1/2 text-2xs font-medium text-label2",
                  months.length > 7 && i % 2 === 1 && "max-sm:hidden",
                )}
                style={{ left: `${((dayNumber(m) - origin + 15) / span) * 100}%` }}
              >
                {MONTHS[Number(m.slice(5, 7)) - 1]}
              </span>
            ))}
          </div>
          <span />
        </div>
      </div>
    </figure>
  );
}

function Issues({ card }: { card: ChannelCardView }) {
  if (card.exceptions.length === 0) return null;
  const blocks = card.exceptions.filter((e) => e.severity === "block").length;
  const warns = card.exceptions.filter((e) => e.severity === "warn").length;
  const label = blocks > 0 ? `${blocks} blocking` : warns > 0 ? `${warns} to finish` : `${card.exceptions.length} notes`;
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex h-[26px] items-center gap-[5px] rounded-full px-2.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-tint-blue max-sm:h-11",
          blocks > 0 ? "bg-tint-red/12 text-ink-red" : warns > 0 ? "bg-tint-orange/14 text-ink-orange" : "bg-fill2 text-label2",
        )}
      >
        <Glyph name="warning" size={13} />
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] px-0 py-1.5 text-sm">
        <ul className="flex flex-col">
          {card.exceptions.map((e, index) => (
            <li key={`${e.code}-${index}`} className={cn("flex gap-2.5 px-3.5 py-2", index > 0 && "hairline-t")}>
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  e.severity === "block" ? "bg-tint-red" : e.severity === "warn" ? "bg-tint-orange" : "bg-tint-blue",
                )}
              />
              <span className="leading-[1.4]">{e.message}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A live channel's clearing account: the balance as the headline, the two-lane picture of what
 * settled against what was deposited, and the one next step. Every sentence of explanation is
 * behind the ⓘ.
 */
export function ClearingAccount({ card }: { card: ChannelCardView }) {
  const name = PROVIDER_NAME[card.provider];
  const badge = PROVIDER_BADGE[card.provider];
  const projected = card.projectedBalanceCents;
  const depositsOnly = card.settlements.length === 0 && card.deposits.length > 0;
  const span = dateSpan(card.deposits.map((d) => d.date));
  const file = PROVIDER_GUIDE[card.provider].file.replace(/ \(.*\)$/, "").toLowerCase();
  const status = card.blocking ? (
    <Pill tone="red" glyph="warning">
      Blocks close
    </Pill>
  ) : depositsOnly ? (
    <Pill tone="orange" glyph="flag">
      Settlements missing
    </Pill>
  ) : projected === 0 ? (
    <Pill tone="green" glyph="check-circle">
      Clear
    </Pill>
  ) : (
    <Pill tone="blue" glyph="clock">
      In transit
    </Pill>
  );

  return (
    <section aria-labelledby={`channel-${card.provider}`} className="flex flex-col gap-4 rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <IconBadge glyph={badge.glyph} tint={badge.tint} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 id={`channel-${card.provider}`} className="text-lg leading-tight font-semibold tracking-[-0.01em]">
            {name}
          </h2>
          <p className="truncate text-xs font-medium text-label2">
            <span className="num">{card.accountCode}</span> {card.accountName}
          </p>
        </div>
        {status}
      </header>

      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div>
          <p className="flex items-center gap-1 text-sm font-semibold text-label2">
            Clearing
            <InfoButton label={`About the ${name} clearing balance`} align="start">
              {depositsOnly ? (
                <>
                  <p>
                    {dollars(card.unmatchedDepositCents)} of {name} deposits reached the bank with no settlement behind them.
                  </p>
                  <p>
                    The cash is real. The {name} sales, sales tax and fees that netted to it have not been imported, so revenue is
                    understated and {card.accountCode} sits at a {dollars(Math.abs(projected))} credit until they are.
                  </p>
                  <p>
                    Import the {name} {file} covering {span}.
                  </p>
                </>
              ) : (
                <p>{card.explanation}</p>
              )}
              <p className="text-label2">
                A settlement posts gross sales, tax and fees here; the bank deposit takes it back to zero. As of {longDate(card.asOf)}.
              </p>
            </InfoButton>
          </p>
          <p className="mt-0.5 flex items-baseline gap-1.5">
            <Money cents={Math.abs(projected)} currency plain className="text-4xl leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.25rem]" />
            {projected !== 0 ? <span className="text-sm font-semibold text-label2">{projected < 0 ? "credit" : "debit"}</span> : null}
          </p>
        </div>
        <dl className="grid min-w-[260px] grid-cols-3 overflow-hidden rounded-[11px] bg-inset max-sm:w-full max-sm:min-w-0">
          <div className="px-3 py-2">
            <dt className="text-2xs font-semibold text-label2">Posted</dt>
            <dd className="text-sm font-semibold">
              <Money cents={card.balanceCents} currency plain />
            </dd>
          </div>
          <div className="hairline-l px-3 py-2">
            <dt className="text-2xs font-semibold text-label2">Not posted</dt>
            <dd className="text-sm font-semibold">
              <Money cents={card.pendingDepositsCents} currency plain />
            </dd>
          </div>
          <div className="hairline-l px-3 py-2">
            <dt className="text-2xs font-semibold text-label2">Unmatched</dt>
            <dd className={cn("num text-sm font-semibold", card.unmatchedDepositCount > 0 && "text-ink-orange")}>
              {card.unmatchedDepositCount}
            </dd>
          </div>
        </dl>
      </div>

      <ClearingLanes settlements={card.settlements} deposits={card.deposits} asOf={card.asOf} />

      <footer className="flex flex-wrap items-center gap-2 hairline-t pt-3.5">
        <Issues card={card} />
        {card.lastSettlement !== null ? (
          <Link href={`/channels/payouts/${card.lastSettlement.id}`} className="text-xs font-medium text-label2 hover:text-label">
            Last settled {longDate(card.lastSettlement.date)}
          </Link>
        ) : null}
        <span className="flex-1" />
        <Button asChild variant="secondary" size="sm">
          <Link href={`/channels/payouts?provider=${card.provider}`}>Payouts</Link>
        </Button>
        <Button asChild size="sm">
          <Link href={`/channels/payouts?provider=${card.provider}#import`}>
            <Glyph name="import" />
            Import
          </Link>
        </Button>
      </footer>
    </section>
  );
}

/** A channel that has never carried a settlement or a deposit: a quiet tile with one action. */
export function UnconnectedChannel({ card }: { card: ChannelCardView }) {
  const name = PROVIDER_NAME[card.provider];
  const guide = PROVIDER_GUIDE[card.provider];
  const badge = PROVIDER_BADGE[card.provider];
  return (
    <section aria-label={name} className="flex min-w-0 items-center gap-3 rounded-2xl bg-card px-4 py-3.5 shadow-card max-md:rounded-[22px]">
      <IconBadge glyph={badge.glyph} tint={badge.tint} size="lg" className="opacity-45 saturate-50" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-sm font-semibold max-sm:text-lg">
          {name}
          <InfoButton label={`How to connect ${name}`} align="start" title={guide.file}>
            <p>{guide.path}</p>
            {guide.secondary === null ? null : (
              <p>
                With it: {guide.secondary.label} — {guide.secondary.path}
              </p>
            )}
            <p className="text-label2">{guide.note}</p>
          </InfoButton>
        </p>
        <p className="text-xs font-medium text-label2">Not connected</p>
      </div>
      <Button asChild variant="secondary" size="sm">
        <Link href={`/channels/payouts?provider=${card.provider}#import`} aria-label={`Import ${name}`}>
          Import
        </Link>
      </Button>
    </section>
  );
}

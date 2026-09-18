import * as React from "react";
import Link from "next/link";
import { ArrowRight, ChevronRight, TriangleAlert, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import { Figure, dateSpan, longDate, shortDate } from "./parts";
import { PROVIDER_GUIDE } from "./providers";
import { PROVIDER_NAME, type ChannelCardView } from "./types";

const SHOWN = 12;

/**
 * A clearing account drawn the way it is taught: as a T. Settlements — what the channel
 * says it owes Sooz — on the debit side; deposits — the cash that reached the bank — on
 * the credit side. When both halves of every payout are in, the sides are equal and the
 * account is zero. When one side is empty, the picture says which half is missing before
 * a word is read.
 */
export function ClearingAccount({ card }: { card: ChannelCardView }) {
  const name = PROVIDER_NAME[card.provider];
  const settlementTotal = card.settlements.reduce((sum, s) => sum + s.netCents, 0);
  const depositTotal = card.deposits.reduce((sum, d) => sum + d.amountCents, 0);
  const projected = card.projectedBalanceCents;
  // What the T itself adds to: every settlement and deposit shown, posted or not.
  const tBalance = settlementTotal - depositTotal;
  const anyUnposted = card.settlements.some((s) => !s.posted) || card.deposits.some((d) => !d.posted);
  const blocks = card.exceptions.filter((e) => e.severity === "block").length;
  const warns = card.exceptions.filter((e) => e.severity === "warn").length;
  const depositsOnly = card.settlements.length === 0 && card.deposits.length > 0;
  const span = dateSpan(card.deposits.map((d) => d.date));
  const importHref = `/channels/payouts?provider=${card.provider}#import`;

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>
            {name} <span className="font-normal text-muted-foreground">·</span>{" "}
            <span className="num text-muted-foreground">{card.accountCode}</span> {card.accountName}
          </CardTitle>
          <CardDescription>Live channel · as of {longDate(card.asOf)}</CardDescription>
        </div>
        {card.blocking ? (
          <Badge tone="negative">
            <TriangleAlert aria-hidden />
            Blocks the close
          </Badge>
        ) : projected === 0 ? (
          <Badge tone="positive">Clear</Badge>
        ) : (
          <Badge tone="info">In transit</Badge>
        )}
      </CardHeader>

      <div className="px-4 pt-4 pb-3">
        {depositsOnly ? (
          <>
            <p className="max-w-3xl text-lg leading-snug font-semibold tracking-tight text-balance">
              <Money cents={card.unmatchedDepositCents} currency plain /> of {name} deposits reached the bank with no
              settlement behind them.
            </p>
            <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">
              The cash is real and nothing is wrong with the deposits. What is missing is the other half: the {name}{" "}
              sales, sales tax and fees that netted to that cash have never been imported, so revenue is understated and{" "}
              {card.accountCode} will sit at a <Money cents={Math.abs(projected)} currency plain /> credit until they are.
              Import the {name} {PROVIDER_GUIDE[card.provider].file.replace(/ \(.*\)$/, "").toLowerCase()} covering {span}.
            </p>
          </>
        ) : (
          <p className="max-w-3xl text-sm text-muted-foreground">{card.explanation}</p>
        )}
      </div>

      {/* The T. */}
      <div className="mx-4 mb-4 rounded-sm border border-border bg-surface-raised">
        <div className="grid grid-cols-2">
          <div className="rule-head px-3 py-1.5">
            <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
              Debit · settlements
            </p>
            <p className="hidden text-2xs text-muted-foreground sm:block">What {name} says it owes Sooz</p>
          </div>
          <div className="rule-head rule-gutter border-l-border-strong px-3 py-1.5 text-right sm:text-left">
            <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
              Credit · deposits
            </p>
            <p className="hidden text-2xs text-muted-foreground sm:block">Cash that reached the bank</p>
          </div>
        </div>
        <div className="grid grid-cols-2">
          <ul className="flex min-w-0 flex-col">
            {card.settlements.length === 0 ? (
              <li className="flex h-full min-h-16 items-center justify-center px-3 py-4 text-center text-xs text-muted-foreground italic">
                No {name} settlement imported
              </li>
            ) : (
              card.settlements.slice(-SHOWN).map((s) => (
                <li key={s.id} className="rule-row flex items-baseline gap-2 px-3 py-1 text-sm">
                  <span className="num w-12 shrink-0 text-xs text-muted-foreground">{shortDate(s.date)}</span>
                  <Link href={`/channels/payouts/${s.id}`} className="hidden min-w-0 flex-1 truncate text-xs hover:underline sm:block">
                    {s.key ?? "Settlement"}
                  </Link>
                  <span className="flex-1 sm:hidden" />
                  <Money cents={s.netCents} plain className={cn(!s.posted && "text-muted-foreground")} />
                </li>
              ))
            )}
            {card.settlements.length > SHOWN ? (
              <li className="px-3 py-1 text-2xs text-muted-foreground">and {card.settlements.length - SHOWN} earlier</li>
            ) : null}
          </ul>
          <ul className="rule-gutter flex min-w-0 flex-col border-l-border-strong">
            {card.deposits.length === 0 ? (
              <li className="flex h-full min-h-16 items-center justify-center px-3 py-4 text-center text-xs text-muted-foreground italic">
                No deposit coded here
              </li>
            ) : (
              card.deposits.slice(-SHOWN).map((d) => (
                <li key={d.id} className="rule-row flex items-baseline gap-2 px-3 py-1 text-sm">
                  <span className="num w-12 shrink-0 text-xs text-muted-foreground">{shortDate(d.date)}</span>
                  <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">
                    {d.description}
                    {d.posted ? null : <span> · coded, not posted</span>}
                    {d.payoutImportId === null ? null : <span className="text-positive"> · matched</span>}
                  </span>
                  <span className="flex-1 sm:hidden" />
                  <Money cents={d.amountCents} plain className={cn(!d.posted && "text-muted-foreground")} />
                </li>
              ))
            )}
            {card.deposits.length > SHOWN ? (
              <li className="px-3 py-1 text-2xs text-muted-foreground">and {card.deposits.length - SHOWN} earlier</li>
            ) : null}
          </ul>
        </div>
        <div className="grid grid-cols-2">
          <div className="rule-subtotal flex items-baseline justify-between gap-2 px-3 py-1.5">
            <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Total</span>
            <Money cents={settlementTotal} plain className="font-semibold" />
          </div>
          <div className="rule-subtotal rule-gutter flex items-baseline justify-between gap-2 border-l-border-strong px-3 py-1.5">
            <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Total</span>
            <Money cents={depositTotal} plain className="font-semibold" />
          </div>
        </div>
        <div className="rule-subtotal flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
          <span className="text-xs">
            <span className="font-semibold">Balance{anyUnposted ? " once everything shown posts" : ""}</span>
            {anyUnposted ? <span className="block text-2xs text-muted-foreground">Grey figures are imported or coded, not yet posted.</span> : null}
          </span>
          <span className="rule-total inline-flex items-baseline gap-1.5 pb-0.5">
            <Money
              cents={Math.abs(tBalance)}
              currency
              plain
              className={cn("text-base font-semibold", tBalance < 0 && "text-warning", tBalance > 0 && "text-info")}
            />
            <span className="text-xs text-muted-foreground">{tBalance < 0 ? "Cr" : tBalance > 0 ? "Dr" : ""}</span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 border-t border-border lg:grid-cols-4">
        <Figure label={`Posted balance, ${card.accountCode}`}>
          <Money cents={card.balanceCents} currency plain={card.balanceCents === 0} />
        </Figure>
        <Figure label="Coded, not posted" className="border-l">
          <Money cents={card.pendingDepositsCents} currency plain />
        </Figure>
        <Figure label="Last settlement" className="border-t lg:border-t-0 lg:border-l">
          {card.lastSettlement === null ? (
            <span className="text-sm font-normal text-muted-foreground">None imported</span>
          ) : (
            <Link href={`/channels/payouts/${card.lastSettlement.id}`} className="num text-base hover:underline">
              {longDate(card.lastSettlement.date)}
            </Link>
          )}
        </Figure>
        <Figure label="Unmatched deposits" className="border-t border-l lg:border-t-0">
          <span className={cn("num", card.unmatchedDepositCount > 0 && "text-warning")}>
            {card.unmatchedDepositCount}
            {card.unmatchedDepositCount > 0 ? (
              <span className="ml-1.5 text-sm font-normal">
                · <Money cents={card.unmatchedDepositCents} plain />
              </span>
            ) : null}
          </span>
        </Figure>
      </div>

      <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        {card.exceptions.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing on this account needs attention.</p>
        ) : (
          <details className="group min-w-0 text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground max-sm:min-h-10">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
              <span>
                {blocks > 0 ? <span className="font-medium text-negative">{blocks} block the close</span> : null}
                {blocks > 0 && warns > 0 ? " · " : null}
                {warns > 0 ? <span className="text-warning">{warns} to finish</span> : null}
                {blocks === 0 && warns === 0 ? `${card.exceptions.length} notes` : null}
              </span>
            </summary>
            <ul className="mt-2 flex flex-col gap-1 pl-4.5">
              {card.exceptions.map((e, index) => (
                <li key={`${e.code}-${index}`} className="flex gap-2">
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      e.severity === "block" ? "bg-negative" : e.severity === "warn" ? "bg-warning" : "bg-info",
                    )}
                    aria-hidden
                  />
                  <span className="text-muted-foreground">{e.message}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button asChild variant="secondary" size="sm">
            <Link href={`/channels/payouts?provider=${card.provider}`}>
              Settlements
              <ArrowRight />
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href={importHref}>
              <Upload />
              Import {name} settlements
            </Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** A channel that has never carried a settlement or a deposit: what connects it. */
export function UnconnectedChannel({ card }: { card: ChannelCardView }) {
  const name = PROVIDER_NAME[card.provider];
  const guide = PROVIDER_GUIDE[card.provider];
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{name}</CardTitle>
          <CardDescription>
            <span className="num">{card.accountCode}</span> {card.accountName}
          </CardDescription>
        </div>
        <Badge tone="neutral">Not connected</Badge>
      </CardHeader>
      <div className="flex flex-1 flex-col gap-3 px-4 py-3">
        <div>
          <p className="eyebrow">To connect, import</p>
          <p className="mt-0.5 text-sm font-medium">{guide.file}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{guide.path}</p>
          {guide.secondary === null ? null : (
            <p className="mt-1 text-xs text-muted-foreground">
              With it: {guide.secondary.label} — {guide.secondary.path}
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{guide.note}</p>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
        <span className="text-xs text-muted-foreground">
          Balance <Money cents={card.balanceCents} currency plain />
        </span>
        <Button asChild variant="secondary" size="sm">
          <Link href={`/channels/payouts?provider=${card.provider}#import`}>
            <Upload />
            Import
          </Link>
        </Button>
      </div>
    </Card>
  );
}

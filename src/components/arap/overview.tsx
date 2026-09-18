import * as React from "react";
import Link from "next/link";

import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { InsetGroup } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import type { Tint } from "@/lib/ui/tints";

import { AgingBar, AgingLegend } from "./aging-bar";
import type { AgingBuckets } from "./types";

export interface OwedStat {
  label: string;
  cents: number;
  /** A quiet note beside the label: a count, a month. */
  note?: string | number;
  href?: string;
  tone?: "red" | "orange" | "plain";
}

export interface AgingSplit {
  /** Open invoices (or bills), before anything unapplied is netted against them. */
  docsCents: number;
  docsLabel: string;
  /** Unapplied receipts, credits and deductions: negative. */
  creditsCents: number;
  creditsLabel: string;
}

const DOC_KINDS: Record<string, string> = { invoice: "Invoices", bill: "Bills" };

/**
 * Splits an aging's net total into the open documents and the unapplied money netted against them,
 * so a net of $0.00 beside "2 open · $1,419.78" explains itself.
 */
export function agingSplit(parties: ReadonlyArray<{ items: ReadonlyArray<{ kind: string; balanceCents: number }> }>): AgingSplit {
  let docsCents = 0;
  let creditsCents = 0;
  let docsLabel = "Open";
  const creditKinds = new Set<string>();
  for (const party of parties) {
    for (const item of party.items) {
      const docs = DOC_KINDS[item.kind];
      if (docs !== undefined) {
        docsCents += item.balanceCents;
        docsLabel = docs;
      } else {
        creditsCents += item.balanceCents;
        creditKinds.add(item.kind);
      }
    }
  }
  const creditsLabel = creditKinds.size === 1 && creditKinds.has("deduction") ? "Deductions" : "Unapplied";
  return { docsCents, docsLabel, creditsCents, creditsLabel };
}

/** "Invoices $1,419.78 · Deductions −$1,419.78": shown only when unapplied money is netted in. */
export function AgingSplitLine({ split, className }: { split: AgingSplit; className?: string }) {
  if (split.creditsCents === 0) return null;
  return (
    <p className={cn("mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-label2", className)}>
      <span className="inline-flex items-center gap-1.5">
        {split.docsLabel}
        <Money cents={split.docsCents} currency plain className="font-semibold text-label" />
      </span>
      <span aria-hidden className="text-label3">·</span>
      <span className="inline-flex items-center gap-1.5">
        {split.creditsLabel}
        <Money cents={split.creditsCents} currency plain className="font-semibold text-label" />
      </span>
    </p>
  );
}

/**
 * The overview's hero: what is owed as one big figure, the same money as a bar split by age, and
 * the few figures that need attention beside it.
 */
export function OwedCard({
  title,
  info,
  totalCents,
  buckets,
  stats,
  agingHref,
  split,
  className,
}: {
  title: string;
  info: React.ReactNode;
  totalCents: number;
  /** The open documents and the unapplied money netted into `totalCents`. */
  split?: AgingSplit;
  buckets: AgingBuckets;
  stats: OwedStat[];
  agingHref: string;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-2xl bg-card px-5 pt-[18px] pb-5 shadow-card max-md:rounded-[22px] max-md:p-4",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1 text-sm font-semibold text-label2">
            {title}
            <InfoButton label={`About ${title.toLowerCase()}`} align="start">
              {info}
            </InfoButton>
          </h2>
          <Money
            cents={totalCents}
            currency
            plain
            className="mt-0.5 block text-5xl leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.5rem]"
          />
          {split ? <AgingSplitLine split={split} /> : null}
        </div>
        <ul className="grid min-w-[240px] gap-1.5 pt-1 max-md:hidden">
          {stats.map((s) => (
            <li key={s.label}>
              <StatLine stat={s} />
            </li>
          ))}
        </ul>
      </div>

      <Link
        href={agingHref}
        aria-label="Open the aging"
        className="group/aging -mx-2 mt-auto flex flex-col gap-3 rounded-[12px] px-2 py-2 transition-colors hover:bg-fill2"
      >
        <AgingBar buckets={buckets} />
        <AgingLegend buckets={buckets} />
      </Link>

      <ul className="-mx-4 -mb-4 md:hidden">
        {stats.map((s) => (
          <li
            key={s.label}
            className="relative before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-sep"
          >
            <StatLine stat={s} phone />
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatLine({ stat, phone }: { stat: OwedStat; phone?: boolean }) {
  const body = (
    <>
      <span className={cn("text-label", phone && "text-lg")}>{stat.label}</span>
      {stat.note !== undefined && stat.note !== 0 ? <span className="text-xs text-label2">{stat.note}</span> : null}
      <Money
        cents={stat.cents}
        currency
        plain
        className={cn(
          "ml-auto pl-4 font-semibold",
          phone && "text-lg",
          stat.cents > 0 && stat.tone === "red" && "text-ink-red",
          stat.cents > 0 && stat.tone === "orange" && "text-ink-orange",
        )}
      />
      {phone && stat.href ? <Glyph name="chevron-right" size={12} weight={2.4} className="text-label3" /> : null}
    </>
  );
  const classes = cn(
    "flex items-center gap-2 text-sm",
    phone ? "min-h-11 px-4" : "rounded-[6px]",
    stat.href && "transition-colors hover:text-label",
  );
  return stat.href ? (
    <Link href={stat.href} className={classes}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}

export interface SectionLink {
  label: string;
  href: string;
  glyph: GlyphName;
  tint: Tint;
  /** A quiet figure at the trailing edge: a count, an amount. */
  value?: React.ReactNode;
}

/** The section's pages as System-Settings rows: a coloured badge, a word, a quiet figure, a chevron. */
export function SectionLinks({ links, className }: { links: SectionLink[]; className?: string }) {
  return (
    <InsetGroup separatorInset={50} className={className}>
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="relative flex min-h-[46px] items-center gap-3 px-4 py-2 text-sm font-medium outline-none focus-ring-inset transition-colors before:absolute before:top-0 before:right-0 before:left-[var(--sep-inset)] before:border-t-[0.5px] before:border-sep first:before:hidden hover:bg-fill2 focus-visible:bg-fill2 max-sm:text-lg max-sm:font-normal"
        >
          <IconBadge glyph={l.glyph} tint={l.tint} />
          <span className="flex-1">{l.label}</span>
          {l.value !== undefined ? <span className="text-label2">{l.value}</span> : null}
          <Glyph name="chevron-right" size={12} weight={2.4} className="text-label3" />
        </Link>
      ))}
    </InsetGroup>
  );
}

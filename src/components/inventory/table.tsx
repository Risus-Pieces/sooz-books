import * as React from "react";

import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { cn } from "@/lib/cn";

/**
 * The register pieces every inventory table is built from, Numbers-style: a quiet header over a
 * hairline, hairline rows, right-aligned tabular figures, weight only where a total closes. The
 * wrapper scrolls sideways inside its own box so a wide register never pushes a phone page wide.
 */
export function TableScroll({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("w-full overflow-x-auto overscroll-x-contain", className)}>{children}</div>;
}

export function Table({
  className,
  caption,
  children,
}: {
  className?: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <table className={cn("w-full border-separate border-spacing-0 text-sm", className)}>
      <caption className="sr-only">{caption}</caption>
      {children}
    </table>
  );
}

export function Th({
  className,
  children,
  align = "left",
}: {
  className?: string;
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head px-3 pt-2 pb-1.5 text-xs font-semibold whitespace-nowrap text-label2 first:pl-5 last:pr-5 max-sm:first:pl-4 max-sm:last:pr-4",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  className,
  children,
  align = "left",
  colSpan,
}: {
  className?: string;
  children?: React.ReactNode;
  align?: "left" | "right";
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        "px-3 py-2 align-middle first:pl-5 last:pr-5 max-sm:first:pl-4 max-sm:last:pr-4",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </td>
  );
}

export type CalloutTone = "warning" | "info" | "positive" | "negative";

const toneGlyph: Record<CalloutTone, GlyphName> = {
  warning: "warning",
  info: "info",
  positive: "check-circle",
  negative: "warning",
};

const toneInk: Record<CalloutTone, string> = {
  warning: "text-ink-orange",
  info: "text-ink-blue",
  positive: "text-ink-green",
  negative: "text-ink-red",
};

/**
 * A one-line status on a card: a coloured glyph, a few words, and at most one action. Anything
 * that explains it goes behind the ⓘ, never on the screen.
 */
export function Callout({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: CalloutTone;
  title: React.ReactNode;
  /** The explanation: shown in the ⓘ popover. */
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "warning" || tone === "negative" ? "status" : undefined}
      className={cn(
        "flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-card px-4 py-2.5 shadow-card max-sm:rounded-[22px]",
        className,
      )}
    >
      <Glyph name={toneGlyph[tone]} size={18} className={cn("shrink-0", toneInk[tone])} />
      <p className="min-w-0 flex-1 text-sm font-semibold">{title}</p>
      {children ? (
        <InfoButton label="More information" align="end">
          {children}
        </InfoButton>
      ) : null}
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** A label over a value, for the small facts a card header or dialog carries. */
export function Fact({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <dt className="text-xs font-medium text-label2">{label}</dt>
      <dd className="text-sm font-semibold text-label">{children}</dd>
    </div>
  );
}

import * as React from "react";
import { Flag } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import { FLAG_LABEL, SOURCE_LABEL } from "./review-logic";
import type { QueueFlag, QueueSource } from "./types";

/** A header cell in the register's voice: small caps on the sunken band. */
export function Th({ className, ...props }: React.ComponentPropsWithRef<"th">) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head bg-surface-sunken px-3 py-1.5 text-left align-bottom text-2xs font-semibold tracking-wider whitespace-nowrap text-muted-foreground uppercase",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.ComponentPropsWithRef<"td">) {
  return <td className={cn("px-3 py-1.5 align-top", className)} {...props} />;
}

/**
 * Money in and money out never share a column. The bank's direction is read from which
 * column holds the figure before a digit is read: in on the left in green, out on the
 * right in red, the ledger gutter between them.
 */
export function InCell({ cents, className }: { cents: number; className?: string }) {
  return (
    <td className={cn("px-3 py-1.5 text-right align-top", className)}>
      {cents > 0 ? <Money cents={cents} colorPositive className="font-medium" /> : null}
    </td>
  );
}

export function OutCell({ cents, className }: { cents: number; className?: string }) {
  return (
    <td className={cn("rule-gutter px-3 py-1.5 text-right align-top", className)}>
      {cents < 0 ? <Money cents={cents} className="font-medium" /> : null}
    </td>
  );
}

const SOURCE_TONE: Record<QueueSource, "primary" | "info" | "neutral" | "positive"> = {
  rule: "primary",
  ai: "info",
  history: "neutral",
  match: "positive",
  none: "neutral",
};

export function SourceChip({ source, confidence }: { source: QueueSource | null; confidence: number | null }) {
  if (source === null) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={SOURCE_TONE[source]} size="sm">
        {SOURCE_LABEL[source]}
      </Badge>
      {confidence === null ? null : (
        <span
          className={cn("num text-2xs", confidence < 0.6 ? "text-warning" : "text-muted-foreground")}
          title="How sure the suggestion is"
        >
          {Math.round(confidence * 100)}%
        </span>
      )}
    </span>
  );
}

const FLAG_TONE: Record<QueueFlag, "warning" | "negative" | "neutral" | "info"> = {
  mixed_use: "warning",
  ask_accountant: "negative",
  already_booked: "warning",
  open_document: "info",
  low_confidence: "neutral",
  no_suggestion: "neutral",
};

export function FlagMarks({ flags }: { flags: readonly QueueFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {flags.map((flag) => (
        <Badge key={flag} tone={FLAG_TONE[flag]} size="sm">
          {flag === "mixed_use" ? <Flag aria-hidden /> : null}
          {FLAG_LABEL[flag]}
        </Badge>
      ))}
    </span>
  );
}

/** A keyboard key, as the shortcut hints print it. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "num inline-flex h-4 min-w-4 items-center justify-center rounded-xs border border-border-strong bg-surface-raised px-1 text-[0.625rem] leading-none font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** One figure in a summary strip: a small-caps label over the number. */
export function Figure({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 border-border px-3 py-2", className)}>
      <span className="eyebrow truncate">{label}</span>
      <span className="text-xl leading-none font-semibold tracking-tight">{children}</span>
    </div>
  );
}

import * as React from "react";
import { CircleCheck, Info, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * The register pieces every inventory table is built from: a sunken header on a
 * solid rule, hairline rows, and a wrapper that scrolls sideways inside its own
 * box so a wide register never pushes the page past the viewport on a phone.
 */
export function TableScroll({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("w-full overflow-x-auto", className)}>{children}</div>;
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
        "rule-head bg-surface-sunken px-3 py-1.5 text-2xs font-semibold tracking-wider whitespace-nowrap text-muted-foreground uppercase",
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
    <td colSpan={colSpan} className={cn("px-3 py-1.5 align-middle", align === "right" && "text-right", className)}>
      {children}
    </td>
  );
}

export type CalloutTone = "warning" | "info" | "positive" | "negative";

const toneClass: Record<CalloutTone, string> = {
  warning: "border-warning/35 bg-warning/8",
  info: "border-info/30 bg-info/6",
  positive: "border-positive/30 bg-positive/6",
  negative: "border-negative/35 bg-negative/8",
};

const iconClass: Record<CalloutTone, string> = {
  warning: "text-warning",
  info: "text-info",
  positive: "text-positive",
  negative: "text-negative",
};

/** A boxed note that says what is true and what to do about it. */
export function Callout({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: CalloutTone;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const Icon = tone === "positive" ? CircleCheck : tone === "info" ? Info : TriangleAlert;
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-start sm:justify-between",
        toneClass[tone],
        className,
      )}
    >
      <div className="flex min-w-0 gap-2.5">
        <Icon className={cn("mt-0.5 size-4 shrink-0", iconClass[tone])} aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {children ? <div className="text-xs leading-relaxed text-muted-foreground">{children}</div> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2 pl-6.5 sm:pl-0">{action}</div> : null}
    </div>
  );
}

/** A label over a value, for the small facts a card header or dialog carries. */
export function Fact({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <dt className="eyebrow">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

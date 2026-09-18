import * as React from "react";

import { cn } from "@/lib/cn";

import { Glyph, type GlyphName } from "./glyph";

export type PillTone = "neutral" | "blue" | "green" | "red" | "orange" | "purple";

const toneClass: Record<PillTone, string> = {
  neutral: "bg-fill2 text-label2",
  blue: "bg-tint-blue/12 text-ink-blue",
  green: "bg-tint-green/12 text-ink-green",
  red: "bg-tint-red/12 text-ink-red",
  orange: "bg-tint-orange/14 text-ink-orange",
  purple: "bg-tint-purple/12 text-label",
};

export interface PillProps extends React.ComponentPropsWithRef<"span"> {
  tone?: PillTone;
  glyph?: GlyphName;
}

/** A capsule status: "Mixed use", "Posted", "Closed". A glyph first, one or two words. */
export function Pill({ tone = "neutral", glyph, className, children, ...props }: PillProps) {
  return (
    <span
      data-slot="pill"
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center gap-[5px] self-start rounded-full px-2.5 text-xs font-semibold whitespace-nowrap",
        toneClass[tone],
        className,
      )}
      {...props}
    >
      {glyph ? <Glyph name={glyph} size={13} /> : null}
      {children}
    </span>
  );
}

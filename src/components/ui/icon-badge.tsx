import * as React from "react";

import { cn } from "@/lib/cn";
import type { Category } from "@/lib/ui/categories";
import { tintVar, type Tint } from "@/lib/ui/tints";

import { Glyph, type GlyphName } from "./glyph";

type TintStyle = React.CSSProperties & { "--c": string };

function tintStyle(tint: Tint, style?: React.CSSProperties): TintStyle {
  return { ...style, "--c": tintVar(tint) };
}

export interface IconBadgeProps extends Omit<React.ComponentPropsWithRef<"span">, "children"> {
  glyph: GlyphName;
  tint: Tint;
  /** md 22px (sidebar, card headers) · sm 20px (phone widgets) · lg 28px · xl 36px. */
  size?: "sm" | "md" | "lg" | "xl";
}

const sizes = {
  sm: { box: "size-5 rounded-[5.5px]", glyph: 13 },
  md: { box: "size-[22px] rounded-[6px]", glyph: 14 },
  lg: { box: "size-7 rounded-[7px]", glyph: 17 },
  xl: { box: "size-9 rounded-[9px]", glyph: 21 },
} as const;

/**
 * The System Settings badge: a white glyph on a coloured rounded square with a soft top light.
 * Used for sections in the sidebar, card headers, and the two ends of a flow diagram.
 */
export function IconBadge({ glyph, tint, size = "md", className, style, ...props }: IconBadgeProps) {
  const s = sizes[size];
  return (
    <span
      data-slot="icon-badge"
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center text-white shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]",
        "bg-[linear-gradient(180deg,color-mix(in_srgb,var(--c)_88%,#fff),var(--c))]",
        s.box,
        className,
      )}
      style={tintStyle(tint, style)}
      {...props}
    >
      <Glyph name={glyph} size={s.glyph} weight={1.9} />
    </span>
  );
}

/** A category's badge. */
export function CategoryBadge({
  category,
  ...props
}: Omit<IconBadgeProps, "glyph" | "tint"> & { category: Category }) {
  return <IconBadge glyph={category.glyph} tint={category.tint} {...props} />;
}

export interface DotProps extends Omit<React.ComponentPropsWithRef<"span">, "children"> {
  tint: Tint | "quiet";
  size?: 7 | 8 | 10;
}

/** A colour dot: a category in a list row, an account in a legend. */
export function Dot({ tint, size = 8, className, style, ...props }: DotProps) {
  return (
    <span
      data-slot="dot"
      aria-hidden
      className={cn("inline-block shrink-0 rounded-full bg-[var(--c)]", className)}
      style={{ ...style, width: size, height: size, "--c": tint === "quiet" ? "var(--label3)" : tintVar(tint) } as TintStyle}
      {...props}
    />
  );
}

/** A legend key: a rounded square swatch and a word. */
export function LegendItem({ tint, children }: { tint: Tint; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[5px] text-xs font-medium text-label2">
      <span aria-hidden className="size-2 rounded-[2.5px]" style={{ background: tintVar(tint) }} />
      {children}
    </span>
  );
}

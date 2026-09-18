/**
 * The system tints, by name. A tint is a CSS custom property defined for light and dark in
 * globals.css; these helpers turn a name into something a style or class can use, so no screen ever
 * writes a hex value.
 */

export const TINTS = [
  "blue",
  "green",
  "red",
  "orange",
  "indigo",
  "teal",
  "purple",
  "pink",
  "brown",
  "cyan",
  "mint",
  "gray",
] as const;

export type Tint = (typeof TINTS)[number];

/** `var(--teal)` — for SVG fills, inline styles and the `--c` custom property the kit reads. */
export function tintVar(tint: Tint): string {
  return `var(--${tint})`;
}

/**
 * Literal class names, spelled out so Tailwind's scanner sees every one of them.
 */
export const TINT_BG: Record<Tint, string> = {
  blue: "bg-tint-blue",
  green: "bg-tint-green",
  red: "bg-tint-red",
  orange: "bg-tint-orange",
  indigo: "bg-tint-indigo",
  teal: "bg-tint-teal",
  purple: "bg-tint-purple",
  pink: "bg-tint-pink",
  brown: "bg-tint-brown",
  cyan: "bg-tint-cyan",
  mint: "bg-tint-mint",
  gray: "bg-tint-gray",
};

export const TINT_TEXT: Record<Tint, string> = {
  blue: "text-tint-blue",
  green: "text-tint-green",
  red: "text-tint-red",
  orange: "text-tint-orange",
  indigo: "text-tint-indigo",
  teal: "text-tint-teal",
  purple: "text-tint-purple",
  pink: "text-tint-pink",
  brown: "text-tint-brown",
  cyan: "text-tint-cyan",
  mint: "text-tint-mint",
  gray: "text-tint-gray",
};

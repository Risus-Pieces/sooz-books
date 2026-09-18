"use client";

import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";
import type { Tint } from "@/lib/ui/tints";
import { TINT_TEXT } from "@/lib/ui/tints";

import { Glyph, type GlyphName } from "./glyph";

export interface SegmentOption {
  value: string;
  label: string;
  glyph?: GlyphName;
  /** Colours the glyph: the orange flag, the purple AI sparkle. */
  glyphTint?: Tint;
  /** Hide the label visually (the glyph and a count say it); still read aloud. */
  iconOnly?: boolean;
  /** A figure shown after the label ("⚑ 52"); with `iconOnly` it is the only visible text. */
  count?: number;
}

const track = "flex gap-0.5 rounded-[8px] bg-fill2 p-0.5";
const segment =
  "flex h-6 min-w-0 items-center justify-center gap-1 rounded-[6px] px-2.5 text-xs font-medium whitespace-nowrap text-label outline-none focus-ring transition-[background-color,box-shadow] duration-150 max-sm:h-8 max-sm:text-sm";
const on = "bg-ctl font-semibold shadow-ctl";

function SegmentBody({ option }: { option: SegmentOption }) {
  return (
    <>
      {option.glyph ? (
        <Glyph
          name={option.glyph}
          size={12}
          className={option.glyphTint ? TINT_TEXT[option.glyphTint] : undefined}
        />
      ) : null}
      <span className={cn("truncate", option.iconOnly && "sr-only")}>{option.label}</span>
      {option.count === undefined ? null : (
        <>
          {" "}
          <span className="num">{option.count}</span>
        </>
      )}
    </>
  );
}

export interface SegmentedControlProps {
  options: SegmentOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  "aria-label": string;
  /** Stretch to the container, every segment the same width. */
  fill?: boolean;
  className?: string;
}

/**
 * One choice among two to five views of the same thing (All · Flagged · AI). A radio group:
 * arrow keys move the choice.
 */
export function SegmentedControl({
  options,
  value,
  defaultValue,
  onValueChange,
  fill,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps) {
  const [inner, setInner] = React.useState(defaultValue ?? options[0]?.value);
  const current = value ?? inner;
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const choose = (next: string) => {
    setInner(next);
    onValueChange?.(next);
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const nextIndex = (index + delta + options.length) % options.length;
    choose(options[nextIndex].value);
    refs.current[nextIndex]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn(track, fill ? "w-full" : "inline-flex", className)}>
      {options.map((option, index) => {
        const selected = option.value === current;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => choose(option.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(segment, fill && "flex-1", selected ? on : "hover:bg-fill2")}
          >
            <SegmentBody option={option} />
          </button>
        );
      })}
    </div>
  );
}

export interface SegmentLink extends SegmentOption {
  href: string;
}

/**
 * The same control for choices that live in the URL (?stage=review): each segment is a link, the
 * current one marked with aria-current.
 */
export function SegmentedNav({
  items,
  current,
  fill,
  className,
  "aria-label": ariaLabel,
}: {
  items: SegmentLink[];
  current: string;
  fill?: boolean;
  className?: string;
  "aria-label": string;
}) {
  return (
    <nav aria-label={ariaLabel} className={cn(track, fill ? "w-full" : "inline-flex", className)}>
      {items.map((item) => {
        const selected = item.value === current;
        return (
          <Link
            key={item.value}
            href={item.href}
            scroll={false}
            aria-current={selected ? "page" : undefined}
            className={cn(segment, fill && "flex-1", selected ? on : "hover:bg-fill2")}
          >
            <SegmentBody option={item} />
          </Link>
        );
      })}
    </nav>
  );
}

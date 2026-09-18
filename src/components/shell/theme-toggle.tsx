"use client";

import * as React from "react";

import { cn } from "@/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useTheme, type ThemePreference } from "@/components/ui/theme";

const OPTIONS: Array<{ value: ThemePreference; label: string; glyph: GlyphName }> = [
  { value: "system", label: "Auto", glyph: "appearance" },
  { value: "light", label: "Light", glyph: "sun" },
  { value: "dark", label: "Dark", glyph: "moon" },
];

function isPreference(value: string): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** The toolbar's appearance button: a menu of Auto, Light and Dark. */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  const current = OPTIONS.find((o) => o.value === preference) ?? OPTIONS[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Appearance"
        title="Appearance"
        className={cn(
          "grid h-7 w-8 place-items-center rounded-[8px] text-label2 outline-none focus-ring transition-colors hover:bg-fill2 hover:text-label data-[state=open]:bg-fill max-sm:size-11",
          className,
        )}
      >
        <Glyph name={current.glyph} size={17} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(v) => {
            if (isPreference(v)) setPreference(v);
          }}
        >
          {OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <Glyph name={option.glyph} />
              <span>{option.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same choice as a segmented control, for the phone's More sheet. */
export function ThemeSegmented({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  return (
    <SegmentedControl
      aria-label="Appearance"
      className={className}
      fill
      value={preference}
      onValueChange={(v) => {
        if (isPreference(v)) setPreference(v);
      }}
      options={OPTIONS.map((o) => ({ value: o.value, label: o.label, glyph: o.glyph }))}
    />
  );
}

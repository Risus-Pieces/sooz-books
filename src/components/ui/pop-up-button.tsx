"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";

import { cn } from "@/lib/cn";
import type { Tint } from "@/lib/ui/tints";

import { Glyph } from "./glyph";
import { Dot } from "./icon-badge";
import { menuItem, menuLabel, menuSeparator, menuSurface } from "./menu-styles";

export interface PopUpOption {
  value: string;
  label: string;
  /** A category colour shown as a dot before the label, in the button and in the menu. */
  tint?: Tint;
  disabled?: boolean;
}

export interface PopUpGroup {
  label?: string;
  options: PopUpOption[];
}

export interface PopUpButtonProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Flat options, or labelled groups separated by a rule. */
  options: PopUpOption[] | PopUpGroup[];
  /** Required: the button shows a value, not a name. */
  "aria-label": string;
  placeholder?: string;
  /** Submits with a surrounding <form>. */
  name?: string;
  disabled?: boolean;
  /** `bezel` — the white pop-up in a grouped row. `toolbar` — the borderless capsule in a toolbar group. */
  appearance?: "bezel" | "toolbar";
  className?: string;
}

function isGrouped(options: PopUpOption[] | PopUpGroup[]): options is PopUpGroup[] {
  return options.length > 0 && "options" in options[0];
}

/**
 * The macOS pop-up button: shows the chosen value, opens a menu of the choices. Use it for
 * one-of-many choices inside a grouped row (an account, a period) and for the year/period
 * capsule in a toolbar.
 */
export function PopUpButton({
  options,
  placeholder,
  appearance = "bezel",
  className,
  "aria-label": ariaLabel,
  ...rootProps
}: PopUpButtonProps) {
  const groups: PopUpGroup[] = isGrouped(options) ? options : [{ options }];
  const all = groups.flatMap((g) => g.options);
  const [inner, setInner] = React.useState(rootProps.defaultValue);
  const current = rootProps.value ?? inner;
  const selected = all.find((o) => o.value === current);

  return (
    <SelectPrimitive.Root
      {...rootProps}
      onValueChange={(v) => {
        setInner(v);
        rootProps.onValueChange?.(v);
      }}
    >
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "inline-flex max-w-full min-w-0 items-center gap-[7px] outline-none focus-ring disabled:opacity-45",
          appearance === "bezel" &&
            "h-[26px] rounded-[7px] bg-ctl pr-1.5 pl-2.5 font-medium shadow-ctl max-sm:h-11 data-[state=open]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--blue)_45%,transparent)]",
          appearance === "toolbar" &&
            "h-7 rounded-full pr-2.5 pl-3 text-sm font-semibold hover:bg-fill2 data-[state=open]:bg-fill max-sm:h-11",
          className,
        )}
      >
        {selected?.tint ? <Dot tint={selected.tint} /> : null}
        <span className="truncate">
          {/* The label is passed in, not left to Radix, so the server paints it before the menu mounts. */}
          <SelectPrimitive.Value placeholder={placeholder}>{selected?.label}</SelectPrimitive.Value>
        </span>
        <Glyph
          name={appearance === "toolbar" ? "chevron-down" : "chevron-updown"}
          size={appearance === "toolbar" ? 12 : 13}
          weight={2.2}
          className="text-label2"
        />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className={cn(menuSurface, "max-h-80 p-0")}>
          <SelectPrimitive.Viewport className="p-[5px]">
            {groups.map((group, gi) => (
              <SelectPrimitive.Group key={group.label ?? gi}>
                {gi > 0 ? <SelectPrimitive.Separator className={menuSeparator} /> : null}
                {group.label ? <SelectPrimitive.Label className={menuLabel}>{group.label}</SelectPrimitive.Label> : null}
                {group.options.map((o) => (
                  <SelectPrimitive.Item key={o.value} value={o.value} disabled={o.disabled} className={cn(menuItem, "pl-7")}>
                    <span className="absolute left-2 flex size-3.5 items-center justify-center">
                      <SelectPrimitive.ItemIndicator>
                        <Glyph name="check" size={13} weight={2.2} />
                      </SelectPrimitive.ItemIndicator>
                    </span>
                    {o.tint ? <Dot tint={o.tint} /> : null}
                    <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Group>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

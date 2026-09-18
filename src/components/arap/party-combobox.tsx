"use client";

import * as React from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Glyph } from "@/components/ui/glyph";
import { fieldBase, fieldInvalid } from "@/components/ui/menu-styles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";

export interface PartyOption {
  id: string;
  name: string;
  /** A quieter note beside the name: terms, an open balance. */
  note?: string;
}

/** Search-as-you-type picker for a customer or a vendor. */
export function PartyCombobox({
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  id,
  disabled,
  invalid,
  className,
}: {
  options: readonly PartyOption[];
  value: string | null;
  onChange: (id: string) => void;
  placeholder: string;
  emptyText: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((option) => option.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        type="button"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          fieldBase,
          "flex items-center justify-between gap-1.5 pr-1.5 text-left font-medium data-[state=open]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--blue)_45%,transparent),0_0_0_0.5px_var(--blue)]",
          invalid && fieldInvalid,
          className,
        )}
      >
        {selected ? (
          <span className="truncate">{selected.name}</span>
        ) : (
          <span className="font-normal text-label2">{placeholder}</span>
        )}
        <Glyph name="chevron-updown" size={13} weight={2.2} className="shrink-0 text-label2" />
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by name" />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.name} ${option.id}`}
                  onSelect={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                  className="gap-2"
                >
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {option.note ? <span className="num shrink-0 text-2xs opacity-70">{option.note}</span> : null}
                  {option.id === value ? <Glyph name="check" size={13} weight={2.2} /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
          "flex h-8 w-full items-center justify-between gap-1.5 rounded-sm border max-sm:h-10 border-border-strong bg-surface-raised px-2.5 text-sm text-foreground transition-colors data-[state=open]:border-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground",
          invalid && "border-negative",
          className,
        )}
      >
        {selected ? (
          <span className="truncate">{selected.name}</span>
        ) : (
          <span className="text-muted-foreground/80">{placeholder}</span>
        )}
        <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
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
                  {option.note ? <span className="num shrink-0 text-2xs text-muted-foreground">{option.note}</span> : null}
                  {option.id === value ? <Check className="size-3.5 !text-primary" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

"use client";

import * as React from "react";

import { inputBase } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/cn";

/** A labelled control with an optional note under it. */
export function Field({
  id,
  label,
  required,
  hint,
  note,
  className,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  note?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id} required={required} hint={hint}>
        {label}
      </Label>
      {children}
      {note ? <p className="text-2xs leading-relaxed text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/**
 * A native select in the input's clothes. Native on purpose: on a phone it opens
 * the platform picker, and a bookkeeper can type-ahead through it on a desktop.
 */
export function NativeSelect({ className, ...props }: React.ComponentPropsWithRef<"select">) {
  return <select className={cn(inputBase, "pr-8", className)} {...props} />;
}

/** Two or three choices set side by side, one of which is on. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-fit self-start rounded-sm border border-border-strong bg-surface-raised p-0.5">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-6.5 rounded-xs px-2.5 text-xs font-medium transition-colors disabled:opacity-45",
              on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

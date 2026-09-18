"use client";

import * as React from "react";

import { inputBase } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
      {note ? <p className="text-xs text-label2">{note}</p> : null}
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

/** Two or three choices set side by side, one of which is on: the kit's segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  fill,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  fill?: boolean;
}) {
  return (
    <SegmentedControl
      aria-label={label}
      fill={fill}
      className={fill ? undefined : "w-fit self-start"}
      value={value}
      options={options.map((o) => ({ value: o.value, label: o.label }))}
      onValueChange={(next) => {
        const match = options.find((o) => o.value === next);
        if (match) onChange(match.value);
      }}
    />
  );
}

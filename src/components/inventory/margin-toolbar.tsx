"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Glyph } from "@/components/ui/glyph";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PopUpButton } from "@/components/ui/pop-up-button";
import { SegmentedNav } from "@/components/ui/segmented-control";

export type MarginGroupKey = "product" | "channel" | "product_channel";

export interface MarginToolbarProps {
  path: string;
  from: string;
  to: string;
  groupBy: MarginGroupKey;
  presets: ReadonlyArray<{ key: string; label: string; from: string; to: string }>;
}

const GROUPS: ReadonlyArray<{ value: MarginGroupKey; label: string }> = [
  { value: "product", label: "Product" },
  { value: "channel", label: "Channel" },
  { value: "product_channel", label: "Both" },
];

const CUSTOM = "custom";

function href(path: string, from: string, to: string, by: MarginGroupKey): string {
  return `${path}?${new URLSearchParams({ from, to, by }).toString()}`;
}

/**
 * The margin report's controls on one line: the period as a pop-up (presets, or a custom range in a
 * popover), and what to group by as a segmented control. The whole state is in the URL, so a view
 * can be bookmarked or sent to the accountant.
 */
export function MarginToolbar({ path, from, to, groupBy, presets }: MarginToolbarProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [open, setOpen] = React.useState(false);
  const active = presets.find((preset) => preset.from === from && preset.to === to);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <PopUpButton
        aria-label="Period"
        value={active?.key ?? CUSTOM}
        disabled={pending}
        options={[
          ...presets.map((p) => ({ value: p.key, label: p.label })),
          ...(active ? [] : [{ value: CUSTOM, label: `${from} – ${to}` }]),
        ]}
        onValueChange={(key) => {
          const preset = presets.find((p) => p.key === key);
          if (preset) startTransition(() => router.push(href(path, preset.from, preset.to, groupBy), { scroll: false }));
        }}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label="Custom range"
          className="grid size-[26px] place-items-center rounded-[7px] bg-ctl text-label2 shadow-ctl outline-none focus-ring hover:text-label max-sm:size-11"
        >
          <Glyph name="calendar" size={14} />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-3">
          <form method="get" action={path} className="flex flex-col gap-3" onSubmit={() => setOpen(false)}>
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              From
              <DateInput name="from" defaultValue={from} />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              To
              <DateInput name="to" defaultValue={to} />
            </label>
            <input type="hidden" name="by" value={groupBy} />
            <Button type="submit" size="sm" className="self-end">
              Apply
            </Button>
          </form>
        </PopoverContent>
      </Popover>
      <span className="flex-1" />
      <SegmentedNav
        aria-label="Margin by"
        current={groupBy}
        items={GROUPS.map((g) => ({ value: g.value, label: g.label, href: href(path, from, to, g.value) }))}
      />
    </div>
  );
}

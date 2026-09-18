import * as React from "react";

import { IconBadge } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";
import type { GlyphName } from "@/lib/ui/glyphs";
import type { Tint } from "@/lib/ui/tints";

export interface EntryFlowNode {
  label: string;
  glyph: GlyphName;
  tint: Tint;
  cents: number;
}

function Nodes({ nodes, caption, align }: { nodes: readonly EntryFlowNode[]; caption: string; align: "start" | "end" }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", align === "end" && "md:items-stretch")}>
      {nodes.map((n) => (
        <div key={n.label} className="flex min-w-0 items-center gap-2.5">
          <IconBadge glyph={n.glyph} tint={n.tint} />
          <span className="min-w-0 flex-1 leading-tight">
            <b className="block truncate text-sm font-semibold">{n.label}</b>
            {nodes.length > 1 ? <Money cents={n.cents} currency plain className="text-xs font-medium text-label2" /> : null}
          </span>
        </div>
      ))}
      <small className="pl-[32px] text-2xs font-medium text-label2">{caption}</small>
    </div>
  );
}

/**
 * The flow diagram for an entry with several accounts on both sides — a production run's costing,
 * a tie-out adjustment: the credited accounts, one arrow carrying the entry's total, the debited
 * accounts. Same shapes and captions as the kit's FlowDiagram, which draws the one-credit case.
 * Place it on a card.
 */
export function EntryFlow({
  from,
  to,
  className,
}: {
  from: readonly EntryFlowNode[];
  to: readonly EntryFlowNode[];
  className?: string;
}) {
  const total = to.reduce((s, n) => s + n.cents, 0);
  const sentence = `Posting moves ${dollars(total)} from ${from.map((n) => `${n.label} ${dollars(n.cents)}`).join(", ")} (credit) to ${to
    .map((n) => `${n.label} ${dollars(n.cents)}`)
    .join(", ")} (debit).`;
  return (
    <figure data-slot="entry-flow" className={cn("min-w-0", className)}>
      <figcaption className="sr-only">{sentence}</figcaption>
      <div aria-hidden className="grid items-center gap-x-3.5 gap-y-1 md:grid-cols-[minmax(0,1fr)_minmax(90px,0.7fr)_minmax(0,1fr)]">
        <Nodes nodes={from} caption="Credit" align="start" />
        <div className="relative grid h-[30px] place-items-center max-md:h-10 max-md:w-full max-md:justify-items-start">
          <i className="absolute top-1/2 right-1.5 left-0 border-t-[1.5px] border-label3 max-md:top-0 max-md:right-auto max-md:bottom-1.5 max-md:left-[10px] max-md:border-t-0 max-md:border-l-[1.5px]" />
          <i className="absolute top-1/2 right-0 -mt-[4.5px] border-y-[4.5px] border-l-8 border-y-transparent border-l-label3 max-md:top-auto max-md:right-auto max-md:bottom-0 max-md:left-[5.5px] max-md:mt-0 max-md:border-x-[4.5px] max-md:border-t-8 max-md:border-b-0 max-md:border-x-transparent max-md:border-t-label3" />
          <span className="relative z-[1] bg-card px-2 text-sm font-semibold max-md:ml-7 max-md:px-0">
            <Money cents={total} currency plain />
          </span>
        </div>
        <Nodes nodes={to} caption="Debit" align="end" />
      </div>
    </figure>
  );
}

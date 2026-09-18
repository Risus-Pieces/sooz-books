import * as React from "react";

import { cn } from "@/lib/cn";
import { IconBadge } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import type { GlyphName } from "@/lib/ui/glyphs";
import { dollars } from "@/lib/ui/format";
import type { Tint } from "@/lib/ui/tints";

export interface FlowNode {
  /** "Relay ••9726", "Office Supplies". */
  label: string;
  glyph: GlyphName;
  tint: Tint;
}

export interface FlowTarget extends FlowNode {
  cents: number;
}

export interface FlowDiagramProps {
  /** The credited account: where the money comes from. */
  from: FlowNode;
  /** The debited account(s). One target draws one arrow; a split draws one arrow per line. */
  to: FlowTarget[];
  /** Captions under the nodes; plain words, not Dr/Cr. */
  fromCaption?: string;
  toCaption?: string;
  className?: string;
}

function Node({ node, caption }: { node: FlowNode; caption: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <IconBadge glyph={node.glyph} tint={node.tint} />
      <div className="min-w-0 leading-tight">
        <b className="block truncate font-semibold">{node.label}</b>
        <small className="text-2xs font-medium text-label2">{caption}</small>
      </div>
    </div>
  );
}

function Arrow({ cents }: { cents: number }) {
  return (
    <div aria-hidden className="relative grid h-[30px] min-w-[90px] flex-1 place-items-center max-sm:h-10 max-sm:w-[30px] max-sm:min-w-0 max-sm:flex-none max-sm:justify-items-start">
      <i className="absolute top-1/2 right-1.5 left-0 border-t-[1.5px] border-label3 max-sm:top-0 max-sm:right-auto max-sm:bottom-1.5 max-sm:left-[10px] max-sm:border-t-0 max-sm:border-l-[1.5px]" />
      <i className="absolute top-1/2 right-0 -mt-[4.5px] border-y-[4.5px] border-l-8 border-y-transparent border-l-label3 max-sm:top-auto max-sm:right-auto max-sm:bottom-0 max-sm:left-[5.5px] max-sm:mt-0 max-sm:border-x-[4.5px] max-sm:border-t-8 max-sm:border-b-0 max-sm:border-x-transparent max-sm:border-t-label3" />
      <span className="relative z-[1] bg-card px-2 text-sm font-semibold max-sm:ml-7 max-sm:px-0">
        <Money cents={cents} currency plain />
      </span>
    </div>
  );
}

/**
 * What posting will do, drawn: [source] Relay ••9726 —— $26.07 ——▶ [category] Office Supplies,
 * captioned "Credit" and "Debit". Use it wherever one entry is previewed before it posts. Place it
 * on a card (it paints the amount's backing in the card colour).
 */
export function FlowDiagram({ from, to, fromCaption = "Credit", toCaption = "Debit", className }: FlowDiagramProps) {
  const sentence = `Posting moves ${to.map((t) => `${dollars(t.cents)} to ${t.label} (${toCaption.toLowerCase()})`).join(", ")} from ${from.label} (${fromCaption.toLowerCase()}).`;
  return (
    <figure data-slot="flow-diagram" className={cn("min-w-0", className)}>
      <figcaption className="sr-only">{sentence}</figcaption>
      <div aria-hidden className="flex items-center gap-3.5 max-sm:flex-col max-sm:items-start max-sm:gap-0">
        <Node node={from} caption={fromCaption} />
        {to.length === 1 ? (
          <>
            <Arrow cents={to[0].cents} />
            <Node node={to[0]} caption={toCaption} />
          </>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 max-sm:w-full">
            {to.map((t) => (
              <div key={`${t.label}-${t.cents}`} className="flex min-w-0 items-center gap-3.5 max-sm:flex-col max-sm:items-start max-sm:gap-0">
                <Arrow cents={t.cents} />
                <Node node={t} caption={toCaption} />
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}

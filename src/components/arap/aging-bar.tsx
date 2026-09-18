import * as React from "react";

import { SplitBar } from "@/components/charts";
import { Dot } from "@/components/ui/icon-badge";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";
import type { Tint } from "@/lib/ui/tints";

import { BUCKETS, type AgingBuckets, type Bucket } from "./types";

/** Each age bucket's word and colour: calm while current, warmer as it ages. */
export const BUCKET_META: Readonly<Record<Bucket, { label: string; long: string; tint: Tint }>> = {
  current: { label: "Current", long: "Not yet due", tint: "blue" },
  days1to30: { label: "1–30", long: "1 to 30 days late", tint: "orange" },
  days31to60: { label: "31–60", long: "31 to 60 days late", tint: "red" },
  days61to90: { label: "61–90", long: "61 to 90 days late", tint: "pink" },
  over90: { label: "90+", long: "Over 90 days late", tint: "purple" },
};

function spoken(buckets: AgingBuckets): string {
  return BUCKETS.map((b) => `${BUCKET_META[b].long} ${dollars(buckets[b])}`).join(", ");
}

/** What is owed, one bar split by how late it is. */
export function AgingBar({
  buckets,
  className,
  thin,
}: {
  buckets: AgingBuckets;
  className?: string;
  /** A 6px bar for a list row; the default is the 12px card bar. */
  thin?: boolean;
}) {
  const segments = BUCKETS.map((b) => ({ label: b, value: Math.max(0, buckets[b]), tint: BUCKET_META[b].tint }));
  if (segments.every((s) => s.value === 0)) {
    return <div aria-hidden className={cn("rounded-[4px] bg-fill", thin ? "h-1.5" : "h-3", className)} />;
  }
  return (
    <SplitBar
      label={spoken(buckets)}
      segments={segments}
      className={cn(thin ? "h-1.5 [&>i]:rounded-[3px]" : "h-3 [&>i]:rounded-[5px]", className)}
    />
  );
}

/** The five buckets as a legend with their figures: a dot, a word, the amount. */
export function AgingLegend({ buckets, className }: { buckets: AgingBuckets; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-5 gap-3 max-sm:grid-cols-3 max-sm:gap-y-3", className)}>
      {BUCKETS.map((b) => (
        <div key={b} className="min-w-0">
          <dt className="flex items-center gap-1.5 text-xs font-medium text-label2">
            <Dot tint={BUCKET_META[b].tint} size={7} />
            {BUCKET_META[b].label}
          </dt>
          <dd className="mt-0.5 truncate text-sm font-semibold">
            <Money cents={buckets[b]} currency plain zeroDash />
          </dd>
        </div>
      ))}
    </dl>
  );
}

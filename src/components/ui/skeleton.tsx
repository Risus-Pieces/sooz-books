import * as React from "react";

import { cn } from "@/lib/cn";

export function Skeleton({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div data-slot="skeleton" aria-hidden className={cn("animate-shimmer rounded-[6px] bg-fill", className)} {...props} />
  );
}

/** Placeholder that keeps a list's row rhythm while its data loads. */
export function SkeletonRows({
  rows = 6,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className={cn("flex items-center gap-4 px-4 py-3", r > 0 && "hairline-t")}>
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton
              key={c}
              className={cn("h-3", c === 0 ? "w-24" : c === columns - 1 ? "ml-auto w-16" : "w-full max-w-48")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

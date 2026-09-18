import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/cn";

/**
 * A small rounded-square tag: "Equity", "7 payouts", "Draft". Quiet by default; a tone only when
 * the state is the point (posted, overdue, closed). Never uppercase.
 */
const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 rounded-[6px] font-semibold whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-fill2 text-label2",
        primary: "bg-tint-blue/12 text-ink-blue",
        positive: "bg-tint-green/12 text-ink-green",
        negative: "bg-tint-red/12 text-ink-red",
        warning: "bg-tint-orange/14 text-ink-orange",
        info: "bg-tint-blue/12 text-ink-blue",
        outline: "bg-transparent text-label2 shadow-[inset_0_0_0_0.5px_var(--sep-strong)]",
      },
      size: {
        sm: "h-4 px-1.5 text-[0.6875rem] leading-none",
        md: "h-[1.125rem] px-[7px] text-[0.6875rem] leading-none",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  },
);

export interface BadgeProps
  extends React.ComponentPropsWithRef<"span">,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}

export { badgeVariants };

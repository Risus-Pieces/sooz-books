import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-xs border px-1.5 py-px text-2xs font-semibold tracking-wide whitespace-nowrap uppercase [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "border-border-strong/70 bg-muted text-muted-foreground",
        primary: "border-primary/35 bg-primary/10 text-primary",
        positive: "border-positive/35 bg-positive/10 text-positive",
        negative: "border-negative/35 bg-negative/10 text-negative",
        warning: "border-warning/35 bg-warning/10 text-warning",
        info: "border-info/35 bg-info/10 text-info",
        outline: "border-border-strong bg-transparent text-foreground",
      },
      size: {
        sm: "px-1 text-[0.5625rem]",
        md: "px-1.5 text-2xs",
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

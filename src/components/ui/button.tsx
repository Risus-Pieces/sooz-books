import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border font-medium transition-colors outline-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover",
        secondary:
          "border-border-strong bg-surface-raised text-foreground hover:bg-muted active:bg-muted",
        outline: "border-border-strong bg-transparent text-foreground hover:bg-muted",
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        danger: "border-negative bg-negative text-background hover:brightness-95",
        "danger-quiet":
          "border-negative/35 bg-negative/8 text-negative hover:border-negative/60 hover:bg-negative/14",
        link: "h-auto border-transparent bg-transparent p-0 text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary",
      },
      size: {
        // Below the `sm` breakpoint every size grows to a 40px touch target. The `max-sm:`
        // prefix keeps that from overriding a caller's own height on a desktop screen.
        sm: "h-7 px-2.5 text-xs max-sm:h-10 max-sm:px-3 [&_svg]:size-3.5",
        md: "h-8 px-3 text-sm max-sm:h-10 [&_svg]:size-4",
        lg: "h-9 px-4 text-sm max-sm:h-10 [&_svg]:size-4",
        icon: "size-8 max-sm:size-10 [&_svg]:size-4",
        "icon-sm": "size-7 max-sm:size-10 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends React.ComponentPropsWithRef<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };

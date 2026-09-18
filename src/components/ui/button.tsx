import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/cn";

/**
 * macOS push buttons. `default` is the one blue button a view may have; `secondary` the white
 * bezel beside it; `ghost` a borderless toolbar-style button. Below the `sm` breakpoint every size
 * grows to a 44px touch target (the `max-sm:` prefix keeps a caller's own desktop height intact).
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-[7px] whitespace-nowrap font-medium transition-[background-color,box-shadow,color] duration-150 ease-out select-none outline-none focus-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-accent-fill font-semibold text-white shadow-[0_1px_2px_rgba(0,122,255,0.3)] hover:bg-accent-fill-hover active:bg-accent-fill-hover [&_kbd]:bg-white/20 [&_kbd]:text-white [&_kbd]:shadow-none",
        secondary:
          "bg-ctl text-label shadow-ctl hover:bg-[color-mix(in_srgb,var(--ctl)_94%,var(--label))] active:bg-[color-mix(in_srgb,var(--ctl)_88%,var(--label))]",
        outline:
          "bg-transparent text-label shadow-[inset_0_0_0_0.5px_var(--sep-strong)] hover:bg-fill2 active:bg-fill",
        ghost: "bg-transparent text-label2 hover:bg-fill2 hover:text-label active:bg-fill",
        danger:
          "bg-danger-fill font-semibold text-white shadow-[0_1px_2px_rgba(215,0,21,0.25)] hover:brightness-95 active:brightness-90",
        "danger-quiet": "bg-tint-red/10 text-ink-red hover:bg-tint-red/16 active:bg-tint-red/20",
        link: "h-auto bg-transparent p-0 text-ink-blue underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-7 rounded-[8px] px-2.5 text-xs max-sm:h-11 max-sm:px-3.5 max-sm:text-sm [&_svg]:size-3.5",
        md: "h-8 rounded-[9px] px-3 text-sm max-sm:h-11 max-sm:px-4 [&_svg]:size-[15px]",
        lg: "h-9 rounded-[10px] px-4 text-sm max-sm:h-11 [&_svg]:size-4",
        icon: "size-8 rounded-[9px] max-sm:size-11 [&_svg]:size-4",
        "icon-sm": "size-7 rounded-[8px] max-sm:size-11 [&_svg]:size-3.5",
      },
    },
    compoundVariants: [{ variant: "link", className: "h-auto max-sm:h-auto px-0 max-sm:px-0" }],
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

import * as React from "react";

import { cn } from "@/lib/cn";
import { initials } from "@/lib/ui/format";

export interface MonogramProps extends Omit<React.ComponentPropsWithRef<"span">, "children"> {
  /** The payee, vendor or customer. Initials are taken from it. */
  name: string;
  /** 36px in lists, 56px at the head of a detail pane, 28px compact. */
  size?: "sm" | "md" | "lg";
}

const sizes = {
  sm: "size-7 text-xs",
  md: "size-9 text-[0.8125rem]",
  lg: "size-14 text-xl",
} as const;

/**
 * Contacts-style initials in a grey disc. Decorative: the name is always written beside it, so the
 * disc is hidden from assistive technology.
 */
export function Monogram({ name, size = "md", className, ...props }: MonogramProps) {
  return (
    <span
      data-slot="monogram"
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold tracking-[0.02em] text-white",
        "bg-[linear-gradient(180deg,var(--mono1),var(--mono2))]",
        sizes[size],
        className,
      )}
      {...props}
    >
      {initials(name) || "?"}
    </span>
  );
}

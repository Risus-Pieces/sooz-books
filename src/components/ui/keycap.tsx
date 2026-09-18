import * as React from "react";

import { cn } from "@/lib/cn";

/** One key, as the macOS menus draw it. */
export function Kbd({ className, ...props }: React.ComponentPropsWithRef<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-grid h-[18px] min-w-[18px] place-items-center rounded-[5px] bg-fill2 px-1 font-sans text-[0.6875rem] leading-none font-medium text-label2 shadow-[inset_0_0_0_0.5px_var(--sep)]",
        className,
      )}
      {...props}
    />
  );
}

export interface KeyLegendItem {
  keys: string;
  label: string;
}

/**
 * The footer of a keyboard-driven screen (Review): each shortcut as a key and one word. Hidden on
 * touch screens, where there is no keyboard to press.
 */
export function KeyLegend({ items, className }: { items: KeyLegendItem[]; className?: string }) {
  return (
    <footer
      data-slot="key-legend"
      aria-label="Keyboard shortcuts"
      className={cn(
        "flex flex-wrap justify-center gap-x-4 gap-y-1.5 px-5 pt-3.5 pb-4.5 text-2xs font-medium text-label2 max-md:hidden",
        className,
      )}
    >
      {items.map((item) => (
        <span key={`${item.keys}-${item.label}`} className="inline-flex items-center gap-[5px]">
          <Kbd>{item.keys}</Kbd>
          {item.label}
        </span>
      ))}
    </footer>
  );
}

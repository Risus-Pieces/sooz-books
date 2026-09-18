import * as React from "react";

import { cn } from "@/lib/cn";

import { Glyph } from "./glyph";

export interface SearchFieldProps extends Omit<React.ComponentPropsWithRef<"input">, "type"> {
  /** `plain` — the grey field in a list header or sidebar. `toolbar` — the glass capsule in a toolbar. */
  appearance?: "plain" | "toolbar";
  className?: string;
  inputClassName?: string;
}

/**
 * A search field. Works inside a GET <form> (give it a `name`) or controlled. The placeholder is
 * always just "Search".
 */
export function SearchField({
  appearance = "plain",
  className,
  inputClassName,
  placeholder = "Search",
  "aria-label": ariaLabel,
  ...props
}: SearchFieldProps) {
  return (
    <label
      data-slot="search-field"
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-label2 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--blue)_45%,transparent)]",
        appearance === "plain" && "h-7 rounded-[8px] bg-fill2 px-2 max-sm:h-9 max-sm:rounded-[10px] max-sm:bg-fill",
        appearance === "toolbar" && "h-[34px] w-[220px] rounded-full vibrancy px-3 shadow-glass max-md:h-11 max-md:w-full",
        className,
      )}
    >
      <Glyph name="search" size={14} className="max-sm:size-4" />
      <input
        type="search"
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-sm text-label outline-none placeholder:text-label2 max-sm:text-[1rem] [&::-webkit-search-cancel-button]:opacity-60",
          inputClassName,
        )}
        {...props}
      />
    </label>
  );
}

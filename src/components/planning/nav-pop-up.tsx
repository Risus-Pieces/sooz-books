"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { PopUpButton } from "@/components/ui/pop-up-button";
import type { Tint } from "@/lib/ui/tints";

export interface NavPopUpOption {
  value: string;
  label: string;
  href: string;
  tint?: Tint;
}

/**
 * A pop-up button whose choice lives in the URL: choosing a budget version or a variance period
 * navigates to it, so the view can be bookmarked or sent to the accountant.
 */
export function NavPopUp({
  options,
  value,
  "aria-label": ariaLabel,
  appearance = "bezel",
}: {
  options: readonly NavPopUpOption[];
  value: string;
  "aria-label": string;
  appearance?: "bezel" | "toolbar";
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <PopUpButton
      aria-label={ariaLabel}
      appearance={appearance}
      value={value}
      disabled={pending}
      options={options.map((o) => ({ value: o.value, label: o.label, tint: o.tint }))}
      onValueChange={(next) => {
        const target = options.find((o) => o.value === next);
        if (target) startTransition(() => router.push(target.href, { scroll: false }));
      }}
    />
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { PopUpButton } from "@/components/ui/pop-up-button";

/** The tax year as a toolbar pop-up: choosing one reloads the page for that year. */
export function YearPicker({
  years,
  year,
  hrefFor,
}: {
  years: readonly number[];
  year: number;
  /** The page URL for a year, keeping the other settings. */
  hrefFor: Record<string, string>;
}) {
  const router = useRouter();
  return (
    <PopUpButton
      aria-label="Tax year"
      appearance="toolbar"
      value={String(year)}
      options={years.map((y) => ({ value: String(y), label: String(y) }))}
      onValueChange={(value) => {
        const href = hrefFor[value];
        if (href) router.push(href);
      }}
    />
  );
}

"use client";

import * as React from "react";
import { Check, ClipboardCopy } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface CopyReportButtonProps {
  /** The export route with `format=tsv`. Fetched on click rather than shipped with the page. */
  href: string;
}

/**
 * Puts the statement on the clipboard as tab-separated text, which is what a
 * spreadsheet wants: paste and every figure lands in its own cell, no import
 * dialog, no re-typing.
 *
 * The rows are fetched when the button is pressed. Embedding them in the page
 * would double the weight of every report for a feature most readers never use.
 */
export function CopyReportButton({ href }: CopyReportButtonProps) {
  const [state, setState] = React.useState<"idle" | "busy" | "done" | "failed">("idle");

  const copy = React.useCallback(async () => {
    setState("busy");
    try {
      const response = await fetch(href, { headers: { accept: "text/tab-separated-values" } });
      if (!response.ok) throw new Error(`Export failed with ${response.status}`);
      await navigator.clipboard.writeText(await response.text());
      setState("done");
      window.setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("failed");
      window.setTimeout(() => setState("idle"), 3000);
    }
  }, [href]);

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={copy}
      disabled={state === "busy"}
      title="Copy the statement as tab-separated text"
    >
      {state === "done" ? <Check aria-hidden /> : <ClipboardCopy aria-hidden />}
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </Button>
  );
}

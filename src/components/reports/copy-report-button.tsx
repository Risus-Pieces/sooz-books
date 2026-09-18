"use client";

import * as React from "react";

import { toast } from "@/components/ui/toast";
import { ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";

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
  const [state, setState] = React.useState<"idle" | "busy" | "done">("idle");

  const copy = React.useCallback(async () => {
    setState("busy");
    try {
      const response = await fetch(href, { headers: { accept: "text/tab-separated-values" } });
      if (!response.ok) throw new Error(`Export failed with ${response.status}`);
      await navigator.clipboard.writeText(await response.text());
      setState("done");
      toast.success("Copied for a spreadsheet");
      window.setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("idle");
      toast.error("Copy failed");
    }
  }, [href]);

  return (
    <ToolbarButton
      glyph={state === "done" ? "check" : "doc"}
      label={state === "done" ? "Copied" : "Copy as table"}
      disabled={state === "busy"}
      onClick={copy}
    />
  );
}

/** Export and copy, the report's toolbar group. Export is a plain download of the CSV route. */
export function ReportFileActions({ csvHref, copyHref }: { csvHref: string; copyHref: string }) {
  return (
    <ToolbarGroup>
      <CopyReportButton href={copyHref} />
      <ToolbarButton glyph="export" label="Export CSV" onClick={() => window.location.assign(csvHref)} />
    </ToolbarGroup>
  );
}

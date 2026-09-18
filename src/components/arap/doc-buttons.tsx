"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar";

import type { ActionResult, DocRef } from "./types";

/** Opens the browser's print dialog; the invoice sheet's print stylesheet does the rest. */
export function PrintButton({ label = "Print or save PDF" }: { label?: string }) {
  return <ToolbarButton glyph="printer" label={label} shortcut="⌘P" onClick={() => window.print()} />;
}

/**
 * The one-click step that takes a draft into the ledger: issuing an invoice or approving a bill.
 * It posts, so it says so before it does.
 */
export function PostDocButton({
  label,
  done,
  confirmText,
  icon,
  onPost,
}: {
  label: string;
  /** Past tense for the toast: "INV-1001 issued". */
  done: string;
  confirmText: string;
  icon: "send" | "approve";
  onPost: () => Promise<ActionResult<DocRef>>;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() => {
        if (!window.confirm(confirmText)) return;
        start(async () => {
          const result = await onPost();
          if (!result.ok) {
            toast.error(`${label} failed`, { description: result.error.message });
            return;
          }
          toast.success(`${result.value.docNo} ${done}`);
          router.refresh();
        });
      }}
    >
      <Glyph name={icon === "send" ? "arrow-out" : "check"} size={15} weight={2} />
      {label}
    </Button>
  );
}

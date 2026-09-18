"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Printer, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

import type { ActionResult, DocRef } from "./types";

/** Opens the browser's print dialog; the invoice sheet's print stylesheet does the rest. */
export function PrintButton({ label = "Print / PDF" }: { label?: string }) {
  return (
    <Button variant="secondary" size="sm" onClick={() => window.print()}>
      <Printer />
      {label}
    </Button>
  );
}

/**
 * The one-click step that takes a draft into the ledger: issuing an invoice or
 * approving a bill. It posts, so it says so before it does.
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
      size="sm"
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
      {icon === "send" ? <Send /> : <CheckCheck />}
      {label}
    </Button>
  );
}

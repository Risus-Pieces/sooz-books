"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { postAutoPostRows } from "@/app/(app)/banking/actions";

import { ConfirmDialog, type ConfirmRequest } from "./review-dialogs";

/**
 * Posts what the owner's auto-post rules already coded. One deliberate click, with a
 * confirmation that states how many and how much.
 */
export function AutoPostButton({ count, netCents, className }: { count: number; netCents: number; className?: string }) {
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null);
  const [pending, startTransition] = React.useTransition();
  if (count === 0) return null;
  return (
    <>
      <Button
        size="sm"
        className={className}
        disabled={pending}
        onClick={() =>
          setRequest({
            title: "Post auto-post rows",
            confirmLabel: `Post ${count}`,
            body: (
              <p>
                Post the {count} transaction{count === 1 ? "" : "s"} your auto-post rules coded, net{" "}
                <Money cents={netCents} currency signed colorPositive />. Each posts to the account its rule names.
              </p>
            ),
            onConfirm: () =>
              startTransition(async () => {
                const result = await postAutoPostRows();
                if (!result.ok) {
                  toast.error(result.error.message);
                  return;
                }
                toast.success(`Posted ${result.value.posted} auto-post transaction${result.value.posted === 1 ? "" : "s"}`);
                if (result.value.failed.length > 0) {
                  toast.error(`${result.value.failed.length} could not post. ${result.value.failed[0]}`);
                }
              }),
          })
        }
      >
        <Glyph name="wand" />
        Post {count} auto-post
      </Button>
      <ConfirmDialog request={request} onClose={() => setRequest(null)} />
    </>
  );
}

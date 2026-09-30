"use client";

import * as React from "react";

import {
  editProposal,
  listWaitingReceipts,
  postAllProposals,
  postProposal,
  sendChatMessage,
  skipProposal,
} from "@/app/(app)/receipts/actions";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import type { ProposalView } from "@/lib/receipts/types";

import { markPosted, mergeWaiting, nextCardKey, postableProposals, replaceProposal, settleUpload } from "./cards";
import { ReceiptCard } from "./receipt-card";
import type { CardState, PayerOption } from "./types";

/** iPhone Safari converts HEIC to JPEG when the list names JPEG and omits HEIC, so it is left out on purpose. */
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,application/pdf";
const PARALLEL_UPLOADS = 3;
const MAX_FILES = 10;

type UploadReply = { proposal?: ProposalView; alreadyFiled?: boolean; error?: string };

/**
 * The receipt assistant: drop receipts, check each proposed entry, tap Post.
 *
 * Nothing here posts by itself. The sheet holds cards; a card posts only when its own Post
 * button is pressed, or when Post all is pressed for the cards with nothing to check.
 */
export function ReceiptAssistant({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [cards, setCards] = React.useState<CardState[]>([]);
  const [payers, setPayers] = React.useState<PayerOption[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState("");
  const [replies, setReplies] = React.useState<string[]>([]);
  const [chatBusy, setChatBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  // Load what is still waiting the first time the sheet opens. Nothing is set synchronously here.
  React.useEffect(() => {
    if (!open || loaded || loadFailed) return;
    let cancelled = false;
    void listWaitingReceipts().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadFailed(true);
        toast.error("Could not load receipts", { description: result.error.message });
        return;
      }
      setPayers(result.value.payers);
      setCards((current) => mergeWaiting(current, result.value.proposals));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, loaded, loadFailed]);

  const uploadOne = React.useCallback(async (file: File, key: string) => {
    let outcome: { proposal: ProposalView } | { error: string };
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/receipts/upload", { method: "POST", body });
      const data = (await response.json().catch(() => ({}))) as UploadReply;
      outcome =
        response.ok && data.proposal ? { proposal: data.proposal } : { error: data.error ?? "Could not upload this file." };
      if (response.ok && data.proposal) {
        setSelectedKey(data.proposal.id);
        if (data.alreadyFiled) {
          toast(
            data.proposal.status === "posted" ? `Already posted as entry #${data.proposal.entryNo}` : "Already filed",
          );
        }
      }
    } catch {
      outcome = { error: "Could not reach the server. Check your connection and try again." };
    }
    setCards((current) => settleUpload(current, key, file.name, outcome));
  }, []);

  const uploadFiles = React.useCallback(
    (chosen: File[]) => {
      if (chosen.length === 0) return;
      if (chosen.length > MAX_FILES) toast(`Up to ${MAX_FILES} receipts at a time. Taking the first ${MAX_FILES}.`);
      const files = chosen.slice(0, MAX_FILES);
      const entries = files.map((file) => ({ file, key: nextCardKey() }));
      setCards((current) => [
        ...entries.map((e): CardState => ({ key: e.key, kind: "uploading", filename: e.file.name })),
        ...current,
      ]);
      const queue = [...entries];
      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) await uploadOne(item.file, item.key);
      };
      void Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, entries.length) }, worker));
    },
    [uploadOne],
  );

  const patch = (id: string, next: ProposalView) => setCards((current) => replaceProposal(current, id, next));
  const dismiss = (key: string) => {
    setCards((current) => current.filter((c) => c.key !== key));
    setSelectedKey((current) => (current === key ? null : current));
  };

  const onPost = async (proposal: ProposalView, confirmedNew: boolean) => {
    setBusyKey(proposal.id);
    const result = await postProposal(proposal.id, confirmedNew);
    setBusyKey(null);
    if (!result.ok) {
      toast.error("Not posted", { description: result.error.message });
      return;
    }
    setCards((current) => markPosted(current, [{ id: proposal.id, ...result.value }]));
    toast.success(`Posted entry #${result.value.entryNo}`);
  };

  const onSkip = async (proposal: ProposalView) => {
    setBusyKey(proposal.id);
    const result = await skipProposal(proposal.id);
    setBusyKey(null);
    if (!result.ok) {
      toast.error("Not skipped", { description: result.error.message });
      return;
    }
    patch(proposal.id, { ...proposal, status: "skipped", canPost: false });
  };

  const onPayer = async (proposal: ProposalView, userId: string) => {
    setBusyKey(proposal.id);
    const result = await editProposal(proposal.id, { kind: "set_payer", who: userId });
    setBusyKey(null);
    if (!result.ok) {
      toast.error("Not changed", { description: result.error.message });
      return;
    }
    patch(proposal.id, result.value.view);
  };

  const postable = postableProposals(cards);
  const onPostAll = async () => {
    setBusyKey("all");
    const result = await postAllProposals(postable.map((p) => p.id));
    setBusyKey(null);
    if (!result.ok) {
      toast.error("Not posted", { description: result.error.message });
      return;
    }
    const { posted, failed } = result.value;
    setCards((current) => markPosted(current, posted));
    if (posted.length > 0) toast.success(`Posted ${posted.length} ${posted.length === 1 ? "receipt" : "receipts"}`);
    if (failed.length > 0) toast.error(`${failed.length} not posted`, { description: failed[0].message });
  };

  const selected = cards.find((c) => c.key === selectedKey);
  const selectedProposal = selected?.kind === "proposal" && selected.proposal.status === "proposed" ? selected.proposal : null;

  const onSend = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selectedProposal === null || message.trim() === "") return;
    setChatBusy(true);
    const result = await sendChatMessage(selectedProposal.id, message);
    setChatBusy(false);
    if (!result.ok) {
      toast.error("Could not do that", { description: result.error.message });
      return;
    }
    patch(selectedProposal.id, result.value.view);
    setReplies(result.value.replies);
    setMessage("");
  };

  const select = (key: string) => {
    setSelectedKey(key);
    setReplies([]);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="Receipts" description="Drop receipts to propose journal entries." width="md">
        <div
          className="flex min-h-full flex-col gap-3"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            uploadFiles([...event.dataTransfer.files]);
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length === 0) return;
            event.preventDefault();
            uploadFiles(files);
          }}
        >
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className={cn(
              "flex flex-col items-center justify-center gap-1.5 rounded-[14px] py-7 text-sm text-label2 shadow-[inset_0_0_0_1px_var(--sep-strong)] transition-colors hover:bg-fill2",
              dragging && "bg-fill2",
            )}
          >
            <Glyph name="import" size={22} />
            <span>Drop receipts, or choose</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            className="sr-only"
            aria-label="Choose receipts"
            onChange={(event) => {
              uploadFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />

          {cards.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {cards.map((card) => (
                <li key={card.key}>
                  <ReceiptCard
                    card={card}
                    payers={payers}
                    selected={card.key === selectedKey}
                    busy={busyKey === "all" || (card.kind === "proposal" && busyKey === card.proposal.id)}
                    onSelect={() => select(card.key)}
                    onPost={(confirmedNew) => card.kind === "proposal" && void onPost(card.proposal, confirmedNew)}
                    onSkip={() => card.kind === "proposal" && void onSkip(card.proposal)}
                    onPayer={(userId) => card.kind === "proposal" && void onPayer(card.proposal, userId)}
                    onDismiss={() => dismiss(card.key)}
                  />
                </li>
              ))}
            </ul>
          ) : loaded ? (
            <p className="py-6 text-center text-sm text-label3">Nothing waiting.</p>
          ) : null}

          {postable.length > 1 ? (
            <Button onClick={() => void onPostAll()} disabled={busyKey !== null}>
              Post all {postable.length}
            </Button>
          ) : null}
        </div>

        <form
          onSubmit={(event) => void onSend(event)}
          className="sticky bottom-0 mt-3 flex flex-col gap-1.5 bg-bg/90 pt-2 pb-1 backdrop-blur"
        >
          {selectedProposal ? (
            <p className="truncate text-xs text-label2">Editing {selectedProposal.vendorName ?? selectedProposal.filename}</p>
          ) : null}
          {replies.map((reply) => (
            <p key={reply} className="text-xs">
              {reply}
            </p>
          ))}
          <div className="flex gap-2">
            <Input
              aria-label="Tell me what to change"
              placeholder="e.g. the sugar is ingredients"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              disabled={selectedProposal === null || chatBusy}
            />
            <Button type="submit" disabled={selectedProposal === null || chatBusy || message.trim() === ""}>
              Send
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

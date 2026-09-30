"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { inputBase } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import { formatDateUS } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import type { ProposalView } from "@/lib/receipts/types";

import type { CardState, PayerOption } from "./types";

export interface ReceiptCardProps {
  card: CardState;
  payers: PayerOption[];
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onPost: (confirmedNew: boolean) => void;
  onSkip: () => void;
  onPayer: (userId: string) => void;
  onDismiss: () => void;
}

const shell = "flex flex-col gap-2.5 rounded-[14px] bg-card p-4 shadow-card";

/** One receipt: what it says, the entry it would make, and the two things a person can do about it. */
export function ReceiptCard(props: ReceiptCardProps) {
  const { card } = props;

  if (card.kind === "uploading") {
    return (
      <div className={cn(shell, "flex-row items-center gap-3")} aria-busy="true">
        <Glyph name="hourglass" size={18} className="shrink-0 text-label3" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{card.filename}</p>
          <p className="text-xs text-label2">Reading</p>
        </div>
      </div>
    );
  }

  if (card.kind === "failed") {
    return (
      <div className={cn(shell, "flex-row items-start gap-3")} role="alert">
        <Glyph name="warning" size={18} className="mt-0.5 shrink-0 text-ink-orange" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{card.filename}</p>
          <p className="text-xs text-label2">{card.message}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={props.onDismiss} aria-label={`Dismiss ${card.filename}`}>
          <Glyph name="xmark" />
        </Button>
      </div>
    );
  }

  return <ProposalCard {...props} proposal={card.proposal} />;
}

function ProposalCard({
  proposal,
  payers,
  selected,
  busy,
  onSelect,
  onPost,
  onSkip,
  onPayer,
  onDismiss,
}: ReceiptCardProps & { proposal: ProposalView }) {
  const waiting = proposal.status === "proposed";

  return (
    <section
      aria-label={proposal.vendorName ?? proposal.filename}
      className={cn(shell, waiting && selected && "ring-2 ring-tint-blue")}
    >
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[0.95rem] font-semibold">
            {proposal.vendorName ?? "Unknown vendor"}
            {proposal.vendorIsNew ? <span className="ml-1.5 text-xs font-normal text-label2">new</span> : null}
          </h3>
          <p className="truncate text-xs text-label2">
            {proposal.date ? formatDateUS(proposal.date) : "No date"} ·{" "}
            <a
              href={`/receipts/file/${proposal.attachmentId}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open receipt ${proposal.filename}`}
              className="hover:underline focus-visible:underline"
            >
              {proposal.filename}
            </a>
          </p>
        </div>
        <p className="num text-lg font-semibold">
          {proposal.totalCents === null ? "—" : formatMoney(proposal.totalCents)}
        </p>
      </header>

      {proposal.lines.length > 0 ? (
        <ul className="flex flex-col">
          {proposal.lines.map((line, i) => (
            <li key={i} className={cn("flex items-baseline gap-3 py-1.5 text-sm", i > 0 && "hairline-t")}>
              <div className="min-w-0 flex-1">
                <p className="truncate">{line.description}</p>
                <p className={cn("truncate text-xs", line.accountLabel ? "text-label2" : "text-ink-orange")}>
                  {line.accountLabel ?? "Choose an account"}
                </p>
              </div>
              <span className="num shrink-0">{formatMoney(line.cents)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {proposal.error ? (
        <p className="text-xs text-label2">
          {proposal.error}
          {proposal.warnings.some((w) => w.code === "no_model") ? "" : " Choose the file again to try once more."}
        </p>
      ) : null}
      {proposal.warnings.map((warning) => (
        <p
          key={warning.code}
          className={cn("flex items-start gap-1.5 text-xs", warning.blocking ? "text-ink-orange" : "text-label2")}
        >
          <Glyph name="warning" size={13} className="mt-px shrink-0" />
          {warning.message}
        </p>
      ))}

      {proposal.status === "posted" ? (
        <footer className="flex items-center gap-2">
          <Pill tone="green" glyph="check-circle">
            Posted
          </Pill>
          {proposal.entryId ? (
            <Link href={`/ledger/${proposal.entryId}`} className="text-sm text-ink-blue">
              Entry #{proposal.entryNo}
            </Link>
          ) : null}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onDismiss}>
            Done
          </Button>
        </footer>
      ) : proposal.status === "skipped" ? (
        <footer className="flex items-center gap-2">
          <Pill glyph="exclude">Skipped</Pill>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onDismiss}>
            Done
          </Button>
        </footer>
      ) : (
        <footer className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-label2">
            Paid by
            <select
              aria-label="Paid by"
              value={proposal.payerId ?? ""}
              disabled={busy}
              onChange={(event) => onPayer(event.target.value)}
              className={cn(inputBase, "h-8 w-auto max-w-40")}
            >
              <option value="" disabled>
                Choose
              </option>
              {payers.map((payer) => (
                <option key={payer.userId} value={payer.userId}>
                  {payer.name}
                </option>
              ))}
            </select>
          </label>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={onSkip} disabled={busy}>
              Skip
            </Button>
            <Button variant="outline" size="sm" onClick={onSelect} disabled={busy}>
              Edit
            </Button>
            <Button size="sm" onClick={() => onPost(proposal.needsConfirmation)} disabled={!proposal.canPost || busy}>
              {proposal.needsConfirmation ? "Post anyway" : "Post"}
            </Button>
          </div>
        </footer>
      )}
    </section>
  );
}

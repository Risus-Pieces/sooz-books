"use client";

import * as React from "react";

import { Glyph } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import type { Category } from "@/lib/ui/categories";

import { bankShortName } from "./queue-format";

import { FLAG_LABEL, SOURCE_LABEL, payeeOf, shortDate } from "./review-logic";
import type { AccountRef, QueueFlag, QueueRow, QueueStage } from "./types";

// ---------------------------------------------------------------------------
// The grouped list
// ---------------------------------------------------------------------------

/**
 * One month of the list. Beside a detail pane (≥1024px) the rows sit straight on the pane with a
 * small header, Mail-style; on a phone or tablet they are an inset grouped card under a larger one.
 */
export function ListSection({
  header,
  children,
  className,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0", className)}>
      <h3 className="px-4 pt-5 pb-1.5 text-sm font-semibold text-label2 lg:px-2.5 lg:pt-3 lg:pb-1 lg:text-2xs">{header}</h3>
      <ul className="flex flex-col overflow-hidden rounded-[14px] bg-card shadow-card lg:overflow-visible lg:rounded-none lg:bg-transparent lg:shadow-none">
        {children}
      </ul>
    </section>
  );
}

const rowSeparator =
  "relative before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-16 before:border-t-[0.5px] before:border-sep first:before:hidden lg:before:left-[57px] lg:before:right-2.5";

export interface QueueListItemProps {
  row: QueueRow;
  stage: QueueStage;
  account: AccountRef | null;
  category: Category | null;
  overridden: boolean;
  /** The row the detail shows. */
  current: boolean;
  /** Part of a multi-selection. */
  selected: boolean;
  /** Touch selection mode: a check circle leads the row. */
  selecting: boolean;
  onClick: (event: React.MouseEvent) => void;
  onToggle: (shift: boolean) => void;
}

/**
 * A queue row: monogram, payee, amount; the account's colour dot and name, what proposed it, any
 * flag, and the date. The selected row fills with the accent, as in Mail.
 */
export function QueueListItem({
  row,
  stage,
  account,
  category,
  overridden,
  current,
  selected,
  selecting,
  onClick,
  onToggle,
}: QueueListItemProps) {
  const payee = payeeOf(row);
  const filled = selected || current;
  const quiet = filled ? "text-white/88" : "text-label2";
  return (
    <li
      data-row-id={row.id}
      data-bank-mask={row.bankAccountMask ?? undefined}
      aria-current={current || undefined}
      data-selected={selected || undefined}
      onClick={onClick}
      className={cn(
        "flex cursor-default items-center gap-3 px-3.5 py-2.5 transition-colors duration-150 select-none lg:gap-[11px] lg:rounded-[10px] lg:px-2.5 lg:py-[9px]",
        rowSeparator,
        filled
          ? "bg-accent-fill text-white before:hidden [&+li]:before:hidden [&_[data-slot=dot]]:shadow-[0_0_0_1.5px_#fff] [&_[data-slot=monogram]]:bg-none [&_[data-slot=monogram]]:bg-white/22"
          : "hover:bg-fill2",
        current && selected && "shadow-[inset_0_0_0_2px_rgba(255,255,255,0.55)]",
      )}
    >
      {selecting ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${payee} ${shortDate(row.txnDate)}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(event.shiftKey);
          }}
          className={cn(
            "relative grid size-[22px] shrink-0 place-items-center rounded-full border-[1.5px] after:absolute after:-inset-3 after:content-['']",
            selected ? "border-white bg-white text-accent-fill" : "border-label3",
          )}
        >
          {selected ? <Glyph name="check" size={13} weight={2.6} /> : null}
        </button>
      ) : null}
      {row.status === "transfer" ? (
        <span
          aria-hidden
          className={cn(
            "grid size-[38px] shrink-0 place-items-center rounded-full text-white lg:size-9",
            filled ? "bg-white/22" : "bg-[linear-gradient(180deg,var(--mono1),var(--mono2))]",
          )}
        >
          <Glyph name="transfer" size={17} />
        </span>
      ) : (
        <Monogram name={payee} className="max-lg:size-[38px] max-lg:text-sm" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <b className="min-w-0 flex-1 truncate text-[1rem] font-semibold lg:text-sm">{payee}</b>
          <Money
            cents={row.amountCents}
            currency
            signed
            plain={row.amountCents < 0 || filled}
            colorPositive
            className={cn("shrink-0 text-[1rem] font-semibold lg:text-sm", filled && "text-white")}
          />
        </div>
        <div className={cn("mt-[3px] flex items-center gap-1.5 text-[0.8125rem] lg:text-xs", quiet)}>
          <AccountLine row={row} stage={stage} account={account} category={category} filled={filled} />
          <Marks row={row} stage={stage} overridden={overridden} filled={filled} />
          <span className={cn("ml-auto shrink-0 pl-1 whitespace-nowrap", filled ? "text-white/88" : "text-label2")}>
            {shortDate(row.txnDate)}
          </span>
        </div>
      </div>
    </li>
  );
}

function AccountLine({
  row,
  stage,
  account,
  category,
  filled,
}: {
  row: QueueRow;
  stage: QueueStage;
  account: AccountRef | null;
  category: Category | null;
  filled: boolean;
}) {
  if (row.status === "transfer") {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Glyph name="transfer" size={12} className={filled ? undefined : "text-tint-blue"} />
        <span className="truncate">
          Transfer {row.amountCents < 0 ? "to" : "from"}{" "}
          {row.transferPartner === null ? "another account" : bankShortName(row.transferPartner.bankAccountName)}
        </span>
      </span>
    );
  }
  if (account === null) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Dot tint="quiet" size={7} />
        <span className="truncate italic">Choose account</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Dot tint={category?.tint ?? "gray"} size={7} />
      <span className="truncate">{account.name}</span>
      {stage === "posted" && row.postedLineCount > 1 ? <span className="shrink-0">· Split</span> : null}
    </span>
  );
}

const FLAG_GLYPH: Partial<Record<QueueFlag, "flag" | "question" | "link" | "doc">> = {
  mixed_use: "flag",
  ask_accountant: "question",
  already_booked: "link",
  open_document: "doc",
};

/**
 * The small marks after the account: an AI sparkle (orange when unsure), the owner's own pick, and
 * a flag. Each carries its words for assistive technology; the words for a rule or history match
 * are read, not drawn — most rows have one, and a glyph on every row would be noise.
 */
function Marks({
  row,
  stage,
  overridden,
  filled,
}: {
  row: QueueRow;
  stage: QueueStage;
  overridden: boolean;
  filled: boolean;
}) {
  const source = row.suggestion.source;
  const confidence = row.suggestion.confidence;
  const unsure = confidence !== null && confidence < 0.6;
  const deciding = stage === "review" || stage === "ready";
  return (
    <>
      {overridden ? (
        <span className={cn("inline-flex shrink-0", !filled && "text-ink-blue")}>
          <Glyph name="pencil" size={12} label="Your choice" />
        </span>
      ) : deciding && source === "ai" ? (
        <span className={cn("inline-flex shrink-0", !filled && (unsure ? "text-tint-orange" : "text-tint-purple"))}>
          <Glyph
            name="sparkle"
            size={12}
            label={`AI${confidence === null ? "" : ` ${Math.round(confidence * 100)}%`}`}
          />
        </span>
      ) : deciding && source !== null ? (
        <span className="sr-only">{SOURCE_LABEL[source]}</span>
      ) : stage === "posted" && row.entryNo !== null ? (
        <span className="sr-only">Entry #{row.entryNo}</span>
      ) : null}
      {row.flags.map((flag) => {
        const glyph = FLAG_GLYPH[flag];
        if (glyph === undefined) return null;
        return (
          <span
            key={flag}
            className={cn("inline-flex shrink-0", !filled && (flag === "open_document" ? "text-tint-blue" : "text-tint-orange"))}
          >
            <Glyph name={glyph} size={12} label={FLAG_LABEL[flag]} />
          </span>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// The confidence meter
// ---------------------------------------------------------------------------

/** "✦ AI ▬▬▬──── 35%": what proposed the account and how sure it is. */
export function ConfidenceMeter({
  source,
  confidence,
}: {
  source: NonNullable<QueueRow["suggestion"]["source"]>;
  confidence: number | null;
}) {
  const pct = confidence === null ? null : Math.round(confidence * 100);
  return (
    <span className="flex items-center gap-2.5">
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs font-semibold",
          source === "ai" ? "text-label" : "text-label2",
        )}
      >
        {source === "ai" ? <Glyph name="sparkle" size={13} className="text-tint-purple" /> : null}
        {source === "rule" ? <Glyph name="wand" size={13} /> : null}
        {source === "history" ? <Glyph name="clock" size={13} /> : null}
        {source === "match" ? <Glyph name="link" size={13} /> : null}
        {SOURCE_LABEL[source]}
      </span>
      {pct === null ? null : (
        <>
          <span
            role="meter"
            aria-label="Confidence"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="block h-1.5 w-[120px] overflow-hidden rounded-[3px] bg-fill max-sm:w-16"
          >
            <i
              className={cn("block h-full rounded-[3px]", pct >= 80 ? "bg-tint-green" : "bg-tint-orange")}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </span>
          <b className="num w-[34px] text-right font-semibold text-label">{pct}%</b>
        </>
      )}
    </span>
  );
}

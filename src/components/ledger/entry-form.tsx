"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Lock, Scale, Send, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCents, Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { deleteDraftEntry, postEntry, saveDraftEntry } from "@/app/(app)/ledger/actions";

import { rememberAccount } from "./account-combobox";
import { EntryLinesEditor } from "./entry-lines-editor";
import {
  autoBalanceFor,
  blankLine,
  draftReadiness,
  entryTotals,
  isLineEmpty,
  postReadiness,
  seedLines,
  setAmount,
  toEntryLines,
  type DraftLineState,
} from "./entry-math";
import type {
  AccountOption,
  ActionFailure,
  ChannelOption,
  EntrySeedLine,
  ProductOption,
} from "./types";

export interface JournalEntryFormProps {
  accounts: readonly AccountOption[];
  channels: readonly ChannelOption[];
  products: readonly ProductOption[];
  /** The draft being edited. Null for a new entry, including a duplicate. */
  draftId: string | null;
  draftEntryNo: number | null;
  initialDate: string;
  initialMemo: string;
  initialLines: readonly EntrySeedLine[];
  /** Months already closed, as `YYYY-MM`; nothing posts into one. */
  closedPeriods: readonly string[];
  canPost: boolean;
}

function periodOfDate(date: string): string {
  return date.slice(0, 7);
}

function describe(failure: ActionFailure): string {
  return failure.message;
}

/**
 * The screen a bookkeeper lives in.
 *
 * Two ways out: save it as a draft, which keeps whatever is on the grid however
 * unfinished, or post it, which is refused until the entry balances. There is no
 * third way — a posted entry is immutable, so the Post button is the last chance
 * to change anything and it says exactly what is standing between here and there.
 */
export function JournalEntryForm({
  accounts,
  channels,
  products,
  draftId,
  draftEntryNo,
  initialDate,
  initialMemo,
  initialLines,
  closedPeriods,
  canPost,
}: JournalEntryFormProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const [date, setDate] = React.useState(initialDate);
  const [memo, setMemo] = React.useState(initialMemo);
  const [lines, setLines] = React.useState<DraftLineState[]>(() => seedLines(initialLines));
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null);

  const totals = React.useMemo(() => entryTotals(lines), [lines]);
  const readiness = React.useMemo(() => postReadiness(lines, date, totals), [lines, date, totals]);
  const saveable = React.useMemo(() => draftReadiness(lines, date), [lines, date]);

  const periodClosed = closedPeriods.includes(periodOfDate(date));
  const postable = canPost && readiness.ready && !periodClosed && !pending;

  /**
   * Fills the difference into the line the cursor is on. When that line already
   * carries an amount the next empty one takes it, and when there is no empty
   * line left the grid grows one — the action should never be a no-op the
   * bookkeeper has to diagnose.
   */
  const autoBalance = React.useCallback(() => {
    if (totals.balanced) return;

    const candidates = [
      ...(focusedKey === null ? [] : [focusedKey]),
      ...lines.filter((line) => autoBalanceFor(lines, line.key) !== null).map((line) => line.key),
    ];

    for (const key of candidates) {
      const fill = autoBalanceFor(lines, key);
      if (fill === null) continue;
      setLines((current) =>
        current.map((line) =>
          line.key === key ? setAmount(line, fill.side, formatCents(fill.cents)) : line,
        ),
      );
      setFocusedKey(key);
      return;
    }

    // Every line is spoken for: add one and put the remainder on it.
    const created = blankLine();
    const fill =
      totals.differenceCents > 0
        ? { side: "credit" as const, cents: totals.differenceCents }
        : { side: "debit" as const, cents: -totals.differenceCents };
    setLines((current) => [...current, setAmount(created, fill.side, formatCents(fill.cents))]);
    setFocusedKey(created.key);
  }, [focusedKey, lines, totals]);

  const submit = React.useCallback(
    (intent: "draft" | "post") => {
      startTransition(async () => {
        const payload = {
          draftId,
          date,
          memo,
          lines: toEntryLines(lines),
        };

        const result =
          intent === "post" ? await postEntry(payload) : await saveDraftEntry(payload);

        if (!result.ok) {
          toast.error(intent === "post" ? "Entry not posted" : "Draft not saved", {
            description: describe(result.error),
          });
          return;
        }

        if (intent === "post") {
          toast.success(`Entry #${result.value.entryNo} posted`);
        } else {
          toast.success(`Draft #${result.value.entryNo} saved`);
        }
        router.push(`/ledger/${result.value.entryId}`);
      });
    },
    [date, draftId, lines, memo, router],
  );

  const discard = React.useCallback(() => {
    if (draftId === null) return;
    startTransition(async () => {
      const result = await deleteDraftEntry(draftId);
      if (!result.ok) {
        toast.error("Draft not deleted", { description: describe(result.error) });
        return;
      }
      toast.success("Draft deleted");
      router.push("/ledger");
    });
  }, [draftId, router]);

  const touched = lines.some((line) => !isLineEmpty(line));

  return (
    <div className="flex flex-col gap-4 pb-24">
      <Card>
        <CardHeader>
          <CardTitle>{draftId === null ? "New journal entry" : `Draft #${draftEntryNo}`}</CardTitle>
          {periodClosed ? (
            <Badge tone="warning">
              <Lock />
              {periodOfDate(date)} is closed
            </Badge>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-date" required>
              Date
            </Label>
            <DateInput
              id="entry-date"
              value={date}
              onValueChange={setDate}
              disabled={pending}
              invalid={date === ""}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-memo" hint="What this entry is for">
              Memo
            </Label>
            <Input
              id="entry-memo"
              value={memo}
              disabled={pending}
              placeholder="e.g. Accrue September co-packer run"
              onChange={(event) => setMemo(event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending || totals.balanced}
            onClick={autoBalance}
          >
            <Scale />
            Auto-balance
            {totals.balanced ? null : (
              <span className="num text-2xs">
                {formatCents(Math.abs(totals.differenceCents), { currency: true })}
              </span>
            )}
          </Button>
        </CardHeader>
        <div className="p-3">
          <EntryLinesEditor
            lines={lines}
            onChange={setLines}
            accounts={accounts}
            channels={channels}
            products={products}
            totals={totals}
            onAccountUsed={rememberAccount}
            focusedKey={focusedKey}
            onFocusLine={setFocusedKey}
            disabled={pending}
          />
        </div>
      </Card>

      <TotalsBar
        totals={totals}
        reason={
          periodClosed
            ? `${periodOfDate(date)} is closed. Post to an open period, or reopen that one first.`
            : canPost
              ? readiness.reason
              : "Your role may not post to the ledger."
        }
        postable={postable}
        pending={pending}
        saveable={saveable.ready && !pending}
        canDelete={draftId !== null}
        touched={touched}
        onPost={() => submit("post")}
        onSaveDraft={() => submit("draft")}
        onDelete={discard}
      />
    </div>
  );
}

function TotalsBar({
  totals,
  reason,
  postable,
  pending,
  saveable,
  canDelete,
  touched,
  onPost,
  onSaveDraft,
  onDelete,
}: {
  totals: ReturnType<typeof entryTotals>;
  reason: string | null;
  postable: boolean;
  pending: boolean;
  saveable: boolean;
  canDelete: boolean;
  touched: boolean;
  onPost: () => void;
  onSaveDraft: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border-strong bg-surface-raised/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[104rem] flex-wrap items-center justify-between gap-3 px-4 py-2.5 lg:px-6">
        <dl className="flex items-center gap-5 text-sm">
          <Total label="Debits" cents={totals.debitCents} />
          <Total label="Credits" cents={totals.creditCents} />
          <div className="flex flex-col leading-tight">
            <dt className="eyebrow">Difference</dt>
            <dd>
              <Money
                cents={totals.differenceCents}
                currency
                zeroDash
                className={cn(
                  "text-sm font-semibold",
                  totals.balanced ? "text-positive" : "text-negative",
                )}
              />
            </dd>
          </div>
          {totals.balanced && totals.amountLineCount >= 2 ? (
            <Badge tone="positive">In balance</Badge>
          ) : null}
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          {reason === null ? null : (
            <span className="max-w-sm text-xs text-muted-foreground">{reason}</span>
          )}
          {canDelete ? (
            <Button type="button" variant="danger-quiet" size="sm" disabled={pending} onClick={onDelete}>
              <Trash2 />
              Delete draft
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!saveable || !touched}
            onClick={onSaveDraft}
          >
            Save draft
          </Button>
          <Button type="button" size="sm" disabled={!postable} onClick={onPost}>
            <Send />
            {totals.balanced
              ? "Post entry"
              : `Out by ${formatCents(Math.abs(totals.differenceCents), { currency: true })}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Total({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex flex-col leading-tight">
      <dt className="eyebrow">{label}</dt>
      <dd>
        <Money cents={cents} currency plain className="text-sm font-semibold" />
      </dd>
    </div>
  );
}

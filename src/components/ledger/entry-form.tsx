"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { FlowDiagram } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Glyph } from "@/components/ui/glyph";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { toast } from "@/components/ui/toast";
import { deleteDraftEntry, postEntry, saveDraftEntry } from "@/app/(app)/ledger/actions";

import { rememberAccount } from "./account-combobox";
import { BalanceGauge, BalanceVerdict } from "./balance-gauge";
import { EntryLinesEditor } from "./entry-lines-editor";
import {
  autoBalanceFor,
  blankLine,
  draftReadiness,
  entryTotals,
  isLineEmpty,
  lineAmounts,
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
import { entryFlow } from "./visuals";

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

  // What posting will do, drawn from the lines as they stand.
  const flow = React.useMemo(() => {
    const byId = new Map(accounts.map((account) => [account.id, account]));
    return entryFlow(
      lines.flatMap((line) => {
        const account = line.accountId === null ? undefined : byId.get(line.accountId);
        const amounts = lineAmounts(line);
        if (account === undefined || amounts.error !== null) return [];
        return [{ accountCode: account.code, accountName: account.name, ...amounts }];
      }),
    );
  }, [accounts, lines]);

  const reason = periodClosed
    ? `${periodOfDate(date)} is closed. Post to an open month, or reopen that one first.`
    : canPost
      ? readiness.reason
      : "Your role may not post to the ledger.";

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <InsetGroup
        headerAccessory={
          periodClosed ? (
            <Pill tone="orange" glyph="lock">
              {periodOfDate(date)} is closed
            </Pill>
          ) : undefined
        }
      >
        <GroupRow label="Date" htmlFor="entry-date">
          <DateInput
            id="entry-date"
            value={date}
            onValueChange={setDate}
            disabled={pending}
            invalid={date === ""}
          />
        </GroupRow>
        <GroupRow label="Memo" htmlFor="entry-memo" className="[&>span:last-child]:flex-[3]">
          <Input
            id="entry-memo"
            value={memo}
            disabled={pending}
            placeholder="What this entry is for"
            className="w-full"
            onChange={(event) => setMemo(event.target.value)}
          />
        </GroupRow>
      </InsetGroup>

      <Card className="overflow-hidden">
        <header className="flex items-center gap-2 px-5 pt-4 pb-2 max-sm:px-4">
          <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">Lines</h2>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending || totals.balanced}
            onClick={autoBalance}
          >
            <Glyph name="wand" size={14} />
            Auto-balance
          </Button>
        </header>
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
      </Card>

      {flow === null ? null : (
        <Card className="px-5 py-[18px] max-sm:px-4">
          <FlowDiagram from={flow.from} to={flow.to} />
        </Card>
      )}

      <div className="flex flex-col gap-3 rounded-2xl bg-card px-5 py-3.5 shadow-card md:sticky md:bottom-3 md:z-20 md:flex-row md:items-center md:vibrancy md:shadow-glass max-sm:rounded-[22px] max-sm:px-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <BalanceGauge debitCents={totals.debitCents} creditCents={totals.creditCents} className="md:max-w-[420px]" />
          <p className="min-h-4 text-xs text-label2" aria-live="polite">
            <BalanceVerdict debitCents={totals.debitCents} creditCents={totals.creditCents} />
            {reason === null || reason === "The entry is out of balance." ? null : <> · {reason}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-md:[&>button]:flex-1">
          {draftId !== null ? (
            <Button type="button" variant="danger-quiet" disabled={pending} onClick={discard}>
              <Glyph name="trash" size={15} />
              Delete draft
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={!(saveable.ready && !pending) || !touched}
            onClick={() => submit("draft")}
          >
            Save draft
          </Button>
          <Button type="button" disabled={!postable} onClick={() => submit("post")}>
            <Glyph name={totals.balanced ? "check" : "warning"} size={15} />
            {totals.balanced
              ? "Post entry"
              : `Out by ${formatCents(Math.abs(totals.differenceCents), { currency: true })}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

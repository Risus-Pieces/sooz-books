"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeftRight,
  Check,
  CircleSlash,
  FilterX,
  Flag,
  Keyboard,
  Link2,
  Rows3,
  Scissors,
  Search,
  Undo2,
  User,
  Users,
  Wand2,
} from "lucide-react";

import { AccountCombobox, rememberAccount } from "@/components/ledger/account-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  acceptTransactions,
  confirmTransfer,
  excludeRows,
  includeRows,
  markPersonalTransaction,
  splitTransaction,
  unpostRow,
  type AcceptItem,
} from "@/app/(app)/banking/actions";

import { Figure, FlagMarks, InCell, Kbd, OutCell, SourceChip, Th } from "./parts";
import {
  ConfirmDialog,
  MatchDialog,
  RuleDialog,
  ShortcutsDialog,
  SplitDialog,
  TransferDialog,
  type ConfirmRequest,
  type MatchRequest,
} from "./review-dialogs";
import {
  EMPTY_FILTER,
  canAcceptAsSuggested,
  groupByPayee,
  isFilterActive,
  matchesFilter,
  monthLabel,
  nextFocus,
  payeeOf,
  rangeIds,
  shortDate,
  totalsOf,
  type PayeeGroup,
  type QueueFilter,
} from "./review-logic";
import type { AccountOption, QueueRow, QueueSource, QueueStage, VendorOption } from "./types";

const ANY = "__any__";

export interface ReviewQueueProps {
  stage: QueueStage;
  rows: readonly QueueRow[];
  accounts: readonly AccountOption[];
  vendors: readonly VendorOption[];
  canApprove: boolean;
  mayAutoPost: boolean;
  /** True when the engine returned its page limit and older rows exist. */
  truncated: boolean;
}

type View = "list" | "payee";

const NARROW_QUERY = "(max-width: 767px)";

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * A phone gets cards instead of the register table: the amount and its direction have to be
 * on screen without scrolling sideways. The server renders the table; a phone swaps on hydrate.
 */
function useNarrow(): boolean {
  return React.useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/**
 * Anything that answers the keyboard itself. With one of these focused, Enter and Space
 * press it and letters belong to it — the queue's shortcuts must not fire on top, or Enter
 * on "Split" would post the row instead of opening the split.
 */
const OWNS_KEYS =
  "input, textarea, select, button, a[href], summary, [contenteditable='true'], [role='button'], [role='checkbox'], " +
  "[role='radio'], [role='switch'], [role='tab'], [role='combobox'], [role='listbox'], [role='option'], " +
  "[role='menu'], [role='menuitem'], [role='slider'], [role='spinbutton'], [role='textbox']";

/**
 * Keys are the queue's only when the focus is on the list itself (or nowhere): never while
 * someone is typing, a control has the focus, or a dialog is open.
 */
export function keyIsForUs(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "target">): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return false;
    if (target.closest(OWNS_KEYS)) return false;
  }
  return document.querySelector("[role='dialog'], [role='alertdialog']") === null;
}

function sumSigned(rows: readonly QueueRow[]): number {
  return rows.reduce((sum, row) => sum + row.amountCents, 0);
}

function InOutSentence({ rows }: { rows: readonly QueueRow[] }) {
  const totals = totalsOf(rows);
  return (
    <>
      {totals.inCents > 0 ? (
        <>
          money in <Money cents={totals.inCents} currency colorPositive />
        </>
      ) : null}
      {totals.inCents > 0 && totals.outCents > 0 ? " and " : null}
      {totals.outCents > 0 ? (
        <>
          money out <Money cents={-totals.outCents} currency />
        </>
      ) : null}
    </>
  );
}

export function ReviewQueue({ stage, rows, accounts, vendors, canApprove, mayAutoPost, truncated }: ReviewQueueProps) {
  const [filter, setFilter] = React.useState<QueueFilter>(EMPTY_FILTER);
  const [view, setView] = React.useState<View>("list");
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  const [focusState, setFocusId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = React.useState<string | null>(null);
  const [overrides, setOverrides] = React.useState<Readonly<Record<string, string>>>({});
  const [detailsOpen, setDetailsOpen] = React.useState(true);
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const [splitRow, setSplitRow] = React.useState<QueueRow | null>(null);
  const [transferRow, setTransferRow] = React.useState<QueueRow | null>(null);
  const [ruleRow, setRuleRow] = React.useState<QueueRow | null>(null);
  const [matchRequest, setMatchRequest] = React.useState<MatchRequest | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const narrow = useNarrow();

  const listRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const pickerRef = React.useRef<HTMLButtonElement>(null);

  const live = React.useMemo(() => rows.filter((row) => !hidden.has(row.id)), [rows, hidden]);
  const visible = React.useMemo(() => live.filter((row) => matchesFilter(row, filter)), [live, filter]);
  const ids = React.useMemo(() => visible.map((row) => row.id), [visible]);
  const groups = React.useMemo(() => groupByPayee(visible), [visible]);
  const [groupFocus, setGroupFocus] = React.useState<string | null>(null);

  // The focused row, or the first one when it has left the list.
  const focusId = focusState !== null && ids.includes(focusState) ? focusState : (ids[0] ?? null);
  const focused = focusId === null ? undefined : visible.find((row) => row.id === focusId);
  const selectedRows = React.useMemo(() => visible.filter((row) => selected.has(row.id)), [visible, selected]);

  React.useEffect(() => {
    if (focusId === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-id="${focusId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  const months = React.useMemo(
    () => [...new Set(rows.map((row) => row.txnDate.slice(0, 7)))].sort().reverse(),
    [rows],
  );
  const banks = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.bankAccountId, row.bankAccountMask === null ? row.bankAccountName : `••${row.bankAccountMask}`);
    return [...map];
  }, [rows]);

  // ---------------------------------------------------------------------------
  // Optimism
  // ---------------------------------------------------------------------------

  const hide = React.useCallback(
    (leaving: readonly string[]) => {
      const set = new Set(leaving);
      setFocusId(nextFocus(ids, set, focusId));
      setHidden((current) => new Set([...current, ...leaving]));
      setSelected((current) => {
        const next = new Set([...current].filter((id) => !set.has(id)));
        return next.size === current.size ? current : next;
      });
    },
    [focusId, ids],
  );

  const restore = React.useCallback((returning: readonly string[]) => {
    if (returning.length === 0) return;
    setHidden((current) => new Set([...current].filter((id) => !returning.includes(id))));
  }, []);

  const refocusList = React.useCallback(() => {
    window.setTimeout(() => listRef.current?.focus({ preventScroll: true }), 0);
  }, []);

  // ---------------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------------

  /**
   * When the engine refuses a single row because an entry already records its money, the
   * reviewer sees that entry and chooses: match to it, or post this as a different one.
   */
  const offerMatch = React.useCallback(
    (row: QueueRow, postAnyway: () => void) => {
      restore([row.id]);
      setFocusId(row.id);
      setMatchRequest({ row, postAnyway });
    },
    [restore],
  );

  const runAccept = React.useCallback(
    function runAcceptRows(targets: readonly QueueRow[], confirmedNew = false) {
      const items: AcceptItem[] = targets.map((row) => {
        const override = overrides[row.id];
        return {
          txnId: row.id,
          ...(override === undefined ? {} : { accountId: override }),
          ...(confirmedNew ? { confirmedNew: true } : {}),
        };
      });
      const leaving = targets.map((row) => row.id);
      hide(leaving);
      void acceptTransactions(items).then((result) => {
        if (!result.ok) {
          restore(leaving);
          toast.error(result.error.message);
          return;
        }
        const { posted, failed } = result.value;
        const only = targets.length === 1 ? targets[0] : undefined;
        if (only !== undefined && failed.length === 1 && failed[0].code === "already_booked") {
          offerMatch(only, () => runAcceptRows([only], true));
          return;
        }
        restore(failed.map((f) => f.txnId));
        if (posted.length === 1 && failed.length === 0) {
          toast.success(`Posted as entry #${posted[0].entryNo}`);
        } else if (posted.length > 0) {
          toast.success(`Posted ${posted.length} transaction${posted.length === 1 ? "" : "s"}`);
        }
        if (failed.length > 0) {
          toast.error(
            failed.length === 1 ? failed[0].message : `${failed.length} could not post. ${failed[0].message}`,
          );
        }
      });
    },
    [hide, offerMatch, overrides, restore],
  );

  const openPicker = React.useCallback(() => {
    setDetailsOpen(true);
    window.setTimeout(() => pickerRef.current?.click(), 0);
  }, []);

  const acceptOne = React.useCallback(
    (row: QueueRow) => {
      if (row.status === "transfer") {
        if (row.transferPartner === null) {
          setTransferRow(row);
          return;
        }
        const leaving = [row.id, row.transferPartner.id];
        const post = (confirmedNew: boolean) => {
          hide(leaving);
          void confirmTransfer(row.id, confirmedNew).then((result) => {
            if (result.ok) toast.success(`Transfer posted as entry #${result.value.entryNo}`);
            else {
              restore(leaving);
              if (result.error.code === "already_booked") offerMatch(row, () => post(true));
              else toast.error(result.error.message);
            }
          });
        };
        post(false);
        return;
      }
      if (overrides[row.id] === undefined && !canAcceptAsSuggested(row)) {
        toast.info("This transaction has no suggestion. Choose the account to post it to.");
        setFocusId(row.id);
        openPicker();
        return;
      }
      runAccept([row]);
    },
    [hide, offerMatch, openPicker, overrides, restore, runAccept],
  );

  const acceptSelection = React.useCallback(
    (targets: readonly QueueRow[], title: string) => {
      const acceptable = targets.filter((row) => overrides[row.id] !== undefined || canAcceptAsSuggested(row));
      const skipped = targets.length - acceptable.length;
      if (acceptable.length === 0) {
        toast.info("None of these has a suggestion to accept. Choose an account for each, or split them.");
        return;
      }
      const flagged = acceptable.filter((row) => row.flags.includes("mixed_use")).length;
      setConfirm({
        title,
        confirmLabel: `Post ${acceptable.length}`,
        body: (
          <div className="flex flex-col gap-2">
            <p>
              Post <strong className="num">{acceptable.length}</strong> transaction{acceptable.length === 1 ? "" : "s"} to
              the account{acceptable.length === 1 ? "" : "s"} shown — <InOutSentence rows={acceptable} />, net{" "}
              <Money cents={sumSigned(acceptable)} currency signed colorPositive />.
            </p>
            {flagged > 0 ? (
              <p className="text-warning">
                {flagged} {flagged === 1 ? "is" : "are"} from a mixed-use payee. Mark any personal purchase with{" "}
                <Kbd>p</Kbd> before accepting the rest: once posted, a purchase has to be unposted to change.
              </p>
            ) : null}
            {skipped > 0 ? (
              <p className="text-muted-foreground">
                {skipped} without a suggestion {skipped === 1 ? "stays" : "stay"} in the queue.
              </p>
            ) : null}
          </div>
        ),
        onConfirm: () => runAccept(acceptable),
      });
    },
    [overrides, runAccept],
  );

  const personal = React.useCallback(
    (row: QueueRow) => {
      if (row.amountCents > 0) {
        toast.info("Personal applies to money out. Money the owner put in is a member contribution.");
        return;
      }
      if (row.status === "transfer") {
        toast.info("This is a transfer leg. Unpair it before treating it as personal.");
        return;
      }
      const post = (confirmedNew: boolean) => {
        hide([row.id]);
        void markPersonalTransaction(row.id, confirmedNew).then((result) => {
          if (result.ok) toast.success(`Posted to Owner Draws as entry #${result.value.entryNo}`);
          else {
            restore([row.id]);
            if (result.error.code === "already_booked") offerMatch(row, () => post(true));
            else toast.error(result.error.message);
          }
        });
      };
      post(false);
    },
    [hide, offerMatch, restore],
  );

  const match = React.useCallback((row: QueueRow) => {
    if (row.status === "transfer") {
      toast.info("This is a transfer leg. Unpair it before matching it to anything else.");
      return;
    }
    setMatchRequest({ row, postAnyway: null });
  }, []);

  const exclude = React.useCallback(
    (targets: readonly QueueRow[]) => {
      const leaving = targets.map((row) => row.id);
      const run = () => {
        hide(leaving);
        const action = stage === "excluded" ? includeRows : excludeRows;
        void action(leaving).then((result) => {
          if (!result.ok) {
            restore(leaving);
            toast.error(result.error.message);
            return;
          }
          toast.success(
            stage === "excluded"
              ? `Returned ${result.value.changed} to review`
              : `Excluded ${result.value.changed} — ${result.value.changed === 1 ? "it" : "they"} will never post`,
          );
        });
      };
      if (targets.length === 1) {
        run();
        return;
      }
      setConfirm({
        title: stage === "excluded" ? "Return to review" : "Exclude transactions",
        confirmLabel: stage === "excluded" ? `Return ${targets.length}` : `Exclude ${targets.length}`,
        tone: stage === "excluded" ? "default" : "danger",
        body:
          stage === "excluded" ? (
            <p>Return {targets.length} excluded transactions to the review queue.</p>
          ) : (
            <p>
              Exclude {targets.length} transactions (<InOutSentence rows={targets} />
              ). Excluded rows never reach the ledger. Use this only when the money never moved.
            </p>
          ),
        onConfirm: run,
      });
    },
    [hide, restore, stage],
  );

  const unpost = React.useCallback(
    (row: QueueRow) => {
      if (row.stage !== "posted") return;
      if (row.matchedType === "receipt" || row.matchedType === "bill_payment") {
        toast.info(
          row.matchedType === "receipt"
            ? "This deposit was recorded as a receipt. Void the receipt in Sales to undo it."
            : "This payment was recorded against a bill. Void the payment in Purchases to undo it.",
        );
        return;
      }
      if (row.matchedType === "entry") {
        setConfirm({
          title: "Unmatch transaction",
          confirmLabel: "Unmatch",
          tone: "danger",
          body: (
            <p>
              Release {shortDate(row.txnDate)} {payeeOf(row)} (
              <Money cents={row.amountCents} currency signed colorPositive />) from entry #{row.entryNo} and send it
              back to review. Entry #{row.entryNo} stays in the ledger.
            </p>
          ),
          onConfirm: () => {
            hide([row.id]);
            void unpostRow(row.id).then((result) => {
              if (result.ok) toast.success(`Unmatched from entry #${result.value.unlinkedEntryNo ?? row.entryNo}`);
              else {
                restore([row.id]);
                toast.error(result.error.message);
              }
            });
          },
        });
        return;
      }
      setConfirm({
        title: "Unpost transaction",
        confirmLabel: "Unpost",
        tone: "danger",
        body: (
          <p>
            Reverse entry #{row.entryNo} for {shortDate(row.txnDate)} {payeeOf(row)} (
            <Money cents={row.amountCents} currency signed colorPositive />) and send it back to review with its
            suggestion.{row.status === "transfer" ? " Its other leg comes back with it." : ""}
          </p>
        ),
        onConfirm: () => {
          const leaving = [row.id, ...(row.transferPartner === null ? [] : [row.transferPartner.id])];
          hide(leaving);
          void unpostRow(row.id).then((result) => {
            if (result.ok) {
              toast.success(
                result.value.reversalEntryNo === null
                  ? "Unposted"
                  : `Unposted — reversal entry #${result.value.reversalEntryNo}`,
              );
            }
            else {
              restore(leaving);
              toast.error(result.error.message);
            }
          });
        },
      });
    },
    [hide, restore],
  );

  const transfer = React.useCallback(
    (row: QueueRow) => {
      if (row.status === "transfer" && row.transferPartner !== null) acceptOne(row);
      else setTransferRow(row);
    },
    [acceptOne],
  );

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  const move = React.useCallback(
    (delta: number, extend: boolean) => {
      if (ids.length === 0) return;
      const at = focusId === null ? -1 : ids.indexOf(focusId);
      const nextIndex = Math.min(ids.length - 1, Math.max(0, at + delta));
      const next = ids[nextIndex];
      if (extend) {
        const from = anchor ?? focusId ?? next;
        setAnchor(from);
        setSelected(new Set(rangeIds(ids, from, next)));
      } else {
        setAnchor(next);
      }
      setFocusId(next);
    },
    [anchor, focusId, ids],
  );

  const moveGroup = React.useCallback(
    (delta: number) => {
      if (groups.length === 0) return;
      const at = groupFocus === null ? -1 : groups.findIndex((g) => g.key === groupFocus);
      setGroupFocus(groups[Math.min(groups.length - 1, Math.max(0, at + delta))].key);
    },
    [groupFocus, groups],
  );

  const acceptGroup = React.useCallback(
    (group: PayeeGroup) => {
      acceptSelection(group.rows, `Accept all ${group.payee}`);
    },
    [acceptSelection],
  );

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!keyIsForUs(event)) return;
      const key = event.key;

      if (key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (view === "payee") {
        const group = groups.find((g) => g.key === groupFocus);
        if (key === "j" || key === "ArrowDown") {
          event.preventDefault();
          moveGroup(1);
        } else if (key === "k" || key === "ArrowUp") {
          event.preventDefault();
          moveGroup(-1);
        } else if ((key === "Enter" || key === "a") && group !== undefined && canApprove && stage !== "posted" && stage !== "excluded") {
          event.preventDefault();
          acceptGroup(group);
        }
        return;
      }

      const down = key === "j" || key === "J" || key === "ArrowDown";
      const up = key === "k" || key === "K" || key === "ArrowUp";
      if (down || up) {
        event.preventDefault();
        move(down ? 1 : -1, event.shiftKey);
        return;
      }
      if (key === "Escape") {
        setSelected(new Set());
        setAnchor(focusId);
        return;
      }
      if (key === "o") {
        event.preventDefault();
        setDetailsOpen((open) => !open);
        return;
      }

      const row = focused;
      if (row === undefined || !canApprove) return;
      const many = selectedRows.length > 1;

      switch (key) {
        case "Enter":
        case "a":
          if (stage === "posted" || stage === "excluded") return;
          event.preventDefault();
          if (many) acceptSelection(selectedRows, `Accept ${selectedRows.length} selected`);
          else acceptOne(row);
          return;
        case "e":
          if (stage === "posted" || stage === "excluded") return;
          event.preventDefault();
          openPicker();
          return;
        case "p":
          if (stage === "posted" || stage === "excluded") return;
          event.preventDefault();
          personal(row);
          return;
        case "s":
          if (stage === "posted" || stage === "excluded") return;
          event.preventDefault();
          setSplitRow(row);
          return;
        case "t":
          if (stage !== "review") return;
          event.preventDefault();
          transfer(row);
          return;
        case "m":
          if (stage === "posted" || stage === "excluded") return;
          event.preventDefault();
          match(row);
          return;
        case "r":
          event.preventDefault();
          setRuleRow(row);
          return;
        case "x":
          if (stage === "posted") return;
          event.preventDefault();
          exclude(many ? selectedRows : [row]);
          return;
        case "u":
          if (stage !== "posted") return;
          event.preventDefault();
          unpost(row);
          return;
        default:
          return;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    acceptGroup,
    acceptOne,
    acceptSelection,
    canApprove,
    exclude,
    focusId,
    focused,
    groupFocus,
    groups,
    match,
    move,
    moveGroup,
    openPicker,
    personal,
    selectedRows,
    stage,
    transfer,
    unpost,
    view,
  ]);

  // ---------------------------------------------------------------------------
  // Pointer
  // ---------------------------------------------------------------------------

  const onRowClick = (event: React.MouseEvent, row: QueueRow) => {
    if ((event.target as HTMLElement).closest("button, a, input, [role='combobox']")) return;
    if (event.shiftKey) {
      event.preventDefault();
      const from = anchor ?? focusId ?? row.id;
      setSelected(new Set(rangeIds(ids, from, row.id)));
      setAnchor(from);
    } else if (event.metaKey || event.ctrlKey) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      setAnchor(row.id);
    } else {
      setAnchor(row.id);
      if (focusId === row.id) setDetailsOpen((open) => !open);
      else setDetailsOpen(true);
    }
    setFocusId(row.id);
  };

  const toggleSelected = (row: QueueRow, shift: boolean) => {
    if (shift && anchor !== null) {
      setSelected((current) => new Set([...current, ...rangeIds(ids, anchor, row.id)]));
    } else {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      setAnchor(row.id);
    }
    setFocusId(row.id);
    // Hand the keyboard back to the list, so j/k and Enter work straight after a click.
    refocusList();
  };

  const renderDetail = (row: QueueRow) => (
    <RowDetail
      row={row}
      stage={stage}
      accounts={accounts}
      override={overrides[row.id] ?? null}
      canApprove={canApprove}
      pickerRef={pickerRef}
      onPick={(accountId) => {
        rememberAccount(accountId);
        setOverrides((current) => ({ ...current, [row.id]: accountId }));
      }}
      onPickerClosed={refocusList}
      onAccept={() => acceptOne(row)}
      onPersonal={() => personal(row)}
      onSplit={() => setSplitRow(row)}
      onTransfer={() => transfer(row)}
      onMatch={() => match(row)}
      onRule={() => setRuleRow(row)}
      onExclude={() => exclude([row])}
      onUnpost={() => unpost(row)}
    />
  );

  const totals = totalsOf(visible);
  const filtered = isFilterActive(filter);
  const decisionStage = stage === "review" || stage === "ready";
  const columnCount = 7;

  return (
    <div className="flex flex-col gap-3">
      <SummaryBar stage={stage} totals={totals} filtered={filtered} liveCount={live.length} />

      <Card>
        <div className="flex flex-wrap items-end gap-2 p-3">
          <div className="relative min-w-0 flex-[1_1_14rem]">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              aria-label="Search payee, reference or amount"
              placeholder="Payee, reference or amount"
              className="pr-8 pl-7"
              value={filter.search}
              onChange={(event) => setFilter((f) => ({ ...f, search: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "Enter") {
                  event.preventDefault();
                  listRef.current?.focus();
                }
              }}
            />
            <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
          </div>
          <Select value={filter.month === "" ? ANY : filter.month} onValueChange={(v) => setFilter((f) => ({ ...f, month: v === ANY ? "" : v }))}>
            <SelectTrigger aria-label="Month" className="w-[8.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Every month</SelectItem>
              {months.map((month) => (
                <SelectItem key={month} value={month}>
                  {monthLabel(month)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filter.source === "" ? ANY : filter.source}
            onValueChange={(v) => setFilter((f) => ({ ...f, source: v === ANY ? "" : (v as QueueSource) }))}
          >
            <SelectTrigger aria-label="Suggestion source" className="w-[9rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any source</SelectItem>
              <SelectItem value="rule">Rule</SelectItem>
              <SelectItem value="history">History</SelectItem>
              <SelectItem value="ai">AI</SelectItem>
              <SelectItem value="match">Match</SelectItem>
              <SelectItem value="none">No suggestion</SelectItem>
            </SelectContent>
          </Select>
          {banks.length > 1 ? (
            <Select
              value={filter.bankAccountId === "" ? ANY : filter.bankAccountId}
              onValueChange={(v) => setFilter((f) => ({ ...f, bankAccountId: v === ANY ? "" : v }))}
            >
              <SelectTrigger aria-label="Bank account" className="w-[8.5rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All accounts</SelectItem>
                {banks.map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            type="button"
            variant={filter.flaggedOnly ? "default" : "secondary"}
            aria-pressed={filter.flaggedOnly}
            onClick={() => setFilter((f) => ({ ...f, flaggedOnly: !f.flaggedOnly }))}
          >
            <Flag />
            Flagged
          </Button>
          {filtered ? (
            <Button type="button" variant="ghost" onClick={() => setFilter(EMPTY_FILTER)}>
              <FilterX />
              Clear
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="View">
            <Button
              type="button"
              size="sm"
              variant={view === "list" ? "secondary" : "ghost"}
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <Rows3 />
              List
            </Button>
            <Button
              type="button"
              size="sm"
              variant={view === "payee" ? "secondary" : "ghost"}
              aria-pressed={view === "payee"}
              onClick={() => {
                setView("payee");
                setGroupFocus(groups[0]?.key ?? null);
              }}
            >
              <Users />
              By payee
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}>
              <Keyboard />
            </Button>
          </div>
        </div>

        {selectedRows.length > 1 && view === "list" ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-primary/6 px-3 py-2 text-sm">
            <span>
              <strong className="num">{selectedRows.length}</strong> selected · <InOutSentence rows={selectedRows} />
            </span>
            <div className="ml-auto flex flex-wrap gap-2">
              {canApprove && decisionStage ? (
                <Button size="sm" onClick={() => acceptSelection(selectedRows, `Accept ${selectedRows.length} selected`)}>
                  <Check />
                  Accept {selectedRows.length}
                  <Kbd className="border-primary-foreground/40 bg-transparent text-primary-foreground">↵</Kbd>
                </Button>
              ) : null}
              {canApprove && stage !== "posted" ? (
                <Button size="sm" variant="secondary" onClick={() => exclude(selectedRows)}>
                  <CircleSlash />
                  {stage === "excluded" ? "Return to review" : "Exclude"}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </div>
          </div>
        ) : null}

        {view === "payee" ? (
          <PayeeGroups
            groups={groups}
            focusKey={groupFocus}
            stage={stage}
            canApprove={canApprove}
            onFocus={setGroupFocus}
            onAccept={acceptGroup}
            onReview={(group) => {
              setFilter((f) => ({ ...f, search: group.payee }));
              setView("list");
            }}
          />
        ) : (
          <div
            ref={listRef}
            tabIndex={-1}
            className="relative overflow-x-auto border-t border-border outline-none"
            aria-label="Bank transactions"
          >
            {narrow ? (
              <MobileList
                rows={visible}
                stage={stage}
                focusId={focusId}
                selected={selected}
                detailsOpen={detailsOpen}
                overrides={overrides}
                accounts={accounts}
                empty={<QueueEmpty stage={stage} filtered={filtered} onClear={() => setFilter(EMPTY_FILTER)} />}
                onRowClick={onRowClick}
                onToggle={toggleSelected}
                renderDetail={renderDetail}
              />
            ) : (
            <table className="w-full min-w-[56rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">
                Bank transactions. j and k move, Enter accepts, question mark lists every key.
              </caption>
              <thead>
                <tr>
                  <Th className="w-9 pr-0">
                    <span className="sr-only">Selected</span>
                  </Th>
                  <Th className="w-16">Date</Th>
                  <Th>Payee</Th>
                  <Th className="w-[30%]">{stage === "posted" ? "Posted to" : "Suggested account"}</Th>
                  <Th className="w-28">Flags</Th>
                  <Th className="w-28 text-right">Money in</Th>
                  <Th className="rule-gutter w-28 text-right">Money out</Th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={columnCount}>
                      <QueueEmpty stage={stage} filtered={filtered} onClear={() => setFilter(EMPTY_FILTER)} />
                    </td>
                  </tr>
                ) : (
                  visible.map((row) => {
                    const isFocused = row.id === focusId;
                    const isSelected = selected.has(row.id);
                    const override = overrides[row.id];
                    const overrideAccount = override === undefined ? undefined : accounts.find((a) => a.id === override);
                    const shown = stage === "posted" ? row.postedAccount : (overrideAccount ?? row.suggestion.account ?? row.refundOriginal?.account ?? null);
                    return (
                      <React.Fragment key={row.id}>
                        <tr
                          data-row-id={row.id}
                          aria-selected={isSelected}
                          aria-current={isFocused || undefined}
                          onClick={(event) => onRowClick(event, row)}
                          className={cn(
                            "cursor-default align-top transition-colors select-none",
                            isSelected ? "bg-primary/9" : isFocused ? "bg-primary/5" : "hover:bg-muted/60",
                          )}
                        >
                          <td
                            className={cn(
                              "rule-row relative w-9 py-1.5 pr-0 pl-3 align-top",
                              isFocused && "shadow-[inset_3px_0_0_var(--color-primary)]",
                            )}
                          >
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={isSelected}
                              aria-label={`Select ${payeeOf(row)} ${shortDate(row.txnDate)}`}
                              onClick={(event) => toggleSelected(row, event.shiftKey)}
                              className={cn(
                                "mt-0.5 flex size-4 items-center justify-center rounded-xs border transition-colors relative max-sm:after:absolute max-sm:after:-inset-3 max-sm:after:content-['']",
                                isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border-strong bg-surface-raised",
                              )}
                            >
                              {isSelected ? <Check className="size-3" strokeWidth={3} /> : null}
                            </button>
                          </td>
                          <td className="rule-row num px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground">
                            {shortDate(row.txnDate)}
                          </td>
                          <td className="rule-row max-w-0 px-3 py-1.5">
                            <p className="truncate font-medium text-foreground">{payeeOf(row)}</p>
                            <p className="truncate text-2xs text-muted-foreground">
                              <span className="num">••{row.bankAccountMask}</span>
                              {row.reference ? <> · {row.reference}</> : null}
                            </p>
                          </td>
                          <td className="rule-row max-w-0 px-3 py-1.5">
                            {row.status === "transfer" ? (
                              <p className="flex items-center gap-1.5 text-sm">
                                <ArrowLeftRight className="size-3.5 shrink-0 text-info" aria-hidden />
                                <span className="truncate">
                                  Transfer {row.amountCents < 0 ? "to" : "from"}{" "}
                                  {row.transferPartner === null
                                    ? "an unpaired account"
                                    : row.transferPartner.bankAccountName.replace(/^Relay\s+—\s+/, "")}
                                </span>
                              </p>
                            ) : shown === null ? (
                              <p className="text-sm text-muted-foreground italic">Choose an account</p>
                            ) : (
                              <p className="flex min-w-0 items-baseline gap-1.5">
                                <span className="num shrink-0 text-xs text-muted-foreground">{shown.code}</span>
                                <span className="truncate">{shown.name}</span>
                                {stage === "posted" && row.postedLineCount > 1 ? (
                                  <Badge size="sm">Split</Badge>
                                ) : null}
                              </p>
                            )}
                            <p className="flex min-w-0 items-center gap-1.5">
                              {overrideAccount !== undefined ? (
                                <Badge tone="outline" size="sm">
                                  Your choice
                                </Badge>
                              ) : stage === "posted" ? (
                                <span className="num text-2xs text-muted-foreground">#{row.entryNo}</span>
                              ) : (
                                <SourceChip source={row.suggestion.source} confidence={row.suggestion.confidence} />
                              )}
                              {row.suggestion.reasoning && stage !== "posted" ? (
                                <span className="truncate text-2xs text-muted-foreground" title={row.suggestion.reasoning}>
                                  {row.suggestion.reasoning}
                                </span>
                              ) : null}
                            </p>
                          </td>
                          <td className="rule-row px-3 py-1.5">
                            <FlagMarks flags={row.flags} />
                          </td>
                          <InCell cents={row.amountCents} className="rule-row" />
                          <OutCell cents={row.amountCents} className="rule-row" />
                        </tr>
                        {isFocused && detailsOpen ? (
                          <tr className="bg-primary/5">
                            <td colSpan={columnCount} className="rule-row px-3 pt-1 pb-3 shadow-[inset_3px_0_0_var(--color-primary)]">
                              {renderDetail(row)}
                            </td>
                          </tr>
                        ) : null}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
            )}
            {truncated ? (
              <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                Showing the newest 500. Narrow by month on the register to see older ones.
              </p>
            ) : null}
          </div>
        )}
      </Card>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <SplitDialog
        row={splitRow}
        accounts={accounts}
        onClose={() => setSplitRow(null)}
        onSubmit={(row, lines) => {
          setSplitRow(null);
          const post = (confirmedNew: boolean) => {
            hide([row.id]);
            void splitTransaction(row.id, lines, confirmedNew).then((result) => {
              if (result.ok) toast.success(`Split posted as entry #${result.value.entryNo}`);
              else {
                restore([row.id]);
                if (result.error.code === "already_booked") offerMatch(row, () => post(true));
                else toast.error(result.error.message);
              }
            });
          };
          post(false);
        }}
      />
      <TransferDialog row={transferRow} onClose={() => setTransferRow(null)} onPosted={(leaving) => hide(leaving)} />
      <MatchDialog
        request={matchRequest}
        onClose={() => {
          setMatchRequest(null);
          refocusList();
        }}
        onDone={(leaving) => hide(leaving)}
      />
      <RuleDialog
        row={ruleRow}
        accounts={accounts}
        vendors={vendors}
        accountOverride={ruleRow === null ? null : (overrides[ruleRow.id] ?? null)}
        mayAutoPost={mayAutoPost}
        onClose={() => setRuleRow(null)}
      />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const STAGE_NOUN: Record<QueueStage, string> = {
  review: "Awaiting review",
  ready: "Ready to post",
  posted: "Posted",
  excluded: "Excluded",
};

function SummaryBar({
  stage,
  totals,
  filtered,
  liveCount,
}: {
  stage: QueueStage;
  totals: ReturnType<typeof totalsOf>;
  filtered: boolean;
  liveCount: number;
}) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border bg-surface shadow-raised sm:grid-cols-4">
      <Figure label={filtered ? `Shown of ${liveCount}` : STAGE_NOUN[stage]}>
        <span className="num">{totals.count}</span>
      </Figure>
      <Figure label="Money in" className="sm:border-l">
        <Money cents={totals.inCents} currency colorPositive />
      </Figure>
      <Figure label="Money out" className="border-t sm:border-t-0 sm:border-l">
        <Money cents={-totals.outCents} currency />
      </Figure>
      <Figure label="Flagged" className="border-t border-l sm:border-t-0">
        <span className={cn("num", totals.flagged > 0 && "text-warning")}>{totals.flagged}</span>
      </Figure>
    </div>
  );
}


function QueueEmpty({ stage, filtered, onClear }: { stage: QueueStage; filtered: boolean; onClear: () => void }) {
  if (filtered) {
    return (
      <EmptyState
        title="Nothing matches these filters"
        description="Clear a filter or search for a different payee."
        action={
          <Button size="sm" variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    );
  }
  const copy: Record<QueueStage, { title: string; description: string }> = {
    review: {
      title: "Every transaction is decided",
      description: "Import the next statement to bring in new transactions to review.",
    },
    ready: {
      title: "Nothing is waiting to post",
      description: "Transactions an auto-post rule codes appear here until they are posted.",
    },
    posted: { title: "Nothing posted yet", description: "Accepted transactions appear here with their journal entry." },
    excluded: { title: "Nothing excluded", description: "Returned payments and other money that never moved land here." },
  };
  return (
    <EmptyState
      title={copy[stage].title}
      description={copy[stage].description}
      action={
        stage === "review" ? (
          <Button asChild size="sm">
            <Link href="/banking/import">Import a statement</Link>
          </Button>
        ) : undefined
      }
    />
  );
}

function ActionButton({
  label,
  hint,
  icon,
  onClick,
  variant = "secondary",
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  onClick: () => void;
  variant?: "default" | "secondary" | "ghost" | "danger-quiet";
}) {
  return (
    <Button type="button" size="sm" variant={variant} onClick={onClick}>
      {icon}
      {label}
      <Kbd className={cn(variant === "default" && "border-primary-foreground/40 bg-transparent text-primary-foreground")}>{hint}</Kbd>
    </Button>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="eyebrow">{label}</dt>
      <dd className="min-w-0 text-xs text-foreground">{children}</dd>
    </div>
  );
}

function RowDetail({
  row,
  stage,
  accounts,
  override,
  canApprove,
  pickerRef,
  onPick,
  onPickerClosed,
  onAccept,
  onPersonal,
  onSplit,
  onTransfer,
  onMatch,
  onRule,
  onExclude,
  onUnpost,
}: {
  row: QueueRow;
  stage: QueueStage;
  accounts: readonly AccountOption[];
  override: string | null;
  canApprove: boolean;
  pickerRef: React.Ref<HTMLButtonElement>;
  onPick: (accountId: string) => void;
  onPickerClosed: () => void;
  onAccept: () => void;
  onPersonal: () => void;
  onSplit: () => void;
  onTransfer: () => void;
  onMatch: () => void;
  onRule: () => void;
  onExclude: () => void;
  onUnpost: () => void;
}) {
  const deciding = stage === "review" || stage === "ready";
  const current = override ?? row.suggestion.account?.id ?? row.refundOriginal?.account?.id ?? null;
  // Money the ledger already holds is matched, not accepted: the key action swaps.
  const booked = row.flags.includes("already_booked");
  const matchedDocument =
    row.matchedType === "receipt"
      ? { label: "Receipt", href: `/sales/receipts/${row.matchedId ?? ""}` }
      : row.matchedType === "bill_payment"
        ? { label: "Bill payment", href: `/purchases/payments/${row.matchedId ?? ""}` }
        : null;
  return (
    <div className="flex flex-col gap-3 pl-6">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Why this account">
          {row.suggestion.reasoning ?? <span className="text-muted-foreground">No reasoning recorded.</span>}
        </Fact>
        <Fact label="Source">
          {row.suggestion.rule !== null ? (
            <>
              Rule “{row.suggestion.rule.name}”
              {row.suggestion.rule.autoPost ? (
                <Badge tone="primary" size="sm" className="ml-1">
                  Auto-post
                </Badge>
              ) : null}
            </>
          ) : row.suggestion.source === null ? (
            <span className="text-muted-foreground">Nothing proposed an account</span>
          ) : (
            <>
              {row.suggestion.source === "ai" ? "AI suggestion" : row.suggestion.source === "history" ? "Earlier decisions for this payee" : "Matched document"}
            </>
          )}
          {row.suggestion.vendor !== null ? <span className="block text-muted-foreground">Vendor: {row.suggestion.vendor.name}</span> : null}
        </Fact>
        <Fact label="Statement line">
          <span className="block break-words">{row.description}</span>
          {row.balanceCents !== null ? (
            <span className="text-muted-foreground">
              Balance after <Money cents={row.balanceCents} currency plain className="text-xs" />
            </span>
          ) : null}
        </Fact>
        {row.transferPartner !== null ? (
          <Fact label="Other leg">
            {shortDate(row.transferPartner.txnDate)} on {row.transferPartner.bankAccountName} ·{" "}
            <Money cents={row.transferPartner.amountCents} currency signed colorPositive className="text-xs" />
          </Fact>
        ) : row.refundOriginal !== null ? (
          <Fact label="Refund of">
            {shortDate(row.refundOriginal.txnDate)} {row.refundOriginal.payee} ·{" "}
            <Money cents={row.refundOriginal.amountCents} currency className="text-xs" />
            {row.refundOriginal.account !== null ? (
              <span className="block text-muted-foreground">
                Charge coded to {row.refundOriginal.account.code} {row.refundOriginal.account.name}
              </span>
            ) : null}
          </Fact>
        ) : row.notes ? (
          <Fact label="Notes">{row.notes}</Fact>
        ) : null}
      </dl>

      {canApprove ? (
        <div className="flex flex-wrap items-center gap-2">
          {deciding && row.status !== "transfer" ? (
            <>
              <div className="w-full sm:w-72">
                <AccountCombobox
                  accounts={accounts}
                  value={current}
                  trackRecents
                  triggerRef={pickerRef}
                  placeholder="Choose account"
                  className="h-7"
                  onChange={onPick}
                  onDismiss={onPickerClosed}
                />
              </div>
              {booked ? (
                <ActionButton label="Match" hint="m" icon={<Link2 />} variant="default" onClick={onMatch} />
              ) : null}
              <ActionButton
                label="Accept"
                hint="↵"
                icon={<Check />}
                variant={booked ? "secondary" : "default"}
                onClick={onAccept}
              />
              {booked ? null : <ActionButton label="Match" hint="m" icon={<Link2 />} onClick={onMatch} />}
              {row.amountCents < 0 ? <ActionButton label="Personal" hint="p" icon={<User />} onClick={onPersonal} /> : null}
              <ActionButton label="Split" hint="s" icon={<Scissors />} onClick={onSplit} />
              {stage === "review" ? (
                <ActionButton label="Transfer" hint="t" icon={<ArrowLeftRight />} onClick={onTransfer} />
              ) : null}
            </>
          ) : null}
          {deciding && row.status === "transfer" ? (
            <ActionButton
              label={row.transferPartner === null ? "Find other leg" : "Post transfer"}
              hint="t"
              icon={<ArrowLeftRight />}
              variant="default"
              onClick={onTransfer}
            />
          ) : null}
          <ActionButton label="Rule" hint="r" icon={<Wand2 />} variant="ghost" onClick={onRule} />
          {stage === "posted" ? (
            <>
              {matchedDocument !== null ? (
                <Button asChild size="sm" variant="secondary">
                  <Link href={matchedDocument.href}>{matchedDocument.label} — void it to undo</Link>
                </Button>
              ) : (
                <ActionButton
                  label={row.matchedType === "entry" ? "Unmatch" : "Unpost"}
                  hint="u"
                  icon={<Undo2 />}
                  variant="danger-quiet"
                  onClick={onUnpost}
                />
              )}
              {row.journalEntryId !== null ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/ledger/${row.journalEntryId}`}>Entry #{row.entryNo}</Link>
                </Button>
              ) : null}
            </>
          ) : (
            <ActionButton
              label={stage === "excluded" ? "Return to review" : "Exclude"}
              hint="x"
              icon={<CircleSlash />}
              variant="ghost"
              onClick={onExclude}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function PayeeGroups({
  groups,
  focusKey,
  stage,
  canApprove,
  onFocus,
  onAccept,
  onReview,
}: {
  groups: readonly PayeeGroup[];
  focusKey: string | null;
  stage: QueueStage;
  canApprove: boolean;
  onFocus: (key: string) => void;
  onAccept: (group: PayeeGroup) => void;
  onReview: (group: PayeeGroup) => void;
}) {
  const deciding = stage === "review" || stage === "ready";
  if (groups.length === 0) {
    return <p className="border-t border-border px-3 py-10 text-center text-xs text-muted-foreground">No payees to group.</p>;
  }
  return (
    <div className="relative overflow-x-auto border-t border-border">
      <table className="w-full min-w-[52rem] border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Transactions grouped by payee</caption>
        <thead>
          <tr>
            <Th>Payee</Th>
            <Th className="w-16 text-right">Count</Th>
            <Th className="w-[34%]">Suggested</Th>
            <Th className="w-28 text-right">Money in</Th>
            <Th className="rule-gutter w-28 text-right">Money out</Th>
            <Th className="w-56">
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const isFocused = group.key === focusKey;
            const inCents = group.rows.reduce((s, r) => s + Math.max(0, r.amountCents), 0);
            const outCents = group.rows.reduce((s, r) => s + Math.min(0, r.amountCents), 0);
            return (
              <tr
                key={group.key}
                onClick={() => onFocus(group.key)}
                className={cn("align-top", isFocused ? "bg-primary/5" : "hover:bg-muted/60")}
              >
                <td className={cn("rule-row px-3 py-2", isFocused && "shadow-[inset_3px_0_0_var(--color-primary)]")}>
                  <p className="font-medium">{group.payee}</p>
                  {group.flagged > 0 ? (
                    <p className="text-2xs text-warning">
                      {group.flagged} flagged
                    </p>
                  ) : null}
                </td>
                <td className="rule-row num px-3 py-2 text-right">{group.rows.length}</td>
                <td className="rule-row px-3 py-2">
                  {group.accounts.slice(0, 2).map((account) => (
                    <p key={account.label} className="truncate text-xs">
                      <span className="num text-muted-foreground">{account.count}×</span> {account.label}
                    </p>
                  ))}
                  {group.accounts.length > 2 ? (
                    <p className="text-2xs text-muted-foreground">and {group.accounts.length - 2} more</p>
                  ) : null}
                </td>
                <td className="rule-row px-3 py-2 text-right">
                  {inCents > 0 ? <Money cents={inCents} colorPositive className="font-medium" /> : null}
                </td>
                <td className="rule-row rule-gutter px-3 py-2 text-right">
                  {outCents < 0 ? <Money cents={outCents} className="font-medium" /> : null}
                </td>
                <td className="rule-row px-3 py-2">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => onReview(group)}>
                      Review rows
                    </Button>
                    {canApprove && deciding && group.acceptable.length > 0 ? (
                      <Button size="sm" variant={isFocused ? "default" : "secondary"} onClick={() => onAccept(group)}>
                        <Check />
                        Accept {group.acceptable.length}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MobileList({
  rows,
  stage,
  focusId,
  selected,
  detailsOpen,
  overrides,
  accounts,
  empty,
  onRowClick,
  onToggle,
  renderDetail,
}: {
  rows: readonly QueueRow[];
  stage: QueueStage;
  focusId: string | null;
  selected: ReadonlySet<string>;
  detailsOpen: boolean;
  overrides: Readonly<Record<string, string>>;
  accounts: readonly AccountOption[];
  empty: React.ReactNode;
  onRowClick: (event: React.MouseEvent, row: QueueRow) => void;
  onToggle: (row: QueueRow, shift: boolean) => void;
  renderDetail: (row: QueueRow) => React.ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => {
        const isFocused = row.id === focusId;
        const isSelected = selected.has(row.id);
        const override = overrides[row.id];
        const overrideAccount = override === undefined ? undefined : accounts.find((a) => a.id === override);
        const shown =
          stage === "posted" ? row.postedAccount : (overrideAccount ?? row.suggestion.account ?? row.refundOriginal?.account ?? null);
        const inflow = row.amountCents > 0;
        return (
          <li
            key={row.id}
            data-row-id={row.id}
            data-selected={isSelected || undefined}
            aria-current={isFocused || undefined}
            onClick={(event) => onRowClick(event, row)}
            className={cn(
              "flex flex-col gap-2 px-3 py-2.5",
              isSelected ? "bg-primary/9" : isFocused && "bg-primary/5",
              isFocused && "shadow-[inset_3px_0_0_var(--color-primary)]",
            )}
          >
            <div className="flex items-start gap-2.5">
              <button
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`Select ${payeeOf(row)} ${shortDate(row.txnDate)}`}
                onClick={() => onToggle(row, false)}
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-xs border relative max-sm:after:absolute max-sm:after:-inset-3 max-sm:after:content-['']",
                  isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border-strong bg-surface-raised",
                )}
              >
                {isSelected ? <Check className="size-3" strokeWidth={3} /> : null}
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{payeeOf(row)}</p>
                <p className="num truncate text-2xs text-muted-foreground">
                  {shortDate(row.txnDate)} · ••{row.bankAccountMask}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span className={cn("eyebrow", inflow ? "text-positive" : "text-negative")}>{inflow ? "In" : "Out"}</span>
                <Money cents={row.amountCents} colorPositive className="text-base font-semibold" />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pl-6.5 text-xs">
              {row.status === "transfer" ? (
                <span className="inline-flex items-center gap-1">
                  <ArrowLeftRight className="size-3 text-info" aria-hidden />
                  Transfer
                </span>
              ) : shown === null ? (
                <span className="text-muted-foreground italic">Choose an account</span>
              ) : (
                <span className="min-w-0 truncate">
                  <span className="num text-muted-foreground">{shown.code}</span> {shown.name}
                </span>
              )}
              {overrideAccount !== undefined ? (
                <Badge tone="outline" size="sm">
                  Your choice
                </Badge>
              ) : stage === "posted" ? null : (
                <SourceChip source={row.suggestion.source} confidence={row.suggestion.confidence} />
              )}
              <FlagMarks flags={row.flags} />
            </div>
            {isFocused && detailsOpen ? <div className="-ml-6 pt-1">{renderDetail(row)}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

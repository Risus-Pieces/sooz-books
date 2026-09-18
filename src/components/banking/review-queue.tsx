"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { rememberAccount } from "@/components/ledger/account-combobox";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { GroupRow, InsetGroup, ListRow } from "@/components/ui/inset-group";
import { KeyLegend, Kbd, type KeyLegendItem } from "@/components/ui/keycap";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PopUpButton } from "@/components/ui/pop-up-button";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";
import { ToolbarButton, ToolbarGroup, ToolbarLink } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";
import type { Tint } from "@/lib/ui/tints";
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

import { AutoPostButton } from "./auto-post-button";
import { BulkDetail, NothingChosen, PayeeDetail, RowDetail, type CategoryShare } from "./queue-detail";
import { byMonth, categoryOf, indexAccounts, monthHeader, shownAccount } from "./queue-format";
import { ListSection, QueueListItem } from "./queue-parts";
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
  payeeKey,
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
  stageCounts: Record<QueueStage, number>;
  rows: readonly QueueRow[];
  accounts: readonly AccountOption[];
  vendors: readonly VendorOption[];
  canApprove: boolean;
  mayAutoPost: boolean;
  mayImport: boolean;
  /** The auto-post rows waiting in "Ready", when that stage is shown to someone who may post them. */
  autoPost: { count: number; netCents: number } | null;
  /** True when the engine returned its page limit and older rows exist. */
  truncated: boolean;
}

type View = "list" | "payee";
type Quick = "all" | "flagged" | "ai";

const STAGE_LABEL: Record<QueueStage, string> = {
  review: "To review",
  ready: "Ready",
  posted: "Posted",
  excluded: "Excluded",
};

const STAGE_ORDER: readonly QueueStage[] = ["review", "ready", "posted", "excluded"];

const DESKTOP_QUERY = "(min-width: 1024px)";

function isDesktop(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

function subscribeDesktop(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Whether the detail sits beside the list. The server renders the phone's answer, so a phone never
 * flashes a highlighted row it cannot see; a desktop highlights the focused row once hydrated.
 */
function useDesktop(): boolean {
  return React.useSyncExternalStore(subscribeDesktop, isDesktop, () => false);
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

/** One toolbar action: its name, glyph and key, for the desktop toolbar and the phone's list alike. */
interface QueueAction {
  id: string;
  label: string;
  glyph: GlyphName;
  shortcut?: string;
  tone?: "danger";
  tint: Tint;
  run?: () => void;
  href?: string;
}

export function ReviewQueue({
  stage,
  stageCounts,
  rows,
  accounts,
  vendors,
  canApprove,
  mayAutoPost,
  mayImport,
  autoPost,
  truncated,
}: ReviewQueueProps) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<QueueFilter>(EMPTY_FILTER);
  const [view, setView] = React.useState<View>("list");
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  const [focusState, setFocusId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = React.useState<string | null>(null);
  const [selecting, setSelecting] = React.useState(false);
  const [overrides, setOverrides] = React.useState<Readonly<Record<string, string>>>({});
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const [splitRow, setSplitRow] = React.useState<QueueRow | null>(null);
  const [transferRow, setTransferRow] = React.useState<QueueRow | null>(null);
  const [ruleRow, setRuleRow] = React.useState<QueueRow | null>(null);
  const [matchRequest, setMatchRequest] = React.useState<MatchRequest | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const desktop = useDesktop();

  const listRef = React.useRef<HTMLUListElement>(null);
  const deskSearchRef = React.useRef<HTMLInputElement>(null);
  const phoneSearchRef = React.useRef<HTMLInputElement>(null);
  const pickerRef = React.useRef<HTMLButtonElement>(null);

  const accountIndex = React.useMemo(() => indexAccounts(accounts), [accounts]);
  const live = React.useMemo(() => rows.filter((row) => !hidden.has(row.id)), [rows, hidden]);
  const visible = React.useMemo(() => live.filter((row) => matchesFilter(row, filter)), [live, filter]);
  const ids = React.useMemo(() => visible.map((row) => row.id), [visible]);
  const groups = React.useMemo(() => groupByPayee(visible), [visible]);
  const [groupFocus, setGroupFocus] = React.useState<string | null>(null);

  // The focused row, or the first one when it has left the list.
  const focusId = focusState !== null && ids.includes(focusState) ? focusState : (ids[0] ?? null);
  const focused = focusId === null ? undefined : visible.find((row) => row.id === focusId);
  const selectedRows = React.useMemo(() => visible.filter((row) => selected.has(row.id)), [visible, selected]);
  const focusedGroup = groups.find((g) => g.key === groupFocus) ?? groups[0];

  React.useEffect(() => {
    if (focusId === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-id="${focusId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  const months = React.useMemo(
    () => [...new Set(rows.map((row) => row.txnDate.slice(0, 7)))].sort().reverse(),
    [rows],
  );
  const newestYear = months[0]?.slice(0, 4) ?? "";
  const banks = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.bankAccountId, row.bankAccountMask === null ? row.bankAccountName : `••${row.bankAccountMask}`);
    return [...map];
  }, [rows]);

  const accountFor = React.useCallback(
    (row: QueueRow) => {
      const override = overrides[row.id];
      return shownAccount(row, stage, override === undefined ? undefined : accountIndex.get(override));
    },
    [accountIndex, overrides, stage],
  );

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

  /** A decision made from the phone's sheet returns to the list, as iOS pops a pushed view. */
  const closeSheet = React.useCallback(() => setSheetOpen(false), []);

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
    window.setTimeout(() => pickerRef.current?.click(), 0);
  }, []);

  const acceptOne = React.useCallback(
    (row: QueueRow) => {
      if (row.status === "transfer") {
        if (row.transferPartner === null) {
          closeSheet();
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
        closeSheet();
        post(false);
        return;
      }
      if (overrides[row.id] === undefined && !canAcceptAsSuggested(row)) {
        toast.info("Choose an account first.");
        setFocusId(row.id);
        openPicker();
        return;
      }
      closeSheet();
      runAccept([row]);
    },
    [closeSheet, hide, offerMatch, openPicker, overrides, restore, runAccept],
  );

  const acceptSelection = React.useCallback(
    (targets: readonly QueueRow[], title: string) => {
      const acceptable = targets.filter((row) => overrides[row.id] !== undefined || canAcceptAsSuggested(row));
      const skipped = targets.length - acceptable.length;
      if (acceptable.length === 0) {
        toast.info("None of these has an account yet. Choose one for each, or split them.");
        return;
      }
      const flagged = acceptable.filter((row) => row.flags.includes("mixed_use")).length;
      closeSheet();
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
              <p className="text-ink-orange">
                {flagged} {flagged === 1 ? "is" : "are"} from a mixed-use payee. Mark any personal purchase with{" "}
                <Kbd>P</Kbd> first: once posted, a purchase has to be unposted to change.
              </p>
            ) : null}
            {skipped > 0 ? (
              <p className="text-label2">
                {skipped} without an account {skipped === 1 ? "stays" : "stay"} in the queue.
              </p>
            ) : null}
          </div>
        ),
        onConfirm: () => runAccept(acceptable),
      });
    },
    [closeSheet, overrides, runAccept],
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
      closeSheet();
      post(false);
    },
    [closeSheet, hide, offerMatch, restore],
  );

  const match = React.useCallback(
    (row: QueueRow) => {
      if (row.status === "transfer") {
        toast.info("This is a transfer leg. Unpair it before matching it to anything else.");
        return;
      }
      closeSheet();
      setMatchRequest({ row, postAnyway: null });
    },
    [closeSheet],
  );

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
      closeSheet();
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
    [closeSheet, hide, restore, stage],
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
      closeSheet();
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
            } else {
              restore(leaving);
              toast.error(result.error.message);
            }
          });
        },
      });
    },
    [closeSheet, hide, restore],
  );

  const transfer = React.useCallback(
    (row: QueueRow) => {
      if (row.status === "transfer" && row.transferPartner !== null) acceptOne(row);
      else {
        closeSheet();
        setTransferRow(row);
      }
    },
    [acceptOne, closeSheet],
  );

  const split = React.useCallback(
    (row: QueueRow) => {
      closeSheet();
      setSplitRow(row);
    },
    [closeSheet],
  );

  const rule = React.useCallback(
    (row: QueueRow) => {
      closeSheet();
      setRuleRow(row);
    },
    [closeSheet],
  );

  const clearSelection = React.useCallback(() => {
    setSelected(new Set());
    setAnchor(focusId);
  }, [focusId]);

  /** Selects every visible row that shares something with the focused one: the bulk shortcut. */
  const selectWhere = React.useCallback(
    (predicate: (row: QueueRow) => boolean) => {
      const chosen = visible.filter(predicate).map((row) => row.id);
      setSelected(new Set(chosen));
      setAnchor(focusId);
    },
    [focusId, visible],
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

  const focusSearch = React.useCallback(() => {
    const target = [deskSearchRef.current, phoneSearchRef.current].find((el) => el !== null && el.offsetParent !== null);
    target?.focus();
  }, []);

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
        focusSearch();
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
        clearSelection();
        return;
      }
      if (key === "o") {
        event.preventDefault();
        if (!isDesktop()) setSheetOpen((open) => !open);
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
          if (!isDesktop()) setSheetOpen(true);
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
          split(row);
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
          rule(row);
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
    clearSelection,
    exclude,
    focusSearch,
    focused,
    groupFocus,
    groups,
    match,
    move,
    moveGroup,
    openPicker,
    personal,
    rule,
    selectedRows,
    split,
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
    } else if (event.metaKey || event.ctrlKey || selecting) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      setAnchor(row.id);
    } else {
      setAnchor(row.id);
      setSelected(new Set());
      if (!isDesktop()) setSheetOpen(true);
    }
    setFocusId(row.id);
    // Hand the keyboard back to the list, so j/k and Enter work straight after a click.
    refocusList();
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
    refocusList();
  };

  // ---------------------------------------------------------------------------
  // What the toolbar offers
  // ---------------------------------------------------------------------------

  const deciding = stage === "review" || stage === "ready";
  const many = selectedRows.length > 1 && view === "list";

  const actionGroups = React.useMemo((): QueueAction[][] => {
    if (!canApprove) return [];
    if (view === "payee") {
      const group = focusedGroup;
      if (group === undefined) return [];
      return [
        deciding && group.acceptable.length > 0
          ? [{ id: "accept-group", label: `Accept ${group.acceptable.length}`, glyph: "check", shortcut: "⏎", tint: "blue", run: () => acceptGroup(group) } satisfies QueueAction]
          : [],
        [
          {
            id: "rows",
            label: "Show rows",
            glyph: "list",
            tint: "gray",
            run: () => {
              setFilter((f) => ({ ...f, search: group.payee }));
              setView("list");
            },
          } satisfies QueueAction,
        ],
      ].filter((g) => g.length > 0);
    }
    if (many) {
      return [
        deciding
          ? [
              {
                id: "accept-many",
                label: `Accept ${selectedRows.length}`,
                glyph: "check",
                shortcut: "⏎",
                tint: "blue",
                run: () => acceptSelection(selectedRows, `Accept ${selectedRows.length} selected`),
              } satisfies QueueAction,
            ]
          : [],
        stage !== "posted"
          ? [
              {
                id: "exclude-many",
                label: stage === "excluded" ? "Return to review" : "Exclude",
                glyph: stage === "excluded" ? "undo" : "exclude",
                shortcut: "X",
                tone: stage === "excluded" ? undefined : "danger",
                tint: stage === "excluded" ? "blue" : "red",
                run: () => exclude(selectedRows),
              } satisfies QueueAction,
            ]
          : [],
        [{ id: "clear", label: "Clear selection", glyph: "xmark", shortcut: "Esc", tint: "gray", run: clearSelection } satisfies QueueAction],
      ].filter((g) => g.length > 0);
    }
    const row = focused;
    if (row === undefined) return [];
    if (stage === "posted") {
      const doc =
        row.matchedType === "receipt"
          ? { label: "Open receipt", href: `/sales/receipts/${row.matchedId ?? ""}` }
          : row.matchedType === "bill_payment"
            ? { label: "Open bill payment", href: `/purchases/payments/${row.matchedId ?? ""}` }
            : null;
      return [
        [
          doc !== null
            ? ({ id: "doc", label: doc.label, glyph: "doc", tint: "blue", href: doc.href } satisfies QueueAction)
            : ({
                id: "unpost",
                label: row.matchedType === "entry" ? "Unmatch" : "Unpost",
                glyph: "undo",
                shortcut: "U",
                tone: "danger",
                tint: "red",
                run: () => unpost(row),
              } satisfies QueueAction),
          ...(row.journalEntryId !== null
            ? [{ id: "entry", label: `Entry #${row.entryNo}`, glyph: "doc-text", tint: "gray", href: `/ledger/${row.journalEntryId}` } satisfies QueueAction]
            : []),
        ],
        [{ id: "rule", label: "Make rule", glyph: "wand", shortcut: "R", tint: "purple", run: () => rule(row) } satisfies QueueAction],
      ];
    }
    if (stage === "excluded") {
      return [
        [{ id: "return", label: "Return to review", glyph: "undo", shortcut: "X", tint: "blue", run: () => exclude([row]) } satisfies QueueAction],
        [{ id: "rule", label: "Make rule", glyph: "wand", shortcut: "R", tint: "purple", run: () => rule(row) } satisfies QueueAction],
      ];
    }
    const isTransfer = row.status === "transfer";
    const primary: QueueAction[] = isTransfer
      ? [
          {
            id: "transfer-post",
            label: row.transferPartner === null ? "Find other leg" : "Post transfer",
            glyph: "transfer",
            shortcut: "T",
            tint: "blue",
            run: () => transfer(row),
          },
        ]
      : [
          { id: "accept", label: "Accept", glyph: "check", shortcut: "⏎", tint: "blue", run: () => acceptOne(row) },
          {
            id: "account",
            label: "Change account",
            glyph: "pencil",
            shortcut: "E",
            tint: "gray",
            run: () => {
              if (!isDesktop()) setSheetOpen(true);
              openPicker();
            },
          },
        ];
    const decide: QueueAction[] = isTransfer
      ? []
      : [
          ...(row.amountCents < 0
            ? [{ id: "personal", label: "Personal", glyph: "person", shortcut: "P", tint: "indigo", run: () => personal(row) } satisfies QueueAction]
            : []),
          { id: "split", label: "Split", glyph: "split", shortcut: "S", tint: "orange", run: () => split(row) },
          ...(stage === "review"
            ? [{ id: "transfer", label: "Transfer", glyph: "transfer", shortcut: "T", tint: "cyan", run: () => transfer(row) } satisfies QueueAction]
            : []),
          { id: "match", label: "Match", glyph: "link", shortcut: "M", tint: "teal", run: () => match(row) },
        ];
    const all: QueueAction[][] = [
      primary,
      decide,
      [{ id: "rule", label: "Make rule", glyph: "wand", shortcut: "R", tint: "purple", run: () => rule(row) }],
      [{ id: "exclude", label: "Exclude", glyph: "exclude", shortcut: "X", tone: "danger", tint: "red", run: () => exclude([row]) }],
    ];
    return all.filter((g) => g.length > 0);
  }, [
    acceptGroup,
    acceptOne,
    acceptSelection,
    canApprove,
    clearSelection,
    deciding,
    exclude,
    focused,
    focusedGroup,
    many,
    match,
    openPicker,
    personal,
    rule,
    selectedRows,
    split,
    stage,
    transfer,
    unpost,
    view,
  ]);

  const legend: KeyLegendItem[] = React.useMemo(() => {
    if (view === "payee") return [{ keys: "↑↓", label: "Move" }, { keys: "⏎", label: "Accept all" }, { keys: "?", label: "Keys" }];
    if (stage === "posted") return [{ keys: "↑↓", label: "Move" }, { keys: "U", label: "Unpost" }, { keys: "R", label: "Rule" }, { keys: "/", label: "Search" }, { keys: "?", label: "Keys" }];
    if (stage === "excluded") return [{ keys: "↑↓", label: "Move" }, { keys: "X", label: "Return" }, { keys: "R", label: "Rule" }, { keys: "/", label: "Search" }, { keys: "?", label: "Keys" }];
    return [
      { keys: "↑↓", label: "Move" },
      { keys: "⏎", label: "Accept" },
      { keys: "E", label: "Account" },
      { keys: "P", label: "Personal" },
      { keys: "S", label: "Split" },
      ...(stage === "review" ? [{ keys: "T", label: "Transfer" }] : []),
      { keys: "M", label: "Match" },
      { keys: "R", label: "Rule" },
      { keys: "X", label: "Exclude" },
      { keys: "?", label: "Keys" },
    ];
  }, [stage, view]);

  // ---------------------------------------------------------------------------
  // The detail
  // ---------------------------------------------------------------------------

  const renderDetail = (phone: boolean) => {
    const footer = phone ? undefined : <KeyLegend items={legend} />;
    // The phone lists every action the buttons above it do not already offer.
    const personalShown = focused !== undefined && !many && view === "list" && focused.flags.includes("mixed_use") && !focused.flags.includes("already_booked");
    const skip = ["accept", "account", "accept-many", "accept-group", "transfer-post", "clear", ...(personalShown ? ["personal"] : [])];
    const more = phone ? <PhoneActions groups={actionGroups} skip={skip} /> : undefined;

    if (view === "payee") {
      if (focusedGroup === undefined) return <NothingChosen />;
      return (
        <PayeeDetail
          group={focusedGroup}
          footer={footer}
          actions={
            canApprove && deciding && focusedGroup.acceptable.length > 0 ? (
              <>
                <Button onClick={() => acceptGroup(focusedGroup)}>
                  <Glyph name="check" />
                  Accept {focusedGroup.acceptable.length}
                  <Kbd className="bg-white/20 text-white shadow-none">⏎</Kbd>
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFilter((f) => ({ ...f, search: focusedGroup.payee }));
                    setView("list");
                    closeSheet();
                  }}
                >
                  <Glyph name="list" />
                  Show rows
                </Button>
              </>
            ) : undefined
          }
        />
      );
    }

    if (many) {
      const shares = new Map<string, CategoryShare>();
      for (const row of selectedRows) {
        const account = accountFor(row);
        const c = categoryOf(account, accountIndex);
        const key = row.status === "transfer" ? "transfer" : (c?.key ?? "none");
        const entry = shares.get(key) ?? {
          key,
          label: row.status === "transfer" ? "Transfers" : (c?.label ?? "No account"),
          tint: row.status === "transfer" ? "blue" : (c?.tint ?? "gray"),
          cents: 0,
          count: 0,
        };
        entry.cents += Math.abs(row.amountCents);
        entry.count += 1;
        shares.set(key, entry);
      }
      return (
        <BulkDetail
          rows={selectedRows}
          shares={[...shares.values()].sort((a, b) => b.cents - a.cents)}
          footer={footer}
          more={more}
          actions={
            canApprove ? (
              <>
                {deciding ? (
                  <Button onClick={() => acceptSelection(selectedRows, `Accept ${selectedRows.length} selected`)}>
                    <Glyph name="check" />
                    Accept {selectedRows.length}
                    <Kbd className="bg-white/20 text-white shadow-none">⏎</Kbd>
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={clearSelection}>
                  Clear
                </Button>
              </>
            ) : undefined
          }
        />
      );
    }

    const row = focused;
    if (row === undefined) return <NothingChosen />;
    const account = accountFor(row);
    const category = categoryOf(account, accountIndex);
    const booked = row.flags.includes("already_booked");
    const mixed = row.flags.includes("mixed_use");
    const key = payeeKey(row);
    const sameAccountRows =
      account === null || !deciding ? [] : visible.filter((r) => r.id !== row.id && accountFor(r)?.id === account.id);
    const samePayeeRows = deciding ? visible.filter((r) => r.id !== row.id && payeeKey(r) === key) : [];

    let actions: React.ReactNode = undefined;
    if (canApprove && deciding) {
      if (row.status === "transfer") {
        actions = (
          <Button onClick={() => transfer(row)}>
            <Glyph name="transfer" />
            {row.transferPartner === null ? "Find other leg" : "Post transfer"}
            <Kbd className="bg-white/20 text-white shadow-none">T</Kbd>
          </Button>
        );
      } else {
        actions = (
          <>
            {booked ? (
              <Button onClick={() => match(row)}>
                <Glyph name="link" />
                Match
                <Kbd className="bg-white/20 text-white shadow-none">M</Kbd>
              </Button>
            ) : null}
            <Button variant={booked ? "secondary" : "default"} onClick={() => acceptOne(row)}>
              <Glyph name="check" />
              Accept
              <Kbd className={booked ? undefined : "bg-white/20 text-white shadow-none"}>⏎</Kbd>
            </Button>
            {!booked && mixed && row.amountCents < 0 ? (
              <Button variant="secondary" onClick={() => personal(row)}>
                <Glyph name="person" />
                Personal
                <Kbd>P</Kbd>
              </Button>
            ) : null}
          </>
        );
      }
    } else if (canApprove && stage === "excluded") {
      actions = (
        <Button variant="secondary" onClick={() => exclude([row])}>
          <Glyph name="undo" />
          Return to review
          <Kbd>X</Kbd>
        </Button>
      );
    }

    return (
      <RowDetail
        key={row.id}
        row={row}
        stage={stage}
        account={account}
        category={category}
        accounts={accounts}
        override={overrides[row.id] ?? null}
        canApprove={canApprove}
        pickerRef={pickerRef}
        onPick={(accountId) => {
          rememberAccount(accountId);
          setOverrides((current) => ({ ...current, [row.id]: accountId }));
        }}
        onPickerClosed={refocusList}
        sameAccount={
          sameAccountRows.length > 0
            ? {
                count: sameAccountRows.length,
                cents: sameAccountRows.reduce((s, r) => s + Math.abs(r.amountCents), 0),
                onSelect: () => selectWhere((r) => accountFor(r)?.id === account?.id),
              }
            : null
        }
        samePayee={
          samePayeeRows.length > 0
            ? {
                count: samePayeeRows.length,
                cents: samePayeeRows.reduce((s, r) => s + Math.abs(r.amountCents), 0),
                onSelect: () => selectWhere((r) => payeeKey(r) === key),
              }
            : null
        }
        actions={actions}
        footer={footer}
        more={more}
      />
    );
  };

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  const totals = totalsOf(visible);
  const filtered = isFilterActive(filter);
  const quick: Quick = filter.flaggedOnly ? "flagged" : filter.source === "ai" ? "ai" : "all";
  const flaggedCount = live.filter((row) => row.flags.length > 0).length;

  const searchProps = {
    value: filter.search,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setFilter((f) => ({ ...f, search: event.target.value })),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        listRef.current?.focus();
      }
    },
    "aria-label": "Search payee, reference or amount",
  };

  const empty = (
    <QueueEmpty stage={stage} filtered={filtered} mayImport={mayImport} onClear={() => setFilter(EMPTY_FILTER)} />
  );

  return (
    <div className="flex flex-col lg:-mx-5 lg:-mb-8 lg:grid lg:min-h-dvh lg:grid-cols-[380px_minmax(0,1fr)]">
      {/* ------------------------------------------------------------ the list */}
      <section aria-label="Transactions" className="flex min-w-0 flex-col lg:hairline-r lg:bg-card">
        <PageToolbar
          title="Review"
          subtitle={
            <span className="flex items-center gap-1.5 max-md:hidden">
              <span className="num">{totals.count}</span>
              <span aria-hidden>·</span>
              <Money cents={-totals.outCents} currency plain />
            </span>
          }
          info="Decide what each bank transaction was. Nothing reaches the ledger until you accept it; only a rule you marked auto-post posts on its own."
          appearanceButton={false}
          className="lg:mx-0 lg:bg-[color-mix(in_srgb,var(--card)_82%,transparent)]"
          actions={
            <OptionsButton
              filter={filter}
              setFilter={setFilter}
              months={months}
              banks={banks}
              view={view}
              setView={(next) => {
                setView(next);
                if (next === "payee") setGroupFocus(groups[0]?.key ?? null);
              }}
              selecting={selecting}
              setSelecting={(next) => {
                setSelecting(next);
                if (!next) setSelected(new Set());
              }}
              mayImport={mayImport}
              onShortcuts={() => setShortcutsOpen(true)}
            />
          }
        />

        <SummaryStrip totals={totals} className="md:hidden" />

        <div className="flex flex-col gap-2.5 pt-2 lg:hairline-b lg:px-3.5 lg:pt-0 lg:pb-2.5">
          <SearchField ref={phoneSearchRef} className="lg:hidden" {...searchProps} />
          <div className="flex items-center gap-2">
            <SegmentedControl
              aria-label="Show"
              fill
              className="min-w-0 flex-1 max-md:bg-fill"
              value={quick}
              onValueChange={(next) =>
                setFilter((f) => ({
                  ...f,
                  flaggedOnly: next === "flagged",
                  source: next === "ai" ? "ai" : f.source === "ai" ? "" : f.source,
                }))
              }
              options={[
                { value: "all", label: "All" },
                { value: "flagged", label: "Flagged", glyph: "flag", glyphTint: "orange", iconOnly: true, count: flaggedCount },
                { value: "ai", label: "AI", glyph: "sparkle", glyphTint: "purple" },
              ]}
            />
            <PopUpButton
              aria-label="Stage"
              appearance="toolbar"
              className="shrink-0 max-md:h-8 max-md:bg-fill max-md:text-sm"
              value={stage}
              onValueChange={(next) => router.push(next === "review" ? "/banking/review" : `/banking/review?stage=${next}`)}
              options={STAGE_ORDER.map((s) => ({ value: s, label: `${STAGE_LABEL[s]} ${stageCounts[s]}` }))}
            />
          </div>
          {autoPost !== null && autoPost.count > 0 ? (
            <AutoPostButton count={autoPost.count} netCents={autoPost.netCents} className="self-start" />
          ) : null}
        </div>

        {many ? (
          <div className="sticky top-0 z-10 mt-2 flex items-center gap-2 rounded-[12px] bg-accent-fill px-3 py-2 text-sm font-medium text-white lg:hidden">
            <span className="num flex-1">{selectedRows.length} selected</span>
            {canApprove && deciding ? (
              <Button size="sm" variant="secondary" onClick={() => acceptSelection(selectedRows, `Accept ${selectedRows.length} selected`)}>
                Accept {selectedRows.length}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" className="text-white hover:bg-white/15" onClick={() => setSheetOpen(true)}>
              More
            </Button>
          </div>
        ) : null}

        <ul
          ref={listRef}
          tabIndex={-1}
          aria-label="Bank transactions"
          className="flex min-w-0 flex-1 flex-col outline-none lg:px-2 lg:pt-1 lg:pb-4"
        >
          {view === "payee" ? (
            groups.length === 0 ? (
              <li>{empty}</li>
            ) : (
              <li>
                <ListSection header="Payees">
                  {groups.map((group) => (
                    <PayeeRow
                      key={group.key}
                      group={group}
                      current={group.key === focusedGroup?.key && (desktop || sheetOpen)}
                      onClick={() => {
                        setGroupFocus(group.key);
                        if (!isDesktop()) setSheetOpen(true);
                      }}
                    />
                  ))}
                </ListSection>
              </li>
            )
          ) : visible.length === 0 ? (
            <li>{empty}</li>
          ) : (
            byMonth(visible, (row) => row.txnDate).map((bucket) => (
              <li key={bucket.month}>
                <ListSection header={monthHeader(bucket.month, newestYear)}>
                  {bucket.items.map((row) => {
                    const account = accountFor(row);
                    return (
                      <QueueListItem
                        key={row.id}
                        row={row}
                        stage={stage}
                        account={account}
                        category={categoryOf(account, accountIndex)}
                        overridden={overrides[row.id] !== undefined && stage !== "posted"}
                        current={row.id === focusId && (desktop || sheetOpen) && (selected.size === 0 || selected.has(row.id))}
                        selected={selected.has(row.id)}
                        selecting={selecting}
                        onClick={(event) => onRowClick(event, row)}
                        onToggle={(shift) => toggleSelected(row, shift)}
                      />
                    );
                  })}
                </ListSection>
              </li>
            ))
          )}
          {truncated ? (
            <li className="px-4 pt-3 text-xs text-label2">Newest 500 shown</li>
          ) : null}
        </ul>
      </section>

      {/* ------------------------------------------------------------ the detail (desktop) */}
      <section aria-label="Detail" className="min-w-0 max-lg:hidden">
        <div className="sticky top-0 flex h-dvh flex-col">
          <div
            role="toolbar"
            aria-label="Transaction"
            className="flex h-[60px] shrink-0 items-center gap-3 px-5"
          >
            {actionGroups.map((group) => (
              <ToolbarGroup key={group.map((a) => a.id).join("-")}>
                {group.map((action) =>
                  action.href !== undefined ? (
                    <ToolbarLink key={action.id} href={action.href} glyph={action.glyph} label={action.label} tone={action.tone} />
                  ) : (
                    <ToolbarButton
                      key={action.id}
                      glyph={action.glyph}
                      label={action.label}
                      shortcut={action.shortcut}
                      tone={action.tone}
                      onClick={action.run}
                    />
                  ),
                )}
              </ToolbarGroup>
            ))}
            <span className="flex-1" />
            <SearchField ref={deskSearchRef} appearance="toolbar" {...searchProps} />
            <ThemeToggle />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto [&>article]:min-h-full">{renderDetail(false)}</div>
        </div>
      </section>

      {/* ------------------------------------------------------------ the detail (phone, tablet) */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent title={view === "payee" ? (focusedGroup?.payee ?? "Payee") : many ? "Selection" : focused === undefined ? "Transaction" : payeeOf(focused)} hideTitle width="lg" className="lg:hidden">
          {renderDetail(true)}
        </SheetContent>
      </Sheet>

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

/** The phone's In · Out · Flagged card under the large title. */
function SummaryStrip({ totals, className }: { totals: ReturnType<typeof totalsOf>; className?: string }) {
  const cell = "flex min-w-0 flex-col gap-1 px-3.5";
  const label = "flex items-center gap-1 text-xs font-semibold text-label2";
  return (
    <div className={cn("mb-1 grid grid-cols-3 rounded-[22px] bg-card py-3.5 shadow-card", className)}>
      <div className={cell}>
        <span className={label}>
          <Glyph name="arrow-in" size={13} weight={2.2} className="text-ink-green" />
          In
        </span>
        <Money cents={totals.inCents} currency className="text-[1.1875rem] font-bold tracking-[-0.02em] text-ink-green" />
      </div>
      <div className={cn(cell, "hairline-l")}>
        <span className={label}>
          <Glyph name="arrow-out" size={13} weight={2.2} />
          Out
        </span>
        <Money cents={totals.outCents} currency plain className="text-[1.1875rem] font-bold tracking-[-0.02em]" />
      </div>
      <div className={cn(cell, "hairline-l")}>
        <span className={label}>
          <Glyph name="flag" size={13} className="text-tint-orange" />
          Flagged
        </span>
        <span className="num text-[1.1875rem] font-bold tracking-[-0.02em]">{totals.flagged}</span>
      </div>
    </div>
  );
}

/** Month, source, bank, view, selection and help, behind one button. */
function OptionsButton({
  filter,
  setFilter,
  months,
  banks,
  view,
  setView,
  selecting,
  setSelecting,
  mayImport,
  onShortcuts,
}: {
  filter: QueueFilter;
  setFilter: React.Dispatch<React.SetStateAction<QueueFilter>>;
  months: readonly string[];
  banks: readonly (readonly [string, string])[];
  view: View;
  setView: (view: View) => void;
  selecting: boolean;
  setSelecting: (on: boolean) => void;
  mayImport: boolean;
  onShortcuts: () => void;
}) {
  const active = filter.month !== "" || filter.bankAccountId !== "" || (filter.source !== "" && filter.source !== "ai");
  return (
    <ToolbarGroup>
      <Popover>
        <PopoverTrigger asChild>
          <ToolbarButton glyph="filter" label="Filters" tone={active ? "accent" : "default"} />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[300px] p-2">
          <InsetGroup className="[&>div]:bg-inset [&>div]:shadow-none">
            <GroupRow label="Month">
              <PopUpButton
                aria-label="Month"
                value={filter.month === "" ? ANY : filter.month}
                onValueChange={(v) => setFilter((f) => ({ ...f, month: v === ANY ? "" : v }))}
                options={[{ value: ANY, label: "Every month" }, ...months.map((m) => ({ value: m, label: monthLabel(m) }))]}
              />
            </GroupRow>
            <GroupRow label="Source">
              <PopUpButton
                aria-label="Suggestion source"
                value={filter.source === "" ? ANY : filter.source}
                onValueChange={(v) => setFilter((f) => ({ ...f, source: v === ANY ? "" : (v as QueueSource) }))}
                options={[
                  { value: ANY, label: "Any" },
                  { value: "rule", label: "Rule" },
                  { value: "history", label: "History" },
                  { value: "ai", label: "AI" },
                  { value: "match", label: "Match" },
                  { value: "none", label: "None" },
                ]}
              />
            </GroupRow>
            {banks.length > 1 ? (
              <GroupRow label="Account">
                <PopUpButton
                  aria-label="Bank account"
                  value={filter.bankAccountId === "" ? ANY : filter.bankAccountId}
                  onValueChange={(v) => setFilter((f) => ({ ...f, bankAccountId: v === ANY ? "" : v }))}
                  options={[{ value: ANY, label: "All" }, ...banks.map(([id, label]) => ({ value: id, label }))]}
                />
              </GroupRow>
            ) : null}
            <GroupRow label="View">
              <SegmentedControl
                aria-label="View"
                value={view}
                onValueChange={(v) => setView(v === "payee" ? "payee" : "list")}
                options={[
                  { value: "list", label: "List", glyph: "list" },
                  { value: "payee", label: "Payee", glyph: "people" },
                ]}
              />
            </GroupRow>
          </InsetGroup>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant={selecting ? "default" : "secondary"} aria-pressed={selecting} onClick={() => setSelecting(!selecting)}>
              <Glyph name="check-circle" />
              Select
            </Button>
            <Button size="sm" variant="ghost" onClick={onShortcuts} className="max-md:hidden">
              <Glyph name="key" />
              Keys
            </Button>
            {mayImport ? (
              <Button asChild size="sm" variant="ghost">
                <Link href="/banking/import">
                  <Glyph name="import" />
                  Import
                </Link>
              </Button>
            ) : null}
            {isFilterActive(filter) ? (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setFilter(EMPTY_FILTER)}>
                Clear
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </ToolbarGroup>
  );
}

/** Every other action for the row, as the phone lists them under the detail. */
function PhoneActions({ groups, skip }: { groups: QueueAction[][]; skip: string[] }) {
  const items = groups.flat().filter((a) => !skip.includes(a.id));
  if (items.length === 0) return null;
  return (
    <InsetGroup className="lg:hidden" separatorInset={52}>
      {items.map((action) => (
        <ListRow
          key={action.id}
          leading={<IconBadge glyph={action.glyph} tint={action.tint} size="lg" />}
          title={<span className={action.tone === "danger" ? "text-ink-red" : undefined}>{action.label}</span>}
          chevron={action.href !== undefined}
          href={action.href}
          onClick={action.href === undefined ? action.run : undefined}
        />
      ))}
    </InsetGroup>
  );
}

function PayeeRow({ group, current, onClick }: { group: PayeeGroup; current: boolean; onClick: () => void }) {
  const top = group.accounts[0];
  return (
    <li
      aria-current={current || undefined}
      onClick={onClick}
      className={cn(
        "relative flex cursor-default items-center gap-3 px-3.5 py-2.5 transition-colors select-none lg:gap-[11px] lg:rounded-[10px] lg:px-2.5 lg:py-[9px]",
        "before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-16 before:border-t-[0.5px] before:border-sep first:before:hidden lg:before:left-[57px]",
        current ? "bg-accent-fill text-white before:hidden [&+li]:before:hidden" : "hover:bg-fill2",
      )}
    >
      <Monogram name={group.payee} className={cn("max-lg:size-[38px]", current && "bg-white/22")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <b className="min-w-0 flex-1 truncate text-[1rem] font-semibold lg:text-sm">{group.payee}</b>
          <Money
            cents={group.netCents}
            currency
            signed
            colorPositive
            plain={group.netCents < 0 || current}
            className="shrink-0 text-[1rem] font-semibold lg:text-sm"
          />
        </div>
        <div className={cn("mt-[3px] flex items-center gap-1.5 text-[0.8125rem] lg:text-xs", current ? "text-white/88" : "text-label2")}>
          <span className="min-w-0 flex-1 truncate">{top === undefined ? "" : top.label}</span>
          {group.flagged > 0 ? <Glyph name="flag" size={12} label={`${group.flagged} flagged`} className={current ? undefined : "text-tint-orange"} /> : null}
          <span className="num shrink-0">{group.rows.length}</span>
        </div>
      </div>
    </li>
  );
}

function QueueEmpty({
  stage,
  filtered,
  mayImport,
  onClear,
}: {
  stage: QueueStage;
  filtered: boolean;
  mayImport: boolean;
  onClear: () => void;
}) {
  if (filtered) {
    return (
      <EmptyState
        glyph="filter"
        title="Nothing matches"
        action={
          <Button size="sm" variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    );
  }
  const copy: Record<QueueStage, { glyph: GlyphName; title: string; description: string }> = {
    review: { glyph: "check-circle", title: "All caught up", description: "Import the next statement to bring in new transactions to review." },
    ready: { glyph: "wand", title: "Nothing ready to post", description: "Transactions an auto-post rule codes appear here until they are posted." },
    posted: { glyph: "tray", title: "Nothing posted yet", description: "Accepted transactions appear here with their journal entry." },
    excluded: { glyph: "exclude", title: "Nothing excluded", description: "Returned payments and other money that never moved land here." },
  };
  return (
    <EmptyState
      glyph={copy[stage].glyph}
      title={copy[stage].title}
      description={copy[stage].description}
      action={
        stage === "review" && mayImport ? (
          <Button asChild size="sm">
            <Link href="/banking/import">Import</Link>
          </Button>
        ) : undefined
      }
    />
  );
}

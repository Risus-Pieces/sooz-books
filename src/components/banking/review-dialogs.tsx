"use client";

import * as React from "react";

import { AccountCombobox } from "@/components/ledger/account-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Glyph } from "@/components/ui/glyph";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money, formatCents } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { parseMoney } from "@/lib/money";
import {
  createRuleFromRow,
  linkToEntry,
  matchOptions,
  matchToDocuments,
  pairAndConfirmTransfer,
  transferCandidates,
  type TransferCandidate,
} from "@/app/(app)/banking/actions";

import { Kbd } from "./parts";
import { payeeOf, shortDate } from "./review-logic";
import type {
  AccountOption,
  BookedEntryView,
  DocumentMatchView,
  MatchOptionsView,
  QueueRow,
  RuleCondition,
  RuleDirection,
  RuleField,
  RuleOperator,
  VendorOption,
} from "./types";

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export interface ConfirmRequest {
  title: string;
  /** The sentence that states exactly what will happen, with its count and total. */
  body: React.ReactNode;
  confirmLabel: string;
  tone?: "default" | "danger";
  onConfirm: () => void;
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="sm">
        {request === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle>{request.title}</DialogTitle>
            </DialogHeader>
            <DialogBody className="text-sm">{request.body}</DialogBody>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant={request.tone === "danger" ? "danger" : "default"}
                autoFocus
                onClick={() => {
                  request.onConfirm();
                  onClose();
                }}
              >
                {request.confirmLabel}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

interface SplitLine {
  key: number;
  accountId: string | null;
  amount: string;
  memo: string;
}

function centsOf(text: string): number | null {
  if (text.trim() === "") return null;
  try {
    const cents = parseMoney(text);
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

type SplitDialogProps = {
  row: QueueRow | null;
  accounts: readonly AccountOption[];
  onClose: () => void;
  onSubmit: (row: QueueRow, lines: { accountId: string; amountCents: number; memo: string }[]) => void;
};

/** Keyed by the row, so each split starts from that row's own amount and suggestion. */
export function SplitDialog(props: SplitDialogProps) {
  return <SplitDialogBody key={props.row?.id ?? "closed"} {...props} />;
}

function SplitDialogBody({
  row,
  accounts,
  onClose,
  onSubmit,
}: {
  row: QueueRow | null;
  accounts: readonly AccountOption[];
  onClose: () => void;
  onSubmit: (row: QueueRow, lines: { accountId: string; amountCents: number; memo: string }[]) => void;
}) {
  const magnitude = row === null ? 0 : Math.abs(row.amountCents);
  const [lines, setLines] = React.useState<SplitLine[]>(() =>
    row === null
      ? []
      : [
          { key: 1, accountId: row.suggestion.account?.id ?? null, amount: formatCents(magnitude), memo: "" },
          { key: 2, accountId: null, amount: "", memo: "" },
        ],
  );
  const nextKey = React.useRef(3);

  const allocated = lines.reduce((sum, line) => sum + (centsOf(line.amount) ?? 0), 0);
  const remaining = magnitude - allocated;
  const complete =
    lines.length >= 2 &&
    remaining === 0 &&
    lines.every((line) => line.accountId !== null && centsOf(line.amount) !== null);

  const update = (key: number, patch: Partial<SplitLine>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  return (
    <Dialog open={row !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="lg">
        {row === null ? null : (
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!complete) return;
              onSubmit(
                row,
                lines.map((line) => ({
                  accountId: line.accountId as string,
                  amountCents: centsOf(line.amount) as number,
                  memo: line.memo,
                })),
              );
            }}
          >
            <DialogHeader>
              <DialogTitle>Split {payeeOf(row)}</DialogTitle>
              <DialogDescription>
                {shortDate(row.txnDate)} · {row.amountCents < 0 ? "money out" : "money in"}{" "}
                <Money cents={Math.abs(row.amountCents)} currency plain /> across two or more accounts.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-2">
              <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_2rem] gap-2">
                <Label>Account and memo</Label>
                <Label className="justify-end">Amount</Label>
                <span />
              </div>
              {lines.map((line, index) => (
                <div
                  key={line.key}
                  className="grid grid-cols-[minmax(0,1fr)_7.5rem_2rem] gap-x-2 gap-y-1 border-b border-sep/60 pb-2"
                >
                  <AccountCombobox
                    accounts={accounts}
                    value={line.accountId}
                    trackRecents
                    className="h-8"
                    placeholder={`Account for line ${index + 1}`}
                    onChange={(accountId) => update(line.key, { accountId })}
                  />
                  <Input
                    numeric
                    inputMode="decimal"
                    aria-label={`Amount for line ${index + 1}`}
                    placeholder="0.00"
                    value={line.amount}
                    invalid={line.amount !== "" && centsOf(line.amount) === null}
                    onChange={(event) => update(line.key, { amount: event.target.value })}
                  />
                  <Input
                    aria-label={`Memo for line ${index + 1}`}
                    placeholder="Memo"
                    className="col-span-2 h-7 text-xs"
                    value={line.memo}
                    onChange={(event) => update(line.key, { memo: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove line ${index + 1}`}
                    className="col-start-3 row-span-2 row-start-1"
                    disabled={lines.length <= 2}
                    onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}
                  >
                    <Glyph name="trash" />
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const key = nextKey.current;
                    nextKey.current += 1;
                    setLines((current) => [
                      ...current,
                      { key, accountId: null, amount: remaining > 0 ? formatCents(remaining) : "", memo: "" },
                    ]);
                  }}
                >
                  <Glyph name="plus" />
                  Add line
                </Button>
                <p className="text-xs text-label2">
                  {remaining === 0 ? (
                    <span className="text-ink-green">Fully allocated</span>
                  ) : remaining > 0 ? (
                    <>
                      <Money cents={remaining} currency plain className="text-label" /> still to allocate
                    </>
                  ) : (
                    <>
                      <Money cents={-remaining} currency plain className="text-ink-red" /> over the transaction
                    </>
                  )}
                </p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!complete}>
                Post split
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Transfer pairing
// ---------------------------------------------------------------------------

type TransferDialogProps = {
  row: QueueRow | null;
  onClose: () => void;
  onPosted: (ids: string[]) => void;
};

export function TransferDialog(props: TransferDialogProps) {
  return <TransferDialogBody key={props.row?.id ?? "closed"} {...props} />;
}

function TransferDialogBody({ row, onClose, onPosted }: TransferDialogProps) {
  const [candidates, setCandidates] = React.useState<TransferCandidate[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (row === null) return;
    let live = true;
    void transferCandidates(row.id).then((result) => {
      if (!live) return;
      if (result.ok) setCandidates(result.value);
      else setError(result.error.message);
    });
    return () => {
      live = false;
    };
  }, [row]);

  return (
    <Dialog open={row !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="md">
        {row === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle>Pair as a transfer</DialogTitle>
              <DialogDescription>
                {shortDate(row.txnDate)} {payeeOf(row)} ·{" "}
                <Money cents={row.amountCents} currency signed colorPositive /> on ••{row.bankAccountMask}. Choose the
                other leg on another of the company&apos;s accounts.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="p-0">
              {error !== null ? (
                <p className="p-4 text-sm text-ink-red">{error}</p>
              ) : candidates === null ? (
                <p className="p-4 text-sm text-label2">Looking for the other leg…</p>
              ) : candidates.length === 0 ? (
                <p className="p-4 text-sm text-label2">
                  No unposted {row.amountCents < 0 ? "deposit" : "withdrawal"} of{" "}
                  <Money cents={Math.abs(row.amountCents)} currency plain /> on another account within ten days.
                  If this money went to or came from someone else, it is not a transfer: code it to an account instead.
                </p>
              ) : (
                <ul className="divide-y divide-sep">
                  {candidates.map((candidate) => (
                    <li key={candidate.id} className="flex items-center gap-3 px-4 py-2">
                      <span className="num w-14 shrink-0 text-xs text-label2">{shortDate(candidate.txnDate)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{candidate.payee}</span>
                        <span className="num text-2xs text-label2">{candidate.bankLabel}</span>
                      </span>
                      <Money cents={candidate.amountCents} signed colorPositive />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const result = await pairAndConfirmTransfer(row.id, candidate.id);
                            if (result.ok) {
                              toast.success(`Transfer posted as entry #${result.value.entryNo}`);
                              onPosted([row.id, candidate.id]);
                              onClose();
                            } else {
                              toast.error(result.error.message);
                            }
                          })
                        }
                      >
                        <Glyph name="transfer" />
                        Pair and post
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Match to the books
// ---------------------------------------------------------------------------

export interface MatchRequest {
  row: QueueRow;
  /**
   * Set when the engine refused to post the row because an entry already records its
   * money: the reviewer can still post it as a different transaction.
   */
  postAnyway: (() => void) | null;
}

type MatchDialogProps = {
  request: MatchRequest | null;
  onClose: () => void;
  /** Rows that left the queue: linked or matched. */
  onDone: (ids: string[]) => void;
};

/** Keyed by the row, so each opening loads that row's own candidates. */
export function MatchDialog(props: MatchDialogProps) {
  return <MatchDialogBody key={props.request?.row.id ?? "closed"} {...props} />;
}

const SOURCE_NOUN: Readonly<Record<string, string>> = {
  receipt: "Receipt",
  bill_payment: "Bill payment",
  manual: "Journal entry",
  recurring: "Recurring entry",
  sales_tax: "Sales tax payment",
  deduction: "Deduction",
  payout: "Settlement",
  inventory: "Inventory adjustment",
};

function bookedLabel(entry: BookedEntryView): string {
  const noun = SOURCE_NOUN[entry.sourceType] ?? entry.sourceType.replace("_", " ");
  const doc = entry.documentNo === null ? "" : ` ${entry.documentNo}`;
  const party = entry.partyName === null ? "" : ` · ${entry.partyName}`;
  return `${noun}${doc}${party}`;
}

function apart(days: number): string {
  if (days === 0) return "same day";
  const n = Math.abs(days);
  return `${n} day${n === 1 ? "" : "s"} ${days > 0 ? "before" : "after"} the bank`;
}

function MatchDialogBody({ request, onClose, onDone }: MatchDialogProps) {
  const row = request?.row ?? null;
  const [options, setOptions] = React.useState<MatchOptionsView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (row === null) return;
    let live = true;
    void matchOptions(row.id).then((result) => {
      if (!live) return;
      if (result.ok) setOptions(result.value);
      else setError(result.error.message);
    });
    return () => {
      live = false;
    };
  }, [row]);

  const link = (entry: BookedEntryView) => {
    if (row === null) return;
    startTransition(async () => {
      const result = await linkToEntry(row.id, entry.entryId);
      if (result.ok) {
        toast.success(`Matched to entry #${result.value.entryNo}`, { description: "Nothing new was posted." });
        onDone([row.id]);
        onClose();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  const record = (candidate: DocumentMatchView) => {
    if (row === null) return;
    const kind = candidate.documents[0]?.kind ?? "invoice";
    startTransition(async () => {
      const result = await matchToDocuments(
        row.id,
        kind,
        candidate.documents.map((doc) => doc.id),
      );
      if (result.ok) {
        toast.success(`Recorded ${kind === "invoice" ? "receipt" : "payment"} ${result.value.documentNo}`);
        onDone([row.id]);
        onClose();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  const inflow = row !== null && row.amountCents > 0;
  const docNoun = inflow ? "invoice" : "bill";

  return (
    <Dialog open={row !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="lg">
        {row === null || request === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle>Match {payeeOf(row)}</DialogTitle>
              <DialogDescription>
                {shortDate(row.txnDate)} · {inflow ? "money in" : "money out"}{" "}
                <Money cents={Math.abs(row.amountCents)} currency plain /> on ••{row.bankAccountMask}. Match it to what
                the books already hold, so the money is recorded once.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4 p-0">
              {request.postAnyway !== null ? (
                <p className="mx-4 mt-4 flex gap-2 rounded-[10px] bg-tint-orange/14 px-3 py-2 text-xs text-ink-orange">
                  <Glyph name="warning" size={14} className="mt-0.5 shrink-0" />
                  <span>
                    Not posted. An entry below already records this amount on ••{row.bankAccountMask}. Posting the
                    line as well would count the money twice.
                  </span>
                </p>
              ) : null}
              {error !== null ? (
                <p className="p-4 text-sm text-ink-red">{error}</p>
              ) : options === null ? (
                <p className="p-4 text-sm text-label2">Looking through the ledger…</p>
              ) : (
                <>
                  <section aria-labelledby="match-booked" className="flex flex-col">
                    <h3 id="match-booked" className="text-xs font-semibold text-label2 px-4 pt-3 pb-1.5">
                      Already in the ledger
                    </h3>
                    {options.booked.length === 0 ? (
                      <p className="border-y border-sep px-4 py-2.5 text-xs text-label2">
                        No unmatched entry on ••{row.bankAccountMask} for exactly this amount near this date.
                      </p>
                    ) : (
                      <ul className="divide-y divide-sep border-y border-sep">
                        {options.booked.map((entry) => (
                          <li key={entry.entryId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                            <span className="num w-14 shrink-0 text-xs text-label2">
                              {shortDate(entry.entryDate)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{bookedLabel(entry)}</span>
                              <span className="block truncate text-2xs text-label2">
                                <span className="num">#{entry.entryNo}</span> · {apart(entry.daysApart)}
                                {entry.memo === null ? null : <> · {entry.memo}</>}
                              </span>
                            </span>
                            <Money cents={entry.amountCents} signed colorPositive />
                            <Button size="sm" variant="default" disabled={pending} onClick={() => link(entry)}>
                              <Glyph name="link" />
                              Match
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section aria-labelledby="match-docs" className="flex flex-col">
                    <h3 id="match-docs" className="text-xs font-semibold text-label2 px-4 pb-1.5">
                      Open {docNoun}s
                    </h3>
                    {options.documentsBlocked !== null ? (
                      <p className="border-t border-sep px-4 py-2.5 text-xs text-label2">
                        {options.documentsBlocked}
                      </p>
                    ) : options.documents.length === 0 ? (
                      <p className="border-t border-sep px-4 py-2.5 text-xs text-label2">
                        No open {docNoun} or set of {docNoun}s adds up to this amount.
                      </p>
                    ) : (
                      <ul className="divide-y divide-sep border-t border-sep">
                        {options.documents.map((candidate) => (
                          <li
                            key={candidate.documents.map((doc) => doc.id).join(":")}
                            className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2"
                          >
                            <span className="min-w-0 flex-1">
                              {candidate.documents.map((doc) => (
                                <span key={doc.id} className="flex min-w-0 items-baseline gap-2 text-sm">
                                  <span className="num shrink-0">{doc.docNo}</span>
                                  <span className="truncate">{doc.partyName}</span>
                                  <span className="num shrink-0 text-2xs text-label2">
                                    due {shortDate(doc.dueDate)}
                                  </span>
                                  <Money cents={doc.balanceCents} plain className="ml-auto shrink-0 text-xs" />
                                </span>
                              ))}
                              <span className="block text-2xs text-label2">{candidate.reasons.join(" · ")}</span>
                            </span>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={pending || !options.mayRecordDocuments}
                              title={
                                options.mayRecordDocuments
                                  ? undefined
                                  : `Your role may not record ${inflow ? "receipts" : "bill payments"}.`
                              }
                              onClick={() => record(candidate)}
                            >
                              <Glyph name="doc-text" />
                              {inflow ? "Record receipt" : "Record payment"}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
              {request.postAnyway !== null ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    request.postAnyway?.();
                    onClose();
                  }}
                >
                  Post as a different transaction
                </Button>
              ) : null}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rule from a row
// ---------------------------------------------------------------------------

export const FIELD_LABEL: Record<RuleField, string> = {
  payee: "Payee",
  description: "Description",
  reference: "Reference",
  type: "Bank's type",
};

export const OP_LABEL: Record<RuleOperator, string> = {
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  exact: "is exactly",
  regex: "matches pattern",
};

export const DIRECTION_LABEL: Record<RuleDirection, string> = {
  out: "Money out",
  in: "Money in",
  any: "Either direction",
};

export function ConditionRows({
  conditions,
  onChange,
}: {
  conditions: RuleCondition[];
  onChange: (next: RuleCondition[]) => void;
}) {
  const set = (index: number, patch: Partial<RuleCondition>) =>
    onChange(conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  return (
    <div className="flex flex-col gap-2">
      {conditions.map((condition, index) => (
        <div key={index} className="grid grid-cols-[7.5rem_9.5rem_minmax(0,1fr)_2rem] items-center gap-2 max-sm:grid-cols-2">
          <Select value={condition.field} onValueChange={(value) => set(index, { field: value as RuleField })}>
            <SelectTrigger aria-label={`Field of condition ${index + 1}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FIELD_LABEL) as RuleField[]).map((field) => (
                <SelectItem key={field} value={field}>
                  {FIELD_LABEL[field]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={condition.op} onValueChange={(value) => set(index, { op: value as RuleOperator })}>
            <SelectTrigger aria-label={`Test of condition ${index + 1}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(OP_LABEL) as RuleOperator[]).map((op) => (
                <SelectItem key={op} value={op}>
                  {OP_LABEL[op]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label={`Text of condition ${index + 1}`}
            className={cn(condition.op === "regex" && "num")}
            value={condition.value}
            placeholder={condition.op === "regex" ? "^SQ[0-9]{6}$" : "Text to match"}
            onChange={(event) => set(index, { value: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove condition ${index + 1}`}
            disabled={conditions.length <= 1}
            onClick={() => onChange(conditions.filter((_, i) => i !== index))}
          >
            <Glyph name="trash" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([...conditions, { field: "reference", op: "contains", value: "" }])}
        >
          <Glyph name="plus" />
          Add condition
        </Button>
      </div>
      <p className="text-2xs text-label2">Every condition must hold. Text tests ignore case; a pattern does not.</p>
    </div>
  );
}

export function AutoPostWarning() {
  return (
    <p className="flex gap-2 rounded-[10px] bg-tint-orange/14 px-3 py-2 text-xs text-ink-orange">
      <Glyph name="warning" size={14} className="mt-0.5 shrink-0" />
      <span>
        Matching transactions will post to the ledger on import with no one reviewing them. Only turn this on for payees
        whose coding never changes, such as bank fees or card-processor payouts.
      </span>
    </p>
  );
}

function defaultConditions(row: QueueRow): RuleCondition[] {
  const payee = (row.payee ?? "").trim();
  if (payee !== "") return [{ field: "payee", op: "contains", value: payee }];
  return [{ field: "description", op: "contains", value: row.description.trim() }];
}

type RuleDialogProps = {
  row: QueueRow | null;
  accounts: readonly AccountOption[];
  vendors: readonly VendorOption[];
  accountOverride: string | null;
  mayAutoPost: boolean;
  onClose: () => void;
};

/** Keyed by the row, so every rule starts from that row's payee, direction and account. */
export function RuleDialog(props: RuleDialogProps) {
  return <RuleDialogBody key={props.row?.id ?? "closed"} {...props} />;
}

function RuleDialogBody({ row, accounts, vendors, accountOverride, mayAutoPost, onClose }: RuleDialogProps) {
  const [conditions, setConditions] = React.useState<RuleCondition[]>(() => (row === null ? [] : defaultConditions(row)));
  const [direction, setDirection] = React.useState<RuleDirection>(row !== null && row.amountCents > 0 ? "in" : "out");
  const [accountId, setAccountId] = React.useState<string | null>(accountOverride ?? row?.suggestion.account?.id ?? null);
  const [vendorId, setVendorId] = React.useState<string>(row?.suggestion.vendor?.id ?? "");
  const [name, setName] = React.useState("");
  const [thisAccountOnly, setThisAccountOnly] = React.useState(false);
  const [autoPost, setAutoPost] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const canSave = accountId !== null && conditions.length > 0 && conditions.every((c) => c.value.trim() !== "");

  return (
    <Dialog open={row !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="lg">
        {row === null ? null : (
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSave || accountId === null) return;
              startTransition(async () => {
                const result = await createRuleFromRow({
                  txnId: row.id,
                  accountId,
                  vendorId: vendorId === "" ? null : vendorId,
                  conditions,
                  direction,
                  name,
                  thisAccountOnly,
                  autoPost,
                });
                if (result.ok) {
                  toast.success(`Rule saved: ${result.value.name}`, {
                    description: "It suggests from the next import on. This row is unchanged.",
                  });
                  onClose();
                } else {
                  toast.error(result.error.message);
                }
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Create a rule from {payeeOf(row)}</DialogTitle>
              <DialogDescription>
                Future transactions that match are suggested to the account below. This row is not posted by saving
                a rule.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>When</Label>
                <ConditionRows conditions={conditions} onChange={setConditions} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label>Direction</Label>
                  <Select value={direction} onValueChange={(value) => setDirection(value as RuleDirection)}>
                    <SelectTrigger aria-label="Direction">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(DIRECTION_LABEL) as RuleDirection[]).map((d) => (
                        <SelectItem key={d} value={d}>
                          {DIRECTION_LABEL[d]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Code to</Label>
                  <AccountCombobox
                    accounts={accounts}
                    value={accountId}
                    trackRecents
                    className="h-8"
                    onChange={setAccountId}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Vendor</Label>
                  <Select value={vendorId === "" ? "__none__" : vendorId} onValueChange={(v) => setVendorId(v === "__none__" ? "" : v)}>
                    <SelectTrigger aria-label="Vendor">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No vendor</SelectItem>
                      {vendors.map((vendor) => (
                        <SelectItem key={vendor.id} value={vendor.id}>
                          {vendor.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label hint="optional">Name</Label>
                  <Input value={name} placeholder="Named after its first condition" onChange={(e) => setName(e.target.value)} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={thisAccountOnly} onCheckedChange={(v) => setThisAccountOnly(v === true)} />
                Only for ••{row.bankAccountMask}
              </label>
              {mayAutoPost ? (
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={autoPost} onCheckedChange={(v) => setAutoPost(v === true)} />
                    Post matches without review
                  </label>
                  {autoPost ? <AutoPostWarning /> : null}
                </div>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSave || pending}>
                Save rule
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

const SHORTCUTS: [string[], string][] = [
  [["j", "↓"], "Next transaction"],
  [["k", "↑"], "Previous transaction"],
  [["⇧ j", "⇧ k"], "Extend the selection"],
  [["Enter", "a"], "Accept the suggested account (or your choice)"],
  [["e"], "Choose a different account"],
  [["p"], "Personal purchase — post to Owner Draws"],
  [["s"], "Split across accounts"],
  [["t"], "Post a transfer pair, or find the other leg"],
  [["m"], "Match to an entry, invoice or bill already in the books"],
  [["r"], "Create a rule from this transaction"],
  [["x"], "Exclude — the money never moved"],
  [["u"], "Unpost or unmatch (on the Posted tab)"],
  [["o"], "Open or close the details"],
  [["/"], "Search"],
  [["Esc"], "Clear the selection"],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Keyboard</DialogTitle>
          <DialogDescription>Every decision in the queue has a key.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
            {SHORTCUTS.map(([keys, label]) => (
              <React.Fragment key={label}>
                <dt className="flex gap-1">
                  {keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </dt>
                <dd className="text-label2">{label}</dd>
              </React.Fragment>
            ))}
          </dl>
          <p className="mt-3 text-xs text-label2">
            Shift-click selects a range. With several selected, <Badge size="sm">Enter</Badge> accepts them all after
            one confirmation.
          </p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

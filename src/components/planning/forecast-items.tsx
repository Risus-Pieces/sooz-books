"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { addForecastItem, removeForecastItem, updateForecastItem } from "@/app/(app)/plan/actions";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { Input, inputBase } from "@/components/ui/input";
import { InsetGroup } from "@/components/ui/inset-group";
import { Label } from "@/components/ui/label";
import { Money, formatCents } from "@/components/ui/money";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { parseMoney } from "@/lib/money";
import { shortDate } from "@/lib/ui/format";

import type { BankAccountOption, ForecastItemForm, ForecastItemRow, RecurrenceKey } from "./types";

const RECURRENCE_LABEL: Record<RecurrenceKey, string> = {
  none: "Once",
  weekly: "Weekly",
  biweekly: "Every two weeks",
  semimonthly: "Twice a month",
  monthly: "Monthly",
  quarterly: "Quarterly",
};

const CATEGORIES = ["Member contribution", "Co-packer", "Ingredients", "Packaging", "Marketing", "Software", "Square sales", "Loan", "Other"];

/** "0.750" → "75". */
function confidencePercent(confidence: string): string {
  const [whole, fraction = ""] = confidence.split(".");
  const thousandths = Number(whole) * 1000 + Number(fraction.padEnd(3, "0").slice(0, 3));
  const tenths = thousandths % 10 === 0 ? "" : `.${thousandths % 10}`;
  return `${Math.floor(thousandths / 10)}${tenths}`;
}

/** "75" → "0.750"; null when it is not a percentage between 0 and 100 with at most one decimal. */
function percentToConfidence(text: string): string | null {
  const match = /^\s*(\d{1,3})(?:\.(\d))?\s*%?\s*$/.exec(text);
  if (match === null) return null;
  const thousandths = Number(match[1]) * 10 + Number(match[2] ?? "0");
  if (thousandths > 1000) return null;
  return `${Math.floor(thousandths / 1000)}.${String(thousandths % 1000).padStart(3, "0")}`;
}

/**
 * The known future movements the ledger cannot see yet: a contribution the
 * founder has promised, a co-packer deposit, a launch invoice. Each is weighted
 * by its confidence in the forecast. Changing an item retires it and records a
 * replacement, so a frozen forecast that counted the old terms stays readable.
 */
export function ForecastItems({
  items,
  bankAccounts,
  asOf,
  canEdit,
}: {
  items: readonly ForecastItemRow[];
  bankAccounts: readonly BankAccountOption[];
  asOf: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<ForecastItemRow | "new" | null>(null);
  const [pending, startTransition] = React.useTransition();
  const bankName = new Map(bankAccounts.map((b) => [b.id, b.label]));

  const remove = (item: ForecastItemRow) => {
    startTransition(async () => {
      const result = await removeForecastItem(item.id);
      if (!result.ok) {
        toast.error("Item not removed", { description: result.error.message });
        return;
      }
      toast.success(`"${item.label}" removed from the forecast`);
      router.refresh();
    });
  };

  const groups: Array<{ key: "inflow" | "outflow"; label: string; rows: ForecastItemRow[] }> = [
    { key: "inflow", label: "Money in", rows: items.filter((i) => i.direction === "inflow") },
    { key: "outflow", label: "Money out", rows: items.filter((i) => i.direction === "outflow") },
  ];
  const addButton = canEdit ? (
    <Button variant="ghost" size="sm" onClick={() => setEditing("new")} className="text-ink-blue">
      <Glyph name="plus" />
      Add
    </Button>
  ) : null;

  return (
    <section className="min-w-0">
      <div className="flex items-center gap-2 px-1 pt-2 pb-1">
        <h2 className="flex flex-1 items-center gap-1 text-xl font-bold tracking-[-0.02em]">
          Expected
          <InfoButton label="About expected movements" align="start">
            <p>What the books cannot see yet: a contribution the founder has promised, a co-packer deposit, a launch invoice. Open invoices and bills are added from receivables and payables on their own.</p>
            <p>Each is weighted by its confidence: a $1,000 deposit at 50% counts as $500 in each week it lands.</p>
          </InfoButton>
        </h2>
        {items.length > 0 ? addButton : null}
      </div>
      {items.length === 0 ? (
        <div className="rounded-2xl bg-card shadow-card max-md:rounded-[22px]">
          <EmptyState
            glyph="calendar"
            title="Nothing expected yet"
            description="Add the founder contributions you plan to make, the co-packer deposit, the first production run — anything with a date and an amount. Until then the forecast only carries today's cash forward."
            action={
              canEdit ? (
                <Button onClick={() => setEditing("new")}>
                  <Glyph name="plus" />
                  Add item
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        groups
          .filter((g) => g.rows.length > 0)
          .map((g) => (
            <InsetGroup
              key={g.key}
              header={g.label}
              headerAccessory={
                <Money
                  cents={g.rows.reduce((s, i) => s + i.amountCents, 0) * (g.key === "inflow" ? 1 : -1)}
                  currency
                  signed
                  plain
                  className="text-xs font-semibold text-label2"
                />
              }
              separatorInset={63}
            >
              {g.rows.map((item) => {
                const overdue = item.recurrence === "none" && item.expectedDate <= asOf;
                const body = (
                  <>
                    <IconBadge
                      glyph={item.direction === "inflow" ? "arrow-in" : "arrow-out"}
                      tint={item.direction === "inflow" ? "green" : "red"}
                      size="xl"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold max-sm:text-lg max-sm:font-medium">{item.label}</span>
                        <Money
                          cents={item.direction === "inflow" ? item.amountCents : -item.amountCents}
                          currency
                          signed
                          colorPositive
                          className="shrink-0 text-sm font-semibold max-sm:text-lg"
                        />
                      </span>
                      <span className="mt-[3px] flex items-center gap-1.5 text-xs text-label2 max-sm:text-sm">
                        <span className="min-w-0 flex-1 truncate">
                          {item.category} · {RECURRENCE_LABEL[item.recurrence]}
                          {item.bankAccountId !== null ? ` · ${bankName.get(item.bankAccountId) ?? "bank account"}` : ""}
                        </span>
                        <span className="num shrink-0">
                          {overdue ? <span className="font-semibold text-ink-orange">Overdue · </span> : null}
                          {shortDate(item.expectedDate)}
                          {item.endDate !== null ? `–${shortDate(item.endDate)}` : ""} · {confidencePercent(item.confidence)}%
                        </span>
                      </span>
                    </span>
                  </>
                );
                return (
                  <div key={item.id} className={cn(rowSep, "flex items-center")}>
                    {canEdit ? (
                      <button
                        type="button"
                        aria-label={`Edit ${item.label}`}
                        disabled={pending}
                        onClick={() => setEditing(item)}
                        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-2 pl-4 text-left transition-colors hover:bg-fill2"
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-2 pl-4">{body}</div>
                    )}
                    {canEdit ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${item.label}`}
                        disabled={pending}
                        onClick={() => remove(item)}
                        className="mr-2 shrink-0 text-label2"
                      >
                        <Glyph name="trash" />
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </InsetGroup>
          ))
      )}
      {editing === null ? null : (
        <ItemDialog
          key={editing === "new" ? "new" : editing.id}
          item={editing === "new" ? null : editing}
          asOf={asOf}
          bankAccounts={bankAccounts}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

const rowSep =
  "relative before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[var(--sep-inset)] before:border-t-[0.5px] before:border-sep first:before:hidden";

function ItemDialog({
  item,
  asOf,
  bankAccounts,
  onClose,
}: {
  item: ForecastItemRow | null;
  asOf: string;
  bankAccounts: readonly BankAccountOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [label, setLabel] = React.useState(item?.label ?? "");
  const [category, setCategory] = React.useState(item?.category ?? "");
  const [direction, setDirection] = React.useState<"inflow" | "outflow">(item?.direction ?? "outflow");
  const [amount, setAmount] = React.useState(item === null ? "" : formatCents(item.amountCents));
  const [expectedDate, setExpectedDate] = React.useState(item?.expectedDate ?? asOf);
  const [recurrence, setRecurrence] = React.useState<RecurrenceKey>(item?.recurrence ?? "none");
  const [endDate, setEndDate] = React.useState(item?.endDate ?? "");
  const [bankAccountId, setBankAccountId] = React.useState(item?.bankAccountId ?? "");
  const [confidence, setConfidence] = React.useState(item === null ? "100" : confidencePercent(item.confidence));
  const [notes, setNotes] = React.useState(item?.notes ?? "");

  let amountCents: number | null = null;
  try {
    amountCents = amount.trim() === "" ? null : parseMoney(amount);
  } catch {
    amountCents = null;
  }
  const confidenceValue = percentToConfidence(confidence);
  const valid =
    label.trim() !== "" && category.trim() !== "" && amountCents !== null && amountCents > 0 && confidenceValue !== null && expectedDate !== "";

  const submit = () => {
    if (!valid || amountCents === null || confidenceValue === null) return;
    const form: ForecastItemForm = {
      label,
      category,
      direction,
      amountCents,
      expectedDate,
      recurrence,
      endDate: recurrence === "none" || endDate === "" ? null : endDate,
      bankAccountId: bankAccountId === "" ? null : bankAccountId,
      confidence: confidenceValue,
      notes: notes.trim() === "" ? null : notes,
    };
    startTransition(async () => {
      const result = item === null ? await addForecastItem(form) : await updateForecastItem(item.id, form);
      if (!result.ok) {
        toast.error(item === null ? "Item not added" : "Item not changed", { description: result.error.message });
        return;
      }
      toast.success(item === null ? `"${label.trim()}" added to the forecast` : `"${label.trim()}" changed`);
      onClose();
      router.refresh();
    });
  };

  const selectClass = cn(inputBase, "w-full");

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{item === null ? "Add an expected movement" : `Change "${item.label}"`}</DialogTitle>
          <DialogDescription>
            Weighted by its confidence: a $1,000 deposit at 50% counts as $500 in each week it lands.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="fi-label" required>What it is</Label>
            <Input id="fi-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Founder contribution for first run" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fi-direction" required>Direction</Label>
            <select id="fi-direction" className={selectClass} value={direction} onChange={(e) => setDirection(e.target.value === "inflow" ? "inflow" : "outflow")}>
              <option value="outflow">Money out</option>
              <option value="inflow">Money in</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fi-amount" required>Amount</Label>
            <Input id="fi-amount" numeric inputMode="decimal" value={amount} invalid={amount !== "" && (amountCents === null || amountCents <= 0)} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fi-category" required>Category</Label>
            <Input id="fi-category" list="fi-categories" value={category} onChange={(e) => setCategory(e.target.value)} />
            <datalist id="fi-categories">
              {CATEGORIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fi-confidence" hint="%">Confidence</Label>
            <Input id="fi-confidence" numeric value={confidence} invalid={confidenceValue === null} onChange={(e) => setConfidence(e.target.value)} className="w-24" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fi-date" required>{recurrence === "none" ? "Expected on" : "First on"}</Label>
            <DateInput id="fi-date" value={expectedDate} onValueChange={setExpectedDate} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fi-recurrence">Repeats</Label>
            <select id="fi-recurrence" className={selectClass} value={recurrence} onChange={(e) => setRecurrence(e.target.value as RecurrenceKey)}>
              {(Object.keys(RECURRENCE_LABEL) as RecurrenceKey[]).map((r) => (
                <option key={r} value={r}>
                  {RECURRENCE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          {recurrence === "none" ? null : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fi-end" hint="optional">Until</Label>
              <DateInput id="fi-end" value={endDate} onValueChange={setEndDate} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fi-bank" hint="optional">Bank account</Label>
            <select id="fi-bank" className={selectClass} value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
              <option value="">Any</option>
              {bankAccounts.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="fi-notes">Notes</Label>
            <Textarea id="fi-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={pending || !valid}>
            {item === null ? "Add item" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { disputeDeductions, previewBulkValidation, validateDeductions } from "@/app/(app)/trade/actions";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
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
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";

import { DeductionTable } from "./deduction-table";
import { longDate } from "./labels";
import { EntryPreview, Field, Refusals } from "./parts";
import type { BulkValidationView, DeductionRowView, DeductionTab } from "./types";

const EMPTY: Record<DeductionTab, string> = {
  open: "Nothing waiting",
  disputed: "No open disputes",
  resolved: "Nothing resolved yet",
};

/**
 * The deduction register with its bulk actions. Select open deductions, then validate them
 * (each posts its own reclassification out of 1210, shown combined before it posts) or file a
 * dispute on them (no entry; each gets its deadline).
 */
export function DeductionWorkbench({
  rows,
  tab,
  canManage,
  today,
}: {
  rows: DeductionRowView[];
  tab: DeductionTab;
  canManage: boolean;
  today: string;
}) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [dialog, setDialog] = React.useState<"validate" | "dispute" | null>(null);
  const picked = rows.filter((r) => selected.has(r.id));
  const openTotal = picked.reduce((s, r) => s + r.openCents, 0);
  const selectable = canManage && tab !== "resolved";

  const done = () => {
    setDialog(null);
    setSelected(new Set());
  };

  return (
    <>
      {selectable ? (
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 hairline-b px-4 py-2">
          <p className="text-sm font-semibold text-label2" aria-live="polite">
            {picked.length === 0 ? (
              "Select to act"
            ) : (
              <>
                <span className="num text-label">{picked.length}</span> ·{" "}
                <Money cents={openTotal} currency plain className="text-label" />
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={picked.length === 0} onClick={() => setDialog("dispute")}>
              <Glyph name="flag" />
              Dispute
            </Button>
            <Button size="sm" disabled={picked.length === 0} onClick={() => setDialog("validate")}>
              <Glyph name="check" />
              Validate
            </Button>
          </div>
        </div>
      ) : null}

      <DeductionTable
        rows={rows}
        deadlines={tab !== "resolved"}
        empty={EMPTY[tab]}
        {...(selectable ? { selected, onSelectedChange: setSelected } : {})}
      />

      {dialog === "validate" ? (
        <BulkValidateDialog rows={picked} today={today} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
      {dialog === "dispute" ? <BulkDisputeDialog rows={picked} today={today} onClose={() => setDialog(null)} onDone={done} /> : null}
    </>
  );
}

function BulkValidateDialog({
  rows,
  today,
  onClose,
  onDone,
}: {
  rows: DeductionRowView[];
  today: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [date, setDate] = React.useState(today);
  const [preview, setPreview] = React.useState<BulkValidationView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const ids = React.useMemo(() => rows.map((r) => r.id), [rows]);

  React.useEffect(() => {
    let live = true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    void previewBulkValidation(ids, date).then((result) => {
      if (!live) return;
      if (result.ok) {
        setPreview(result.value);
        setError(null);
      } else {
        setPreview(null);
        setError(result.error.message);
      }
    });
    return () => {
      live = false;
    };
  }, [ids, date]);

  const ready = preview?.ready ?? [];
  const submit = () =>
    startTransition(async () => {
      const result = await validateDeductions(
        ready.map((r) => r.id),
        { date, reasonCode: "", memo: "" },
      );
      if (!result.ok) {
        toast.error("Not validated", { description: result.error.message });
        return;
      }
      const { done, refused } = result.value;
      if (done.length > 0) toast.success(`Validated ${done.length} ${done.length === 1 ? "deduction" : "deductions"}`);
      if (refused.length > 0) toast.error(`${refused.length} refused`, { description: refused.map((r) => r.message).join(" ") });
      onDone();
      router.refresh();
    });

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Validate {rows.length === 1 ? "this deduction" : `${rows.length} deductions`}</DialogTitle>
          <DialogDescription>
            The distributor was entitled to it. Each one moves out of 1210 Deductions Receivable to where it belongs: its promotion’s accrual first, then contra revenue, or gross sales for a real shortage.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Field label="Date" htmlFor="bulk-validate-date" className="max-w-44">
            <DateInput id="bulk-validate-date" value={date} onValueChange={setDate} disabled={pending} />
          </Field>
          {error !== null ? <p className="text-sm text-ink-red">{error}</p> : null}
          {preview === null && error === null ? <p className="text-sm text-label2">Working out each entry…</p> : null}
          {preview !== null ? (
            <>
              {ready.length > 0 ? (
                <ul className="flex flex-col overflow-hidden rounded-[12px] bg-card shadow-card">
                  {ready.map((r, index) => (
                    <li key={r.id} className={index > 0 ? "flex items-center justify-between gap-3 hairline-t px-3.5 py-2 text-sm" : "flex items-center justify-between gap-3 px-3.5 py-2 text-sm"}>
                      <span className="min-w-0">
                        <span className="num block font-semibold">{r.deductionNo}</span>
                        <span className="block truncate text-xs text-label2">{r.destination}</span>
                      </span>
                      <Money cents={r.amountCents} currency plain className="font-semibold" />
                    </li>
                  ))}
                </ul>
              ) : null}
              <Refusals items={preview.refused.map((r) => ({ key: r.id, label: r.deductionNo, message: r.message }))} />
              {preview.entry !== null ? <EntryPreview entry={preview.entry} caption="Combined validation entries" /> : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={pending || ready.length === 0}>
            {pending ? "Validating…" : `Validate ${ready.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkDisputeDialog({
  rows,
  today,
  onClose,
  onDone,
}: {
  rows: DeductionRowView[];
  today: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [date, setDate] = React.useState(today);
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const [refused, setRefused] = React.useState<{ id: string; message: string }[]>([]);
  const closed = rows.filter((r) => r.disputeDeadline !== null && r.disputeDeadline < date);

  const submit = () =>
    startTransition(async () => {
      const result = await disputeDeductions(
        rows.map((r) => r.id),
        { date, reference, notes, reasonCode: "" },
      );
      if (!result.ok) {
        toast.error("Not disputed", { description: result.error.message });
        return;
      }
      const { done } = result.value;
      if (done.length > 0) toast.success(`Disputed ${done.length} ${done.length === 1 ? "deduction" : "deductions"}`);
      if (result.value.refused.length > 0) {
        setRefused(result.value.refused);
        router.refresh();
        return;
      }
      onDone();
      router.refresh();
    });

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Dispute {rows.length === 1 ? "this deduction" : `${rows.length} deductions`}</DialogTitle>
          <DialogDescription>
            No entry posts: the money is already in 1210 Deductions Receivable. Each case is recorded with the deadline from its reason code’s window.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Filed on" htmlFor="bulk-dispute-date">
              <DateInput id="bulk-dispute-date" value={date} onValueChange={setDate} disabled={pending} />
            </Field>
            <Field label="Case number" htmlFor="bulk-dispute-ref" hint="K-Solve or Dispute Center">
              <Input id="bulk-dispute-ref" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} disabled={pending} />
            </Field>
          </div>
          <Field label="Notes" htmlFor="bulk-dispute-notes" hint="what you sent as backup">
            <Textarea id="bulk-dispute-notes" value={notes} rows={3} maxLength={2000} onChange={(e) => setNotes(e.target.value)} disabled={pending} />
          </Field>
          <ul className="flex flex-col overflow-hidden rounded-[12px] bg-card shadow-card">
            {rows.map((r, index) => (
              <li key={r.id} className={index > 0 ? "flex items-center justify-between gap-3 hairline-t px-3.5 py-2 text-sm" : "flex items-center justify-between gap-3 px-3.5 py-2 text-sm"}>
                <span className="num font-semibold">{r.deductionNo}</span>
                <span className="text-xs text-label2">{r.disputeDeadline === null ? "From reason code" : `By ${longDate(r.disputeDeadline)}`}</span>
              </li>
            ))}
          </ul>
          {closed.length > 0 ? (
            <p className="text-sm text-ink-orange">
              {closed.length === 1 ? "One window has" : `${closed.length} windows have`} closed; those can only be written off or recovered and will be refused.
            </p>
          ) : null}
          <Refusals
            items={refused.map((r) => ({ key: r.id, label: rows.find((x) => x.id === r.id)?.deductionNo ?? "", message: r.message }))}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            {refused.length > 0 ? "Close" : "Cancel"}
          </Button>
          <Button size="sm" onClick={submit} disabled={pending || refused.length > 0}>
            {pending ? "Filing…" : `File ${rows.length === 1 ? "dispute" : `${rows.length} disputes`}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

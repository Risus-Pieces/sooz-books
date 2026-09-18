"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { ToolbarButton } from "@/components/ui/toolbar";
import { DateInput, todayIso } from "@/components/ui/date-input";
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
import { fileReturn, payReturn } from "@/app/(app)/channels/actions";

import type { BankOptionView, FilingView } from "./types";

function monthEnd(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return `${period.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

/**
 * Filing a return: every unfiled register entry for the state and period is reported on it
 * and frozen. A period with no sales still files, as a zero return.
 */
export function FileReturnButton({
  state: initialState,
  period,
  owedCents,
  variant = "secondary",
  label = "File return",
  appearance = "button",
}: {
  state: string;
  /** First day of the month the return covers, when filing from a row. */
  period: string | null;
  owedCents: number | null;
  variant?: "default" | "secondary";
  label?: string;
  /** `toolbar` — an icon button in the page toolbar. */
  appearance?: "button" | "toolbar";
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState(initialState);
  const [start, setStart] = React.useState(period ?? "");
  const [end, setEnd] = React.useState(period === null ? "" : monthEnd(period));
  const [confirmation, setConfirmation] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const submit = () =>
    startTransition(async () => {
      const result = await fileReturn({ state, periodStart: start, periodEnd: end, confirmation, notes });
      if (!result.ok) {
        toast.error("Not filed", { description: result.error.message });
        return;
      }
      setOpen(false);
      toast.success(`${state.toUpperCase()} return filed`, {
        description: `${result.value.entriesReported} register entr${result.value.entriesReported === 1 ? "y" : "ies"} reported and locked · ${formatCents(result.value.taxDueCents, { currency: true })} due.`,
      });
      router.refresh();
    });

  return (
    <>
      {appearance === "toolbar" ? (
        <ToolbarButton glyph="doc-text" label={label} onClick={() => setOpen(true)} />
      ) : (
        <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
          <Glyph name="doc-text" />
          {label}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Record a filed return</DialogTitle>
            <DialogDescription>
              Record this after filing with the state. Every unfiled tax entry for the state and period is reported on the return
              and locked, so a later change to that tax becomes a new entry, never an edit.
              {owedCents === null ? null : (
                <>
                  {" "}
                  Unfiled for this month: <Money cents={owedCents} currency plain />.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid grid-cols-2 gap-3">
            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor="file-state" required>
                State
              </Label>
              <Input id="file-state" value={state} maxLength={20} onChange={(e) => setState(e.target.value.toUpperCase())} disabled={pending} />
            </div>
            <div className="hidden sm:block" />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="file-start" required>
                Period from
              </Label>
              <DateInput id="file-start" value={start} onValueChange={setStart} disabled={pending} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="file-end" required>
                to
              </Label>
              <DateInput id="file-end" value={end} onValueChange={setEnd} disabled={pending} />
            </div>
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="file-confirmation">Confirmation number</Label>
              <Input id="file-confirmation" value={confirmation} maxLength={100} onChange={(e) => setConfirmation(e.target.value)} disabled={pending} />
            </div>
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="file-notes">Notes</Label>
              <Input id="file-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} disabled={pending} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={pending || state.trim() === "" || start === "" || end === ""}>
              {pending ? "Recording…" : "Record filed return"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Texas lets a timely filer keep 0.5% of the tax due. Integer cents, rounded half up. */
function texasDiscount(dueCents: number): number {
  return Math.floor((dueCents * 5 + 500) / 1000);
}

/** Paying a filed return: Dr 2200, Cr the bank, and Cr 7020 for any timely-filing discount kept. */
export function PayReturnButton({ filing, banks }: { filing: FilingView; banks: readonly BankOptionView[] }) {
  const router = useRouter();
  const discountDefault = filing.state === "TX" ? texasDiscount(filing.taxDueCents) : 0;
  const [open, setOpen] = React.useState(false);
  const [bank, setBank] = React.useState(banks.find((b) => /9726/.test(b.name))?.id ?? banks[0]?.id ?? "");
  const [date, setDate] = React.useState(todayIso());
  const [discount, setDiscount] = React.useState(formatCents(discountDefault));
  const [amount, setAmount] = React.useState(formatCents(filing.taxDueCents - discountDefault));
  const [pending, startTransition] = React.useTransition();

  const submit = () =>
    startTransition(async () => {
      const result = await payReturn({ filingId: filing.id, bankAccountId: bank, date, amount: amount.replace(/,/g, ""), discount: discount.replace(/,/g, "") });
      if (!result.ok) {
        toast.error("Payment not recorded", { description: result.error.message });
        return;
      }
      setOpen(false);
      toast.success(`Payment posted as entry #${result.value.entryNo}`);
      router.refresh();
    });

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} disabled={banks.length === 0} aria-label={`Record payment, ${filing.state} return`}>
        <Glyph name="bank" />
        Pay
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              Pay {filing.state} sales tax
            </DialogTitle>
            <DialogDescription>
              Posts Dr 2200 Sales Tax Payable <Money cents={filing.taxDueCents} currency plain />, Cr the bank for the payment
              {discountDefault > 0 ? ", and Cr 7020 for the timely-filing discount (Texas: 0.5%, only when filed and paid on time)" : ""}.
              Payment plus discount must equal the tax due.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid grid-cols-2 gap-3">
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="pay-bank" required>
                Paid from
              </Label>
              <Select value={bank === "" ? undefined : bank} onValueChange={setBank}>
                <SelectTrigger id="pay-bank">
                  <SelectValue placeholder="Bank account" />
                </SelectTrigger>
                <SelectContent>
                  {banks.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.code} {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="pay-date" required>
                Date paid
              </Label>
              <DateInput id="pay-date" value={date} onValueChange={setDate} disabled={pending} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pay-amount" required>
                Payment
              </Label>
              <Input id="pay-amount" numeric inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={pending} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pay-discount">Discount kept</Label>
              <Input id="pay-discount" numeric inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} disabled={pending} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={pending || bank === "" || date === ""}>
              {pending ? "Posting…" : "Post payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

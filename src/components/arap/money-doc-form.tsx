"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { HandCoins, Wand2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCents, Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { isCalendarDate } from "@/lib/dates";
import { recordReceiptAction } from "@/app/(app)/sales/actions";
import { payBillsAction } from "@/app/(app)/purchases/actions";

import { allowedDiscount, applyOldestFirst, daysPastDue, readMoney, termsLabel } from "./math";
import { MoneyInput, centsOf, textOf } from "./money-input";
import { PartyCombobox, type PartyOption } from "./party-combobox";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type OpenDoc, type Option, type PaymentMethod } from "./types";

const AUTO = "__auto__";

export interface PartyTerms {
  termsDiscountPct: string;
  termsDiscountDays: number;
  termsDays: number;
}

export interface MoneyDocFormProps {
  /** 'ar' records a customer receipt; 'ap' pays vendor bills. */
  side: "ar" | "ap";
  parties: readonly (PartyOption & Partial<PartyTerms>)[];
  partyId: string | null;
  openDocs: readonly OpenDoc[];
  accounts: readonly Option[];
  defaultAccountId: string | null;
  today: string;
  /** Documents to tick on arrival — "Record payment" from an invoice, "Pay" from a bill. */
  preselect: readonly string[];
  canSubmit: boolean;
}

interface RowState {
  checked: boolean;
  amount: string;
  discount: string;
}

/**
 * Money in from a customer, or money out to a vendor, and which documents it
 * settles. Ticking a document applies its balance (less the early-payment
 * discount its terms allow today, for a customer). Whatever is not applied
 * stays on the account — a customer credit or a vendor prepayment — and can be
 * applied later from the receipt or payment.
 */
export function MoneyDocForm({
  side,
  parties,
  partyId,
  openDocs,
  accounts,
  defaultAccountId,
  today,
  preselect,
  canSubmit,
}: MoneyDocFormProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = React.useTransition();
  const [navigating, startNav] = React.useTransition();

  const party = parties.find((p) => p.id === partyId) ?? null;
  const terms: PartyTerms = {
    termsDiscountPct: party?.termsDiscountPct ?? "0",
    termsDiscountDays: party?.termsDiscountDays ?? 0,
    termsDays: party?.termsDays ?? 30,
  };

  const [date, setDate] = React.useState(today);
  const [accountId, setAccountId] = React.useState<string | null>(defaultAccountId);
  const [method, setMethod] = React.useState<string>(side === "ap" ? AUTO : "ach");
  const [reference, setReference] = React.useState("");
  const [memo, setMemo] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [amountTouched, setAmountTouched] = React.useState(false);

  const seedRows = (onDate: string): Record<string, RowState> => {
    const out: Record<string, RowState> = {};
    for (const doc of openDocs) {
      const checked = preselect.includes(doc.id);
      const discount = side === "ar" && checked ? Math.min(allowedDiscount(terms, doc, onDate), doc.balanceCents) : 0;
      out[doc.id] = {
        checked,
        amount: checked ? textOf(doc.balanceCents - discount) : "",
        discount: textOf(discount),
      };
    }
    return out;
  };
  const [rows, setRows] = React.useState<Record<string, RowState>>(() => seedRows(today));
  // A different party's documents arrive with a navigation: start their grid afresh.
  const [seededFor, setSeededFor] = React.useState(openDocs);
  if (seededFor !== openDocs) {
    setSeededFor(openDocs);
    setRows(seedRows(date));
    setAmountTouched(false);
    setAmount("");
  }

  const appliedCents = openDocs.reduce((sum, doc) => sum + (rows[doc.id]?.checked ? centsOf(rows[doc.id].amount) : 0), 0);
  const discountCents = openDocs.reduce(
    (sum, doc) => sum + (rows[doc.id]?.checked ? centsOf(rows[doc.id].discount) : 0),
    0,
  );
  const amountCents = amountTouched ? centsOf(amount) : appliedCents;
  const unapplied = amountCents - appliedCents;

  const rowErrors = new Map<string, string>();
  for (const doc of openDocs) {
    const row = rows[doc.id];
    if (!row?.checked) continue;
    const cash = readMoney(row.amount);
    const disc = readMoney(row.discount);
    if (cash.error || disc.error) rowErrors.set(doc.id, "Not an amount.");
    else if ((cash.cents ?? 0) + (disc.cents ?? 0) > doc.balanceCents) rowErrors.set(doc.id, "More than is owed.");
    else if ((cash.cents ?? 0) + (disc.cents ?? 0) === 0) rowErrors.set(doc.id, "Nothing applied.");
    else if (side === "ar" && (disc.cents ?? 0) > allowedDiscount(terms, doc, date))
      rowErrors.set(doc.id, "Terms don't allow that discount on this date.");
    else if (doc.date > date) rowErrors.set(doc.id, "Dated after this payment.");
  }

  const partyWord = side === "ar" ? "customer" : "vendor";
  const problem = !canSubmit
    ? side === "ar"
      ? "Your role may not record receipts."
      : "Your role may not pay vendors."
    : party === null
      ? `Choose the ${partyWord}.`
      : !isCalendarDate(date)
        ? "Enter the date."
        : accountId === null
          ? side === "ar"
            ? "Choose where the money was deposited."
            : "Choose the account it was paid from."
          : rowErrors.size > 0
            ? "Fix the rows marked in red."
            : amountTouched && readMoney(amount).error !== null
              ? "The amount is not readable."
              : amountCents <= 0
                ? side === "ar"
                  ? "Enter the amount received, or tick invoices to apply."
                  : "Enter the amount paid, or tick bills to pay."
                : unapplied < 0
                  ? `Applied ${formatShort(appliedCents)} is more than the ${formatShort(amountCents)} ${side === "ar" ? "received" : "paid"}.`
                  : null;

  const pickParty = (id: string) => {
    const param = side === "ar" ? "customer" : "vendor";
    startNav(() => router.replace(`${pathname}?${param}=${id}`));
  };

  const toggle = (doc: OpenDoc, checked: boolean) => {
    setRows((current) => {
      const discount = side === "ar" && checked ? Math.min(allowedDiscount(terms, doc, date), doc.balanceCents) : 0;
      return {
        ...current,
        [doc.id]: checked
          ? { checked, amount: textOf(doc.balanceCents - discount), discount: textOf(discount) }
          : { checked: false, amount: "", discount: "" },
      };
    });
  };

  const autoApply = () => {
    const spread = applyOldestFirst(centsOf(amount), openDocs);
    const next: Record<string, RowState> = {};
    for (const doc of openDocs) {
      const cash = spread.get(doc.id) ?? 0;
      next[doc.id] = { checked: cash > 0, amount: textOf(cash), discount: "" };
    }
    setRows(next);
  };

  const submit = () => {
    if (party === null || accountId === null) return;
    const applications = openDocs
      .filter((doc) => rows[doc.id]?.checked)
      .map((doc) => ({ docId: doc.id, amountCents: centsOf(rows[doc.id].amount), discountCents: centsOf(rows[doc.id].discount) }));
    start(async () => {
      const result =
        side === "ar"
          ? await recordReceiptAction({
              customerId: party.id,
              receiptDate: date,
              amountCents,
              method: method as PaymentMethod,
              reference,
              memo,
              depositAccountId: accountId,
              applications,
            })
          : await payBillsAction({
              vendorId: party.id,
              paymentDate: date,
              amountCents,
              method: method === AUTO ? null : (method as PaymentMethod),
              reference,
              memo,
              paymentAccountId: accountId,
              applications,
            });
      if (!result.ok) {
        toast.error(side === "ar" ? "Receipt not recorded" : "Payment not recorded", { description: result.error.message });
        return;
      }
      toast.success(side === "ar" ? `Receipt ${result.value.docNo} recorded` : `Payment ${result.value.docNo} recorded`);
      router.push(side === "ar" ? `/sales/receipts/${result.value.id}` : `/purchases/payments/${result.value.id}`);
    });
  };

  const busy = pending || navigating;

  return (
    <div className="flex flex-col gap-4 pb-28">
      <Card>
        <CardHeader>
          <CardTitle>{side === "ar" ? "Money received" : "Money paid"}</CardTitle>
          {party && side === "ar" ? (
            <span className="text-xs text-muted-foreground">
              Terms {termsLabel(terms.termsDays, terms.termsDiscountPct, terms.termsDiscountDays)}
            </span>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,2fr)_10rem_minmax(10rem,1.5fr)_9rem_minmax(8rem,1fr)]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="md-party" required>
              {side === "ar" ? "Customer" : "Vendor"}
            </Label>
            <PartyCombobox
              id="md-party"
              options={parties}
              value={partyId}
              onChange={pickParty}
              placeholder={`Choose a ${partyWord}`}
              emptyText={`No ${partyWord} by that name.`}
              disabled={busy}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="md-date" required>
              Date
            </Label>
            <DateInput id="md-date" value={date} onValueChange={setDate} disabled={busy} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="md-account" required>
              {side === "ar" ? "Deposited to" : "Paid from"}
            </Label>
            <Select value={accountId ?? undefined} onValueChange={setAccountId} disabled={busy}>
              <SelectTrigger id="md-account">
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="md-method">Method</Label>
            <Select value={method} onValueChange={setMethod} disabled={busy}>
              <SelectTrigger id="md-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {side === "ap" ? <SelectItem value={AUTO}>From the account</SelectItem> : null}
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="md-ref" hint={side === "ar" ? "check or trace no." : "check or confirmation no."}>
              Reference
            </Label>
            <Input id="md-ref" value={reference} onChange={(e) => setReference(e.target.value)} disabled={busy} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="md-amount" required hint={amountTouched ? "as entered" : "sum of what is applied"}>
              {side === "ar" ? "Amount received" : "Amount paid"}
            </Label>
            <div className="flex gap-2">
              <MoneyInput
                id="md-amount"
                value={amountTouched ? amount : textOf(appliedCents)}
                onValueChange={(value) => {
                  setAmountTouched(true);
                  setAmount(value);
                }}
                disabled={busy}
              />
              {amountTouched && openDocs.length > 0 ? (
                <Button type="button" variant="secondary" size="sm" className="h-8" onClick={autoApply} disabled={busy} title="Apply to the oldest first">
                  <Wand2 />
                  Oldest first
                </Button>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-4">
            <Label htmlFor="md-memo">Memo</Label>
            <Input id="md-memo" value={memo} onChange={(e) => setMemo(e.target.value)} disabled={busy} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{side === "ar" ? "Apply to invoices" : "Apply to bills"}</CardTitle>
          {party ? (
            <span className="text-xs text-muted-foreground">
              {openDocs.length === 0 ? "Nothing open" : `${openDocs.length} open, oldest due first`}
            </span>
          ) : null}
        </CardHeader>
        {party === null ? (
          <EmptyState
            icon={<HandCoins />}
            title={`Choose the ${partyWord} first`}
            description={
              side === "ar"
                ? "Their open invoices appear here to tick off. Money that matches no invoice is kept as a credit on their account."
                : "Their approved bills appear here to tick off. Money paid ahead of a bill is kept as a prepayment."
            }
          />
        ) : openDocs.length === 0 ? (
          <EmptyState
            icon={<HandCoins />}
            title={side === "ar" ? `${party.name} owes nothing on an issued invoice` : `No approved bill from ${party.name} is open`}
            description={
              side === "ar"
                ? "You can still record the money: it is kept as a credit on their account and can be applied to their next invoice."
                : "You can still record the payment: it is kept as a prepayment and applied when their bill arrives."
            }
          />
        ) : (
          <div className={cn("relative overflow-x-auto", navigating && "opacity-60")}>
            <table className="w-full min-w-[46rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Open documents</caption>
              <thead>
                <tr>
                  <GridTh className="w-10" />
                  <GridTh>{side === "ar" ? "Invoice" : "Bill"}</GridTh>
                  <GridTh>Date</GridTh>
                  <GridTh>Due</GridTh>
                  <GridTh className="text-right">Total</GridTh>
                  <GridTh className="text-right">Open</GridTh>
                  {side === "ar" ? <GridTh className="w-28 text-right">Discount</GridTh> : null}
                  <GridTh className="w-32 text-right">Apply</GridTh>
                </tr>
              </thead>
              <tbody>
                {openDocs.map((doc) => {
                  const row = rows[doc.id] ?? { checked: false, amount: "", discount: "" };
                  const overdue = daysPastDue(doc.dueDate, date);
                  const allowed = side === "ar" ? allowedDiscount(terms, doc, date) : 0;
                  const error = rowErrors.get(doc.id);
                  return (
                    <React.Fragment key={doc.id}>
                      <tr className={cn("align-middle", row.checked && "bg-primary/5")}>
                        <GridTd>
                          <Checkbox
                            checked={row.checked}
                            onCheckedChange={(checked) => toggle(doc, checked === true)}
                            aria-label={`Apply to ${doc.docNo}`}
                            disabled={busy}
                          />
                        </GridTd>
                        <GridTd className="num">{doc.docNo}</GridTd>
                        <GridTd className="num">{doc.date}</GridTd>
                        <GridTd className="num">
                          {doc.dueDate}
                          {overdue > 0 ? (
                            <Badge tone="negative" size="sm" className="ml-2">
                              {overdue}d late
                            </Badge>
                          ) : null}
                        </GridTd>
                        <GridTd className="text-right">
                          <Money cents={doc.totalCents} plain />
                        </GridTd>
                        <GridTd className="text-right">
                          <Money cents={doc.balanceCents} plain className="font-medium" />
                        </GridTd>
                        {side === "ar" ? (
                          <GridTd>
                            <MoneyInput
                              className="h-7"
                              value={row.discount}
                              disabled={busy || !row.checked || allowed === 0}
                              placeholder={allowed > 0 ? textOf(allowed) : "—"}
                              aria-label={`Early-payment discount on ${doc.docNo}`}
                              onValueChange={(discount) => setRows((c) => ({ ...c, [doc.id]: { ...row, discount } }))}
                            />
                          </GridTd>
                        ) : null}
                        <GridTd>
                          <MoneyInput
                            className="h-7"
                            value={row.amount}
                            disabled={busy}
                            aria-label={`Amount applied to ${doc.docNo}`}
                            onValueChange={(value) =>
                              setRows((c) => ({ ...c, [doc.id]: { ...row, checked: value.trim() !== "", amount: value } }))
                            }
                          />
                        </GridTd>
                      </tr>
                      {error ? (
                        <tr>
                          <td />
                          <td colSpan={side === "ar" ? 7 : 6} className="pb-1 text-xs text-negative">
                            {error}
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {party !== null ? (
          <div className="flex justify-end border-t border-border p-4">
            <dl className="grid w-full max-w-sm grid-cols-[1fr_8rem] gap-y-1.5 text-sm [&>dd]:pl-4">
              <dt className="text-muted-foreground">Applied</dt>
              <dd className="text-right">
                <Money cents={appliedCents} plain />
              </dd>
              {side === "ar" ? (
                <>
                  <dt className="text-muted-foreground">Early-payment discounts (4580)</dt>
                  <dd className="text-right">
                    <Money cents={discountCents} plain zeroDash />
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">
                {side === "ar" ? "Left as customer credit" : "Left as prepayment"}
              </dt>
              <dd className="text-right">
                <Money cents={unapplied} plain zeroDash className={cn(unapplied < 0 && "text-negative")} />
              </dd>
              <dt className="rule-subtotal pt-1.5 font-semibold">{side === "ar" ? "Received" : "Paid"}</dt>
              <dd className="rule-subtotal rule-total pt-1.5 pb-0.5 text-right">
                <Money cents={amountCents} currency plain className="font-semibold" />
              </dd>
            </dl>
          </div>
        ) : null}
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border-strong bg-surface-raised/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[104rem] flex-wrap items-center justify-between gap-3 px-4 py-2.5 lg:px-6">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="eyebrow">{side === "ar" ? "Received" : "Paid"}</span>
            <Money cents={amountCents} currency plain className="font-semibold" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {problem === null ? null : <span className="max-w-sm text-xs text-muted-foreground">{problem}</span>}
            <Button type="button" size="sm" disabled={busy || problem !== null} onClick={submit}>
              <HandCoins />
              {side === "ar" ? "Record receipt" : "Record payment"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatShort(cents: number): string {
  return formatCents(cents, { currency: true });
}

function GridTh({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider whitespace-nowrap text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </th>
  );
}

function GridTd({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={cn("rule-row px-3 py-1 align-middle", className)}>{children}</td>;
}

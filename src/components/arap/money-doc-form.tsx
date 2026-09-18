"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import { FlowDiagram } from "@/components/charts";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { formatCents, Money } from "@/components/ui/money";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
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
import { CATEGORIES, categoryForCode } from "@/lib/ui/categories";
import { shortDate } from "@/lib/ui/format";
import { recordReceiptAction } from "@/app/(app)/sales/actions";
import { payBillsAction } from "@/app/(app)/purchases/actions";

import { allowedDiscount, applyOldestFirst, daysPastDue, readMoney, termsLabel } from "./math";
import { MoneyInput, centsOf, textOf } from "./money-input";
import { PartyCombobox, type PartyOption } from "./party-combobox";
import { FormSection, Grid, GridFigure, GridTd, GridTh, TotalRow, Totals, cellField } from "./sheet-grid";
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
  /** The page's toolbar: the form draws it, so the Record button sits in it. */
  toolbar: { title: string; back: { href: string; label: string }; info?: React.ReactNode };
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
  toolbar,
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

  const submitLabel = side === "ar" ? "Record receipt" : "Record payment";
  const submitButton = (phone: boolean) => (
    <Button type="button" className={phone ? "flex-1" : undefined} disabled={busy || problem !== null} onClick={submit}>
      <Glyph name={side === "ar" ? "arrow-in" : "arrow-out"} size={15} weight={2} />
      {submitLabel}
    </Button>
  );
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const accountNode = account === null ? null : categoryForCode(account.label.split(" ")[0]);
  const accountName = account === null ? "" : account.label.replace(/^\S+\s+/, "").replace(/^[^—]*—\s*/, "");
  const sideNode = side === "ar" ? CATEGORIES.receivables : CATEGORIES.payables;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={toolbar.title}
        back={toolbar.back}
        info={toolbar.info}
        phoneTitleRow
        actions={<div className="flex items-center gap-2 max-md:hidden">{submitButton(false)}</div>}
      />

      <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-2">
        <InsetGroup>
          <GroupRow label={side === "ar" ? "Customer" : "Vendor"} htmlFor="md-party">
            <div className="w-64 max-sm:w-48">
              <PartyCombobox
                id="md-party"
                options={parties}
                value={partyId}
                onChange={pickParty}
                placeholder="Choose"
                emptyText={`No ${partyWord} by that name.`}
                disabled={busy}
              />
            </div>
          </GroupRow>
          <GroupRow label="Amount" htmlFor="md-amount">
            {amountTouched && openDocs.length > 0 ? (
              <Button type="button" variant="secondary" size="sm" onClick={autoApply} disabled={busy} title="Apply to the oldest first">
                <Glyph name="wand" size={13} />
                Oldest first
              </Button>
            ) : (
              <span className="text-xs text-label2 max-sm:hidden">{openDocs.length > 0 ? "Sum applied" : null}</span>
            )}
            <MoneyInput
              id="md-amount"
              className="w-36"
              value={amountTouched ? amount : textOf(appliedCents)}
              onValueChange={(value) => {
                setAmountTouched(true);
                setAmount(value);
              }}
              disabled={busy}
            />
          </GroupRow>
          <GroupRow label="Reference" htmlFor="md-ref">
            <Input
              id="md-ref"
              className="w-64 max-sm:w-48"
              value={reference}
              placeholder={side === "ar" ? "Check or trace no." : "Check or confirmation no."}
              onChange={(e) => setReference(e.target.value)}
              disabled={busy}
            />
          </GroupRow>
          <GroupRow label="Memo" htmlFor="md-memo">
            <Input id="md-memo" className="w-64 max-sm:w-48" value={memo} onChange={(e) => setMemo(e.target.value)} disabled={busy} />
          </GroupRow>
        </InsetGroup>

        <InsetGroup>
          <GroupRow label="Date" htmlFor="md-date">
            <DateInput id="md-date" value={date} onValueChange={setDate} disabled={busy} />
          </GroupRow>
          <GroupRow label={side === "ar" ? "Deposit to" : "Pay from"} htmlFor="md-account">
            <Select value={accountId ?? undefined} onValueChange={setAccountId} disabled={busy}>
              <SelectTrigger id="md-account" className="w-64 max-sm:w-48">
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </GroupRow>
          <GroupRow label="Method" htmlFor="md-method">
            <Select value={method} onValueChange={setMethod} disabled={busy}>
              <SelectTrigger id="md-method" className="w-44">
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
          </GroupRow>
          {side === "ar" ? (
            <GroupRow label="Terms">{party ? termsLabel(terms.termsDays, terms.termsDiscountPct, terms.termsDiscountDays) : "—"}</GroupRow>
          ) : null}
        </InsetGroup>
      </div>

      <FormSection
        title={side === "ar" ? "Apply to invoices" : "Apply to bills"}
        accessory={
          <InfoButton label="About applying">
            <p>
              {side === "ar"
                ? "Tick the invoices this money pays; an early-payment discount the terms allow today is taken automatically. Money that matches no invoice stays on the customer's account as a credit and can be applied later."
                : "Tick the bills this payment settles. Money paid ahead of a bill is kept as a prepayment and applied when the bill arrives. Paying from a card account keeps it off the 1099."}
            </p>
          </InfoButton>
        }
      >
        {party === null ? (
          <EmptyState glyph={side === "ar" ? "people" : "people"} title={`Choose the ${partyWord}`} className="py-8" />
        ) : openDocs.length === 0 ? (
          <EmptyState glyph="check-circle" title={side === "ar" ? "Nothing open" : "No open bills"} className="py-8" description={
            side === "ar"
              ? "You can still record the money: it is kept as a credit on their account and can be applied to their next invoice."
              : "You can still record the payment: it is kept as a prepayment and applied when their bill arrives."
          } />
        ) : (
          <div className={cn(navigating && "opacity-60")}>
            <Grid
              caption="Open documents"
              minWidth="min-w-[46rem]"
              head={
                <>
                  <GridTh className="w-11">
                    <span className="sr-only">Apply</span>
                  </GridTh>
                  <GridTh>{side === "ar" ? "Invoice" : "Bill"}</GridTh>
                  <GridTh>Date</GridTh>
                  <GridTh>Due</GridTh>
                  <GridTh align="right">Total</GridTh>
                  <GridTh align="right">Open</GridTh>
                  {side === "ar" ? (
                    <GridTh className="w-28" align="right">
                      Discount
                    </GridTh>
                  ) : null}
                  <GridTh className="w-32" align="right">
                    Apply
                  </GridTh>
                </>
              }
            >
              {openDocs.map((doc) => {
                const row = rows[doc.id] ?? { checked: false, amount: "", discount: "" };
                const overdue = daysPastDue(doc.dueDate, date);
                const allowed = side === "ar" ? allowedDiscount(terms, doc, date) : 0;
                const error = rowErrors.get(doc.id);
                return (
                  <React.Fragment key={doc.id}>
                    <tr className={cn(row.checked && "[&>td]:bg-tint-blue/6")}>
                      <GridTd className="text-center">
                        <Checkbox
                          checked={row.checked}
                          onCheckedChange={(checked) => toggle(doc, checked === true)}
                          aria-label={`Apply to ${doc.docNo}`}
                          disabled={busy}
                        />
                      </GridTd>
                      <GridTd className="num px-2.5 font-medium">{doc.docNo}</GridTd>
                      <GridTd className="num px-2.5 text-label2">{shortDate(doc.date)}</GridTd>
                      <GridTd className="num px-2.5">
                        <span className="inline-flex items-center gap-2 whitespace-nowrap">
                          {shortDate(doc.dueDate)}
                          {overdue > 0 ? (
                            <Badge tone="negative" size="sm">
                              {overdue}d late
                            </Badge>
                          ) : null}
                        </span>
                      </GridTd>
                      <GridTd>
                        <GridFigure className="font-normal text-label2">
                          <Money cents={doc.totalCents} plain />
                        </GridFigure>
                      </GridTd>
                      <GridTd>
                        <GridFigure>
                          <Money cents={doc.balanceCents} plain />
                        </GridFigure>
                      </GridTd>
                      {side === "ar" ? (
                        <GridTd>
                          <MoneyInput
                            className={cellField}
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
                          className={cellField}
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
                        <td colSpan={side === "ar" ? 7 : 6} className="border-b-[0.5px] border-sep px-2.5 py-1.5 text-xs font-medium text-ink-red">
                          {error}
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </Grid>
          </div>
        )}

        {party !== null ? (
          <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
            <div className="min-w-0 rounded-[12px] bg-inset px-4 py-3.5 max-lg:order-last">
              <p className="mb-2.5 text-xs font-semibold text-label2">Recording posts</p>
              {account === null || accountNode === null ? (
                <p className="py-2 text-sm text-label2">Choose the account.</p>
              ) : side === "ar" ? (
                <FlowDiagram
                  from={{ label: "Receivables", glyph: sideNode.glyph, tint: sideNode.tint }}
                  to={[{ label: accountName, glyph: accountNode.glyph, tint: accountNode.tint, cents: amountCents }]}
                  className="[&_span.bg-card]:bg-inset"
                />
              ) : (
                <FlowDiagram
                  from={{ label: accountName, glyph: accountNode.glyph, tint: accountNode.tint }}
                  to={[{ label: "Payables", glyph: sideNode.glyph, tint: sideNode.tint, cents: amountCents }]}
                  className="[&_span.bg-card]:bg-inset"
                />
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Totals>
                <TotalRow label="Applied">
                  <Money cents={appliedCents} plain />
                </TotalRow>
                {side === "ar" ? (
                  <TotalRow label="Discounts">
                    <Money cents={discountCents} plain zeroDash />
                  </TotalRow>
                ) : null}
                <TotalRow label={side === "ar" ? "Left as credit" : "Prepaid"}>
                  <Money cents={unapplied} plain zeroDash className={cn(unapplied < 0 && "text-ink-red")} />
                </TotalRow>
                <TotalRow label={side === "ar" ? "Received" : "Paid"} strong>
                  <Money cents={amountCents} currency plain />
                </TotalRow>
              </Totals>
              {problem === null ? null : (
                <p role="status" className="flex items-center justify-end gap-1.5 text-xs font-medium text-label2">
                  <Glyph name="info" size={13} />
                  {problem}
                </p>
              )}
            </div>
          </div>
        ) : null}
      </FormSection>

      <div className="flex gap-2 rounded-[22px] bg-card p-3 shadow-card md:hidden">{submitButton(true)}</div>
    </div>
  );
}

function formatShort(cents: number): string {
  return formatCents(cents, { currency: true });
}

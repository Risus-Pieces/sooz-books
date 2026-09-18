"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Send, Trash2 } from "lucide-react";

import { AccountCombobox } from "@/components/ledger/account-combobox";
import type { AccountOption } from "@/components/ledger/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { addDays, isCalendarDate } from "@/lib/dates";
import { saveInvoice } from "@/app/(app)/sales/actions";

import { extendCents, invoiceTotals, readMoney, scaledQuantity, termsLabel } from "./math";
import { MoneyInput, centsOf, textOf } from "./money-input";
import { PartyCombobox } from "./party-combobox";
import type { CustomerPick, InvoiceForm, Option } from "./types";

const NONE = "__none__";

interface LineState {
  key: string;
  description: string;
  productId: string | null;
  quantity: string;
  price: string;
  discount: string;
  tax: string;
  revenueAccountId: string | null;
}

let sequence = 0;
function blankLine(): LineState {
  sequence += 1;
  return {
    key: `l${sequence}`,
    description: "",
    productId: null,
    quantity: "1",
    price: "",
    discount: "",
    tax: "",
    revenueAccountId: null,
  };
}

function isBlank(line: LineState): boolean {
  return line.description.trim() === "" && line.price.trim() === "" && line.productId === null;
}

export interface InvoiceFormProps {
  /** The draft being edited; null for a new invoice. */
  invoiceId: string | null;
  invoiceNo: string | null;
  customers: readonly CustomerPick[];
  revenueAccounts: readonly AccountOption[];
  products: readonly Option[];
  initial: InvoiceForm;
  /** True when the due date was set by hand rather than from the terms. */
  dueDateOverridden: boolean;
  canManage: boolean;
}

/**
 * Writing an invoice. The lines are priced as they are typed with the same
 * exact arithmetic the engine uses, so the total on screen is the total that
 * posts. Two ways out: keep it as a draft (numbered, not in the ledger), or
 * issue it — which posts it to receivables and makes it final.
 */
export function InvoiceFormView({
  invoiceId,
  invoiceNo,
  customers,
  revenueAccounts,
  products,
  initial,
  dueDateOverridden,
  canManage,
}: InvoiceFormProps) {
  const router = useRouter();
  const [pending, start] = React.useTransition();

  const [customerId, setCustomerId] = React.useState<string | null>(initial.customerId || null);
  const [invoiceDate, setInvoiceDate] = React.useState(initial.invoiceDate);
  const [dueDate, setDueDate] = React.useState<string>(initial.dueDate ?? "");
  const [dueTouched, setDueTouched] = React.useState(dueDateOverridden);
  const [poNumber, setPoNumber] = React.useState(initial.poNumber);
  const [memo, setMemo] = React.useState(initial.memo);
  const [discount, setDiscount] = React.useState(textOf(initial.discountCents));
  const [shipping, setShipping] = React.useState(textOf(initial.shippingCents));
  const [lines, setLines] = React.useState<LineState[]>(() =>
    initial.lines.length === 0
      ? [blankLine()]
      : initial.lines.map((line) => ({
          ...blankLine(),
          description: line.description,
          productId: line.productId,
          quantity: line.quantity,
          price: textOf(line.unitPriceCents),
          discount: textOf(line.discountCents),
          tax: textOf(line.taxCents),
          revenueAccountId: line.revenueAccountId,
        })),
  );

  const customer = customers.find((c) => c.id === customerId) ?? null;
  const defaultAccount = revenueAccounts.find((a) => a.id === customer?.defaultRevenueAccountId) ?? null;

  // Due date follows the terms until someone sets it by hand.
  const effectiveDue =
    dueTouched || customer === null || !isCalendarDate(invoiceDate) ? dueDate : addDays(invoiceDate, customer.termsDays);

  const filled = lines.filter((line) => !isBlank(line));
  const totals = invoiceTotals({
    lines: filled.map((line) => ({
      quantity: line.quantity.trim() === "" ? "1" : line.quantity,
      unitPriceCents: centsOf(line.price),
      discountCents: centsOf(line.discount),
      taxCents: centsOf(line.tax),
    })),
    discountCents: centsOf(discount),
    shippingCents: centsOf(shipping),
  });

  const lineErrors = new Map<string, string>();
  for (const line of filled) {
    const qty = line.quantity.trim() === "" ? "1" : line.quantity;
    const amount = extendCents(qty, centsOf(line.price));
    if (line.description.trim() === "") lineErrors.set(line.key, "Describe what was sold.");
    else if (scaledQuantity(qty) === null) lineErrors.set(line.key, "Quantity must be a number with at most four decimals.");
    else if ([line.price, line.discount, line.tax].some((t) => readMoney(t).error !== null))
      lineErrors.set(line.key, "An amount on this line is not readable.");
    else if (amount !== null && centsOf(line.discount) > amount) lineErrors.set(line.key, "The discount is larger than the line.");
    else if (line.revenueAccountId === null && customer !== null && defaultAccount === null)
      lineErrors.set(line.key, "This customer has no sales channel, so choose the revenue account.");
  }

  const problem =
    !canManage
      ? "Your role may not write invoices."
      : customer === null
        ? "Choose the customer."
        : !isCalendarDate(invoiceDate)
          ? "Enter the invoice date."
          : effectiveDue !== "" && effectiveDue < invoiceDate
            ? "The due date is before the invoice date."
            : filled.length === 0
              ? "Add at least one line."
              : lineErrors.size > 0
                ? "Fix the lines marked in red."
                : readMoney(discount).error !== null || readMoney(shipping).error !== null
                  ? "The discount or shipping amount is not readable."
                  : totals.totalCents <= 0
                    ? "An invoice must total more than zero."
                    : null;

  const patch = (key: string, change: Partial<LineState>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...change } : line)));

  const addAfter = (key: string | null) =>
    setLines((current) => {
      const index = key === null ? -1 : current.findIndex((line) => line.key === key);
      const next = [...current];
      next.splice(index === -1 ? next.length : index + 1, 0, blankLine());
      return next;
    });

  const submit = (intent: "draft" | "issue") => {
    if (customer === null) return;
    const form: InvoiceForm = {
      customerId: customer.id,
      invoiceDate,
      dueDate: dueTouched && effectiveDue !== "" ? effectiveDue : null,
      poNumber,
      memo,
      discountCents: centsOf(discount),
      shippingCents: centsOf(shipping),
      lines: filled.map((line) => ({
        description: line.description,
        productId: line.productId,
        quantity: line.quantity.trim() === "" ? "1" : line.quantity.trim(),
        unitPriceCents: centsOf(line.price),
        discountCents: centsOf(line.discount),
        taxCents: centsOf(line.tax),
        revenueAccountId: line.revenueAccountId,
      })),
    };
    start(async () => {
      const result = await saveInvoice(invoiceId, form, intent);
      if (!result.ok) {
        toast.error(intent === "issue" ? "Invoice not issued" : "Draft not saved", { description: result.error.message });
        return;
      }
      toast.success(intent === "issue" ? `${result.value.docNo} issued` : `${result.value.docNo} saved as a draft`);
      router.push(`/sales/invoices/${result.value.id}`);
    });
  };

  return (
    <div className="flex flex-col gap-4 pb-28">
      <Card>
        <CardHeader>
          <CardTitle>{invoiceNo === null ? "New invoice" : `Draft ${invoiceNo}`}</CardTitle>
          {customer ? (
            <span className="text-xs text-muted-foreground">
              Terms {termsLabel(customer.termsDays, customer.termsDiscountPct, customer.termsDiscountDays)}
              {defaultAccount ? ` · sales to ${defaultAccount.code} ${defaultAccount.name}` : null}
            </span>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,2fr)_10rem_10rem_minmax(8rem,1fr)]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inv-customer" required>
              Customer
            </Label>
            <PartyCombobox
              id="inv-customer"
              options={customers.map((c) => ({ id: c.id, name: c.name, note: termsLabel(c.termsDays, c.termsDiscountPct, c.termsDiscountDays) }))}
              value={customerId}
              onChange={setCustomerId}
              placeholder="Choose a customer"
              emptyText="No customer by that name."
              disabled={pending}
            />
            {customers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No customers yet.{" "}
                <Link href="/sales/customers?new=1" className="text-primary hover:underline">
                  Add the first one
                </Link>
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inv-date" required>
              Invoice date
            </Label>
            <DateInput id="inv-date" value={invoiceDate} onValueChange={setInvoiceDate} disabled={pending} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inv-due" hint={dueTouched ? "set by hand" : "from terms"}>
              Due
            </Label>
            <DateInput
              id="inv-due"
              value={effectiveDue}
              onValueChange={(value) => {
                setDueTouched(true);
                setDueDate(value);
              }}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inv-po" hint="the buyer's">
              PO number
            </Label>
            <Input id="inv-po" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} disabled={pending} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-4">
            <Label htmlFor="inv-memo" hint="printed on the invoice">
              Note to customer
            </Label>
            <Input
              id="inv-memo"
              value={memo}
              placeholder="e.g. Thank you — deliveries Tuesdays before 10am"
              onChange={(e) => setMemo(e.target.value)}
              disabled={pending}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
          <span className="text-xs text-muted-foreground">Enter adds a line · discounts post to 4510, never netted off sales</span>
        </CardHeader>
        <div className="relative overflow-x-auto p-3">
          <table className="w-full min-w-[60rem] border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Invoice lines</caption>
            <thead>
              <tr>
                <GridTh className="w-7 text-right">#</GridTh>
                <GridTh className="min-w-52">Description</GridTh>
                <GridTh className="w-40">Product</GridTh>
                <GridTh className="w-20 text-right">Qty</GridTh>
                <GridTh className="w-28 text-right">Unit price</GridTh>
                <GridTh className="w-24 text-right">Discount</GridTh>
                <GridTh className="w-24 text-right">Tax</GridTh>
                <GridTh className="w-28 text-right">Amount</GridTh>
                <GridTh className="w-52">Revenue account</GridTh>
                <GridTh className="w-8">
                  <span className="sr-only">Remove</span>
                </GridTh>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const qty = line.quantity.trim() === "" ? "1" : line.quantity;
                const amount = extendCents(qty, centsOf(line.price));
                const error = lineErrors.get(line.key);
                return (
                  <React.Fragment key={line.key}>
                    <tr
                      className="align-middle"
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.defaultPrevented) return;
                        if ((event.target as HTMLElement).closest("[cmdk-root]") !== null) return;
                        event.preventDefault();
                        addAfter(line.key);
                      }}
                    >
                      <GridTd className="num text-right text-xs text-muted-foreground">{index + 1}</GridTd>
                      <GridTd>
                        <Input
                          className="h-7"
                          value={line.description}
                          invalid={error === "Describe what was sold."}
                          placeholder="e.g. Hibiscus ginger, case of 12"
                          aria-label={`Description, line ${index + 1}`}
                          disabled={pending}
                          onChange={(e) => patch(line.key, { description: e.target.value })}
                        />
                      </GridTd>
                      <GridTd>
                        <Select
                          value={line.productId ?? NONE}
                          disabled={pending || products.length === 0}
                          onValueChange={(next) => {
                            const productId = next === NONE ? null : next;
                            const product = products.find((p) => p.id === productId);
                            patch(line.key, {
                              productId,
                              ...(product && line.description.trim() === "" ? { description: product.label } : {}),
                            });
                          }}
                        >
                          <SelectTrigger className="h-7" aria-label={`Product, line ${index + 1}`}>
                            <SelectValue placeholder={products.length === 0 ? "No products" : "Product"} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>
                              <span className="text-muted-foreground">No product</span>
                            </SelectItem>
                            {products.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.hint ? `${p.hint} · ` : ""}
                                {p.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </GridTd>
                      <GridTd>
                        <Input
                          numeric
                          inputMode="decimal"
                          className="h-7"
                          value={line.quantity}
                          invalid={scaledQuantity(qty) === null}
                          aria-label={`Quantity, line ${index + 1}`}
                          disabled={pending}
                          onChange={(e) => patch(line.key, { quantity: e.target.value })}
                        />
                      </GridTd>
                      <GridTd>
                        <MoneyInput
                          className="h-7"
                          value={line.price}
                          aria-label={`Unit price, line ${index + 1}`}
                          disabled={pending}
                          onValueChange={(price) => patch(line.key, { price })}
                        />
                      </GridTd>
                      <GridTd>
                        <MoneyInput
                          className="h-7"
                          value={line.discount}
                          aria-label={`Discount, line ${index + 1}`}
                          disabled={pending}
                          onValueChange={(value) => patch(line.key, { discount: value })}
                        />
                      </GridTd>
                      <GridTd>
                        <MoneyInput
                          className="h-7"
                          value={line.tax}
                          aria-label={`Sales tax, line ${index + 1}`}
                          disabled={pending}
                          onValueChange={(value) => patch(line.key, { tax: value })}
                        />
                      </GridTd>
                      <GridTd className="text-right">
                        {amount === null || isBlank(line) ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <Money cents={amount} plain />
                        )}
                      </GridTd>
                      <GridTd>
                        <AccountCombobox
                          accounts={revenueAccounts}
                          value={line.revenueAccountId}
                          disabled={pending}
                          invalid={error === "This customer has no sales channel, so choose the revenue account."}
                          placeholder={defaultAccount ? `${defaultAccount.code} · channel default` : "Revenue account"}
                          onChange={(revenueAccountId) => patch(line.key, { revenueAccountId })}
                          className="h-7"
                        />
                      </GridTd>
                      <GridTd className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove line ${index + 1}`}
                          disabled={pending || (lines.length === 1 && isBlank(line))}
                          onClick={() =>
                            setLines((current) => {
                              const rest = current.filter((l) => l.key !== line.key);
                              return rest.length === 0 ? [blankLine()] : rest;
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </GridTd>
                    </tr>
                    {error ? (
                      <tr>
                        <td />
                        <td colSpan={9} className="pb-1 text-xs text-negative">
                          {error}
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <div className="pt-2">
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => addAfter(null)}>
              <Plus />
              Add line
              <span className="text-2xs text-muted-foreground">or press Enter</span>
            </Button>
          </div>
        </div>

        <div className="flex justify-end border-t border-border p-4">
          <dl className="grid w-full max-w-xs grid-cols-[1fr_8rem] items-center gap-y-1.5 text-sm [&>dd]:pl-4">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="text-right">
              <Money cents={totals.subtotalCents} plain />
            </dd>
            <dt className="text-muted-foreground">
              <label htmlFor="inv-discount">Invoice discount</label>
            </dt>
            <dd>
              <MoneyInput id="inv-discount" className="h-7" value={discount} onValueChange={setDiscount} disabled={pending} />
            </dd>
            <dt className="text-muted-foreground">
              <label htmlFor="inv-shipping">Shipping</label>
            </dt>
            <dd>
              <MoneyInput id="inv-shipping" className="h-7" value={shipping} onValueChange={setShipping} disabled={pending} />
            </dd>
            <dt className="text-muted-foreground">All discounts</dt>
            <dd className="text-right">
              <Money cents={-totals.discountCents} plain zeroDash />
            </dd>
            <dt className="text-muted-foreground">Sales tax</dt>
            <dd className="text-right">
              <Money cents={totals.taxCents} plain zeroDash />
            </dd>
            <dt className="rule-subtotal pt-1.5 font-semibold">Total</dt>
            <dd className="rule-subtotal rule-total pt-1.5 pb-0.5 text-right">
              <Money cents={totals.totalCents} currency plain className="font-semibold" />
            </dd>
          </dl>
        </div>
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border-strong bg-surface-raised/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[104rem] flex-wrap items-center justify-between gap-3 px-4 py-2.5 lg:px-6">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="eyebrow">Total</span>
            <Money cents={totals.totalCents} currency plain className="font-semibold" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {problem === null ? null : <span className="max-w-sm text-xs text-muted-foreground">{problem}</span>}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending || !canManage || customer === null || filled.length === 0}
              onClick={() => submit("draft")}
            >
              Save draft
            </Button>
            <Button type="button" size="sm" disabled={pending || problem !== null} onClick={() => submit("issue")}>
              <Send />
              Issue invoice
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GridTh({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head px-1.5 pb-1 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </th>
  );
}

function GridTd({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={cn("px-1.5 py-1 align-middle", className)}>{children}</td>;
}

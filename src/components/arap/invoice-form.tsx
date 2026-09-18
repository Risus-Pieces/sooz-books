"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { FlowDiagram } from "@/components/charts";
import { AccountCombobox } from "@/components/ledger/account-combobox";
import { PageToolbar } from "@/components/shell/page-toolbar";
import type { AccountOption } from "@/components/ledger/types";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Kbd } from "@/components/ui/keycap";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { addDays, isCalendarDate } from "@/lib/dates";
import { CATEGORIES } from "@/lib/ui/categories";
import { saveInvoice } from "@/app/(app)/sales/actions";

import { extendCents, invoiceTotals, readMoney, scaledQuantity, termsLabel } from "./math";
import { MoneyInput, centsOf, textOf } from "./money-input";
import { PartyCombobox } from "./party-combobox";
import { FormSection, Grid, GridFigure, GridRowNo, GridTd, GridTh, TotalRow, Totals, cellField, stackRow } from "./sheet-grid";
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
  customers: readonly CustomerPick[];
  revenueAccounts: readonly AccountOption[];
  products: readonly Option[];
  initial: InvoiceForm;
  /** True when the due date was set by hand rather than from the terms. */
  dueDateOverridden: boolean;
  canManage: boolean;
  /** The page's toolbar: the form draws it, so Save and Issue sit in it. */
  toolbar: { title: string; back: { href: string; label: string }; info?: React.ReactNode; subtitle?: React.ReactNode };
}

/**
 * Writing an invoice. The lines are priced as they are typed with the same
 * exact arithmetic the engine uses, so the total on screen is the total that
 * posts. Two ways out: keep it as a draft (numbered, not in the ledger), or
 * issue it — which posts it to receivables and makes it final.
 */
export function InvoiceFormView({
  invoiceId,
  customers,
  revenueAccounts,
  products,
  initial,
  dueDateOverridden,
  canManage,
  toolbar,
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

  const saveDisabled = pending || !canManage || customer === null || filled.length === 0;
  const issueDisabled = pending || problem !== null;
  const buttons = (phone: boolean) => (
    <>
      <Button
        type="button"
        variant="secondary"
        className={phone ? "flex-1" : undefined}
        disabled={saveDisabled}
        onClick={() => submit("draft")}
      >
        Save draft
      </Button>
      <Button type="button" className={phone ? "flex-1" : undefined} disabled={issueDisabled} onClick={() => submit("issue")}>
        <Glyph name="arrow-out" size={15} weight={2} />
        Issue invoice
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={toolbar.title}
        subtitle={toolbar.subtitle}
        back={toolbar.back}
        info={toolbar.info}
        phoneTitleRow
        actions={<div className="flex items-center gap-2 max-md:hidden">{buttons(false)}</div>}
      />

      <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-2">
        <InsetGroup className="[&>div]:overflow-visible">
          <GroupRow label="Customer" htmlFor="inv-customer">
            <div className="flex w-64 flex-col items-end gap-1 max-sm:w-48">
              <PartyCombobox
                id="inv-customer"
                options={customers.map((c) => ({ id: c.id, name: c.name, note: termsLabel(c.termsDays, c.termsDiscountPct, c.termsDiscountDays) }))}
                value={customerId}
                onChange={setCustomerId}
                placeholder="Choose"
                emptyText="No customer by that name."
                disabled={pending}
              />
              {customers.length === 0 ? (
                <Link href="/sales/customers?new=1" className="text-xs font-medium text-ink-blue hover:underline">
                  Add customer
                </Link>
              ) : null}
            </div>
          </GroupRow>
          <GroupRow label="PO" htmlFor="inv-po">
            <Input id="inv-po" className="w-64 max-sm:w-48" value={poNumber} placeholder="Buyer’s PO" onChange={(e) => setPoNumber(e.target.value)} disabled={pending} />
          </GroupRow>
          <GroupRow label="Note" htmlFor="inv-memo">
            <Input
              id="inv-memo"
              className="w-64 max-sm:w-48"
              value={memo}
              placeholder="Printed on the invoice"
              onChange={(e) => setMemo(e.target.value)}
              disabled={pending}
            />
          </GroupRow>
        </InsetGroup>

        <InsetGroup>
          <GroupRow label="Date" htmlFor="inv-date">
            <DateInput id="inv-date" value={invoiceDate} onValueChange={setInvoiceDate} disabled={pending} />
          </GroupRow>
          <GroupRow label="Due" htmlFor="inv-due">
            <span className="text-xs text-label2 max-sm:hidden">{dueTouched ? "Set by hand" : "From terms"}</span>
            <DateInput
              id="inv-due"
              value={effectiveDue}
              onValueChange={(value) => {
                setDueTouched(true);
                setDueDate(value);
              }}
              disabled={pending}
            />
          </GroupRow>
          <GroupRow label="Terms">
            <span className="truncate">
              {customer ? termsLabel(customer.termsDays, customer.termsDiscountPct, customer.termsDiscountDays) : "—"}
            </span>
          </GroupRow>
          <GroupRow label="Sales to">
            <span className="truncate">{defaultAccount ? `${defaultAccount.code} ${defaultAccount.name}` : "—"}</span>
          </GroupRow>
        </InsetGroup>
      </div>

      <FormSection
        title="Lines"
        accessory={
          <InfoButton label="About lines">
            <p>Enter adds a line. Discounts post to 4510, never netted off sales. A line with no revenue account uses the customer&rsquo;s channel.</p>
          </InfoButton>
        }
      >
        <Grid
          caption="Invoice lines"
          minWidth="min-w-[62rem]"
          stack
          head={
            <>
              <GridTh className="w-9" align="right">
                <span className="sr-only">Line</span>
              </GridTh>
              <GridTh className="min-w-52">Description</GridTh>
              <GridTh className="w-40">Product</GridTh>
              <GridTh className="w-20" align="right">
                Qty
              </GridTh>
              <GridTh className="w-28" align="right">
                Price
              </GridTh>
              <GridTh className="w-24" align="right">
                Discount
              </GridTh>
              <GridTh className="w-24" align="right">
                Tax
              </GridTh>
              <GridTh className="w-28" align="right">
                Amount
              </GridTh>
              <GridTh className="w-52">Revenue</GridTh>
              <GridTh className="w-10">
                <span className="sr-only">Remove</span>
              </GridTh>
            </>
          }
          after={
            <button
              type="button"
              disabled={pending}
              onClick={() => addAfter(null)}
              className="flex h-10 w-full items-center gap-2 px-3 text-sm font-medium text-ink-blue transition-colors hover:bg-fill2 disabled:opacity-50 max-sm:h-11"
            >
              <Glyph name="plus" size={14} weight={2.2} />
              Add line
              <Kbd className="ml-1 max-sm:hidden">⏎</Kbd>
            </button>
          }
        >
          {lines.map((line, index) => {
            const qty = line.quantity.trim() === "" ? "1" : line.quantity;
            const amount = extendCents(qty, centsOf(line.price));
            const error = lineErrors.get(line.key);
            return (
              <React.Fragment key={line.key}>
                <tr
                  className={stackRow}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.defaultPrevented) return;
                    if ((event.target as HTMLElement).closest("[cmdk-root]") !== null) return;
                    event.preventDefault();
                    addAfter(line.key);
                  }}
                >
                  <GridRowNo n={index + 1} />
                  <GridTd label="Description" className="max-md:order-1 max-md:col-span-6">
                    <Input
                      className={cellField}
                      value={line.description}
                      invalid={error === "Describe what was sold."}
                      placeholder="Hibiscus ginger, case of 12"
                      aria-label={`Description, line ${index + 1}`}
                      disabled={pending}
                      onChange={(e) => patch(line.key, { description: e.target.value })}
                    />
                  </GridTd>
                  <GridTd label="Product" className="max-md:order-2 max-md:col-span-6">
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
                      <SelectTrigger className={cellField} aria-label={`Product, line ${index + 1}`}>
                        <SelectValue placeholder={products.length === 0 ? "No products" : "Product"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>No product</SelectItem>
                        {products.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.hint ? `${p.hint} · ` : ""}
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </GridTd>
                  <GridTd label="Qty" className="max-md:order-3 max-md:col-span-2">
                    <Input
                      numeric
                      inputMode="decimal"
                      className={cellField}
                      value={line.quantity}
                      invalid={scaledQuantity(qty) === null}
                      aria-label={`Quantity, line ${index + 1}`}
                      disabled={pending}
                      onChange={(e) => patch(line.key, { quantity: e.target.value })}
                    />
                  </GridTd>
                  <GridTd label="Price" className="max-md:order-4 max-md:col-span-2">
                    <MoneyInput
                      className={cellField}
                      value={line.price}
                      aria-label={`Unit price, line ${index + 1}`}
                      disabled={pending}
                      onValueChange={(price) => patch(line.key, { price })}
                    />
                  </GridTd>
                  <GridTd label="Discount" className="max-md:order-6 max-md:col-span-3">
                    <MoneyInput
                      className={cellField}
                      value={line.discount}
                      placeholder=""
                      aria-label={`Discount, line ${index + 1}`}
                      disabled={pending}
                      onValueChange={(value) => patch(line.key, { discount: value })}
                    />
                  </GridTd>
                  <GridTd label="Tax" className="max-md:order-7 max-md:col-span-3">
                    <MoneyInput
                      className={cellField}
                      value={line.tax}
                      placeholder=""
                      aria-label={`Sales tax, line ${index + 1}`}
                      disabled={pending}
                      onValueChange={(value) => patch(line.key, { tax: value })}
                    />
                  </GridTd>
                  <GridTd label="Amount" className="bg-fill2/50 max-md:order-5 max-md:col-span-2">
                    <GridFigure>
                      {amount === null || isBlank(line) ? <span className="text-label3">—</span> : <Money cents={amount} plain />}
                    </GridFigure>
                  </GridTd>
                  <GridTd label="Revenue" className="max-md:order-8 max-md:col-span-6">
                    <AccountCombobox
                      accounts={revenueAccounts}
                      value={line.revenueAccountId}
                      disabled={pending}
                      invalid={error === "This customer has no sales channel, so choose the revenue account."}
                      placeholder={defaultAccount ? `${defaultAccount.code} · channel` : "Revenue account"}
                      onChange={(revenueAccountId) => patch(line.key, { revenueAccountId })}
                      className={cellField}
                    />
                  </GridTd>
                  <GridTd className="text-center max-md:order-9 max-md:col-span-6 max-md:in-data-stack:flex max-md:justify-end">
                    <button
                      type="button"
                      aria-label={`Remove line ${index + 1}`}
                      disabled={pending || (lines.length === 1 && isBlank(line))}
                      onClick={() =>
                        setLines((current) => {
                          const rest = current.filter((l) => l.key !== line.key);
                          return rest.length === 0 ? [blankLine()] : rest;
                        })
                      }
                      className="grid size-8 place-items-center rounded-full text-label3 transition-colors hover:bg-fill2 hover:text-ink-red disabled:opacity-30 max-sm:size-11 max-md:flex max-md:h-11 max-md:w-auto max-md:gap-1.5 max-md:px-3 max-md:text-sm max-md:font-medium max-md:text-ink-red"
                    >
                      <Glyph name="minus" size={14} weight={2.2} />
                      <span className="md:hidden">Remove</span>
                    </button>
                  </GridTd>
                </tr>
                {error ? (
                  <tr className="max-md:-mt-1 max-md:mb-2.5 max-md:block">
                    <td className="max-md:hidden" />
                    <td colSpan={9} className="border-b-[0.5px] border-sep px-2.5 py-1.5 text-xs font-medium text-ink-red max-md:block max-md:border-0 max-md:px-3">
                      {error}
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </Grid>

        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <div className="min-w-0 rounded-[12px] bg-inset px-4 py-3.5 max-lg:order-last">
            <p className="mb-2.5 text-xs font-semibold text-label2">Issuing posts</p>
            <FlowDiagram
              from={{ label: customer === null ? "Sales" : (defaultAccount?.name ?? "Sales"), glyph: CATEGORIES.revenue.glyph, tint: CATEGORIES.revenue.tint }}
              to={[{ label: "Receivables", glyph: CATEGORIES.receivables.glyph, tint: CATEGORIES.receivables.tint, cents: totals.totalCents }]}
              className="[&_span.bg-card]:bg-inset"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Totals>
              <TotalRow label="Subtotal">
                <Money cents={totals.subtotalCents} plain />
              </TotalRow>
              <TotalRow label="Invoice discount" htmlFor="inv-discount">
                <MoneyInput id="inv-discount" className="h-7 w-28" value={discount} onValueChange={setDiscount} disabled={pending} />
              </TotalRow>
              <TotalRow label="Shipping" htmlFor="inv-shipping">
                <MoneyInput id="inv-shipping" className="h-7 w-28" value={shipping} onValueChange={setShipping} disabled={pending} />
              </TotalRow>
              <TotalRow label="All discounts">
                <Money cents={-totals.discountCents} plain zeroDash />
              </TotalRow>
              <TotalRow label="Sales tax">
                <Money cents={totals.taxCents} plain zeroDash />
              </TotalRow>
              <TotalRow label="Total" strong>
                <Money cents={totals.totalCents} currency plain />
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
      </FormSection>

      <div className="flex gap-2 rounded-[22px] bg-card p-3 shadow-card md:hidden">{buttons(true)}</div>
    </div>
  );
}

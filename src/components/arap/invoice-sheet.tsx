import * as React from "react";

import { formatCents } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { formatDateUS } from "@/lib/dates";

import { termsLabel } from "./math";
import type { Address, InvoiceDetail } from "./types";

/**
 * The invoice as the buyer receives it — a restaurant's back office, a
 * wholesale buyer's AP clerk. It is the same element on screen and on paper:
 * the print stylesheet below hides the application around it, so the
 * browser's Print → Save as PDF produces the invoice and nothing else.
 *
 * On paper the ink is always black on white, whatever theme the screen is in.
 * A draft or void invoice carries a stamp across it, so a PDF of one can never
 * be mistaken for a bill to pay.
 */
export function InvoiceSheet({
  invoice,
  companyName,
  companyLocation,
}: {
  invoice: InvoiceDetail;
  companyName: string;
  companyLocation: string;
}) {
  const showLineDiscounts = invoice.lines.some((l) => l.discountCents > 0);
  const lineDiscounts = invoice.lines.reduce((sum, l) => sum + l.discountCents, 0);
  const headerDiscount = invoice.discountCents - lineDiscounts;
  const settled = invoice.paidCents + invoice.creditedCents + invoice.deductedCents;
  const stamp =
    invoice.status === "draft" ? "Draft" : invoice.status === "void" ? "Void" : invoice.status === "paid" ? "Paid" : null;
  const terms = termsLabel(invoice.termsDays, invoice.termsDiscountPct, invoice.termsDiscountDays);

  return (
    <article
      className="invoice-sheet relative mx-auto w-full max-w-[52rem] overflow-hidden rounded-md border border-border bg-surface-raised text-foreground shadow-raised"
      aria-label={`Invoice ${invoice.invoiceNo}`}
    >
      <style>{PRINT_CSS}</style>

      {stamp ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span
            className={cn(
              "invoice-stamp -rotate-12 rounded-md border-4 px-6 py-1 text-6xl font-black tracking-[0.2em] uppercase opacity-[0.13] sm:text-8xl",
              stamp === "Paid" ? "border-positive text-positive" : stamp === "Void" ? "border-negative text-negative" : "border-warning text-warning",
            )}
          >
            {stamp}
          </span>
        </div>
      ) : null}

      <div className="relative flex flex-col gap-8 px-5 py-7 sm:px-10 sm:py-10">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-2xl leading-none font-semibold tracking-tight">{companyName}</p>
            <p className="mt-1.5 text-xs text-muted-foreground">{companyLocation}</p>
          </div>
          <div className="sm:text-right">
            <p className="eyebrow">Invoice</p>
            <p className="num text-2xl leading-tight font-semibold">{invoice.invoiceNo}</p>
          </div>
        </header>

        <div className="grid gap-6 sm:grid-cols-[1fr_auto]">
          <div className="grid gap-6 sm:grid-cols-2">
            <PartyBlock label="Bill to" name={invoice.customerName} address={invoice.billingAddress} email={invoice.customerEmail} />
            {invoice.shippingAddress ? (
              <PartyBlock label="Ship to" name={invoice.customerName} address={invoice.shippingAddress} email={null} />
            ) : null}
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1 self-start text-sm">
            <dt className="text-muted-foreground">Invoice date</dt>
            <dd className="num text-right">{formatDateUS(invoice.invoiceDate)}</dd>
            <dt className="text-muted-foreground">Due date</dt>
            <dd className="num text-right font-semibold">{formatDateUS(invoice.dueDate)}</dd>
            <dt className="text-muted-foreground">Terms</dt>
            <dd className="text-right">{terms}</dd>
            {invoice.poNumber ? (
              <>
                <dt className="text-muted-foreground">PO number</dt>
                <dd className="num text-right">{invoice.poNumber}</dd>
              </>
            ) : null}
          </dl>
        </div>

        <div className="relative -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[30rem] border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <SheetTh className="min-w-44">Description</SheetTh>
                <SheetTh align="right" className="w-20">
                  Qty
                </SheetTh>
                <SheetTh align="right" className="w-28">
                  Unit price
                </SheetTh>
                {showLineDiscounts ? (
                  <SheetTh align="right" className="w-24">
                    Discount
                  </SheetTh>
                ) : null}
                <SheetTh align="right" className="w-32">
                  Amount
                </SheetTh>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.lineNo} className="align-top">
                  <td className="rule-row py-2 pr-3">
                    {line.description}
                    {line.productLabel ? (
                      <span className="num block text-2xs text-muted-foreground">{line.productLabel.split(" · ")[0]}</span>
                    ) : null}
                  </td>
                  <td className="rule-row num py-2 pl-3 text-right">{trimQuantity(line.quantity)}</td>
                  <td className="rule-row num py-2 pl-3 text-right">{formatCents(line.unitPriceCents)}</td>
                  {showLineDiscounts ? (
                    <td className="rule-row num py-2 pl-3 text-right">
                      {line.discountCents > 0 ? `(${formatCents(line.discountCents)})` : ""}
                    </td>
                  ) : null}
                  <td className="rule-row num py-2 pl-3 text-right">
                    {formatCents(line.amountCents - line.discountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-sm text-sm">
            {invoice.memo ? <p className="whitespace-pre-line">{invoice.memo}</p> : null}
            {invoice.termsDiscountDays > 0 && Number(invoice.termsDiscountPct) > 0 && invoice.status !== "paid" ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Take {invoice.termsDiscountPct.replace(/\.?0+$/, "")}% off if paid within {invoice.termsDiscountDays} days of
                the invoice date.
              </p>
            ) : null}
          </div>
          <dl className="grid w-full max-w-xs grid-cols-[1fr_auto] gap-y-1 text-sm sm:w-72 [&>dd]:pl-6">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="num text-right">{formatCents(invoice.subtotalCents - lineDiscounts)}</dd>
            {headerDiscount > 0 ? (
              <>
                <dt className="text-muted-foreground">Discount</dt>
                <dd className="num text-right">({formatCents(headerDiscount)})</dd>
              </>
            ) : null}
            {invoice.shippingCents > 0 ? (
              <>
                <dt className="text-muted-foreground">Shipping</dt>
                <dd className="num text-right">{formatCents(invoice.shippingCents)}</dd>
              </>
            ) : null}
            {invoice.taxCents > 0 ? (
              <>
                <dt className="text-muted-foreground">Sales tax</dt>
                <dd className="num text-right">{formatCents(invoice.taxCents)}</dd>
              </>
            ) : null}
            <dt className="rule-subtotal pt-1.5 font-semibold">Total</dt>
            <dd className="num rule-subtotal pt-1.5 text-right font-semibold">{formatCents(invoice.totalCents, { currency: true })}</dd>
            {settled > 0 && invoice.status !== "void" ? (
              <>
                <dt className="text-muted-foreground">Paid and credited</dt>
                <dd className="num text-right">({formatCents(settled)})</dd>
              </>
            ) : null}
            <dt className="rule-subtotal pt-1.5 text-base font-semibold">Balance due</dt>
            <dd className="num rule-subtotal rule-total pt-1.5 pb-0.5 text-right text-base font-semibold">
              {formatCents(invoice.status === "void" ? 0 : invoice.balanceCents, { currency: true })}
            </dd>
          </dl>
        </div>

        <footer className="rule-subtotal flex flex-wrap justify-between gap-2 pt-3 text-xs text-muted-foreground">
          <span>
            Please reference <span className="num text-foreground">{invoice.invoiceNo}</span> with your payment.
          </span>
          <span>Thank you for your business.</span>
        </footer>
      </div>
    </article>
  );
}

function PartyBlock({
  label,
  name,
  address,
  email,
}: {
  label: string;
  name: string;
  address: Address | null;
  email: string | null;
}) {
  const cityLine = address ? [address.city, [address.state, address.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  return (
    <div className="min-w-0 text-sm">
      <p className="eyebrow mb-1">{label}</p>
      <p className="font-semibold">{name}</p>
      {address?.line1 ? <p>{address.line1}</p> : null}
      {address?.line2 ? <p>{address.line2}</p> : null}
      {cityLine ? <p>{cityLine}</p> : null}
      {email ? <p className="text-muted-foreground">{email}</p> : null}
    </div>
  );
}

function SheetTh({
  children,
  align = "left",
  className,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head pb-1.5 text-2xs font-semibold tracking-wider text-muted-foreground uppercase",
        align === "right" ? "pl-3 text-right" : "pr-3 text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

/** "12.0000" → "12", "2.5000" → "2.5". */
function trimQuantity(quantity: string): string {
  return quantity.includes(".") ? quantity.replace(/\.?0+$/, "") : quantity;
}

/**
 * Print: show only the sheet, on white, at letter size. The application shell
 * is a fixed-height flex column that scrolls inside `main`; on paper that
 * clipping has to go, or a long invoice would be cut at one page.
 */
const PRINT_CSS = `
@media print {
  @page { size: letter; margin: 0.55in; }
  html, body { background: #fff !important; height: auto !important; overflow: visible !important; }
  body * { visibility: hidden !important; }
  .invoice-sheet, .invoice-sheet * { visibility: visible !important; }
  .h-dvh, #main, #main * { height: auto !important; overflow: visible !important; max-height: none !important; }
  .invoice-sheet {
    position: absolute !important; left: 0; top: 0; width: 100% !important; max-width: none !important;
    border: 0 !important; box-shadow: none !important; border-radius: 0 !important;
    background: #fff !important; color: #111 !important;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .invoice-sheet > div { padding: 0 !important; }
  .invoice-sheet .text-muted-foreground, .invoice-sheet .eyebrow { color: #555 !important; }
  .invoice-sheet .text-foreground { color: #111 !important; }
  .invoice-sheet .rule-row { border-bottom-color: #ddd !important; }
  .invoice-sheet .rule-head, .invoice-sheet .rule-subtotal { border-color: #999 !important; }
  .invoice-sheet .rule-total { border-bottom-color: #555 !important; }
  .invoice-sheet tr { break-inside: avoid; }
}
`;

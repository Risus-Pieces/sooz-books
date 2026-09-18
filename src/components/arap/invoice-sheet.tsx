import * as React from "react";

import { formatCents } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { initials, mediumDate } from "@/lib/ui/format";

import { termsLabel } from "./math";
import type { Address, InvoiceDetail } from "./types";

/**
 * The invoice as the buyer receives it — a restaurant's back office, a wholesale buyer's AP clerk.
 * It is the same element on screen and on paper: the print stylesheet below hides the application
 * around it, so the browser's Print → Save as PDF produces the invoice and nothing else.
 *
 * On paper the ink is always black on white, whatever appearance the screen is in. A draft or void
 * invoice carries a stamp across it, so a PDF of one can never be mistaken for a bill to pay.
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
  const balance = invoice.status === "void" ? 0 : invoice.balanceCents;

  return (
    <article
      className="invoice-sheet relative mx-auto w-full max-w-[52rem] overflow-hidden rounded-2xl bg-card text-label shadow-card max-sm:rounded-[22px]"
      aria-label={`Invoice ${invoice.invoiceNo}`}
    >
      <style>{PRINT_CSS}</style>

      {stamp ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span
            className={cn(
              "invoice-stamp -rotate-[14deg] rounded-[18px] border-[5px] px-7 py-1 text-6xl font-bold tracking-[0.18em] uppercase opacity-[0.12] sm:text-8xl",
              stamp === "Paid" ? "border-tint-green text-tint-green" : stamp === "Void" ? "border-tint-red text-tint-red" : "border-tint-orange text-tint-orange",
            )}
          >
            {stamp}
          </span>
        </div>
      ) : null}

      <div className="relative flex flex-col gap-9 px-12 pt-11 pb-10 max-sm:gap-7 max-sm:px-5 max-sm:pt-7 max-sm:pb-6">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex min-w-0 items-center gap-3.5">
            <span
              aria-hidden
              className="inv-mark grid size-12 shrink-0 place-items-center rounded-[13px] bg-[linear-gradient(160deg,color-mix(in_srgb,var(--pink)_80%,#fff),var(--pink))] text-lg font-bold tracking-[-0.02em] text-white"
            >
              {initials(companyName).slice(0, 1) || "S"}
            </span>
            <div className="min-w-0">
              <p className="text-xl leading-tight font-semibold tracking-[-0.015em]">{companyName}</p>
              <p className="inv-quiet mt-0.5 text-sm text-label2">{companyLocation}</p>
            </div>
          </div>
          <div className="sm:text-right">
            <p className="text-[2rem] leading-none font-semibold tracking-[-0.03em]">Invoice</p>
            <p className="num inv-quiet mt-1.5 text-sm font-medium text-label2">{invoice.invoiceNo}</p>
          </div>
        </header>

        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="grid gap-5 sm:grid-cols-2">
            <PartyBlock label="Billed to" name={invoice.customerName} address={invoice.billingAddress} email={invoice.customerEmail} />
            {invoice.shippingAddress ? (
              <PartyBlock label="Ship to" name={invoice.customerName} address={invoice.shippingAddress} email={null} />
            ) : null}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 self-start text-sm">
            <Meta label="Issued" value={mediumDate(invoice.invoiceDate)} />
            <Meta label="Due" value={mediumDate(invoice.dueDate)} strong />
            <Meta label="Terms" value={terms} />
            {invoice.poNumber ? <Meta label="PO" value={invoice.poNumber} /> : null}
          </dl>
        </div>

        <div className="relative">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <SheetTh className="min-w-44">Description</SheetTh>
                <SheetTh align="right" className="w-16 max-sm:hidden">
                  Qty
                </SheetTh>
                <SheetTh align="right" className="w-28 max-sm:hidden">
                  Price
                </SheetTh>
                {showLineDiscounts ? (
                  <SheetTh align="right" className="w-24 max-sm:hidden">
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
                  <td className="inv-row py-3 pr-3">
                    <span className="font-medium">{line.description}</span>
                    {line.productLabel ? (
                      <span className="num inv-quiet block text-xs text-label2">{line.productLabel.split(" · ")[0]}</span>
                    ) : null}
                    <span className="num inv-quiet block text-xs text-label2 sm:hidden">
                      {trimQuantity(line.quantity)} × {formatCents(line.unitPriceCents)}
                      {line.discountCents > 0 ? ` − ${formatCents(line.discountCents)}` : ""}
                    </span>
                  </td>
                  <td className="inv-row num py-3 pl-3 text-right max-sm:hidden">{trimQuantity(line.quantity)}</td>
                  <td className="inv-row num py-3 pl-3 text-right max-sm:hidden">{formatCents(line.unitPriceCents)}</td>
                  {showLineDiscounts ? (
                    <td className="inv-row num py-3 pl-3 text-right max-sm:hidden">
                      {line.discountCents > 0 ? `−${formatCents(line.discountCents)}` : ""}
                    </td>
                  ) : null}
                  <td className="inv-row num py-3 pl-3 text-right font-medium">
                    {formatCents(line.amountCents - line.discountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-8">
          <div className="max-w-sm text-sm">
            {invoice.memo ? <p className="whitespace-pre-line">{invoice.memo}</p> : null}
            {invoice.termsDiscountDays > 0 && Number(invoice.termsDiscountPct) > 0 && invoice.status !== "paid" ? (
              <p className="inv-quiet mt-2 text-xs text-label2">
                Take {invoice.termsDiscountPct.replace(/\.?0+$/, "")}% off if paid within {invoice.termsDiscountDays} days of
                the invoice date.
              </p>
            ) : null}
          </div>
          <div className="flex w-full max-w-xs flex-col gap-3 sm:w-80">
            <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm [&>dd]:pl-6">
              <dt className="inv-quiet text-label2">Subtotal</dt>
              <dd className="num text-right">{formatCents(invoice.subtotalCents - lineDiscounts)}</dd>
              {headerDiscount > 0 ? (
                <>
                  <dt className="inv-quiet text-label2">Discount</dt>
                  <dd className="num text-right">−{formatCents(headerDiscount)}</dd>
                </>
              ) : null}
              {invoice.shippingCents > 0 ? (
                <>
                  <dt className="inv-quiet text-label2">Shipping</dt>
                  <dd className="num text-right">{formatCents(invoice.shippingCents)}</dd>
                </>
              ) : null}
              {invoice.taxCents > 0 ? (
                <>
                  <dt className="inv-quiet text-label2">Sales tax</dt>
                  <dd className="num text-right">{formatCents(invoice.taxCents)}</dd>
                </>
              ) : null}
              <dt className="inv-rule-top mt-1 pt-2 font-semibold">Total</dt>
              <dd className="num inv-rule-top mt-1 pt-2 text-right font-semibold">{formatCents(invoice.totalCents, { currency: true })}</dd>
              {settled > 0 && invoice.status !== "void" ? (
                <>
                  <dt className="inv-quiet text-label2">Paid and credited</dt>
                  <dd className="num text-right">−{formatCents(settled)}</dd>
                </>
              ) : null}
            </dl>
            <dl className="inv-due flex items-baseline justify-between gap-4 rounded-[12px] bg-inset px-4 py-3">
              <dt className="text-sm font-semibold">Balance due</dt>
              <dd className="num text-2xl font-bold tracking-[-0.02em]">{formatCents(balance, { currency: true })}</dd>
            </dl>
          </div>
        </div>

        <footer className="inv-rule-top inv-quiet flex flex-wrap justify-between gap-2 pt-4 text-xs text-label2">
          <span>
            Please reference <span className="num font-medium text-label">{invoice.invoiceNo}</span> with your payment.
          </span>
          <span>Thank you for your business.</span>
        </footer>
      </div>
    </article>
  );
}

function Meta({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="inv-quiet text-xs font-medium text-label2">{label}</dt>
      <dd className={cn("num mt-0.5", strong && "font-semibold")}>{value}</dd>
    </div>
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
    <div className="min-w-0 text-sm leading-relaxed">
      <p className="inv-quiet mb-0.5 text-xs font-medium text-label2">{label}</p>
      <p className="font-semibold">{name}</p>
      {address?.line1 ? <p>{address.line1}</p> : null}
      {address?.line2 ? <p>{address.line2}</p> : null}
      {cityLine ? <p>{cityLine}</p> : null}
      {email ? <p className="inv-quiet text-label2">{email}</p> : null}
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
        "inv-head inv-quiet pb-2 text-xs font-medium text-label2",
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
 * On screen: hairlines in the separator colour. On paper: show only the sheet, black on white, at
 * letter size. The sticky shell must not clip it, or a long invoice would be cut at one page.
 */
const PRINT_CSS = `
.invoice-sheet .inv-row { border-bottom: 0.5px solid var(--sep); }
.invoice-sheet .inv-head { border-bottom: 0.5px solid var(--sep-strong); }
.invoice-sheet .inv-rule-top { border-top: 0.5px solid var(--sep-strong); }
@media print {
  @page { size: letter; margin: 0.55in; }
  html, body { background: #fff !important; height: auto !important; overflow: visible !important; }
  body * { visibility: hidden !important; }
  .invoice-sheet, .invoice-sheet * { visibility: visible !important; }
  .min-h-dvh, .h-dvh, #main, #main * { height: auto !important; min-height: 0 !important; overflow: visible !important; max-height: none !important; }
  .invoice-sheet {
    position: absolute !important; left: 0; top: 0; width: 100% !important; max-width: none !important;
    border: 0 !important; box-shadow: none !important; border-radius: 0 !important;
    background: #fff !important; color: #111 !important;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .invoice-sheet > div { padding: 0 !important; }
  .invoice-sheet .inv-quiet { color: #6e6e73 !important; }
  .invoice-sheet .text-label { color: #111 !important; }
  .invoice-sheet .inv-row { border-bottom: 0.5px solid #d2d2d7 !important; }
  .invoice-sheet .inv-head, .invoice-sheet .inv-rule-top { border-color: #86868b !important; }
  .invoice-sheet .inv-due { background: #f5f5f7 !important; }
  .invoice-sheet tr { break-inside: avoid; }
}
`;

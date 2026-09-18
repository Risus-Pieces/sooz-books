import * as React from "react";
import Link from "next/link";

import { Glyph } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { cn } from "@/lib/cn";
import type { GlyphName } from "@/lib/ui/glyphs";
import type { Tint } from "@/lib/ui/tints";

const STEPS: { title: string; body: string; href: string; glyph: GlyphName; tint: Tint }[] = [
  {
    title: "Plan",
    body: "Agree the deal with the distributor: products, units, the allowance per unit and any fixed fee. Record the deal number they will quote.",
    href: "/trade/promotions/new",
    glyph: "calendar",
    tint: "gray",
  },
  {
    title: "Accrue",
    body: "Each month of the ship window books its share to contra revenue and 2120 Accrued Trade Spend, so the cost lands with the sales, not months later.",
    href: "/trade/promotions",
    glyph: "hourglass",
    tint: "cyan",
  },
  {
    title: "Import",
    body: "The distributor pays short and sends a remittance. Each payment is split before it posts: cash, AR relieved at full gross, trade spend, and claims to dispute.",
    href: "/trade/remittances",
    glyph: "import",
    tint: "blue",
  },
  {
    title: "Resolve",
    body: "Validate what the distributor was owed, dispute what it was not before the window closes, then record the recovery or write it off.",
    href: "/trade/deductions",
    glyph: "flag",
    tint: "orange",
  },
];

/** The four steps a distributor's money goes through, as four badges joined by arrows. */
export function TradeWorkflow({ className }: { className?: string }) {
  return (
    <section aria-labelledby="trade-flow" className={cn("rounded-2xl bg-card px-5 pt-[18px] pb-5 shadow-card max-md:rounded-[22px] max-md:p-4", className)}>
      <h2 id="trade-flow" className="mb-4 flex items-center gap-1 text-lg font-semibold tracking-[-0.01em]">
        How it flows
        <InfoButton label="About the trade flow" align="start">
          <p>Sooz has no distributor yet. When the first one signs, this is the order things happen in.</p>
          {STEPS.map((s, i) => (
            <p key={s.title}>
              <b>
                {i + 1}. {s.title}.
              </b>{" "}
              {s.body}
            </p>
          ))}
        </InfoButton>
      </h2>
      <ol className="flex items-start justify-between gap-2 max-sm:flex-col max-sm:gap-0">
        {STEPS.map((step, index) => (
          <React.Fragment key={step.title}>
            {index > 0 ? (
              <li aria-hidden className="mt-4 flex-1 max-sm:mt-0 max-sm:ml-[21px] max-sm:h-4 max-sm:flex-none max-sm:border-l-[1.5px] max-sm:border-label3">
                <span className="relative block border-t-[1.5px] border-label3 max-sm:hidden">
                  <span className="absolute -top-[5.5px] right-0 border-y-[4.5px] border-l-8 border-y-transparent border-l-label3" />
                </span>
              </li>
            ) : null}
            <li>
              <Link href={step.href} className="flex flex-col items-center gap-1.5 rounded-[12px] px-2 py-1 outline-none focus-ring hover:bg-fill2 focus-visible:bg-fill2 max-sm:min-h-11 max-sm:flex-row max-sm:gap-3 max-sm:px-0">
                <IconBadge glyph={step.glyph} tint={step.tint} size="xl" />
                <span className="text-sm font-semibold">
                  <span className="num mr-1 text-label2">{index + 1}</span>
                  {step.title}
                </span>
                <Glyph name="chevron-right" size={12} weight={2.4} className="text-label3 sm:hidden" />
              </Link>
            </li>
          </React.Fragment>
        ))}
      </ol>
    </section>
  );
}

const COLUMNS: { name: string; note: string }[] = [
  { name: "payment_number", note: "One payment is one entry." },
  { name: "payment_date · payment_total", note: "The cash, and when." },
  { name: "line_type", note: "INVOICE, DEDUCTION, CREDIT, DISCOUNT or REPAYMENT." },
  { name: "reference_invoice_number", note: "The Sooz invoice it settles or shorts." },
  { name: "reason_code · description", note: "KeHE prefixes like H or IA, UNFI codes like MCB or 01." },
  { name: "deal_number", note: "Ties a promotion deduction to its accrual." },
  { name: "line_amount", note: "Signed: negative is money kept." },
];

/**
 * What a remittance file is and where each distributor keeps it. Sentences, so it lives in the
 * Import sheet's ⓘ popover.
 */
export function RemittanceFileGuide() {
  return (
    <div className="flex max-w-[340px] flex-col gap-2 text-sm">
      <p>One row per invoice paid and per amount taken off it. The lines must add up to the payment, or it is held for review.</p>
      <p>
        <b>KeHE</b> — CONNECT Supplier → Deductions → export open and closed deductions at the deduction-detail level.
      </p>
      <p>
        <b>UNFI</b> — myUNFI → Dispute Center → Advanced Search, status all, one region at a time, overlapping the last export by a week.
      </p>
      <p className="text-label2">CSV or XLSX, up to 950 KB. PDFs and EDI 820/812 are not read yet.</p>
      <dl className="mt-1 flex flex-col">
        {COLUMNS.map((c) => (
          <div key={c.name} className="flex flex-col hairline-t py-1">
            <dt className="num text-xs font-semibold">{c.name}</dt>
            <dd className="text-xs text-label2">{c.note}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

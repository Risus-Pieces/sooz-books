import * as React from "react";
import Link from "next/link";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/cn";

const STEPS = [
  {
    title: "Plan the promotion",
    body: "Agree the deal with the distributor: products, units, the allowance per unit and any fixed fee. Record the deal number they will quote.",
    href: "/trade/promotions/new",
    link: "New promotion",
  },
  {
    title: "Accrue it monthly",
    body: "Each month of the ship window books its share to contra revenue and 2120 Accrued Trade Spend, so the cost lands with the sales, not months later.",
    href: "/trade/promotions",
    link: "Promotions",
  },
  {
    title: "Import the remittance",
    body: "The distributor pays short and sends a remittance. Each payment is split before it posts: cash, AR relieved at full gross, trade spend, and claims to dispute.",
    href: "/trade/remittances",
    link: "Remittances",
  },
  {
    title: "Work the deductions",
    body: "Validate what the distributor was owed, dispute what it was not before the window closes, then record the recovery or write it off.",
    href: "/trade/deductions",
    link: "Deductions",
  },
] as const;

/** The four steps a distributor's money goes through, in order. */
export function TradeWorkflow({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>How distributor money reaches the books</CardTitle>
          <CardDescription>Sooz has no distributor yet. When the first one signs, this is the order things happen in.</CardDescription>
        </div>
      </CardHeader>
      <ol className="grid md:grid-cols-2 xl:grid-cols-4">
        {STEPS.map((step, index) => (
          <li
            key={step.title}
            className={cn(
              "flex flex-col gap-1.5 border-border px-4 py-3.5",
              index > 0 && "border-t md:border-t-0",
              index % 2 === 1 && "md:border-l",
              index >= 2 && "md:border-t xl:border-t-0",
              index > 0 && "xl:border-l",
            )}
          >
            <p className="flex items-baseline gap-2">
              <span className="num text-xs text-primary">{index + 1}</span>
              <span className="text-sm font-semibold text-foreground">{step.title}</span>
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">{step.body}</p>
            <Link href={step.href} className="mt-auto pt-1 text-xs font-medium text-primary underline decoration-primary/35 underline-offset-4 hover:decoration-primary max-sm:py-3">
              {step.link}
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

const COLUMNS: { name: string; note: string }[] = [
  { name: "payment_number", note: "The ACH or check number. One payment is one entry." },
  { name: "payment_date · payment_total", note: "The cash that reached the bank, and when." },
  { name: "line_type", note: "INVOICE, DEDUCTION, CREDIT, DISCOUNT or REPAYMENT." },
  { name: "reference_invoice_number", note: "Which Sooz invoice the line settles or shorts." },
  { name: "reason_code · description", note: "KeHE prefixes like H or IA, UNFI codes like MCB or 01." },
  { name: "deal_number", note: "Ties a promotion deduction to its accrual." },
  { name: "line_amount", note: "Signed: negative is money the distributor kept." },
];

/** What a remittance file is, and where each distributor keeps it. */
export function RemittanceFileGuide({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>What a distributor sends</CardTitle>
          <CardDescription>
            A remittance advice: one row per invoice paid and per amount taken off it. The lines must add up to the payment, or it is held for review.
          </CardDescription>
        </div>
      </CardHeader>
      <div className="grid gap-0 lg:grid-cols-[1.2fr_1fr]">
        <dl className="flex flex-col px-4 py-3">
          {COLUMNS.map((c) => (
            <div key={c.name} className="grid grid-cols-1 gap-x-4 rule-row py-1.5 sm:grid-cols-[13rem_1fr]">
              <dt className="num text-xs break-words text-foreground">{c.name}</dt>
              <dd className="text-xs text-muted-foreground">{c.note}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-3 border-t border-border px-4 py-3 lg:border-t-0 lg:border-l">
          <div>
            <p className="eyebrow mb-1">KeHE</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              KeHE CONNECT Supplier → Deductions → export open <em>and</em> closed deductions at the deduction-detail level. A closed one that was won comes back later as a repayment line.
            </p>
          </div>
          <div>
            <p className="eyebrow mb-1">UNFI</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              myUNFI → Dispute Center → Advanced Search, status all, one region at a time, overlapping the last export by a week. The 30-day Activity Center view misses rows.
            </p>
          </div>
          <div>
            <p className="eyebrow mb-1">Accepted</p>
            <p className="text-xs leading-relaxed text-muted-foreground">CSV or XLSX, up to 950 KB. PDFs and EDI 820/812 files are not read yet.</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

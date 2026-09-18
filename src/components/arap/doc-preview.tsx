import * as React from "react";
import Link from "next/link";

import { FlowDiagram, SplitBar } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DetailPane } from "@/components/ui/detail-pane";
import { Glyph } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { categoryForCode } from "@/lib/ui/categories";
import { dollars, mediumDate } from "@/lib/ui/format";

import { DocStatusPill } from "./doc-status";
import { billFlow, invoiceFlow, splitAccountLabel } from "./flows";
import { termsLabel } from "./math";
import type { BillDetail, InvoiceDetail } from "./types";

/** "12.0000" → "12". */
export function trimQuantity(quantity: string): string {
  return quantity.includes(".") ? quantity.replace(/\.?0+$/, "") : quantity;
}

/** Paid against open, as one bar with its two figures. */
export function SettledBar({
  settledCents,
  openCents,
  labels = ["Settled", "Open"],
}: {
  settledCents: number;
  openCents: number;
  /** The two halves' words: "Settled"/"Open" for a document, "Applied"/"Credit" for money received. */
  labels?: [string, string];
}) {
  const [done, left] = labels;
  return (
    <div className="flex flex-col gap-2">
      <SplitBar
        label={`${done} ${dollars(settledCents)}, ${left.toLowerCase()} ${dollars(openCents)}`}
        segments={[
          { label: done, value: settledCents, tint: "green" },
          { label: left, value: openCents, tint: "orange" },
        ]}
      />
      <div aria-hidden className="flex justify-between gap-3 text-xs font-medium text-label2">
        <span className="inline-flex items-center gap-1.5">
          <Dot tint="green" size={7} />
          {done} <Money cents={settledCents} currency plain className="text-label" />
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Dot tint="orange" size={7} />
          {left} <Money cents={openCents} currency plain className="text-label" />
        </span>
      </div>
    </div>
  );
}

/** The flow a document posts (or will post), on its own card. */
export function FlowCard({ flow, caption }: { flow: ReturnType<typeof invoiceFlow>; caption?: string }) {
  return (
    <Card className="px-5 py-[18px] max-sm:px-4">
      {caption ? <p className="mb-2.5 text-xs font-semibold text-label2">{caption}</p> : null}
      <FlowDiagram from={flow.from} to={flow.to} />
    </Card>
  );
}

/** The selected invoice beside the register: its facts, what it posts, one next step. */
export function InvoicePreview({
  invoice,
  daysOverdue,
  canManage,
}: {
  invoice: InvoiceDetail;
  daysOverdue: number;
  canManage: boolean;
}) {
  const open = invoice.status === "open" || invoice.status === "partial";
  const settled = invoice.paidCents + invoice.creditedCents + invoice.deductedCents;
  const page = `/sales/invoices/${invoice.id}`;
  return (
    <DetailPane
      leading={<Monogram name={invoice.customerName} size="lg" />}
      title={invoice.customerName}
      meta={[<span key="no" className="num">{invoice.invoiceNo}</span>, mediumDate(invoice.invoiceDate)]}
      amount={<Money cents={invoice.totalCents} currency plain />}
      status={<DocStatusPill status={invoice.status} daysOverdue={daysOverdue} />}
      actions={
        <>
          {canManage && open ? (
            <Button asChild>
              <Link href={`/sales/receipts/new?customer=${invoice.customerId}&invoice=${invoice.id}`}>
                <Glyph name="arrow-in" size={15} />
                Record payment
              </Link>
            </Button>
          ) : null}
          <Button asChild variant={canManage && open ? "secondary" : "default"}>
            <Link href={page}>{invoice.status === "draft" ? "Open draft" : "Open invoice"}</Link>
          </Button>
        </>
      }
    >
      {open ? (
        <Card className="px-5 py-4 max-sm:px-4">
          <SettledBar settledCents={settled} openCents={invoice.balanceCents} />
        </Card>
      ) : null}
      <InsetGroup>
        <GroupRow label="Due">
          <span className={daysOverdue > 0 ? "text-ink-red" : undefined}>{mediumDate(invoice.dueDate)}</span>
        </GroupRow>
        <GroupRow label="Terms">{termsLabel(invoice.termsDays, invoice.termsDiscountPct, invoice.termsDiscountDays)}</GroupRow>
        {invoice.poNumber ? (
          <GroupRow label="PO">
            <span className="num">{invoice.poNumber}</span>
          </GroupRow>
        ) : null}
        {invoice.journalEntryId ? (
          <GroupRow label="Ledger" href={`/ledger/${invoice.journalEntryId}`}>
            <span className="num">Entry #{invoice.journalEntryNo}</span>
          </GroupRow>
        ) : null}
      </InsetGroup>
      {invoice.status !== "void" ? (
        <FlowCard flow={invoiceFlow(invoice)} caption={invoice.status === "draft" ? "Issuing posts" : "Posted"} />
      ) : null}
      <InsetGroup header="Lines">
        {invoice.lines.map((line) => (
          <GroupRow
            key={line.lineNo}
            label={
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{line.description}</span>
                <span className="num text-xs font-normal text-label2">
                  {trimQuantity(line.quantity)} × {dollars(line.unitPriceCents)}
                </span>
              </span>
            }
          >
            <Money cents={line.amountCents - line.discountCents} currency plain className="text-label" />
          </GroupRow>
        ))}
      </InsetGroup>
    </DetailPane>
  );
}

/** The selected bill beside the register. */
export function BillPreview({
  bill,
  daysOverdue,
  canPay,
}: {
  bill: BillDetail;
  daysOverdue: number;
  canPay: boolean;
}) {
  const open = bill.status === "open" || bill.status === "partial";
  const settled = bill.paidCents + bill.creditedCents;
  const page = `/purchases/bills/${bill.id}`;
  return (
    <DetailPane
      leading={<Monogram name={bill.vendorName} size="lg" />}
      title={bill.vendorName}
      meta={[<span key="no" className="num">{bill.billNo}</span>, mediumDate(bill.billDate)]}
      amount={<Money cents={bill.totalCents} currency plain />}
      status={<DocStatusPill status={bill.status} daysOverdue={daysOverdue} />}
      actions={
        <>
          {canPay && open ? (
            <Button asChild>
              <Link href={`/purchases/payments/new?vendor=${bill.vendorId}&bill=${bill.id}`}>
                <Glyph name="dollar" size={15} />
                Pay bill
              </Link>
            </Button>
          ) : null}
          <Button asChild variant={canPay && open ? "secondary" : "default"}>
            <Link href={page}>{bill.status === "draft" ? "Open draft" : "Open bill"}</Link>
          </Button>
        </>
      }
    >
      {open ? (
        <Card className="px-5 py-4 max-sm:px-4">
          <SettledBar settledCents={settled} openCents={bill.balanceCents} />
        </Card>
      ) : null}
      <InsetGroup>
        <GroupRow label="Due">
          <span className={daysOverdue > 0 ? "text-ink-red" : undefined}>{mediumDate(bill.dueDate)}</span>
        </GroupRow>
        <GroupRow label="Terms">{termsLabel(bill.termsDays)}</GroupRow>
        {bill.inventoryCents > 0 ? (
          <GroupRow label="Inventory">
            <Money cents={bill.inventoryCents} currency plain />
          </GroupRow>
        ) : null}
        {bill.journalEntryId ? (
          <GroupRow label="Ledger" href={`/ledger/${bill.journalEntryId}`}>
            <span className="num">Entry #{bill.journalEntryNo}</span>
          </GroupRow>
        ) : null}
      </InsetGroup>
      {bill.status !== "void" ? (
        <FlowCard flow={billFlow(bill)} caption={bill.status === "draft" ? "Approving posts" : "Posted"} />
      ) : null}
      <InsetGroup header="Lines" separatorInset={34}>
        {bill.lines.map((line) => (
          <BillLineRow key={line.lineNo} line={line} />
        ))}
      </InsetGroup>
    </DetailPane>
  );
}

function BillLineRow({ line }: { line: BillDetail["lines"][number] }) {
  const { code, name } = splitAccountLabel(line.accountLabel);
  const category = categoryForCode(code);
  return (
    <div className="relative flex min-h-[46px] items-center gap-2.5 px-4 py-2 before:absolute before:top-0 before:right-0 before:left-[var(--sep-inset)] before:border-t-[0.5px] before:border-sep first:before:hidden">
      <Dot tint={category.tint} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium max-sm:text-lg max-sm:font-normal">{line.description}</span>
        <span className="truncate text-xs text-label2 max-sm:text-sm">
          {name}
          {line.quantity !== null && line.unitCostCents !== null
            ? ` · ${trimQuantity(line.quantity)} × ${dollars(line.unitCostCents)}`
            : ""}
        </span>
      </span>
      <Money cents={line.amountCents} currency plain className="text-sm font-semibold max-sm:text-lg" />
    </div>
  );
}


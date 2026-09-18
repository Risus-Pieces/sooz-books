import * as React from "react";

import { Glyph } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { InsetGroup, ListRow } from "@/components/ui/inset-group";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";
import { today } from "@/lib/dates";
import { monthLong, shortDate } from "@/lib/ui/format";

import { docStatusLabel, docStatusTint } from "./doc-status";
import {
  PAYMENT_METHOD_LABELS,
  type BillListRow,
  type InvoiceListRow,
  type PaymentListRow,
  type ReceiptListRow,
} from "./types";

/** "September", or "May 2025" outside the current year. */
function monthHeader(date: string, currentYear: string): string {
  const [year, month] = date.split("-");
  const name = monthLong(Number(month));
  return year === currentYear ? name : `${name} ${year}`;
}

/** Rows in date order, cut into months. */
function byMonth<T>(rows: readonly T[], dateOf: (row: T) => string): { key: string; date: string; rows: T[] }[] {
  const groups: { key: string; date: string; rows: T[] }[] = [];
  for (const row of rows) {
    const date = dateOf(row);
    const key = date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, date, rows: [row] });
  }
  return groups;
}

interface ListProps<T> {
  rows: readonly T[];
  /** Month sections (a register) or one plain group (a short list on an overview). */
  grouped?: boolean;
  /** The heading of the single group when not grouped. */
  header?: React.ReactNode;
  headerAccessory?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  /**
   * The master list beside a detail pane: rows sit on the pane (plain), link to `selectHref`, and
   * the selected one is filled. Without it, rows are inset cards that open the document's page.
   */
  select?: { selectedId: string | null; href: (id: string) => string };
}

interface RowOptions {
  href: string;
  selected: boolean;
}

function Sections<T extends { id: string }>({
  rows,
  grouped = true,
  header,
  headerAccessory,
  footer,
  className,
  select,
  dateOf,
  pageHref,
  row,
}: ListProps<T> & {
  dateOf: (row: T) => string;
  pageHref: (id: string) => string;
  row: (row: T, options: RowOptions) => React.ReactNode;
}) {
  const variant = select ? "plain" : "inset";
  const inset = select ? 57 : 63;
  const render = (r: T) =>
    row(r, select ? { href: select.href(r.id), selected: select.selectedId === r.id } : { href: pageHref(r.id), selected: false });
  if (!grouped) {
    return (
      <InsetGroup variant={variant} header={header} headerAccessory={headerAccessory} footer={footer} separatorInset={inset} className={className}>
        {rows.map(render)}
      </InsetGroup>
    );
  }
  const year = today().slice(0, 4);
  const groups = byMonth(rows, dateOf);
  return (
    <div className={cn("flex flex-col", className)}>
      {groups.map((group, index) => (
        <InsetGroup
          key={group.key}
          variant={variant}
          header={monthHeader(group.date, year)}
          separatorInset={inset}
          className={index === 0 && !select ? "[&>div:first-child]:pt-0" : undefined}
          footer={index === groups.length - 1 ? footer : undefined}
        >
          {group.rows.map(render)}
        </InsetGroup>
      ))}
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <span className="truncate">{children}</span>;
}

function Sep() {
  return <span aria-hidden>·</span>;
}

export function InvoiceRegister(props: ListProps<InvoiceListRow>) {
  return (
    <Sections
      {...props}
      dateOf={(r) => r.invoiceDate}
      pageHref={(id) => `/sales/invoices/${id}`}
      row={(r, o) => {
        const partial = r.status === "partial" || (r.status === "open" && r.balanceCents < r.totalCents);
        return (
          <ListRow
            key={r.id}
            href={o.href}
            selected={o.selected}
            leading={<Monogram name={r.customerName} />}
            title={r.customerName}
            subtitle={
              <>
                <Dot tint={docStatusTint(r.status, r.daysOverdue)} size={7} />
                <span className="num">{r.invoiceNo}</span>
                <Sep />
                <Quiet>
                  {docStatusLabel(r.status, r.daysOverdue)}
                  {partial ? (
                    <>
                      {" · "}
                      <Money cents={r.balanceCents} currency plain /> open
                    </>
                  ) : null}
                </Quiet>
              </>
            }
            trailing={<Money cents={r.totalCents} currency plain className={cn(r.status === "void" && "line-through opacity-60")} />}
            detail={shortDate(r.invoiceDate)}
          />
        );
      }}
    />
  );
}

export function BillRegister(props: ListProps<BillListRow>) {
  return (
    <Sections
      {...props}
      dateOf={(r) => r.billDate}
      pageHref={(id) => `/purchases/bills/${id}`}
      row={(r, o) => {
        const partial = r.status === "partial";
        return (
          <ListRow
            key={r.id}
            href={o.href}
            selected={o.selected}
            leading={<Monogram name={r.vendorName} />}
            title={r.vendorName}
            subtitle={
              <>
                <Dot tint={docStatusTint(r.status, r.daysOverdue)} size={7} />
                <span className="num truncate">{r.billNo}</span>
                <Sep />
                <Quiet>
                  {docStatusLabel(r.status, r.daysOverdue)}
                  {partial ? (
                    <>
                      {" · "}
                      <Money cents={r.balanceCents} currency plain /> open
                    </>
                  ) : null}
                </Quiet>
                {r.inventoryCents > 0 ? (
                  <span className="inline-flex shrink-0 items-center text-tint-teal" title="Capitalized to inventory">
                    <Glyph name="cube" size={12} />
                    <span className="sr-only">Inventory</span>
                  </span>
                ) : null}
              </>
            }
            trailing={<Money cents={r.totalCents} currency plain className={cn(r.status === "void" && "line-through opacity-60")} />}
            detail={shortDate(r.billDate)}
          />
        );
      }}
    />
  );
}

export function ReceiptRegister(props: ListProps<ReceiptListRow>) {
  return (
    <Sections
      {...props}
      dateOf={(r) => r.receiptDate}
      pageHref={(id) => `/sales/receipts/${id}`}
      row={(r, o) => {
        const unapplied = r.void ? 0 : r.amountCents - r.appliedCents;
        return (
          <ListRow
            key={r.id}
            href={o.href}
            selected={o.selected}
            leading={<Monogram name={r.customerName ?? "?"} />}
            title={r.customerName ?? "Unidentified"}
            subtitle={
              <>
                <Dot tint={r.void ? "quiet" : unapplied > 0 ? "orange" : "green"} size={7} />
                <span className="num">{r.receiptNo}</span>
                <Sep />
                <Quiet>
                  {r.void ? "Void" : PAYMENT_METHOD_LABELS[r.method]}
                  {unapplied > 0 ? (
                    <>
                      {" · "}
                      <Money cents={unapplied} currency plain /> credit
                    </>
                  ) : null}
                </Quiet>
                {r.fromBank ? (
                  <span className="inline-flex shrink-0 items-center" title="Matched from the bank">
                    <Glyph name="bank" size={12} />
                    <span className="sr-only">Bank match</span>
                  </span>
                ) : null}
              </>
            }
            trailing={<Money cents={r.amountCents} currency plain className={cn(r.void && "line-through opacity-60")} />}
            detail={shortDate(r.receiptDate)}
          />
        );
      }}
    />
  );
}

export function PaymentRegister(props: ListProps<PaymentListRow>) {
  return (
    <Sections
      {...props}
      dateOf={(r) => r.paymentDate}
      pageHref={(id) => `/purchases/payments/${id}`}
      row={(r, o) => {
        const unapplied = r.void ? 0 : r.amountCents - r.appliedCents;
        return (
          <ListRow
            key={r.id}
            href={o.href}
            selected={o.selected}
            leading={<Monogram name={r.vendorName} />}
            title={r.vendorName}
            subtitle={
              <>
                <Dot tint={r.void ? "quiet" : unapplied > 0 ? "orange" : "green"} size={7} />
                <span className="num">{r.paymentNo}</span>
                <Sep />
                <Quiet>
                  {r.void ? "Void" : PAYMENT_METHOD_LABELS[r.method]}
                  {r.is1099Reportable ? null : " · not 1099"}
                  {unapplied > 0 ? (
                    <>
                      {" · "}
                      <Money cents={unapplied} currency plain /> prepaid
                    </>
                  ) : null}
                </Quiet>
                {r.fromBank ? (
                  <span className="inline-flex shrink-0 items-center" title="Matched from the bank">
                    <Glyph name="bank" size={12} />
                    <span className="sr-only">Bank match</span>
                  </span>
                ) : null}
              </>
            }
            trailing={<Money cents={r.amountCents} currency plain className={cn(r.void && "line-through opacity-60")} />}
            detail={shortDate(r.paymentDate)}
          />
        );
      }}
    />
  );
}

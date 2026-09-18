import * as React from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

import { DocStatusBadge, Td, Th } from "./doc-status";
import {
  PAYMENT_METHOD_LABELS,
  type BillListRow,
  type InvoiceListRow,
  type PaymentListRow,
  type ReceiptListRow,
} from "./types";

function Register({ caption, minWidth, head, children }: { caption: string; minWidth: string; head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="relative overflow-x-auto">
      <table className={cn("w-full border-separate border-spacing-0 text-sm", minWidth)}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function TotalRow({ span, cents, trailing = 0 }: { span: number; cents: readonly number[]; trailing?: number }) {
  return (
    <tr>
      <td colSpan={span} className="rule-subtotal rule-total px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase">
        Total
      </td>
      {cents.map((value, index) => (
        <td key={index} className="rule-subtotal rule-total px-3 py-1.5 text-right font-semibold">
          <Money cents={value} />
        </td>
      ))}
      {trailing > 0 ? <td colSpan={trailing} className="rule-subtotal rule-total" /> : null}
    </tr>
  );
}

export function InvoiceRegister({ rows, showCustomer = true }: { rows: readonly InvoiceListRow[]; showCustomer?: boolean }) {
  return (
    <Register
      caption="Invoices"
      minWidth="min-w-[48rem]"
      head={
        <>
          <Th>Invoice</Th>
          {showCustomer ? <Th>Customer</Th> : null}
          <Th>Date</Th>
          <Th>Due</Th>
          <Th>Status</Th>
          <Th align="right">Total</Th>
          <Th align="right">Open</Th>
        </>
      }
    >
      {rows.map((row) => (
        <tr key={row.id} className="hover:bg-muted/60">
          <Td className="num whitespace-nowrap">
            <Link href={`/sales/invoices/${row.id}`} className="font-medium text-primary hover:underline">
              {row.invoiceNo}
            </Link>
            {row.poNumber ? (
              <span className="block text-2xs text-muted-foreground">
                {/^po/i.test(row.poNumber) ? row.poNumber : `PO ${row.poNumber}`}
              </span>
            ) : null}
          </Td>
          {showCustomer ? (
            <Td>
              <Link href={`/sales/invoices?customer=${row.customerId}`} className="hover:underline">
                {row.customerName}
              </Link>
            </Td>
          ) : null}
          <Td className="num whitespace-nowrap">{row.invoiceDate}</Td>
          <Td className={cn("num whitespace-nowrap", row.daysOverdue > 0 && "text-negative")}>{row.dueDate}</Td>
          <Td>
            <DocStatusBadge status={row.status} daysOverdue={row.daysOverdue} size="sm" />
          </Td>
          <Td align="right">
            <Money cents={row.totalCents} className={cn(row.status === "void" && "text-muted-foreground line-through")} />
          </Td>
          <Td align="right">
            <Money cents={row.balanceCents} zeroDash className="font-medium" />
          </Td>
        </tr>
      ))}
      {rows.length > 1 ? (
        <TotalRow
          span={showCustomer ? 5 : 4}
          cents={[
            rows.filter((r) => r.status !== "void").reduce((s, r) => s + r.totalCents, 0),
            rows.reduce((s, r) => s + r.balanceCents, 0),
          ]}
        />
      ) : null}
    </Register>
  );
}

export function BillRegister({ rows }: { rows: readonly BillListRow[] }) {
  return (
    <Register
      caption="Bills"
      minWidth="min-w-[52rem]"
      head={
        <>
          <Th>Vendor</Th>
          <Th>Their no.</Th>
          <Th>Date</Th>
          <Th>Due</Th>
          <Th>Status</Th>
          <Th align="right">Inventory</Th>
          <Th align="right">Total</Th>
          <Th align="right">Open</Th>
        </>
      }
    >
      {rows.map((row) => (
        <tr key={row.id} className="hover:bg-muted/60">
          <Td>
            <Link href={`/purchases/bills/${row.id}`} className="font-medium text-primary hover:underline">
              {row.vendorName}
            </Link>
          </Td>
          <Td className="num whitespace-nowrap">{row.billNo}</Td>
          <Td className="num whitespace-nowrap">{row.billDate}</Td>
          <Td className={cn("num whitespace-nowrap", row.daysOverdue > 0 && "text-negative")}>{row.dueDate}</Td>
          <Td>
            <DocStatusBadge status={row.status} daysOverdue={row.daysOverdue} size="sm" />
          </Td>
          <Td align="right">
            <Money cents={row.inventoryCents} zeroDash className="text-info" />
          </Td>
          <Td align="right">
            <Money cents={row.totalCents} className={cn(row.status === "void" && "text-muted-foreground line-through")} />
          </Td>
          <Td align="right">
            <Money cents={row.balanceCents} zeroDash className="font-medium" />
          </Td>
        </tr>
      ))}
      {rows.length > 1 ? (
        <TotalRow
          span={5}
          cents={[
            rows.filter((r) => r.status !== "void").reduce((s, r) => s + r.inventoryCents, 0),
            rows.filter((r) => r.status !== "void").reduce((s, r) => s + r.totalCents, 0),
            rows.reduce((s, r) => s + r.balanceCents, 0),
          ]}
        />
      ) : null}
    </Register>
  );
}

export function ReceiptRegister({ rows }: { rows: readonly ReceiptListRow[] }) {
  return (
    <Register
      caption="Receipts"
      minWidth="min-w-[50rem]"
      head={
        <>
          <Th>Receipt</Th>
          <Th>Customer</Th>
          <Th>Date</Th>
          <Th>Method</Th>
          <Th>Deposited to</Th>
          <Th align="right">Amount</Th>
          <Th align="right">Unapplied</Th>
        </>
      }
    >
      {rows.map((row) => (
        <tr key={row.id} className={cn("hover:bg-muted/60", row.void && "text-muted-foreground")}>
          <Td className="num whitespace-nowrap">
            <Link href={`/sales/receipts/${row.id}`} className="font-medium text-primary hover:underline">
              {row.receiptNo}
            </Link>
            {row.void ? (
              <Badge tone="neutral" size="sm" className="ml-2">
                Void
              </Badge>
            ) : null}
            {row.fromBank ? (
              <Badge tone="info" size="sm" className="ml-2">
                Bank match
              </Badge>
            ) : null}
          </Td>
          <Td>{row.customerName ?? <span className="text-muted-foreground">Unidentified</span>}</Td>
          <Td className="num whitespace-nowrap">{row.receiptDate}</Td>
          <Td className="text-xs">
            {PAYMENT_METHOD_LABELS[row.method]}
            {row.reference ? <span className="num block text-2xs text-muted-foreground">{row.reference}</span> : null}
          </Td>
          <Td className="text-xs">{row.depositAccountLabel}</Td>
          <Td align="right">
            <Money cents={row.amountCents} className={cn(row.void && "line-through")} />
          </Td>
          <Td align="right">
            <Money cents={row.void ? 0 : row.amountCents - row.appliedCents} zeroDash />
          </Td>
        </tr>
      ))}
    </Register>
  );
}

export function PaymentRegister({ rows }: { rows: readonly PaymentListRow[] }) {
  return (
    <Register
      caption="Bill payments"
      minWidth="min-w-[52rem]"
      head={
        <>
          <Th>Payment</Th>
          <Th>Vendor</Th>
          <Th>Date</Th>
          <Th>Method</Th>
          <Th>Paid from</Th>
          <Th align="center">1099</Th>
          <Th align="right">Amount</Th>
          <Th align="right">Unapplied</Th>
        </>
      }
    >
      {rows.map((row) => (
        <tr key={row.id} className={cn("hover:bg-muted/60", row.void && "text-muted-foreground")}>
          <Td className="num whitespace-nowrap">
            <Link href={`/purchases/payments/${row.id}`} className="font-medium text-primary hover:underline">
              {row.paymentNo}
            </Link>
            {row.void ? (
              <Badge tone="neutral" size="sm" className="ml-2">
                Void
              </Badge>
            ) : null}
            {row.fromBank ? (
              <Badge tone="info" size="sm" className="ml-2">
                Bank match
              </Badge>
            ) : null}
          </Td>
          <Td>{row.vendorName}</Td>
          <Td className="num whitespace-nowrap">{row.paymentDate}</Td>
          <Td className="text-xs">
            {PAYMENT_METHOD_LABELS[row.method]}
            {row.reference ? <span className="num block text-2xs text-muted-foreground">{row.reference}</span> : null}
          </Td>
          <Td className="text-xs">{row.accountLabel}</Td>
          <Td align="center" className="text-xs">
            {row.is1099Reportable ? "Counts" : <span className="text-muted-foreground">Card</span>}
          </Td>
          <Td align="right">
            <Money cents={row.amountCents} className={cn(row.void && "line-through")} />
          </Td>
          <Td align="right">
            <Money cents={row.void ? 0 : row.amountCents - row.appliedCents} zeroDash />
          </Td>
        </tr>
      ))}
    </Register>
  );
}

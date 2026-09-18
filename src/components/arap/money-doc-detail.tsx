import * as React from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";

import { Fact, Td, Th } from "./doc-status";
import { PAYMENT_METHOD_LABELS, type MoneyDocDetail } from "./types";

/** A receipt or a bill payment: what came in or went out, and what it settled. */
export function MoneyDocDetailView({ doc, side }: { doc: MoneyDocDetail; side: "ar" | "ap" }) {
  const unapplied = doc.amountCents - doc.appliedCents;
  const docRoute = side === "ar" ? "/sales/invoices" : "/purchases/bills";
  const partyRoute = side === "ar" ? `/sales/invoices?customer=${doc.partyId ?? ""}` : `/purchases/bills?vendor=${doc.partyId ?? ""}`;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{side === "ar" ? "Receipt" : "Payment"}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {doc.void ? <Badge tone="neutral">Void {doc.voidDate}</Badge> : <Badge tone="positive">Posted</Badge>}
            {doc.bankTransactionId ? <Badge tone="info">From a bank match</Badge> : null}
            {side === "ap" && doc.is1099Reportable === false ? <Badge tone="neutral">Card · not on a 1099</Badge> : null}
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Fact label={side === "ar" ? "Customer" : "Vendor"}>
              {doc.partyId ? (
                <Link href={partyRoute} className="text-primary hover:underline">
                  {doc.partyName}
                </Link>
              ) : (
                <span className="text-muted-foreground">Unidentified</span>
              )}
            </Fact>
            <Fact label="Date">
              <span className="num">{doc.date}</span>
            </Fact>
            <Fact label="Method">
              {PAYMENT_METHOD_LABELS[doc.method]}
              {doc.reference ? <span className="num block text-xs text-muted-foreground">{doc.reference}</span> : null}
            </Fact>
            <Fact label={side === "ar" ? "Deposited to" : "Paid from"}>{doc.accountLabel}</Fact>
            <Fact label="Amount">
              <Money cents={doc.amountCents} currency plain className="font-semibold" />
            </Fact>
            <Fact label="Ledger">
              {doc.journalEntryId ? (
                <Link href={`/ledger/${doc.journalEntryId}`} className="num text-primary hover:underline">
                  Entry #{doc.journalEntryNo}
                </Link>
              ) : (
                <span className="text-muted-foreground">Not posted</span>
              )}
            </Fact>
          </dl>
          {doc.memo ? <p className="mt-4 text-sm text-muted-foreground">{doc.memo}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{side === "ar" ? "Invoices it paid" : "Bills it paid"}</CardTitle>
          <span className="text-xs text-muted-foreground">
            <Money cents={doc.appliedCents} plain /> applied ·{" "}
            <Money cents={doc.void ? 0 : unapplied} plain /> {side === "ar" ? "held as credit" : "held as prepayment"}
          </span>
        </CardHeader>
        {doc.applications.length === 0 ? (
          <EmptyState
            title="Not applied to anything yet"
            description={
              side === "ar"
                ? "The whole amount sits on the customer's account as a credit until it is applied to an invoice."
                : "The whole amount sits with the vendor as a prepayment until it is applied to a bill."
            }
          />
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[34rem] border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <Th>{side === "ar" ? "Invoice" : "Bill"}</Th>
                  <Th>Document date</Th>
                  <Th>Applied on</Th>
                  {side === "ar" ? <Th align="right">Discount</Th> : null}
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {doc.applications.map((app) => (
                  <tr key={`${app.docId}-${app.appliedOn}-${app.amountCents}`}>
                    <Td className="num">
                      <Link href={`${docRoute}/${app.docId}`} className="text-primary hover:underline">
                        {app.docNo}
                      </Link>
                    </Td>
                    <Td className="num">{app.docDate}</Td>
                    <Td className="num">{app.appliedOn}</Td>
                    {side === "ar" ? (
                      <Td align="right">
                        <Money cents={app.discountCents} zeroDash />
                      </Td>
                    ) : null}
                    <Td align="right">
                      <Money cents={app.amountCents} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

import * as React from "react";

import { DetailPane } from "@/components/ui/detail-pane";
import { Dot } from "@/components/ui/icon-badge";
import { GroupRow, InsetGroup, ListRow } from "@/components/ui/inset-group";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { mediumDate, shortDate } from "@/lib/ui/format";

import { FlowCard, SettledBar } from "./doc-preview";
import { paymentFlow, receiptFlow } from "./flows";
import { PAYMENT_METHOD_LABELS, type MoneyDocDetail } from "./types";

/** A receipt or a bill payment: what came in or went out, what it posted, and what it settled. */
export function MoneyDocDetailView({ doc, side, children }: { doc: MoneyDocDetail; side: "ar" | "ap"; children?: React.ReactNode }) {
  const unapplied = doc.void ? 0 : doc.amountCents - doc.appliedCents;
  const docRoute = side === "ar" ? "/sales/invoices" : "/purchases/bills";
  const partyRoute = side === "ar" ? `/sales/invoices?customer=${doc.partyId ?? ""}` : `/purchases/bills?vendor=${doc.partyId ?? ""}`;
  const name = doc.partyName ?? "Unidentified";

  return (
    <DetailPane
      leading={<Monogram name={name} size="lg" />}
      title={name}
      meta={[<span key="no" className="num">{doc.docNo}</span>, mediumDate(doc.date)]}
      amount={<Money cents={doc.amountCents} currency plain className={doc.void ? "line-through opacity-60" : undefined} />}
      status={
        <div className="flex flex-wrap gap-1.5">
          {doc.void ? (
            <Pill glyph="exclude">Void{doc.voidDate ? ` ${shortDate(doc.voidDate)}` : ""}</Pill>
          ) : (
            <Pill tone="green" glyph="check-circle">
              Posted
            </Pill>
          )}
          {doc.bankTransactionId ? (
            <Pill tone="blue" glyph="bank">
              Bank match
            </Pill>
          ) : null}
          {side === "ap" && doc.is1099Reportable === false ? <Pill glyph="credit-card">Not on 1099</Pill> : null}
        </div>
      }
    >
      {!doc.void && doc.amountCents > 0 ? (
        <div className="rounded-2xl bg-card px-5 py-4 shadow-card max-sm:rounded-[22px] max-sm:px-4">
          <SettledBar settledCents={doc.appliedCents} openCents={unapplied} labels={["Applied", side === "ar" ? "Credit" : "Prepaid"]} />
        </div>
      ) : null}

      {!doc.void ? <FlowCard flow={side === "ar" ? receiptFlow(doc) : paymentFlow(doc)} caption="Posted" /> : null}

      <InsetGroup>
        {doc.partyId ? (
          <GroupRow label={side === "ar" ? "Customer" : "Vendor"} href={partyRoute}>
            <span className="truncate">{name}</span>
          </GroupRow>
        ) : null}
        <GroupRow label={side === "ar" ? "Deposited to" : "Paid from"}>
          <span className="truncate">{doc.accountLabel}</span>
        </GroupRow>
        <GroupRow label="Method">{PAYMENT_METHOD_LABELS[doc.method]}</GroupRow>
        {doc.reference ? (
          <GroupRow label="Reference">
            <span className="num">{doc.reference}</span>
          </GroupRow>
        ) : null}
        {doc.journalEntryId ? (
          <GroupRow label="Ledger" href={`/ledger/${doc.journalEntryId}`}>
            <span className="num">Entry #{doc.journalEntryNo}</span>
          </GroupRow>
        ) : (
          <GroupRow label="Ledger">Not posted</GroupRow>
        )}
      </InsetGroup>

      <InsetGroup
        header={side === "ar" ? "Invoices paid" : "Bills paid"}
        separatorInset={34}
        footer={
          unapplied > 0 ? (
            <>
              <Money cents={unapplied} currency plain /> {side === "ar" ? "held as credit" : "held as prepayment"}
            </>
          ) : undefined
        }
      >
        {doc.applications.length === 0 ? (
          <p className="px-4 py-3 text-sm text-label2">None yet</p>
        ) : (
          doc.applications.map((app) => (
            <ListRow
              key={`${app.docId}-${app.appliedOn}-${app.amountCents}`}
              href={`${docRoute}/${app.docId}`}
              leading={<Dot tint="green" />}
              title={<span className="num">{app.docNo}</span>}
              subtitle={
                <>
                  Applied {shortDate(app.appliedOn)}
                  {app.discountCents > 0 ? (
                    <>
                      {" · "}
                      <Money cents={app.discountCents} currency plain /> discount
                    </>
                  ) : null}
                </>
              }
              trailing={<Money cents={app.amountCents} currency plain />}
              detail={shortDate(app.docDate)}
            />
          ))
        )}
      </InsetGroup>

      {doc.memo ? (
        <InsetGroup header="Memo">
          <p className="px-4 py-3 text-sm whitespace-pre-line">{doc.memo}</p>
        </InsetGroup>
      ) : null}

      {children}
    </DetailPane>
  );
}

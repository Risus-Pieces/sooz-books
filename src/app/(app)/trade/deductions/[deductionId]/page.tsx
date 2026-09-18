import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Paperclip } from "lucide-react";

import { DeductionActions } from "@/components/trade/deduction-actions";
import { longDate } from "@/components/trade/labels";
import { DeadlineMeter, DeductionStatusBadge, Fact, TreatmentBadge } from "@/components/trade/parts";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { addDays, today } from "@/lib/dates";

import { deductionDetail } from "../../queries";

export async function generateMetadata({ params }: { params: Promise<{ deductionId: string }> }): Promise<Metadata> {
  const { deductionId } = await params;
  const detail = await deductionDetail(deductionId);
  return { title: detail === null ? "Deduction" : `Deduction ${detail.row.deductionNo}` };
}

/**
 * One deduction: the evidence the distributor sent, the case notes, every entry that has moved
 * it, and — while money is still open in 1210 — the four actions, each with the entry it will
 * post shown before it posts.
 */
export default async function DeductionPage({ params }: { params: Promise<{ deductionId: string }> }) {
  const [user, { deductionId }] = await Promise.all([requireUser(), params]);
  const detail = await deductionDetail(deductionId);
  if (detail === null) notFound();
  const { row } = detail;
  const canManage = can(user.role, "trade.manage");
  const deadline = row.disputeDeadline ?? addDays(row.deductionDate, detail.windowDays);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Trade · Deduction"
        title={row.deductionNo}
        meta={
          <span className="flex items-center gap-1.5">
            <DeductionStatusBadge status={row.status} />
            <TreatmentBadge treatment={row.treatment} />
          </span>
        }
        description={`${row.customerName} · ${row.reasonLabel ?? (row.sourceReasonCode ? `unmapped code “${row.sourceReasonCode}”` : "no reason code")}${row.description ? ` · ${row.description}` : ""}`}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link href="/trade/deductions">
              <ArrowLeft />
              Workbench
            </Link>
          </Button>
        }
      />

      <Card>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Amount">
            <Money cents={row.amountCents} currency plain />
          </Fact>
          <Fact label="Open in 1210">
            <Money cents={row.openCents} currency plain zeroDash />
          </Fact>
          <Fact label="Recovered">
            <Money cents={row.recoveredCents} plain zeroDash />
          </Fact>
          <Fact label="Written off">
            <Money cents={row.writtenOffCents} plain zeroDash />
          </Fact>
          <Fact label="Taken">
            <span className="num">{longDate(row.deductionDate)}</span>
            <span className="block text-2xs text-muted-foreground">{row.daysOutstanding} days ago</span>
          </Fact>
          <Fact label="Dispute by">
            {row.actionable ? (
              <DeadlineMeter deadline={row.disputeDeadline ?? deadline} daysToDeadline={row.daysToDeadline} burn={row.burn} alert={row.alert} />
            ) : (
              <span className="num">{longDate(row.disputeDeadline)}</span>
            )}
          </Fact>
        </dl>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>Evidence</CardTitle>
                <CardDescription>The line the distributor sent, as it arrived, and what it points at.</CardDescription>
              </div>
            </CardHeader>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3">
              <Fact label="Remittance">
                {detail.remittance === null ? (
                  "—"
                ) : (
                  <span className="num">
                    {detail.remittance.sourceSystem} {detail.remittance.paymentNumber}
                    <span className="block text-2xs text-muted-foreground">
                      {longDate(detail.remittance.paymentDate)} · <Money cents={detail.remittance.totalCents} plain className="text-2xs" />
                    </span>
                  </span>
                )}
              </Fact>
              <Fact label="Invoice">
                {detail.invoiceId !== null ? (
                  <Link href={`/sales/invoices/${detail.invoiceId}`} className="num text-primary hover:underline">
                    {row.invoiceNo}
                  </Link>
                ) : (
                  <span className="num">{row.invoiceNo ?? "—"}</span>
                )}
                {detail.invoiceDate !== null ? <span className="block text-2xs text-muted-foreground">{longDate(detail.invoiceDate)}</span> : null}
              </Fact>
              <Fact label="Reason code">
                <span className="num">{row.reasonCode ?? "Unmapped"}</span>
                <span className="block text-2xs text-muted-foreground">
                  printed as “{row.sourceReasonCode ?? "—"}” · {detail.windowDays}-day window
                </span>
              </Fact>
              <Fact label="Promotion">
                {detail.promotionId !== null ? (
                  <Link href={`/trade/promotions/${detail.promotionId}`} className="text-primary hover:underline">
                    {row.promotionName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{detail.dealNumber ? `Deal ${detail.dealNumber}, no promotion` : "None"}</span>
                )}
              </Fact>
            </dl>
            {detail.sourceLine.length > 0 ? (
              <details className="border-t border-border">
                <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-primary">Source line, verbatim</summary>
                <dl className="flex flex-col px-4 pb-3">
                  {detail.sourceLine.map((f) => (
                    <div key={f.label} className="grid grid-cols-[9rem_1fr] gap-3 rule-row py-1 text-xs">
                      <dt className="text-muted-foreground">{f.label}</dt>
                      <dd className="num break-all text-foreground">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
            <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
              <p className="eyebrow">Backup documents</p>
              {detail.attachments.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  None stored with this deduction. Keep the distributor’s backup (the MCB detail, the proof of delivery) with the dispute case you file.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {detail.attachments.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-xs">
                      <Paperclip className="size-3.5 text-muted-foreground" aria-hidden />
                      <span className="text-foreground">{a.filename}</span>
                      <span className="num text-muted-foreground">{longDate(a.uploadedOn)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Case notes</CardTitle>
            </CardHeader>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3">
              <Fact label="Disputed on">{longDate(detail.disputedOn)}</Fact>
              <Fact label="Case number">
                <span className="num">{detail.disputeReference ?? "—"}</span>
              </Fact>
              <Fact label="Notes" className="col-span-2">
                <span className="text-sm whitespace-pre-line">{detail.disputeNotes ?? "No notes yet. Filing a dispute records them."}</span>
              </Fact>
              {detail.resolvedOn !== null ? <Fact label="Resolved on">{longDate(detail.resolvedOn)}</Fact> : null}
            </dl>
          </Card>

          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>Entries</CardTitle>
                <CardDescription>Every posting that moved this deduction.</CardDescription>
              </div>
            </CardHeader>
            {detail.entries.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">No posted entry refers to this deduction.</p>
            ) : (
              <ul className="flex flex-col">
                {detail.entries.map((e) => (
                  <li key={e.id} className="flex items-baseline justify-between gap-3 rule-row px-4 py-2 text-sm">
                    <span className="min-w-0">
                      <Link href={`/ledger/${e.id}`} className="num text-primary hover:underline">
                        JE #{e.entryNo}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">{e.role}</span>
                      {e.memo ? <span className="block truncate text-2xs text-muted-foreground">{e.memo}</span> : null}
                    </span>
                    <span className="num shrink-0 text-xs text-muted-foreground">{longDate(e.date)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="min-w-0">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Decide</CardTitle>
              <CardDescription>
                {row.actionable
                  ? "Each action shows the entry it will post. Nothing moves until you press its button."
                  : "Nothing is left open in Deductions Receivable, so there is nothing to decide."}
              </CardDescription>
            </div>
          </CardHeader>
          {row.actionable && canManage ? (
            <DeductionActions
              deductionId={row.id}
              deductionNo={row.deductionNo}
              openCents={row.openCents}
              deductionDate={row.deductionDate}
              disputeDeadline={deadline}
              reasonCode={row.reasonCode}
              validation={detail.validation}
              reasonOptions={detail.reasonOptions}
              depositOptions={detail.depositOptions}
              accounts={detail.accounts}
              today={today()}
              alreadyDisputed={row.status === "disputed" || row.status === "partially_recovered"}
            />
          ) : row.actionable ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">Your role can read deductions but not act on them.</p>
          ) : (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              {row.status === "validated" ? "Validated" : row.status === "recovered" ? "Recovered in full" : row.status === "written_off" ? "Written off" : "Closed"}
              {detail.resolvedOn !== null ? ` on ${longDate(detail.resolvedOn)}` : ""}. The entries are listed on the left.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

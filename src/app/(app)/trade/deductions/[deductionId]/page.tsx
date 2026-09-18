import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeductionActions } from "@/components/trade/deduction-actions";
import { longDate } from "@/components/trade/labels";
import { DeductionStatusPill, Disclosure, TreatmentPill, WindowLine } from "@/components/trade/parts";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { DetailPane } from "@/components/ui/detail-pane";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { addDays, today } from "@/lib/dates";

import { deductionDetail } from "../../queries";

export async function generateMetadata({ params }: { params: Promise<{ deductionId: string }> }): Promise<Metadata> {
  const { deductionId } = await params;
  const detail = await deductionDetail(deductionId);
  return { title: detail === null ? "Deduction" : `Deduction ${detail.row.deductionNo}` };
}

const RESOLVED_LABEL: Record<string, string> = { validated: "Validated", recovered: "Recovered in full", written_off: "Written off" };

/**
 * One deduction: the dispute window as a line, the facts as grouped rows, and — while money is
 * still open in 1210 — the four actions, each drawing the entry it will post before it posts.
 * The evidence, case notes and entries follow.
 */
export default async function DeductionPage({ params }: { params: Promise<{ deductionId: string }> }) {
  const [user, { deductionId }] = await Promise.all([requireUser(), params]);
  const detail = await deductionDetail(deductionId);
  if (detail === null) notFound();
  const { row } = detail;
  const canManage = can(user.role, "trade.manage");
  const deadline = row.disputeDeadline ?? addDays(row.deductionDate, detail.windowDays);
  const reason = row.reasonLabel ?? (row.sourceReasonCode ? `Unmapped “${row.sourceReasonCode}”` : "No reason code");

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Deduction"
        phoneTitleRow
        back={{ href: "/trade/deductions", label: "Deductions" }}
        info={
          <>
            <p>The evidence the distributor sent, the case notes, and every entry that has moved this claim.</p>
            <p>While money is open in 1210 Deductions Receivable, each action shows the entry it will post. Nothing moves until you press its button.</p>
          </>
        }
      />

      <DetailPane
        leading={<Monogram name={row.customerName} size="lg" />}
        title={<span className="num">{row.deductionNo}</span>}
        meta={[row.customerName, reason]}
        amount={<Money cents={row.actionable ? row.openCents : row.amountCents} currency plain />}
        status={
          <div className="flex flex-wrap gap-1.5">
            <DeductionStatusPill status={row.status} />
            <TreatmentPill treatment={row.treatment} />
          </div>
        }
      >
        {row.actionable ? (
          <div className="rounded-[14px] bg-card px-5 pt-4 pb-3.5 shadow-card max-sm:px-4">
            <WindowLine taken={row.deductionDate} deadline={deadline} burn={row.burn} alert={row.alert} daysToDeadline={row.daysToDeadline} />
          </div>
        ) : null}

        <InsetGroup>
          <GroupRow label="Amount">
            <Money cents={row.amountCents} currency plain className="text-label" />
          </GroupRow>
          <GroupRow label="Open">
            <Money cents={row.openCents} currency plain zeroDash className="font-semibold text-label" />
          </GroupRow>
          {row.recoveredCents !== 0 ? (
            <GroupRow label="Recovered">
              <Money cents={row.recoveredCents} currency plain className="text-ink-green" />
            </GroupRow>
          ) : null}
          {row.writtenOffCents !== 0 ? (
            <GroupRow label="Written off">
              <Money cents={row.writtenOffCents} currency plain className="text-ink-red" />
            </GroupRow>
          ) : null}
          <GroupRow label="Taken">
            {longDate(row.deductionDate)} · {row.daysOutstanding}d
          </GroupRow>
          {!row.actionable ? <GroupRow label="Deadline">{longDate(row.disputeDeadline)}</GroupRow> : null}
        </InsetGroup>

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
          <p className="flex items-center gap-2 px-1 text-sm text-label2">
            <Glyph name="lock" size={15} />
            Read only for your role
          </p>
        ) : (
          <p className="flex items-center gap-2 px-1 text-sm font-semibold">
            <Glyph name="check-circle" size={16} className="text-ink-green" />
            {RESOLVED_LABEL[row.status] ?? "Closed"}
            {detail.resolvedOn !== null ? <span className="font-normal text-label2">· {longDate(detail.resolvedOn)}</span> : null}
          </p>
        )}

        <InsetGroup header="Evidence">
          <GroupRow label="Remittance">
            {detail.remittance === null ? (
              "—"
            ) : (
              <span className="num text-right">
                {detail.remittance.sourceSystem} {detail.remittance.paymentNumber}
                <span className="block text-xs">
                  {longDate(detail.remittance.paymentDate)} · <Money cents={detail.remittance.totalCents} currency plain />
                </span>
              </span>
            )}
          </GroupRow>
          {detail.invoiceId !== null ? (
            <GroupRow label="Invoice" href={`/sales/invoices/${detail.invoiceId}`}>
              <span className="num">{row.invoiceNo}</span>
            </GroupRow>
          ) : (
            <GroupRow label="Invoice">
              <span className="num">{row.invoiceNo ?? "—"}</span>
            </GroupRow>
          )}
          <GroupRow
            label={
              <span className="inline-flex items-center gap-1">
                Reason code
                <InfoButton label="About the reason code">
                  <p>
                    Printed as “{row.sourceReasonCode ?? "—"}”. Its dispute window is {detail.windowDays} days from the day the distributor took it.
                  </p>
                </InfoButton>
              </span>
            }
          >
            <span className="num">{row.reasonCode ?? "Unmapped"}</span>
          </GroupRow>
          {detail.promotionId !== null ? (
            <GroupRow label="Promotion" href={`/trade/promotions/${detail.promotionId}`}>
              {row.promotionName}
            </GroupRow>
          ) : (
            <GroupRow label="Promotion">{detail.dealNumber ? `Deal ${detail.dealNumber}` : "None"}</GroupRow>
          )}
          <GroupRow label="Backup">
            {detail.attachments.length === 0 ? (
              "None"
            ) : (
              <span className="flex flex-col items-end">
                {detail.attachments.map((a) => (
                  <span key={a.id} className="inline-flex items-center gap-1.5">
                    <Glyph name="paperclip" size={13} />
                    {a.filename}
                  </span>
                ))}
              </span>
            )}
          </GroupRow>
        </InsetGroup>

        {detail.sourceLine.length > 0 ? (
          <div className="-mt-1 overflow-hidden rounded-[14px] bg-card shadow-card">
            <Disclosure summary="Source line">
              <dl className="flex flex-col pb-2">
                {detail.sourceLine.map((f, index) => (
                  <div key={f.label} className={index > 0 ? "grid grid-cols-[9rem_1fr] gap-3 hairline-t px-5 py-1.5 text-xs max-sm:px-4" : "grid grid-cols-[9rem_1fr] gap-3 px-5 py-1.5 text-xs max-sm:px-4"}>
                    <dt className="text-label2">{f.label}</dt>
                    <dd className="num break-all">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </Disclosure>
          </div>
        ) : null}

        {detail.disputedOn !== null || detail.disputeReference !== null || detail.disputeNotes !== null ? (
          <InsetGroup header="Case">
            <GroupRow label="Filed">{longDate(detail.disputedOn)}</GroupRow>
            <GroupRow label="Case number">
              <span className="num">{detail.disputeReference ?? "—"}</span>
            </GroupRow>
            {detail.disputeNotes ? <p className="hairline-t px-4 py-3 text-sm whitespace-pre-line">{detail.disputeNotes}</p> : null}
          </InsetGroup>
        ) : null}

        {detail.entries.length === 0 ? null : (
          <InsetGroup header="Entries" separatorInset={16}>
            {detail.entries.map((e) => (
              <Link key={e.id} href={`/ledger/${e.id}`} className="relative flex min-h-11 items-center gap-3 px-4 py-2 outline-none focus-ring-inset before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-sep first:before:hidden hover:bg-fill2 focus-visible:bg-fill2">
                <span className="min-w-0 flex-1">
                  <span className="num block text-sm font-semibold">#{e.entryNo}</span>
                  <span className="block truncate text-xs text-label2">
                    {e.role}
                    {e.memo ? ` · ${e.memo}` : ""}
                  </span>
                </span>
                <span className="text-xs text-label2">{longDate(e.date)}</span>
                <Glyph name="chevron-right" size={12} weight={2.4} className="text-label3" />
              </Link>
            ))}
          </InsetGroup>
        )}
      </DetailPane>
    </div>
  );
}

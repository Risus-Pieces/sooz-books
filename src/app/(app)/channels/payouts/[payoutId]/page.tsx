import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check, CircleSlash, ExternalLink, TriangleAlert, X } from "lucide-react";

import { EntryTable } from "@/components/channels/entry-table";
import { DepositBadge, Figure, Notice, PostedBadge, Td, Th, longDate } from "@/components/channels/parts";
import { LinkDepositButton, PostSettlementButton, UnpostSettlementButton } from "@/components/channels/settlement-actions";
import { PROVIDER_NAME } from "@/components/channels/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { cn } from "@/lib/cn";

import { settlementDetail } from "../../queries";

export async function generateMetadata({ params }: { params: Promise<{ payoutId: string }> }): Promise<Metadata> {
  const { payoutId } = await params;
  const detail = await settlementDetail(payoutId);
  return { title: detail === null ? "Settlement" : `${PROVIDER_NAME[detail.row.provider]} settlement` };
}

const LINE_TYPE_LABEL: Record<string, string> = {
  gross_sales: "Sales",
  shipping_income: "Shipping",
  tip: "Tip",
  gift_card: "Gift card",
  discount: "Discount",
  coupon: "Coupon",
  promotion_rebate: "Promotion",
  refund: "Refund",
  chargeback: "Chargeback",
  chargeback_reversal: "Chargeback reversed",
  sales_tax_collected: "Sales tax",
  facilitator_tax: "Facilitator tax",
  referral_fee: "Referral fee",
  processing_fee: "Processing fee",
  fulfillment_fee: "Fulfillment fee",
  storage_fee: "Storage fee",
  shipping_cost: "Shipping cost",
  advertising: "Advertising",
  subscription_fee: "Subscription",
  reimbursement: "Reimbursement",
  adjustment: "Adjustment",
  reserve_held: "Reserve held",
  reserve_released: "Reserve released",
  other: "Other",
};

/**
 * One settlement. Before it posts, the page shows exactly the journal entry posting will
 * write — built by the same function the posting engine uses — and the person reading it is
 * the one who posts it.
 */
export default async function SettlementPage({ params }: { params: Promise<{ payoutId: string }> }) {
  const [user, { payoutId }] = await Promise.all([requireUser(), params]);
  const detail = await settlementDetail(payoutId);
  if (detail === null) notFound();

  const { row, entry, identity } = detail;
  const name = PROVIDER_NAME[row.provider];
  const label = `${name} settlement ${row.key ?? ""}`.trim();
  const canPost = can(user.role, "ledger.post");
  const canLink = can(user.role, "bank.approve");
  const posted = entry.kind === "posted";
  const suspenseLines = detail.lines.filter((l) => l.suspense);
  const facilitatorLines = detail.lines.filter((l) => l.facilitator);
  const issues = detail.issues.filter((i) => i.severity !== "info");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow={`Channels · ${name}`}
        title={row.key ?? "Settlement"}
        description={`${row.periodStart !== null && row.periodStart !== row.periodEnd ? `${longDate(row.periodStart)} – ` : ""}${longDate(row.periodEnd)}${row.filename === null ? "" : ` · from ${row.filename}`}`}
        meta={
          <>
            <PostedBadge entryNo={row.entryNo} />
            <DepositBadge state={row.depositState} />
          </>
        }
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href={`/channels/payouts?provider=${row.provider}`}>
                <ArrowLeft />
                Payouts
              </Link>
            </Button>
            {posted ? (
              <>
                {row.entryId === null ? null : (
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/ledger/${row.entryId}`}>
                      <ExternalLink />
                      Entry #{row.entryNo}
                    </Link>
                  </Button>
                )}
                {canPost ? <UnpostSettlementButton payoutId={row.id} entryNo={row.entryNo} /> : null}
              </>
            ) : canPost ? (
              <PostSettlementButton
                payoutId={row.id}
                label={label}
                clearingCode={entry.clearingAccountCode ?? ""}
                netCents={entry.clearingCents}
                lineCount={entry.lines.length}
                needsTaxState={detail.needsTaxState}
                defaultTaxState={detail.defaultTaxState}
                disabled={entry.kind !== "planned"}
                disabledReason={entry.refusal?.message ?? null}
              />
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border bg-surface shadow-raised lg:grid-cols-4">
        <Figure label="Gross sales">
          <Money cents={row.grossCents} currency plain />
        </Figure>
        <Figure label="Fees" className="border-l">
          <Money cents={row.feesCents} currency plain />
        </Figure>
        <Figure label={`Net paid by ${name}`} className="border-t lg:border-t-0 lg:border-l">
          <Money cents={row.netCents} currency plain />
        </Figure>
        <Figure label="Identity" className="border-t border-l lg:border-t-0">
          {identity.ties ? (
            <span className="inline-flex items-center gap-1.5 text-positive">
              <Check className="size-4" aria-hidden />
              <span className="text-base">Ties to the cent</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-negative">
              <X className="size-4" aria-hidden />
              <span className="text-base">
                {identity.differenceCents === null ? "No reported total" : <>Off by <Money cents={identity.differenceCents} plain /></>}
              </span>
            </span>
          )}
        </Figure>
      </div>
      <p className="-mt-2 px-1 text-xs text-muted-foreground">
        The settlement&apos;s {detail.lines.length} lines add to <Money cents={identity.linesCents} currency plain />;{" "}
        {identity.reportedCents === null ? (
          "the file states no total to check them against."
        ) : (
          <>
            {name} reports <Money cents={identity.reportedCents} currency plain />.
          </>
        )}
      </p>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>{posted ? `Posted as entry #${row.entryNo ?? ""}` : "The entry this settlement will post"}</CardTitle>
            <CardDescription>
              {entry.date === null ? "" : `Dated ${longDate(entry.date)} · `}
              {entry.memo}
            </CardDescription>
          </div>
          {posted ? <Badge>Posted</Badge> : entry.kind === "planned" ? <Badge tone="info">Not posted</Badge> : <Badge tone="negative">Cannot post</Badge>}
        </CardHeader>
        {entry.refusal === null ? null : (
          <Notice tone="negative" icon={<CircleSlash />}>
            <p>{entry.refusal.message}</p>
            {entry.refusal.remedy === null ? null : <p className="mt-0.5 text-foreground/80">{entry.refusal.remedy}</p>}
          </Notice>
        )}
        {entry.lines.length === 0 ? null : (
          <EntryTable lines={entry.lines} clearingCode={entry.clearingAccountCode} caption={posted ? "Posted entry" : "Entry to be posted"} />
        )}
        {entry.lines.length === 0 ? null : (
          <ul className="flex flex-col gap-1 border-t border-border px-4 py-3 text-xs text-muted-foreground">
            <li>
              <span className="num">{entry.clearingAccountCode}</span> takes the net,{" "}
              <Money cents={entry.clearingCents} currency plain />. The {name} deposit, posted from the bank side, takes it back
              to zero.
            </li>
            {entry.facilitatorGrossCents > 0 ? (
              <li>
                Marketplace-facilitator tax ({facilitatorLines.length} line{facilitatorLines.length === 1 ? "" : "s"},{" "}
                <Money cents={entry.facilitatorGrossCents} currency plain /> both halves) is left out: {name} collected and remitted
                it, so it is pass-through and never reaches 2200.
              </li>
            ) : null}
            {entry.suspenseCents !== 0 || suspenseLines.length > 0 ? (
              <li className="text-warning">
                {suspenseLines.length} line{suspenseLines.length === 1 ? "" : "s"} the importer did not recognise go to 7900 Ask My
                Accountant (<Money cents={entry.suspenseCents} currency plain />). Reclassify before the close.
              </li>
            ) : null}
          </ul>
        )}
      </Card>

      {detail.taxLines.length === 0 ? null : (
        <Card>
          <CardHeader>
            <CardTitle>Sales tax in this settlement</CardTitle>
            <CardDescription>What reaches the sales tax register when it posts.</CardDescription>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <Th>State</Th>
                  <Th className="w-40 text-right">Owed by Sooz (2200)</Th>
                  <Th className="rule-gutter w-44 text-right">Facilitator · pass-through</Th>
                  <Th className="w-36 text-right">Non-US tax</Th>
                </tr>
              </thead>
              <tbody>
                {detail.taxLines.map((t) => (
                  <tr key={t.state ?? "none"}>
                    <Td className="rule-row whitespace-nowrap">
                      {t.state ?? (
                        <span className="text-muted-foreground">
                          Not named{detail.defaultTaxState === null ? "" : ` · posts as ${detail.defaultTaxState}`}
                        </span>
                      )}
                    </Td>
                    <Td className="rule-row text-right">
                      <Money cents={t.collectedCents} plain zeroDash />
                    </Td>
                    <Td className="rule-row rule-gutter text-right text-muted-foreground">
                      <Money cents={t.facilitatorCents} plain zeroDash />
                    </Td>
                    <Td className="rule-row text-right">
                      <Money cents={t.foreignCents} plain zeroDash />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Bank deposit</CardTitle>
            <CardDescription>The deposit posts to {entry.clearingAccountCode ?? "clearing"} from the bank side, through the review queue.</CardDescription>
          </div>
        </CardHeader>
        {detail.linkedDeposits.length > 0 ? (
          <ul>
            {detail.linkedDeposits.map((d) => (
              <li key={d.id} className="rule-row flex flex-wrap items-baseline gap-3 px-4 py-2 text-sm last:border-0">
                <span className="num w-28 text-xs text-muted-foreground">{longDate(d.date)}</span>
                <span className="min-w-0 flex-1 truncate">{d.description}</span>
                <Money cents={d.amountCents} currency plain className="font-medium" />
              </li>
            ))}
          </ul>
        ) : detail.candidates.length > 0 ? (
          <>
            <p className="px-4 pt-3 text-xs text-muted-foreground">
              {detail.candidates.length === 1 ? "One deposit matches" : `${detail.candidates.length} deposits match`} this net to the
              cent. Link the one that paid it.
            </p>
            <ul className="mt-1">
              {detail.candidates.map((d) => (
                <li key={d.id} className="rule-row flex flex-wrap items-center gap-3 px-4 py-2 text-sm last:border-0">
                  <span className="num w-28 text-xs text-muted-foreground">{longDate(d.date)}</span>
                  <span className="min-w-0 flex-1 truncate">{d.description}</span>
                  <Money cents={d.amountCents} currency plain className="font-medium" />
                  {canLink ? <LinkDepositButton payoutId={row.id} deposit={d} /> : null}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No bank deposit of exactly <Money cents={row.netCents} currency plain /> from {name} yet
            {row.depositState === "waiting" ? "; it is normally a few days behind the settlement." : ". Import the bank statement that covers it."}
          </p>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Settlement lines</CardTitle>
            <CardDescription>As the file states them, with the account each one {posted ? "posted" : "posts"} to.</CardDescription>
          </div>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Lines of {label}</caption>
            <thead>
              <tr>
                <Th className="w-10 text-right">#</Th>
                <Th className="w-32">Type</Th>
                <Th>Description</Th>
                <Th className="w-28 text-right">Amount</Th>
                <Th className="w-56">Account</Th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((line) => (
                <tr key={line.lineNo}>
                  <Td className="rule-row num text-right text-xs text-muted-foreground">{line.lineNo}</Td>
                  <Td className="rule-row text-xs whitespace-nowrap">{LINE_TYPE_LABEL[line.lineType] ?? line.lineType}</Td>
                  <Td className="rule-row text-xs">
                    <span>{line.label}</span>
                    {line.externalRef === null ? null : <span className="num ml-2 text-muted-foreground">{line.externalRef}</span>}
                    {line.jurisdiction === null ? null : <span className="ml-2 text-muted-foreground">{line.jurisdiction}</span>}
                  </Td>
                  <Td className="rule-row text-right">
                    <Money cents={line.amountCents} />
                  </Td>
                  <Td className="rule-row text-xs">
                    {line.facilitator ? (
                      <span className="text-muted-foreground italic">
                        Pass-through · not posted{line.taxSide === null ? "" : ` (${line.taxSide})`}
                      </span>
                    ) : line.accountCode === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className={cn(line.suspense && "text-warning")}>
                        <span className="num mr-1.5 text-muted-foreground">{line.accountCode}</span>
                        {line.accountName}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {issues.length === 0 ? null : (
        <Card>
          <CardHeader>
            <CardTitle>Import notes</CardTitle>
          </CardHeader>
          <ul className="flex flex-col gap-1.5 px-4 py-3">
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="flex gap-2 text-xs">
                <TriangleAlert className={cn("mt-0.5 size-3.5 shrink-0", issue.severity === "warn" ? "text-warning" : "text-negative")} aria-hidden />
                <span>
                  {issue.message}
                  {issue.remedy === null ? null : <span className="text-muted-foreground"> {issue.remedy}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

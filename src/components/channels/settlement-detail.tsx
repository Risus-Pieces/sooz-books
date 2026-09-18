import * as React from "react";
import Link from "next/link";

import { FlowDiagram } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { DetailPane } from "@/components/ui/detail-pane";
import { Glyph } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";

import { DepositPill, Disclosure, EntryLines, PROVIDER_BADGE, PostedPill, Table, settlementRef, Td, Th, entryFlow, longDate, shortDate } from "./parts";
import { LinkDepositButton, PostSettlementButton, UnpostSettlementButton } from "./settlement-actions";
import { PROVIDER_NAME, type SettlementDetailView } from "./types";

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

const RETURNS = new Set(["refund", "chargeback", "chargeback_reversal"]);
const DISCOUNTS = new Set(["discount", "coupon", "promotion_rebate"]);
const TAX = new Set(["sales_tax_collected"]);

/**
 * Gross, fees, and what sits between them and the net: returns, discounts, sales tax, and the rest
 * (tips, shipping, adjustments) as Other, taken as the remainder so the column always foots to Net.
 */
function summaryRows(
  row: SettlementDetailView["row"],
  lines: SettlementDetailView["lines"],
): Array<{ label: string; cents: number }> {
  const sum = (types: ReadonlySet<string>) =>
    lines.reduce((total, line) => (types.has(line.lineType) && !line.facilitator ? total + line.amountCents : total), 0);
  const returns = sum(RETURNS);
  const discounts = sum(DISCOUNTS);
  const tax = sum(TAX);
  const other = row.netCents - row.grossCents - row.feesCents - returns - discounts - tax;
  return [
    { label: "Gross sales", cents: row.grossCents },
    { label: "Returns", cents: returns },
    { label: "Discounts", cents: discounts },
    { label: "Sales tax", cents: tax },
    { label: "Other", cents: other },
    { label: "Fees", cents: row.feesCents },
  ].filter((line, index) => index === 0 || line.label === "Fees" || line.cents !== 0);
}

/**
 * One settlement: its header, the entry posting writes (or wrote) drawn as a flow, the facts as
 * grouped rows, the bank deposit that pays it, and one primary action. The same content fills the
 * detail pane beside the Payouts list and the settlement's own page.
 */
export function SettlementDetail({
  detail,
  canPost,
  canLink,
  variant,
}: {
  detail: SettlementDetailView;
  canPost: boolean;
  canLink: boolean;
  /** `pane` beside the list (links to the full page); `page` shows every line. */
  variant: "pane" | "page";
}) {
  const { row, entry, identity } = detail;
  const name = PROVIDER_NAME[row.provider];
  const badge = PROVIDER_BADGE[row.provider];
  const label = `${name} settlement ${row.key ?? ""}`.trim();
  const posted = entry.kind === "posted";
  const suspenseLines = detail.lines.filter((l) => l.suspense);
  const facilitatorLines = detail.lines.filter((l) => l.facilitator);
  const issues = detail.issues.filter((i) => i.severity !== "info");
  const flow = entryFlow(entry.lines, { label: `${name} sales`, glyph: "tag", tint: "green" });
  const period =
    row.periodStart !== null && row.periodStart !== row.periodEnd ? `${shortDate(row.periodStart)} – ${longDate(row.periodEnd)}` : longDate(row.periodEnd);

  const actions = (
    <>
      {posted ? (
        <>
          {row.entryId === null ? null : (
            <Button asChild variant="secondary">
              <Link href={`/ledger/${row.entryId}`}>
                <Glyph name="book" />
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
      {variant === "pane" ? (
        <Button asChild variant={posted || !canPost ? "secondary" : "ghost"}>
          <Link href={`/channels/payouts/${row.id}`}>
            Details
            <Glyph name="chevron-right" />
          </Link>
        </Button>
      ) : null}
    </>
  );

  return (
    <DetailPane
      leading={<IconBadge glyph={badge.glyph} tint={badge.tint} size="xl" className="size-14 rounded-[14px] [&_svg]:size-7" />}
      title={name}
      meta={[period, <span key="key" className="num">{settlementRef(row.key)}</span>]}
      amount={<Money cents={row.netCents} currency plain />}
      status={
        <div className="flex flex-wrap gap-1.5">
          <PostedPill entryNo={row.entryNo} />
          <DepositPill state={row.depositState} />
          {identity.ties ? (
            <Pill tone="green" glyph="check">
              Ties
            </Pill>
          ) : (
            <Pill tone="red" glyph="xmark">
              {identity.differenceCents === null ? "No total" : "Off"}
            </Pill>
          )}
        </div>
      }
      actions={actions}
    >
      {entry.refusal === null ? null : (
        <div className="flex gap-2.5 rounded-[14px] bg-tint-red/10 px-4 py-3 text-sm text-ink-red">
          <Glyph name="exclude" size={17} className="mt-px shrink-0" />
          <div>
            <p className="font-semibold">{entry.refusal.message}</p>
            {entry.refusal.remedy === null ? null : <p className="mt-0.5">{entry.refusal.remedy}</p>}
          </div>
        </div>
      )}

      {flow.to.length > 0 ? (
        <div className="rounded-[14px] bg-card px-5 py-[18px] shadow-card max-sm:px-4">
          <FlowDiagram from={flow.from} to={flow.to} fromCaption={flow.creditCount > 1 ? `Credit · ${flow.creditCount} accounts` : "Credit"} />
        </div>
      ) : null}

      <InsetGroup>
        {/* The summary foots: every row between Gross and Net is shown, so the column adds up. */}
        {summaryRows(row, detail.lines).map((line) => (
          <GroupRow key={line.label} label={line.label}>
            <Money cents={line.cents} currency plain className="text-label" />
          </GroupRow>
        ))}
        <GroupRow label={<span className="font-semibold">Net</span>} className="before:left-0 before:border-[color:var(--sep-strong)]">
          <Money cents={row.netCents} currency plain className="font-semibold text-label" />
        </GroupRow>
        <GroupRow
          label={
            <span className="inline-flex items-center gap-1">
              Lines
              <InfoButton label="About the identity check">
                <p>
                  The settlement&apos;s {detail.lines.length} lines add to {dollars(identity.linesCents)}.{" "}
                  {identity.reportedCents === null ? "The file states no total to check them against." : `${name} reports ${dollars(identity.reportedCents)}.`}
                </p>
              </InfoButton>
            </span>
          }
        >
          <span className={cn("inline-flex items-center gap-1.5", identity.ties ? "text-ink-green" : "text-ink-red")}>
            <Glyph name={identity.ties ? "check-circle" : "xmark-circle"} size={15} />
            {identity.ties ? (
              <span className="num">{detail.lines.length}</span>
            ) : identity.differenceCents === null ? (
              "No total"
            ) : (
              <Money cents={identity.differenceCents} currency plain signed />
            )}
          </span>
        </GroupRow>
        {entry.clearingAccountCode === null ? null : (
          <GroupRow label="Clearing">
            <span className="num text-xs">{entry.clearingAccountCode}</span>
            <Money cents={entry.clearingCents} currency plain className="text-label" />
          </GroupRow>
        )}
      </InsetGroup>

      {entry.facilitatorGrossCents > 0 || suspenseLines.length > 0 || entry.suspenseCents !== 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {entry.facilitatorGrossCents > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Pill tone="neutral" glyph="percent">
                Pass-through <Money cents={entry.facilitatorGrossCents} currency plain />
              </Pill>
              <InfoButton label="About pass-through tax">
                <p>
                  Marketplace-facilitator tax ({facilitatorLines.length} line{facilitatorLines.length === 1 ? "" : "s"}) is left out: {name}{" "}
                  collected and remitted it, so it never reaches 2200.
                </p>
              </InfoButton>
            </span>
          ) : null}
          {entry.suspenseCents !== 0 || suspenseLines.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Pill tone="orange" glyph="question">
                Unrecognised <Money cents={entry.suspenseCents} currency plain />
              </Pill>
              <InfoButton label="About unrecognised lines">
                <p>
                  {suspenseLines.length} line{suspenseLines.length === 1 ? "" : "s"} the importer did not recognise go to 7900 Ask My
                  Accountant. Reclassify before the close.
                </p>
              </InfoButton>
            </span>
          ) : null}
        </div>
      ) : null}

      {detail.taxLines.length === 0 ? null : (
        <InsetGroup header="Sales tax" separatorInset={16}>
          {detail.taxLines.map((t) => (
            <GroupRow
              key={t.state ?? "none"}
              label={t.state ?? `Not named${detail.defaultTaxState === null ? "" : ` · ${detail.defaultTaxState}`}`}
            >
              {t.facilitatorCents !== 0 ? (
                <span className="text-xs">
                  pass-through <Money cents={t.facilitatorCents} plain />
                </span>
              ) : null}
              {t.foreignCents !== 0 ? (
                <span className="text-xs">
                  non-US <Money cents={t.foreignCents} plain />
                </span>
              ) : null}
              <Money cents={t.collectedCents} currency plain className="text-label" />
            </GroupRow>
          ))}
        </InsetGroup>
      )}

      <InsetGroup
        header="Deposit"
        headerAccessory={
          <InfoButton label="About the deposit">
            <p>
              The deposit posts to {entry.clearingAccountCode ?? "clearing"} from the bank side, through Review, and takes the account back to
              zero.
            </p>
          </InfoButton>
        }
      >
        {detail.linkedDeposits.length > 0 ? (
          detail.linkedDeposits.map((d) => (
            <GroupRow
              key={d.id}
              label={
                <span className="flex items-center gap-2">
                  <Glyph name="check-circle" size={16} className="text-ink-green" />
                  {longDate(d.date)}
                </span>
              }
            >
              <span className="hidden max-w-56 truncate text-xs lg:inline">{d.description}</span>
              <Money cents={d.amountCents} currency plain className="text-label" />
            </GroupRow>
          ))
        ) : detail.candidates.length > 0 ? (
          detail.candidates.map((d) => (
            <GroupRow key={d.id} label={longDate(d.date)}>
              <span className="hidden max-w-48 truncate text-xs lg:inline">{d.description}</span>
              <Money cents={d.amountCents} currency plain className="text-label" />
              {canLink ? <LinkDepositButton payoutId={row.id} deposit={d} /> : null}
            </GroupRow>
          ))
        ) : (
          <GroupRow label={<span className="text-label2">{row.depositState === "waiting" ? "In transit" : "Not in bank yet"}</span>}>
            <Money cents={row.netCents} currency plain />
          </GroupRow>
        )}
      </InsetGroup>

      {issues.length === 0 ? null : (
        <InsetGroup header="Notes">
          {issues.map((issue, index) => (
            <div key={`${issue.code}-${index}`} className={cn("flex gap-2.5 px-4 py-2.5 text-sm", index > 0 && "hairline-t")}>
              <Glyph name="warning" size={16} className={cn("mt-px shrink-0", issue.severity === "warn" ? "text-ink-orange" : "text-ink-red")} />
              <span className="leading-[1.4]">
                {issue.message}
                {issue.remedy === null ? null : <span className="text-label2"> {issue.remedy}</span>}
              </span>
            </div>
          ))}
        </InsetGroup>
      )}

      {entry.lines.length === 0 ? null : (
        <div className="overflow-hidden rounded-[14px] bg-card shadow-card">
          <Disclosure
            summary={
              <>
                {posted ? `Entry #${row.entryNo ?? ""}` : "Entry"}
                <span className="font-normal text-label2">· {entry.lines.length} lines</span>
              </>
            }
          >
            <div className="pb-2">
              <p className="px-5 pb-2 text-xs text-label2 max-sm:px-4">
                {entry.date === null ? "" : `${longDate(entry.date)} · `}
                {entry.memo}
              </p>
              <EntryLines lines={entry.lines} caption={posted ? "Posted entry" : "Entry to be posted"} highlightCode={entry.clearingAccountCode} />
            </div>
          </Disclosure>
        </div>
      )}

      {variant === "page" && detail.lines.length > 0 ? (
        <div className="overflow-hidden rounded-[14px] bg-card shadow-card">
          <Disclosure
            summary={
              <>
                Settlement lines
                <span className="font-normal text-label2">· {detail.lines.length}</span>
              </>
            }
          >
            <Table caption={`Lines of ${label}`} className="min-w-[40rem]">
              <thead>
                <tr>
                  <Th className="w-10" align="right">
                    #
                  </Th>
                  <Th>Type</Th>
                  <Th>Description</Th>
                  <Th align="right">Amount</Th>
                  <Th>Account</Th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => (
                  <tr key={line.lineNo}>
                    <Td align="right" className="rule-row num text-xs text-label2">
                      {line.lineNo}
                    </Td>
                    <Td className="rule-row text-xs whitespace-nowrap">{LINE_TYPE_LABEL[line.lineType] ?? line.lineType}</Td>
                    <Td className="rule-row text-xs">
                      {line.label}
                      {line.externalRef === null ? null : <span className="num ml-2 text-label2">{line.externalRef}</span>}
                      {line.jurisdiction === null ? null : <span className="ml-2 text-label2">{line.jurisdiction}</span>}
                    </Td>
                    <Td align="right" className="rule-row">
                      <Money cents={line.amountCents} plain />
                    </Td>
                    <Td className="rule-row text-xs">
                      {line.facilitator ? (
                        <span className="text-label2">Pass-through{line.taxSide === null ? "" : ` · ${line.taxSide}`}</span>
                      ) : line.accountCode === null ? (
                        <span className="text-label2">—</span>
                      ) : (
                        <span className={cn(line.suspense && "text-ink-orange")}>
                          <span className="num mr-1.5 text-label2">{line.accountCode}</span>
                          {line.accountName}
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Disclosure>
        </div>
      ) : null}

      {variant === "page" && row.filename !== null ? (
        <p className="flex items-center gap-1.5 px-1 text-xs text-label2">
          <Glyph name="doc" size={13} />
          <span className="truncate">{row.filename}</span>
        </p>
      ) : null}
    </DetailPane>
  );
}

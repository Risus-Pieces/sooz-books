import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SplitBar } from "@/components/charts";
import { PostDocButton } from "@/components/arap/doc-buttons";
import {
  FlowCard,
  SettledBar,
  trimQuantity,
} from "@/components/arap/doc-preview";
import {
  DocStatusBadge,
  NumbersTable,
  Td,
  Th,
} from "@/components/arap/doc-status";
import { billFlow, splitAccountLabel } from "@/components/arap/flows";
import { termsLabel } from "@/components/arap/math";
import { VoidButton } from "@/components/arap/void-button";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { GroupRow, InsetGroup, ListRow } from "@/components/ui/inset-group";
import { Monogram } from "@/components/ui/monogram";
import { Money, formatCents } from "@/components/ui/money";
import { ToolbarGroup, ToolbarLink } from "@/components/ui/toolbar";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { daysBetween, today } from "@/lib/dates";
import { categoryForCode } from "@/lib/ui/categories";
import { dollars, mediumDate, shortDate } from "@/lib/ui/format";

import { approveBillAction, voidBillAction } from "../../actions";
import { billDetail } from "../../queries";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ billId: string }>;
}): Promise<Metadata> {
  const { billId } = await params;
  const bill = await billDetail(billId);
  return {
    title: bill === null ? "Bill" : `${bill.vendorName} ${bill.billNo}`,
  };
}

export default async function BillPage({
  params,
}: {
  params: Promise<{ billId: string }>;
}) {
  const [user, { billId }] = await Promise.all([requireUser(), params]);
  const bill = await billDetail(billId);
  if (bill === null) notFound();

  const canManage = can(user.role, "ap.manage");
  const canPay = can(user.role, "ap.pay");
  const now = today();
  const open = bill.status === "open" || bill.status === "partial";
  const draft = bill.status === "draft";
  const daysOverdue =
    open && bill.dueDate < now ? daysBetween(bill.dueDate, now) : 0;
  const settled = bill.paidCents + bill.creditedCents;
  const showQty = bill.lines.some((l) => l.quantity !== null);
  const expensed = bill.totalCents - bill.inventoryCents;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        back={{ href: "/purchases/bills", label: "Bills" }}
        phoneTitleRow
        title={bill.billNo}
        subtitle={
          <DocStatusBadge status={bill.status} daysOverdue={daysOverdue} />
        }
        info={
          draft ? (
            <p>
              Not in the books yet. Approving posts each line to its account
              (inventory lines to the balance sheet) against 2000 Accounts
              Payable, with {bill.vendorName} on every line.
            </p>
          ) : (
            <p>
              An approved bill is in Accounts Payable until it is paid. It is
              corrected only by voiding it, which posts a reversal on the date
              you choose.
            </p>
          )
        }
        actions={
          <>
            {canManage && draft ? (
              <ToolbarGroup>
                <ToolbarLink
                  href={`/purchases/bills/${bill.id}/edit`}
                  glyph="pencil"
                  label="Edit draft"
                />
                <VoidButton
                  label="Discard draft"
                  glyph="trash"
                  docNo={bill.billNo}
                  consequence="The draft becomes void. Nothing was posted, so nothing is reversed."
                  minDate={bill.billDate}
                  defaultDate={now}
                  needsDate={false}
                  onVoid={voidBillAction.bind(null, bill.id)}
                />
              </ToolbarGroup>
            ) : null}
            {canManage && open && settled === 0 ? (
              <ToolbarGroup>
                <VoidButton
                  label="Void bill"
                  docNo={bill.billNo}
                  consequence={`Posts a reversal of ${bill.vendorName} ${bill.billNo} on the date you choose, taking ${formatCents(bill.totalCents, { currency: true })} back out of Accounts Payable and out of inventory or expense.`}
                  minDate={bill.billDate}
                  defaultDate={now}
                  needsDate
                  onVoid={voidBillAction.bind(null, bill.id)}
                />
              </ToolbarGroup>
            ) : null}
            {canManage && draft ? (
              <PostDocButton
                label="Approve bill"
                done="approved"
                icon="approve"
                confirmText={`Approve ${bill.vendorName} bill ${bill.billNo}? It posts ${formatCents(bill.totalCents, { currency: true })} to Accounts Payable and can only be corrected by voiding it.`}
                onPost={approveBillAction.bind(null, bill.id)}
              />
            ) : null}
            {canPay && open ? (
              <Button asChild>
                <Link
                  href={`/purchases/payments/new?vendor=${bill.vendorId}&bill=${bill.id}`}
                >
                  <Glyph name="dollar" size={15} />
                  Pay bill
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-3.5 max-md:gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-3.5 max-md:gap-3">
          <Card className="overflow-hidden">
            <header className="flex items-center gap-4 px-5 pt-5 pb-4 max-sm:px-4">
              <Monogram name={bill.vendorName} size="lg" />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[1.625rem] leading-[1.15] font-bold tracking-[-0.024em] max-sm:text-2xl">
                  {bill.vendorName}
                </h2>
                <p className="mt-[3px] text-sm font-medium text-label2">
                  <span className="num">{bill.billNo}</span> ·{" "}
                  {mediumDate(bill.billDate)}
                </p>
              </div>
              <Money
                cents={bill.totalCents}
                currency
                plain
                className="shrink-0 text-4xl font-bold tracking-[-0.03em] max-sm:text-2xl"
              />
            </header>

            <dl className="grid grid-cols-4 gap-4 hairline-t px-5 py-3.5 text-sm max-sm:grid-cols-2 max-sm:px-4">
              <Fact label="Due">
                <span className={daysOverdue > 0 ? "text-ink-red" : undefined}>
                  {mediumDate(bill.dueDate)}
                </span>
              </Fact>
              <Fact label="Terms">{termsLabel(bill.termsDays)}</Fact>
              <Fact label="Our PO">{bill.poNumber ?? "—"}</Fact>
              <Fact label="Open">
                <Money
                  cents={
                    draft || bill.status === "void" ? 0 : bill.balanceCents
                  }
                  currency
                  plain
                />
              </Fact>
            </dl>

            <NumbersTable
              caption="Bill lines"
              minWidth="min-w-[36rem]"
              className="hairline-t"
              head={
                <>
                  <Th>Description</Th>
                  <Th>Account</Th>
                  {showQty ? <Th align="right">Qty × cost</Th> : null}
                  <Th align="right">Amount</Th>
                </>
              }
              foot={
                <tr>
                  <td
                    colSpan={showQty ? 3 : 2}
                    className="px-5 py-2.5 font-semibold max-sm:px-4"
                  >
                    Total
                  </td>
                  <td className="px-5 py-2.5 text-right font-semibold max-sm:px-4">
                    <Money cents={bill.totalCents} currency plain />
                  </td>
                </tr>
              }
            >
              {bill.lines.map((line) => {
                const { code, name } = splitAccountLabel(line.accountLabel);
                const category = categoryForCode(code);
                return (
                  <tr key={line.lineNo}>
                    <Td className="font-medium">{line.description}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <Dot tint={category.tint} size={7} />
                        <span className="num text-label2">{code}</span> {name}
                        {line.isInventory ? (
                          <span
                            className="text-tint-teal"
                            title="Capitalized to inventory"
                          >
                            <Glyph name="cube" size={12} />
                            <span className="sr-only">Inventory</span>
                          </span>
                        ) : null}
                      </span>
                    </Td>
                    {showQty ? (
                      <Td
                        align="right"
                        className="num whitespace-nowrap text-label2"
                      >
                        {line.quantity !== null && line.unitCostCents !== null
                          ? `${trimQuantity(line.quantity)} × ${dollars(line.unitCostCents)}`
                          : ""}
                      </Td>
                    ) : null}
                    <Td align="right">
                      <Money cents={line.amountCents} currency plain />
                    </Td>
                  </tr>
                );
              })}
            </NumbersTable>
            {bill.memo ? (
              <p className="hairline-t px-5 py-3 text-sm text-label2 max-sm:px-4">
                {bill.memo}
              </p>
            ) : null}
          </Card>
          {bill.status !== "void" ? (
            <FlowCard
              flow={billFlow(bill)}
              caption={draft ? "Approving posts" : "Posted"}
            />
          ) : null}
        </div>

        <div className="flex flex-col gap-3.5 max-md:gap-3 xl:sticky xl:top-[72px]">
          {open ? (
            <Card className="flex flex-col gap-3 px-5 pt-4 pb-5 max-sm:px-4">
              <SettledBar
                settledCents={settled}
                openCents={bill.balanceCents}
              />
            </Card>
          ) : null}

          {bill.inventoryCents > 0 ? (
            <Card className="flex flex-col gap-2.5 px-5 py-4 max-sm:px-4">
              <SplitBar
                label={`Inventory ${dollars(bill.inventoryCents)}, expensed ${dollars(expensed)}`}
                segments={[
                  {
                    label: "Inventory",
                    value: bill.inventoryCents,
                    tint: "teal",
                  },
                  {
                    label: "Expense",
                    value: Math.max(0, expensed),
                    tint: "gray",
                  },
                ]}
              />
              <div
                aria-hidden
                className="flex justify-between gap-3 text-xs font-medium text-label2"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Dot tint="teal" size={7} />
                  Inventory{" "}
                  <Money
                    cents={bill.inventoryCents}
                    currency
                    plain
                    className="text-label"
                  />
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Dot tint="gray" size={7} />
                  Expense{" "}
                  <Money
                    cents={expensed}
                    currency
                    plain
                    className="text-label"
                  />
                </span>
              </div>
            </Card>
          ) : null}

          <InsetGroup>
            <GroupRow
              label="Vendor"
              href={`/purchases/bills?vendor=${bill.vendorId}`}
            >
              <span className="truncate">{bill.vendorName}</span>
            </GroupRow>
            {bill.journalEntryId ? (
              <GroupRow label="Ledger" href={`/ledger/${bill.journalEntryId}`}>
                <span className="num">Entry #{bill.journalEntryNo}</span>
              </GroupRow>
            ) : (
              <GroupRow label="Ledger">Not posted</GroupRow>
            )}
          </InsetGroup>

          {bill.settlements.length > 0 ? (
            <InsetGroup header="Payments" separatorInset={34}>
              {bill.settlements.map((s) => (
                <ListRow
                  key={`${s.kind}-${s.id}-${s.date}-${s.amountCents}`}
                  href={
                    s.kind === "bill_payment"
                      ? `/purchases/payments/${s.id}`
                      : undefined
                  }
                  leading={<Dot tint={s.void ? "quiet" : "green"} />}
                  title={<span className="num">{s.docNo}</span>}
                  subtitle={
                    <>
                      {shortDate(s.date)}
                      {s.void ? " · void" : ""}
                    </>
                  }
                  trailing={
                    <Money
                      cents={s.amountCents}
                      currency
                      plain
                      className={s.void ? "line-through opacity-60" : undefined}
                    />
                  }
                />
              ))}
            </InsetGroup>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-label2">{label}</dt>
      <dd className="mt-0.5 truncate font-medium">{children}</dd>
    </div>
  );
}

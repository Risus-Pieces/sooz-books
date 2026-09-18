import type { Metadata } from "next";
import Link from "next/link";

import { SplitBar } from "@/components/charts";
import { shortDate } from "@/components/trade/labels";
import { RemittanceImportButton, RemittanceImportProvider } from "@/components/trade/remittance-import";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { LegendItem } from "@/components/ui/icon-badge";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { StatTile } from "@/components/ui/stat-tile";
import { IconBadge } from "@/components/ui/icon-badge";
import { ToolbarGroup } from "@/components/ui/toolbar";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";

import { remittanceFormOptions, remittanceRows } from "../queries";

export const metadata: Metadata = {
  title: "Remittances",
};

/**
 * Distributor payments. A remittance explains a short payment line by line; importing it posts
 * one entry per payment that relieves AR at full gross, books the cash, and parks every claim that
 * is not already-accrued trade spend in Deductions Receivable for the workbench.
 */
export default async function RemittancesPage() {
  const user = await requireUser("/trade/remittances");
  const canManage = can(user.role, "trade.manage");
  const rows = await remittanceRows();
  const options = canManage ? await remittanceFormOptions() : null;
  const totals = rows.reduce(
    (acc, r) => ({ gross: acc.gross + r.invoicesGrossCents, deducted: acc.deducted + r.deductionsCents, cash: acc.cash + r.totalCents }),
    { gross: 0, deducted: 0, cash: 0 },
  );

  return (
    <RemittanceImportProvider options={options} canPost={canManage}>
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar
          title="Remittances"
          subtitle={
            rows.length === 0 ? undefined : (
              <>
                {rows.length} · <Money cents={totals.cash} currency plain />
              </>
            )
          }
          info={
            <>
              <p>What each distributor paid, what it paid for, and what it kept.</p>
              <p>Revenue is never booked net: AR is relieved at full gross and each deduction is booked on its own line. A payment imported twice is skipped, never merged.</p>
            </>
          }
          actions={
            options !== null ? (
              <ToolbarGroup>
                <RemittanceImportButton />
              </ToolbarGroup>
            ) : undefined
          }
        />

        {rows.length === 0 ? (
          <div className="rounded-2xl bg-card shadow-card max-md:rounded-[22px]">
            <EmptyState
              glyph="doc-text"
              title="No remittances yet"
              description="Sooz has no distributor yet; the first KeHE or UNFI payment will arrive with a remittance file. Import it and each payment is split into cash, AR relieved, trade spend and deductions before it posts."
              action={<RemittanceImportButton appearance="button" label="Import" />}
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3.5 max-md:gap-3 lg:grid-cols-3">
              <StatTile label="Invoiced" badge={<IconBadge glyph="doc-text" tint="green" />} value={<Money cents={totals.gross} currency plain />} />
              <StatTile label="Deducted" badge={<IconBadge glyph="flag" tint="orange" />} value={<Money cents={totals.deducted} currency plain />} />
              <StatTile
                label="Cash"
                badge={<IconBadge glyph="bank" tint="blue" />}
                value={<Money cents={totals.cash} currency plain />}
                className="max-lg:col-span-2"
                sparkline={
                  <SplitBar
                    label={`Cash ${dollars(totals.cash)}, deducted ${dollars(totals.deducted)}`}
                    segments={[
                      { label: "Cash", value: totals.cash, tint: "blue" },
                      { label: "Deducted", value: totals.deducted, tint: "orange" },
                    ]}
                  />
                }
              />
            </div>

            <section aria-labelledby="payments">
              <div className="flex items-center gap-3 px-4 pt-3 pb-1.5">
                <h2 id="payments" className="flex-1 text-sm font-semibold text-label2">
                  Payments
                </h2>
                <LegendItem tint="blue">Cash</LegendItem>
                <LegendItem tint="orange">Deducted</LegendItem>
              </div>
              <ul className="overflow-hidden rounded-[14px] bg-card shadow-card">
                {rows.map((r, index) => (
                  <li key={r.id} className={cn("relative flex min-h-16 items-center gap-3 px-4 py-2.5", index > 0 && "before:absolute before:top-0 before:right-0 before:left-[63px] before:border-t-[0.5px] before:border-sep")}>
                    <Monogram name={r.customerName} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="num min-w-0 flex-1 truncate text-sm font-semibold max-sm:text-lg max-sm:font-medium">
                          {r.sourceSystem} {r.paymentNumber}
                        </span>
                        <Money cents={r.totalCents} currency plain className="shrink-0 text-sm font-semibold max-sm:text-lg" />
                      </span>
                      <span className="mt-1 flex items-center gap-3">
                        <span className="min-w-0 flex-1">
                          <SplitBar
                            className="h-1.5"
                            label={`Invoices ${dollars(r.invoicesGrossCents)}: cash ${dollars(r.totalCents)}, deducted ${dollars(r.deductionsCents)}`}
                            segments={[
                              { label: "Cash", value: r.totalCents, tint: "blue" },
                              { label: "Deducted", value: r.deductionsCents, tint: "orange" },
                            ]}
                          />
                        </span>
                        <span className="shrink-0 text-xs text-label2">{shortDate(r.remittanceDate)}</span>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-label2 max-sm:text-sm">
                        <span className="truncate">{r.customerName}</span>
                        <Link href="/trade/deductions" className="inline-flex min-h-6 items-center gap-1 font-medium text-ink-blue hover:underline">
                          {r.deductionCount} {r.deductionCount === 1 ? "deduction" : "deductions"}
                        </Link>
                        {r.warningCount > 0 ? (
                          <span className="inline-flex items-center gap-1 font-medium text-ink-orange">
                            <Glyph name="warning" size={12} />
                            {r.warningCount}
                          </span>
                        ) : null}
                        {r.entryId !== null ? (
                          <Link href={`/ledger/${r.entryId}`} className="num inline-flex min-h-6 items-center font-medium text-ink-blue hover:underline">
                            #{r.entryNo}
                          </Link>
                        ) : (
                          <span className="font-medium text-ink-orange">Not posted</span>
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </RemittanceImportProvider>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import { SplitBar } from "@/components/charts";
import { Table, Td, Th, longDate, monthShortName } from "@/components/channels/parts";
import { FileReturnButton, PayReturnButton } from "@/components/channels/sales-tax-actions";
import type { LiabilityRowView } from "@/components/channels/types";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { IconBadge, LegendItem } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { StatTile } from "@/components/ui/stat-tile";
import { ToolbarGroup } from "@/components/ui/toolbar";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";

import { bankOptions, filings, liability } from "../queries";

export const metadata: Metadata = {
  title: "Sales tax",
};

interface StateTotal {
  state: string;
  owedCents: number;
  unfiledCents: number;
  facilitatorCents: number;
  months: number;
}

/** The register rolled up to one row per state, largest first. */
function byState(rows: readonly LiabilityRowView[]): StateTotal[] {
  const states = new Map<string, StateTotal>();
  for (const r of rows) {
    const t = states.get(r.state) ?? { state: r.state, owedCents: 0, unfiledCents: 0, facilitatorCents: 0, months: 0 };
    t.owedCents += r.owedCents;
    t.unfiledCents += r.unfiledOwedCents;
    t.facilitatorCents += r.facilitatorCents;
    t.months += 1;
    states.set(r.state, t);
  }
  return [...states.values()].sort((a, b) => b.owedCents + b.facilitatorCents - (a.owedCents + a.facilitatorCents));
}

/**
 * Sales tax by state: one bar per state split into filed, unfiled and marketplace pass-through,
 * then the month-by-month register with its File buttons, then the returns. What Sooz owes is kept
 * apart from what a marketplace collected and remitted itself.
 */
export default async function SalesTaxPage() {
  const user = await requireUser("/channels/sales-tax");
  const report = await liability({});
  const returns = await filings();
  const banks = await bankOptions();
  const canFile = can(user.role, "ledger.post");
  const owedRows = [...report.rows].filter((r) => r.taxCents !== 0 || r.owedCents !== 0 || r.facilitatorCents !== 0).reverse();
  const filedUnpaid = returns.filter((f) => f.entryId === null).reduce((sum, f) => sum + f.taxDueCents, 0);
  const states = byState(report.rows);
  const max = Math.max(1, ...states.map((s) => s.owedCents + s.facilitatorCents));
  const differs = report.differenceCents !== 0;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Sales tax"
        subtitle={
          report.totals.unfiledOwedCents === 0 ? undefined : (
            <>
              <Money cents={report.totals.unfiledOwedCents} currency plain /> unfiled
            </>
          )
        }
        info={
          <>
            <p>What Sooz collected and owes each state, month by month, from the register every settlement and invoice writes to.</p>
            <p>
              Tax a marketplace collected and remitted itself is shown apart: it goes on the return as marketplace sales, but it is never
              owed and never in 2200.
            </p>
          </>
        }
        actions={
          canFile ? (
            <ToolbarGroup>
              <FileReturnButton state="TX" period={null} owedCents={null} appearance="toolbar" label="Record filed return" />
            </ToolbarGroup>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3.5 max-md:gap-3 lg:grid-cols-4">
        <StatTile
          label="Unfiled"
          badge={<IconBadge glyph="clock" tint="orange" />}
          value={<Money cents={report.totals.unfiledOwedCents} currency plain />}
        />
        <StatTile
          label="Filed, unpaid"
          badge={<IconBadge glyph="doc-text" tint="blue" />}
          value={<Money cents={filedUnpaid} currency plain />}
        />
        <StatTile
          label="Payable"
          hint="2200"
          badge={<IconBadge glyph="percent" tint="gray" />}
          value={<Money cents={report.ledgerPayableCents} currency plain />}
        />
        <StatTile
          label="Ledger check"
          badge={<IconBadge glyph={differs ? "warning" : "check"} tint={differs ? "orange" : "green"} />}
          value={
            differs ? (
              <Money cents={report.differenceCents} currency signed plain className="text-ink-orange" />
            ) : (
              <span className="text-ink-green">Agrees</span>
            )
          }
          footer={
            differs ? (
              <span className="inline-flex items-center gap-1">
                Register vs 2200
                <InfoButton label="About the difference">
                  <p>
                    2200 and the register disagree by {dollars(report.differenceCents)}: tax posted without a register entry (non-US tax, or a
                    manual journal entry), or the reverse. Find it before filing.
                  </p>
                </InfoButton>
              </span>
            ) : undefined
          }
        />
      </div>

      {states.length === 0 ? (
        <div className="rounded-2xl bg-card shadow-card max-md:rounded-[22px]">
          <EmptyState
            glyph="percent"
            title="No sales tax yet"
            description="It arrives when a settlement posts (Square tax is Texas tax) or an invoice charges it. Square's settlements are the missing piece."
            action={
              <Button asChild>
                <Link href="/channels/payouts">Payouts</Link>
              </Button>
            }
          />
        </div>
      ) : (
        <section aria-labelledby="by-state" className="rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id="by-state" className="flex-1 text-lg font-semibold tracking-[-0.01em]">
              By state
            </h2>
            <div className="flex gap-3.5">
              <LegendItem tint="green">Filed</LegendItem>
              <LegendItem tint="orange">Unfiled</LegendItem>
              <LegendItem tint="gray">Pass-through</LegendItem>
            </div>
          </div>
          <ul className="flex flex-col">
            {states.map((s, index) => {
              const total = s.owedCents + s.facilitatorCents;
              const width = Math.max(1.5, Math.round((total / max) * 1000) / 10);
              return (
                <li key={s.state} className={cn("grid grid-cols-[2.75rem_minmax(0,1fr)_6.5rem] items-center gap-3 py-2.5", index > 0 && "hairline-t")}>
                  <span className="grid h-7 place-items-center rounded-[7px] bg-fill2 text-xs font-bold tracking-[0.04em]">{s.state}</span>
                  <div className="min-w-0">
                    <div style={{ width: `${width}%` }}>
                      <SplitBar
                        label={`${s.state}: filed ${dollars(s.owedCents - s.unfiledCents)}, unfiled ${dollars(s.unfiledCents)}, pass-through ${dollars(s.facilitatorCents)}`}
                        segments={[
                          { label: "Filed", value: s.owedCents - s.unfiledCents, tint: "green" },
                          { label: "Unfiled", value: s.unfiledCents, tint: "orange" },
                          { label: "Pass-through", value: s.facilitatorCents, tint: "gray", muted: true },
                        ]}
                      />
                    </div>
                    <p className="mt-1 text-2xs font-medium text-label2">
                      {s.months} {s.months === 1 ? "month" : "months"}
                      {s.facilitatorCents > 0 ? (
                        <>
                          {" "}
                          · <Money cents={s.facilitatorCents} currency plain /> pass-through
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Money cents={s.owedCents} currency plain className="text-right text-sm font-semibold" />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {owedRows.length === 0 ? null : (
        <section aria-labelledby="by-month" className="overflow-hidden rounded-2xl bg-card shadow-card max-md:rounded-[22px]">
          <h2 id="by-month" className="px-5 pt-[18px] pb-2 text-lg font-semibold tracking-[-0.01em] max-md:px-4">
            By month
          </h2>
          <Table caption="Sales tax owed by state and month" className="sm:min-w-[36rem]">
            <thead>
              <tr>
                <Th>Month</Th>
                <Th>State</Th>
                <Th align="right" className="max-sm:hidden">Taxable</Th>
                <Th align="right">Owed</Th>
                <Th align="right" className="max-sm:hidden">Pass-through</Th>
                <Th align="right">Status</Th>
              </tr>
            </thead>
            <tbody>
              {owedRows.map((r) => (
                <tr key={`${r.state}-${r.period}`}>
                  <Td className="rule-row whitespace-nowrap">{monthShortName(r.period)}</Td>
                  <Td className="rule-row num font-semibold">{r.state}</Td>
                  <Td align="right" className="rule-row max-sm:hidden">
                    <Money cents={r.taxableCents} plain />
                  </Td>
                  <Td align="right" className="rule-row font-semibold">
                    <Money cents={r.owedCents} plain />
                  </Td>
                  <Td align="right" className="rule-row text-label2 max-sm:hidden">
                    <Money cents={r.facilitatorCents} plain zeroDash />
                  </Td>
                  <Td align="right" className="rule-row">
                    {r.unfiledOwedCents === 0 ? (
                      <Pill tone="green" glyph="check" className="self-auto">
                        Filed
                      </Pill>
                    ) : canFile ? (
                      <FileReturnButton state={r.state} period={r.period} owedCents={r.unfiledOwedCents} />
                    ) : (
                      <Pill tone="orange" className="self-auto">
                        <Money cents={r.unfiledOwedCents} plain /> unfiled
                      </Pill>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <Td colSpan={3} className="text-xs font-semibold text-label2 max-sm:hidden">
                  Total
                </Td>
                <Td colSpan={2} className="text-xs font-semibold text-label2 sm:hidden">
                  Total
                </Td>
                <Td align="right" className="rule-subtotal rule-total">
                  <Money cents={report.totals.owedCents} plain />
                </Td>
                <Td align="right" className="rule-subtotal rule-total text-label2 max-sm:hidden">
                  <Money cents={report.totals.facilitatorCents} plain zeroDash />
                </Td>
                <Td />
              </tr>
            </tfoot>
          </Table>
        </section>
      )}

      {returns.length === 0 ? null : (
        <section aria-labelledby="returns">
          <h2 id="returns" className="px-4 pt-3 pb-1.5 text-sm font-semibold text-label2">
            Returns
          </h2>
          <ul className="overflow-hidden rounded-[14px] bg-card shadow-card">
            {returns.map((f, index) => (
              <li key={f.id} className={cn("flex min-h-14 items-center gap-3 px-4 py-2.5", index > 0 && "hairline-t")}>
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-fill2 text-xs font-bold">{f.state}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold max-sm:text-lg max-sm:font-medium">
                    {longDate(f.periodStart)} – {longDate(f.periodEnd)}
                  </span>
                  <span className="block truncate text-xs text-label2 max-sm:text-sm">
                    Filed {f.filedAt ?? "—"}
                    {f.confirmation === null ? null : ` · #${f.confirmation}`}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <Money cents={f.taxDueCents} currency plain className="text-sm font-semibold max-sm:text-lg" />
                  {f.entryId !== null ? (
                    <Link href={`/ledger/${f.entryId}`} className="inline-flex items-center gap-1 text-xs font-medium text-ink-green hover:underline">
                      <Glyph name="check-circle" size={12} />
                      Paid {longDate(f.paidAt)} · #{f.entryNo}
                    </Link>
                  ) : f.taxDueCents === 0 ? (
                    <span className="text-xs text-label2">Nothing due</span>
                  ) : canFile ? (
                    <PayReturnButton filing={f} banks={banks} />
                  ) : (
                    <span className="text-xs font-semibold text-ink-orange">Unpaid</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

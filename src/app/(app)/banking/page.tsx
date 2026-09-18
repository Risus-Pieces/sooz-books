import type { Metadata } from "next";
import Link from "next/link";

import { accountLabel } from "@/components/banking/queue-format";
import { Register, type RegisterFilters } from "@/components/banking/register";
import { EMPTY_FILTER, matchesFilter } from "@/components/banking/review-logic";
import type { QueueRow, QueueStage, RegisterRowView } from "@/components/banking/types";
import { CashLine, Responsive, type CashPoint } from "@/components/charts";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { Money } from "@/components/ui/money";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedNav } from "@/components/ui/segmented-control";
import { ToolbarGroup, ToolbarLink } from "@/components/ui/toolbar";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { listQueue } from "@/lib/banking/queue";
import { cn } from "@/lib/cn";
import { shortDate } from "@/lib/ui/format";

import { bankAccountTabs, entrySummaries } from "./queries";

export const metadata: Metadata = {
  title: "Accounts",
};

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

const STAGES: readonly QueueStage[] = ["review", "ready", "posted", "excluded"];

/**
 * Oldest first, each row with the balance after it: the bank's printed figure where it gave
 * one, otherwise carried forward from the account's opening balance.
 */
function withRunningBalance(newestFirst: readonly QueueRow[], openingCents: number): RegisterRowView[] {
  const out: RegisterRowView[] = [];
  let running = openingCents;
  for (let i = newestFirst.length - 1; i >= 0; i -= 1) {
    const row = newestFirst[i];
    running = row.balanceCents ?? running + row.amountCents;
    out.push({ row, balanceCents: running, printed: row.balanceCents !== null });
  }
  return out;
}

/** The balance at the last line of each month, oldest first: the account's line over time. */
function monthEnds(oldestFirst: readonly RegisterRowView[], opening: { cents: number; date: string | null }): CashPoint[] {
  const points: CashPoint[] = [];
  if (opening.date !== null) points.push({ date: opening.date, cents: opening.cents });
  for (const view of oldestFirst) {
    const last = points[points.length - 1];
    const point = { date: view.row.txnDate, cents: view.balanceCents };
    if (last !== undefined && last.date.slice(0, 7) === point.date.slice(0, 7)) points[points.length - 1] = point;
    else points.push(point);
  }
  return points;
}

/**
 * Accounts: one bank account at a time — its balance over time, whether the books agree with the
 * bank, and the register of every line the bank reported with the entry each became. Import and
 * Reconcile live in its toolbar.
 */
export default async function BankingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, params] = await Promise.all([requireUser("/banking"), searchParams]);
  const tabs = await bankAccountTabs();
  const mayImport = can(user.role, "bank.import");

  if (tabs.length === 0) {
    return (
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar title="Accounts" />
        <EmptyState
          glyph="bank"
          title="No bank accounts yet"
          description="Add a bank account under the chart of accounts, then import its statements."
        />
      </div>
    );
  }

  const accountId = one(params.account);
  const tab = tabs.find((t) => t.id === accountId) ?? tabs[0];
  const stageParam = one(params.stage);
  const filters: RegisterFilters = {
    month: /^\d{4}-\d{2}$/.test(one(params.month)) ? one(params.month) : "",
    stage: STAGES.find((s) => s === stageParam) ?? "",
    q: one(params.q).slice(0, 100),
  };

  const page = await listQueue({ bankAccountId: tab.id, limit: 500 });

  const withBalance = withRunningBalance(page.rows, tab.openingBalanceCents);
  const months = [...new Set(page.rows.map((row) => row.txnDate.slice(0, 7)))];

  const filter = { ...EMPTY_FILTER, month: filters.month, search: filters.q };
  const shown = withBalance
    .filter(({ row }) => (filters.stage === "" || row.stage === filters.stage) && matchesFilter(row, filter))
    .reverse();
  const entries = await entrySummaries(
    shown.flatMap(({ row }) => (row.journalEntryId === null ? [] : [row.journalEntryId])),
  );

  const statement = tab.statementBalanceCents;
  const difference = statement === null ? null : statement - tab.ledgerBalanceCents;
  const unposted = tab.counts.review + tab.counts.ready;
  const balance = statement ?? tab.ledgerBalanceCents;
  const points = monthEnds(withBalance, { cents: tab.openingBalanceCents, date: tab.openingDate });
  const agrees = difference === 0;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Accounts"
        subtitle={accountLabel(tab)}
        info="Every transaction the bank reported, and the journal entry each one became. The balance is the bank's own printed figure after its latest line; the books' figure counts posted entries only."
        search={
          <form action="/banking" role="search" className="max-md:w-full">
            <input type="hidden" name="account" value={tab.id} />
            {filters.month ? <input type="hidden" name="month" value={filters.month} /> : null}
            {filters.stage ? <input type="hidden" name="stage" value={filters.stage} /> : null}
            <SearchField
              appearance="toolbar"
              name="q"
              defaultValue={filters.q}
              aria-label="Search payee, reference or amount"
            />
          </form>
        }
        actions={
          <>
            <ToolbarGroup>
              {mayImport ? <ToolbarLink href="/banking/import" glyph="import" label="Import statement" /> : null}
              <ToolbarLink href={`/banking/reconcile?account=${tab.id}`} glyph="reconcile" label="Reconcile" />
            </ToolbarGroup>
            <ToolbarGroup className="max-md:hidden">
              <ToolbarLink href="/banking/review" glyph="tray" label="Review" />
            </ToolbarGroup>
          </>
        }
      />

      {tabs.length > 1 ? (
        <>
          <SegmentedNav
            aria-label="Bank account"
            className="self-start max-md:hidden"
            current={tab.id}
            items={tabs.map((t) => ({ value: t.id, href: `/banking?account=${t.id}`, label: accountLabel(t), glyph: "bank" }))}
          />
          <SegmentedNav
            aria-label="Bank account"
            className="md:hidden"
            fill
            current={tab.id}
            items={tabs.map((t) => ({
              value: t.id,
              href: `/banking?account=${t.id}`,
              label: t.mask === null ? accountLabel(t) : `••${t.mask}`,
            }))}
          />
        </>
      ) : null}

      <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-12">
        {/* Balance over time */}
        <section className="rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4 lg:col-span-8">
          <h2 className="text-sm font-semibold text-label2">Balance</h2>
          <Money
            cents={balance}
            currency
            plain
            className="mt-0.5 block text-5xl leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.5rem]"
          />
          {tab.statementBalanceDate ? (
            <p className="mt-1 text-xs font-medium text-label2">{shortDate(tab.statementBalanceDate)}</p>
          ) : null}
          {points.length > 1 ? (
            <Responsive
              desktop={<CashLine points={points} height={170} title="Balance at each month end" />}
              phone={
                <div className="mt-2.5">
                  <CashLine points={points} width={342} height={140} compact title="Balance at each month end" />
                </div>
              }
            />
          ) : null}
        </section>

        {/* Books against the bank */}
        <section className="flex flex-col rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4 lg:col-span-4">
          <div className="mb-2.5 flex items-center gap-2">
            <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">Books vs bank</h2>
            <InfoButton label="About books vs bank">
              <p>
                The bank&apos;s printed balance against the general ledger&apos;s balance of this account. A difference
                is lines still waiting in review, or lines the bank has not reported yet.
              </p>
            </InfoButton>
          </div>
          <div className="my-3 flex flex-col items-center gap-1.5">
            <span
              className={cn(
                "grid size-16 place-items-center rounded-full text-white",
                difference === null ? "bg-tint-gray" : agrees ? "bg-tint-green" : "bg-tint-orange",
              )}
            >
              <Glyph name={agrees ? "check" : difference === null ? "question" : "warning"} size={30} weight={2.2} />
            </span>
            {difference === null ? (
              <span className="text-sm font-semibold text-label2">No bank balance</span>
            ) : (
              <Money
                cents={difference}
                currency
                signed={difference !== 0}
                plain
                className={cn("text-3xl font-bold tracking-[-0.028em]", !agrees && "text-ink-orange")}
              />
            )}
          </div>
          <dl className="mt-auto grid rounded-[11px] bg-inset">
            <div className="flex h-9 items-center justify-between px-3">
              <dt className="font-medium text-label2">Bank</dt>
              <dd className="font-semibold">
                {statement === null ? "—" : <Money cents={statement} currency plain />}
              </dd>
            </div>
            <div className="flex h-9 items-center justify-between hairline-t px-3">
              <dt className="font-medium text-label2">Books</dt>
              <dd className="font-semibold">
                <Money cents={tab.ledgerBalanceCents} currency plain />
              </dd>
            </div>
            <Link
              href="/banking/review"
              className="flex h-9 items-center justify-between rounded-b-[11px] hairline-t px-3 transition-colors hover:bg-fill2"
            >
              <span className="font-medium text-label2">To review</span>
              <span className={cn("num flex items-center gap-1 font-semibold", unposted > 0 && "text-ink-orange")}>
                {unposted}
                <Glyph name="chevron-right" size={12} weight={2.4} className="text-label3" />
              </span>
            </Link>
          </dl>
        </section>
      </div>

      <Register
        key={`${tab.id}-${filters.month}-${filters.stage}-${filters.q}`}
        rows={shown}
        entries={entries}
        filters={filters}
        months={months}
        total={page.rows.length}
      />
    </div>
  );
}

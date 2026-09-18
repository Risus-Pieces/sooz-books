import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks, Upload } from "lucide-react";

import { LinkTabs } from "@/components/banking/link-tabs";
import { Register, type RegisterFilters } from "@/components/banking/register";
import { Figure } from "@/components/banking/parts";
import { EMPTY_FILTER, matchesFilter } from "@/components/banking/review-logic";
import type { QueueRow, QueueStage, RegisterRowView } from "@/components/banking/types";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth/session";
import { listQueue } from "@/lib/banking/queue";
import { cn } from "@/lib/cn";

import { bankAccountTabs, entrySummaries } from "./queries";

export const metadata: Metadata = {
  title: "Bank register",
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

/**
 * The register: one bank account at a time, every imported transaction, newest first, with
 * the balance after each and — for a posted one — the journal entry it became.
 */
export default async function BankingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [, params] = await Promise.all([requireUser("/banking"), searchParams]);
  const tabs = await bankAccountTabs();

  if (tabs.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Banking" title="Bank register" />
        <EmptyState title="No bank accounts yet" description="Add a bank account under the chart of accounts, then import its statements." />
      </div>
    );
  }

  const accountId = one(params.account);
  const tab = tabs.find((t) => t.id === accountId) ?? tabs[0];
  const stageParam = one(params.stage);
  const filters: RegisterFilters = {
    month: /^\d{4}-\d{2}$/.test(one(params.month)) ? one(params.month) : "",
    stage: STAGES.includes(stageParam as QueueStage) ? (stageParam as QueueStage) : "",
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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Banking"
        title="Bank register"
        description="Every transaction the bank reported, and the journal entry each one became."
        actions={
          <>
            <Button asChild size="sm" variant="secondary">
              <Link href="/banking/import">
                <Upload />
                Import statement
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/banking/review">
                <ListChecks />
                Review queue
              </Link>
            </Button>
          </>
        }
        tabs={
          <LinkTabs
            label="Bank account"
            tabs={tabs.map((t) => ({
              href: `/banking?account=${t.id}`,
              label: t.name,
              count: t.counts.review + t.counts.ready + t.counts.posted + t.counts.excluded,
              active: t.id === tab.id,
            }))}
          />
        }
      />

      <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border bg-surface shadow-raised lg:grid-cols-4">
        <Figure label={tab.statementBalanceDate === null ? "Balance per bank" : `Per bank, ${tab.statementBalanceDate}`}>
          {statement === null ? <span className="text-muted-foreground">—</span> : <Money cents={statement} currency />}
        </Figure>
        <Figure label={`Per books, ${tab.glCode}`} className="border-l">
          <Money cents={tab.ledgerBalanceCents} currency />
        </Figure>
        <Figure label="Not yet in the books" className="border-t lg:border-t-0 lg:border-l">
          {difference === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <Money cents={difference} currency signed className={cn(difference !== 0 && "text-warning")} plain={difference === 0} />
          )}
        </Figure>
        <Figure label="Waiting on a decision" className="border-t border-l lg:border-t-0">
          <Link href="/banking/review" className={cn("num hover:underline", unposted > 0 && "text-warning")}>
            {unposted}
          </Link>
        </Figure>
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


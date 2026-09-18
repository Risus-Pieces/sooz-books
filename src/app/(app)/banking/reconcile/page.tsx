import type { Metadata } from "next";

import { accountLabel } from "@/components/banking/queue-format";
import {
  MonthPicker,
  ReconHistory,
  ReconcileWorkspace,
  StartReconciliation,
} from "@/components/banking/reconcile-workspace";
import { monthLabel } from "@/components/banking/review-logic";
import type { ReconLineView, ReconSummaryView, StatementProposalView } from "@/components/banking/types";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { SegmentedNav } from "@/components/ui/segmented-control";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { clearedBalance, proposeStatement, reconciliationLines } from "@/lib/banking/reconcile";
import { monthEnd } from "@/lib/dates";

import { bankAccountTabs, postedLineCount, reconciliationHistory, statementMonths } from "../queries";

export const metadata: Metadata = {
  title: "Reconcile",
};

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

const BACK = { href: "/banking", label: "Accounts" };

/** The month after `YYYY-MM-DD`, as `YYYY-MM`. */
function monthAfter(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * Proving the books agree with the bank, one statement at a time. The statement's balances are
 * proposed from the running balance Relay prints on every row; the difference must reach
 * exactly $0.00 before a month can be completed and locked.
 */
export default async function ReconcilePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, params] = await Promise.all([requireUser("/banking/reconcile"), searchParams]);
  const tabs = await bankAccountTabs();
  if (tabs.length === 0) {
    return (
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar title="Reconcile" back={BACK} />
        <EmptyState glyph="bank" title="No bank accounts yet" description="Add a bank account before reconciling it." />
      </div>
    );
  }
  const tab = tabs.find((t) => t.id === one(params.account)) ?? tabs[0];
  const canReconcile = can(user.role, "bank.approve");

  const [history, months] = await Promise.all([reconciliationHistory(tab.id), statementMonths(tab.id)]);
  const inProgress = history.find((row) => row.status === "in_progress");
  const lastCompleted = history.find((row) => row.status === "completed");

  // The next month to reconcile is the one after the last completed statement.
  const next = lastCompleted === undefined ? [...months].reverse()[0] : monthAfter(lastCompleted.statementDate);
  const requested = one(params.month);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : (next ?? months[0] ?? "");
  const monthChoices = [...new Set([month, ...months].filter((m) => m !== ""))].sort().reverse();

  let workspace: { summary: ReconSummaryView; lines: ReconLineView[] } | null = null;
  let proposal: StatementProposalView | null = null;
  let postedInMonth = 0;
  if (inProgress !== undefined) {
    const [summary, lines] = await Promise.all([clearedBalance(inProgress.id), reconciliationLines(inProgress.id)]);
    workspace = {
      summary: {
        id: summary.id,
        status: summary.status,
        statementStartDate: summary.statementStartDate,
        statementDate: summary.statementDate,
        openingBalanceCents: summary.openingBalanceCents,
        closingBalanceCents: summary.closingBalanceCents,
        previouslyClearedCents: summary.previouslyClearedCents,
        clearedThisPeriodCents: summary.clearedThisPeriodCents,
        clearedCount: summary.clearedCount,
        clearedBalanceCents: summary.clearedBalanceCents,
        differenceCents: summary.differenceCents,
        openingDifferenceCents: summary.openingDifferenceCents,
      },
      lines: lines.map((line) => ({
        journalLineId: line.journalLineId,
        entryId: line.entryId,
        entryNo: line.entryNo,
        date: line.date,
        amountCents: line.amountCents,
        memo: line.memo,
        bankTransactionId: line.bankTransactionId,
        payee: line.payee,
        cleared: line.cleared,
      })),
    };
  } else if (month !== "") {
    const [p, posted] = await Promise.all([
      proposeStatement(tab.id, month),
      postedLineCount(tab.glAccountId, `${month}-01`, monthEnd(`${month}-01`)),
    ]);
    proposal = { ...p, breaks: p.breaks.map((b) => ({ ...b })) };
    postedInMonth = posted;
  }

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Reconcile"
        back={BACK}
        subtitle={
          lastCompleted === undefined ? (
            <Pill glyph="lock">Never reconciled</Pill>
          ) : (
            <Pill tone="green" glyph="lock">
              Reconciled through {lastCompleted.statementDate}
            </Pill>
          )
        }
        info="Tick off what the statement shows until the books and the bank agree to the cent. A completed month is locked: its bank lines can no longer be changed until the reconciliation is undone."
        actions={workspace === null && monthChoices.length > 0 ? <MonthPicker months={monthChoices} value={month} /> : null}
      />

      {tabs.length > 1 ? (
        <>
          <SegmentedNav
            aria-label="Bank account"
            className="self-start max-md:hidden"
            current={tab.id}
            items={tabs.map((t) => ({ value: t.id, href: `/banking/reconcile?account=${t.id}`, label: accountLabel(t), glyph: "bank" }))}
          />
          <SegmentedNav
            aria-label="Bank account"
            className="md:hidden"
            fill
            current={tab.id}
            items={tabs.map((t) => ({
              value: t.id,
              href: `/banking/reconcile?account=${t.id}`,
              label: t.mask === null ? accountLabel(t) : `••${t.mask}`,
            }))}
          />
        </>
      ) : null}

      {workspace !== null ? (
        <>
          <Pill tone="orange" glyph="clock">
            In progress · {workspace.summary.statementStartDate} – {workspace.summary.statementDate}
          </Pill>
          <ReconcileWorkspace
            key={workspace.summary.id}
            summary={workspace.summary}
            lines={workspace.lines}
            canReconcile={canReconcile}
          />
        </>
      ) : proposal !== null ? (
        <StartReconciliation
          key={`${tab.id}-${month}`}
          bankAccountId={tab.id}
          proposal={proposal}
          postedInMonth={postedInMonth}
          canReconcile={canReconcile}
        />
      ) : (
        <EmptyState
          glyph="reconcile"
          title="Nothing to reconcile"
          description={month === "" ? `Import a statement for ${tab.name} first.` : `No data for ${monthLabel(month)} on ${tab.name}.`}
        />
      )}

      <ReconHistory rows={history} canUndo={can(user.role, "ledger.reopen")} />
    </div>
  );
}

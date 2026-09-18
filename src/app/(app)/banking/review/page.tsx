import type { Metadata } from "next";

import { ReviewQueue } from "@/components/banking/review-queue";
import type { QueueStage } from "@/components/banking/types";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { listQueue, queueCounts } from "@/lib/banking/queue";

import { accountOptions } from "../../ledger/queries";
import { vendorOptions } from "../queries";

export const metadata: Metadata = {
  title: "Review",
};

const STAGES: readonly QueueStage[] = ["review", "ready", "posted", "excluded"];

const PAGE_LIMIT = 500;

function readStage(value: string | string[] | undefined): QueueStage {
  const raw = Array.isArray(value) ? value[0] : value;
  return STAGES.find((s) => s === raw) ?? "review";
}

/**
 * The review queue: every bank transaction a person has to decide, with what the rules, the
 * payee's history and the AI propose for it. Decisions are made here and nowhere else — the
 * engine posts what a person accepts, and only what an owner-marked rule coded posts without.
 * Laid out as Mail: the list beside the selected transaction, a toolbar of actions over it.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [user, params] = await Promise.all([requireUser("/banking/review"), searchParams]);
  const stage = readStage(params.stage);

  const [page, counts, accounts, vendors] = await Promise.all([
    listQueue({ stage, limit: PAGE_LIMIT }),
    queueCounts(),
    accountOptions(),
    vendorOptions(),
  ]);

  const canApprove = can(user.role, "bank.approve");
  const autoPostRows =
    stage === "ready" ? page.rows.filter((row) => row.suggestion.rule?.autoPost === true && row.status === "categorized") : [];
  const readyNet =
    stage === "ready" ? page.rows.filter((row) => row.status === "categorized").reduce((s, r) => s + r.amountCents, 0) : 0;

  return (
    <ReviewQueue
      key={stage}
      stage={stage}
      stageCounts={counts.byStage}
      rows={page.rows}
      accounts={accounts}
      vendors={vendors}
      canApprove={canApprove}
      mayAutoPost={can(user.role, "settings.manage")}
      mayImport={can(user.role, "bank.import")}
      autoPost={stage === "ready" && canApprove ? { count: autoPostRows.length, netCents: readyNet } : null}
      truncated={page.nextCursor !== null}
    />
  );
}

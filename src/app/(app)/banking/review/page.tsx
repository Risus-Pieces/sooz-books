import type { Metadata } from "next";
import Link from "next/link";
import { Upload } from "lucide-react";

import { AutoPostButton } from "@/components/banking/auto-post-button";
import { LinkTabs } from "@/components/banking/link-tabs";
import { ReviewQueue } from "@/components/banking/review-queue";
import type { QueueStage } from "@/components/banking/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { listQueue, queueCounts } from "@/lib/banking/queue";

import { accountOptions } from "../../ledger/queries";
import { vendorOptions } from "../queries";

export const metadata: Metadata = {
  title: "Review queue",
};

const STAGES: readonly { stage: QueueStage; label: string }[] = [
  { stage: "review", label: "Needs review" },
  { stage: "ready", label: "Ready to post" },
  { stage: "posted", label: "Posted" },
  { stage: "excluded", label: "Excluded" },
];

const PAGE_LIMIT = 500;

function readStage(value: string | string[] | undefined): QueueStage {
  const raw = Array.isArray(value) ? value[0] : value;
  return STAGES.some((s) => s.stage === raw) ? (raw as QueueStage) : "review";
}

/**
 * The review queue: every bank transaction a person has to decide, with what the rules, the
 * payee's history and the AI propose for it. Decisions are made here and nowhere else — the
 * engine posts what a person accepts, and only what an owner-marked rule coded posts without.
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

  const readyNet =
    stage === "ready" ? page.rows.filter((row) => row.status === "categorized").reduce((s, r) => s + r.amountCents, 0) : 0;
  const canApprove = can(user.role, "bank.approve");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Banking"
        title="Review queue"
        description="Decide what each bank transaction was. Nothing reaches the ledger until you accept it."
        meta={
          <Badge tone={counts.byStage.review > 0 ? "warning" : "positive"}>
            {counts.byStage.review} to review
          </Badge>
        }
        actions={
          <>
            {stage === "ready" && canApprove ? (
              <AutoPostButton
                count={page.rows.filter((row) => row.suggestion.rule?.autoPost === true && row.status === "categorized").length}
                netCents={readyNet}
              />
            ) : null}
            {can(user.role, "bank.import") ? (
              <Button asChild size="sm" variant="secondary">
                <Link href="/banking/import">
                  <Upload />
                  Import statement
                </Link>
              </Button>
            ) : null}
          </>
        }
        tabs={
          <LinkTabs
            label="Queue stage"
            tabs={STAGES.map((s) => ({
              href: s.stage === "review" ? "/banking/review" : `/banking/review?stage=${s.stage}`,
              label: s.label,
              count: counts.byStage[s.stage],
              active: s.stage === stage,
            }))}
          />
        }
      />

      <ReviewQueue
        key={stage}
        stage={stage}
        rows={page.rows}
        accounts={accounts}
        vendors={vendors}
        canApprove={canApprove}
        mayAutoPost={can(user.role, "settings.manage")}
        truncated={page.nextCursor !== null}
      />
    </div>
  );
}

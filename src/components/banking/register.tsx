"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { FlowDiagram, type FlowNode, type FlowTarget } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DetailPane } from "@/components/ui/detail-pane";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { GroupRow, InsetGroup, ListRow } from "@/components/ui/inset-group";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { Pill, type PillTone } from "@/components/ui/pill";
import { PopUpButton } from "@/components/ui/pop-up-button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { categoryForCode } from "@/lib/ui/categories";
import { mediumDate } from "@/lib/ui/format";

import { bankLabel, bankShortName, byMonth, monthHeader } from "./queue-format";
import { monthLabel, payeeOf, shortDate } from "./review-logic";
import type { EntrySummary, QueueRow, QueueStage, RegisterRowView } from "./types";

const ANY = "__any__";

const STAGE_PILL: Record<QueueStage, { label: string; tone: PillTone; glyph: GlyphName }> = {
  review: { label: "To review", tone: "orange", glyph: "tray" },
  ready: { label: "Ready", tone: "blue", glyph: "wand" },
  posted: { label: "Posted", tone: "green", glyph: "check" },
  excluded: { label: "Excluded", tone: "neutral", glyph: "exclude" },
};

function statusPill(row: QueueRow) {
  if (row.reconciled) {
    return (
      <Pill tone="blue" glyph="lock">
        Reconciled
      </Pill>
    );
  }
  if (row.status === "transfer" && row.stage !== "posted") {
    return (
      <Pill tone="blue" glyph="transfer">
        Transfer
      </Pill>
    );
  }
  const pill = STAGE_PILL[row.stage];
  return (
    <Pill tone={pill.tone} glyph={pill.glyph}>
      {pill.label}
    </Pill>
  );
}

export interface RegisterFilters {
  month: string;
  stage: QueueStage | "";
  q: string;
}

/**
 * The bank register: every line the bank reported, newest first, by month. A line opens in a
 * sheet with the entry it became drawn as a flow, and the balance after it.
 */
export function Register({
  rows,
  entries,
  filters,
  months,
  total,
}: {
  rows: readonly RegisterRowView[];
  entries: Readonly<Record<string, EntrySummary>>;
  filters: RegisterFilters;
  months: readonly string[];
  /** Rows on the account before filtering. */
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [openId, setOpenId] = React.useState<string | null>(null);

  const apply = (patch: Partial<RegisterFilters>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === "" || value === undefined) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.push(query === "" ? pathname : `${pathname}?${query}`);
  };

  const active = filters.month !== "" || filters.stage !== "" || filters.q !== "";
  const open = openId === null ? undefined : rows.find((r) => r.row.id === openId);
  const newestYear = rows[0]?.row.txnDate.slice(0, 4) ?? "";

  return (
    <section aria-label="Register" className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <h2 className="flex-1 text-xl font-bold tracking-[-0.02em]">
          Register
          <span className="num ml-2 text-xs font-medium text-label2">
            {rows.length === total ? total : `${rows.length} of ${total}`}
          </span>
        </h2>
        <PopUpButton
          aria-label="Month"
          value={filters.month === "" ? ANY : filters.month}
          onValueChange={(v) => apply({ month: v === ANY ? "" : v })}
          options={[{ value: ANY, label: "Every month" }, ...months.map((m) => ({ value: m, label: monthLabel(m) }))]}
        />
        <PopUpButton
          aria-label="Status"
          value={filters.stage === "" ? ANY : filters.stage}
          onValueChange={(v) => apply({ stage: v === ANY ? "" : (v as QueueStage) })}
          options={[
            { value: ANY, label: "Any status" },
            { value: "review", label: "To review" },
            { value: "ready", label: "Ready" },
            { value: "posted", label: "Posted" },
            { value: "excluded", label: "Excluded" },
          ]}
        />
        {active ? (
          <Button size="sm" variant="ghost" onClick={() => apply({ month: "", stage: "", q: "" })}>
            Clear
          </Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <Card className="mt-3">
          <EmptyState
            glyph={active ? "filter" : "tray"}
            title={active ? "Nothing matches" : "No transactions yet"}
            action={
              active ? undefined : (
                <Button asChild size="sm">
                  <Link href="/banking/import">Import</Link>
                </Button>
              )
            }
          />
        </Card>
      ) : (
        byMonth(rows, (r) => r.row.txnDate).map((bucket) => (
          <InsetGroup key={bucket.month} header={monthHeader(bucket.month, newestYear)} separatorInset={63}>
            {bucket.items.map(({ row, balanceCents }) => {
              const account = row.stage === "posted" ? row.postedAccount : row.suggestion.account;
              const tint = account === null ? "gray" : categoryForCode(account.code).tint;
              return (
                <ListRow
                  key={row.id}
                  rowProps={{ "data-register-row": row.id }}
                  onClick={() => setOpenId(row.id)}
                  leading={<Monogram name={payeeOf(row)} />}
                  title={payeeOf(row)}
                  trailing={
                    <Money cents={row.amountCents} currency signed colorPositive plain={row.amountCents < 0} />
                  }
                  subtitle={
                    <>
                      {row.status === "transfer" ? (
                        <Glyph name="transfer" size={12} className="text-tint-blue" />
                      ) : (
                        <Dot tint={account === null ? "quiet" : tint} size={7} />
                      )}
                      <span className={row.stage === "posted" ? "truncate" : "truncate italic"}>
                        {row.status === "transfer" ? "Transfer" : (account?.name ?? "No account")}
                      </span>
                      {row.stage === "review" || row.stage === "ready" ? (
                        <Glyph name="tray" size={12} label="To review" className="shrink-0 text-tint-orange" />
                      ) : null}
                      {row.stage === "excluded" ? <Glyph name="exclude" size={12} label="Excluded" className="shrink-0" /> : null}
                      {row.reconciled ? <Glyph name="lock" size={12} label="Reconciled" className="shrink-0 text-tint-blue" /> : null}
                    </>
                  }
                  detail={
                    <span className="inline-flex items-center gap-1.5">
                      <span>{shortDate(row.txnDate)}</span>
                      <span aria-hidden className="max-sm:hidden">·</span>
                      <Money cents={balanceCents} currency plain className="max-sm:hidden" />
                    </span>
                  }
                />
              );
            })}
          </InsetGroup>
        ))
      )}

      <Sheet open={open !== undefined} onOpenChange={(next) => (next ? null : setOpenId(null))}>
        <SheetContent title={open === undefined ? "Transaction" : payeeOf(open.row)} hideTitle width="lg">
          {open === undefined ? null : (
            <RegisterDetail
              view={open}
              entry={open.row.journalEntryId === null ? undefined : entries[open.row.journalEntryId]}
            />
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

function entryFlow(entry: EntrySummary): { from: FlowNode; to: FlowTarget[] } | null {
  const credits = entry.lines.filter((l) => l.creditCents > 0).sort((a, b) => b.creditCents - a.creditCents);
  const debits = entry.lines.filter((l) => l.debitCents > 0);
  if (credits.length === 0 || debits.length === 0) return null;
  const node = (code: string, name: string): FlowNode => {
    const c = categoryForCode(code);
    return { label: name, glyph: c.key === "cash" ? "bank" : c.glyph, tint: c.key === "cash" ? "green" : c.tint };
  };
  return {
    from: node(credits[0].accountCode, credits[0].accountName),
    to: debits.map((l) => ({ ...node(l.accountCode, l.accountName), cents: l.debitCents })),
  };
}

function RegisterDetail({ view, entry }: { view: RegisterRowView; entry: EntrySummary | undefined }) {
  const { row, balanceCents, printed } = view;
  const flow = entry === undefined ? null : entryFlow(entry);
  const deciding = row.stage === "review" || row.stage === "ready";
  return (
    <DetailPane
      leading={<Monogram name={payeeOf(row)} size="lg" className="max-sm:size-12 max-sm:text-lg" />}
      title={payeeOf(row)}
      meta={[
        mediumDate(row.txnDate),
        <>
          <Glyph name="bank" size={14} />
          {bankLabel(row)}
        </>,
      ]}
      amount={<Money cents={row.amountCents} currency signed colorPositive plain={row.amountCents < 0} />}
      status={statusPill(row)}
      className="[&>div]:px-0 [&>div]:pt-1"
      actions={
        deciding ? (
          <Button asChild>
            <Link href={row.stage === "ready" ? "/banking/review?stage=ready" : "/banking/review"}>
              <Glyph name="tray" />
              Review
            </Link>
          </Button>
        ) : entry !== undefined ? (
          <Button asChild variant="secondary">
            <Link href={`/ledger/${entry.id}`}>
              <Glyph name="doc-text" />
              Entry #{entry.entryNo}
            </Link>
          </Button>
        ) : undefined
      }
    >
      {flow !== null ? (
        <Card className="px-5 py-[18px] max-sm:px-4">
          <FlowDiagram from={flow.from} to={flow.to} />
        </Card>
      ) : null}
      <InsetGroup>
        <GroupRow label="Balance">
          <Money cents={balanceCents} currency plain className={printed ? "text-label" : undefined} />
          {printed ? null : <span className="text-xs">carried</span>}
        </GroupRow>
        {entry !== undefined ? (
          <GroupRow label="Entry" href={`/ledger/${entry.id}`}>
            <span className="num">#{entry.entryNo}</span>
          </GroupRow>
        ) : null}
        {entry?.memo ? (
          <GroupRow label="Memo">
            <span className="max-w-[260px] truncate" title={entry.memo}>
              {entry.memo}
            </span>
          </GroupRow>
        ) : null}
        {row.reference ? (
          <GroupRow label="Reference">
            <span className="max-w-[260px] truncate" title={row.reference}>
              {row.reference}
            </span>
          </GroupRow>
        ) : null}
        {row.transferPartner !== null ? (
          <GroupRow label="Other leg">
            <span className="truncate">{bankShortName(row.transferPartner.bankAccountName)}</span>
          </GroupRow>
        ) : null}
      </InsetGroup>
    </DetailPane>
  );
}

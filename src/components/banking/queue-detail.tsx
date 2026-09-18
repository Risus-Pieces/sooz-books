"use client";

import * as React from "react";

import { CategoryBars, FlowDiagram, SplitBar } from "@/components/charts";
import { AccountCombobox } from "@/components/ledger/account-combobox";
import { Card } from "@/components/ui/card";
import { DetailPane } from "@/components/ui/detail-pane";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Dot, IconBadge } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import { dollars, mediumDate } from "@/lib/ui/format";

import { bankLabel, bankShortName, flowFor } from "./queue-format";
import { ConfidenceMeter } from "./queue-parts";
import { FLAG_LABEL, payeeOf, shortDate, totalsOf, type PayeeGroup } from "./review-logic";
import type { AccountOption, AccountRef, QueueRow, QueueStage } from "./types";
import type { Category } from "@/lib/ui/categories";

/** A tappable row in a grouped form, with a disclosure chevron: "Same account · 47 more". */
export function ActionGroupRow({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex min-h-[46px] w-full items-center gap-3 px-4 py-2 text-left outline-none focus-ring-inset transition-colors before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-sep first:before:hidden hover:bg-fill2 focus-visible:bg-fill2 max-sm:min-h-11"
    >
      <span className="flex-1 text-sm font-medium max-sm:text-lg max-sm:font-normal">{label}</span>
      <span className="flex min-w-0 items-center gap-1 text-sm font-medium text-label2 max-sm:text-lg">{children}</span>
      <Glyph name="chevron-right" size={12} weight={2.4} className="text-label3" />
    </button>
  );
}

/**
 * On a phone the buttons come before the list of every other action, so they are drawn inside the
 * pane's content rather than in its action row (which the pane puts last).
 */
function PhoneTail({ actions, more }: { actions: React.ReactNode; more: React.ReactNode }) {
  return (
    <>
      {actions ? <div className="flex flex-wrap items-center gap-2 [&>*]:flex-1">{actions}</div> : null}
      {more}
    </>
  );
}

export interface SameGroup {
  count: number;
  cents: number;
  onSelect: () => void;
}

const FLAG_PILL: Record<QueueRow["flags"][number], { tone: "orange" | "blue" | "neutral"; glyph: GlyphName } | null> = {
  mixed_use: { tone: "orange", glyph: "flag" },
  ask_accountant: { tone: "orange", glyph: "question" },
  already_booked: { tone: "orange", glyph: "link" },
  open_document: { tone: "blue", glyph: "doc" },
  low_confidence: null,
  no_suggestion: null,
};

function StatusPills({ row, stage }: { row: QueueRow; stage: QueueStage }) {
  const pills: React.ReactNode[] = [];
  if (row.reconciled) {
    pills.push(
      <Pill key="rec" tone="blue" glyph="lock">
        Reconciled
      </Pill>,
    );
  }
  if (stage === "posted" && row.entryNo !== null) {
    pills.push(
      <Pill key="posted" tone="green" glyph="check">
        Posted #{row.entryNo}
      </Pill>,
    );
  }
  if (stage === "excluded") {
    pills.push(
      <Pill key="excl" glyph="exclude">
        Excluded
      </Pill>,
    );
  }
  if (row.suggestion.rule?.autoPost && stage !== "posted") {
    pills.push(
      <Pill key="auto" tone="blue" glyph="wand">
        Auto-post
      </Pill>,
    );
  }
  for (const flag of row.flags) {
    const style = FLAG_PILL[flag];
    if (style === null) continue;
    pills.push(
      <Pill key={flag} tone={style.tone} glyph={style.glyph}>
        {FLAG_LABEL[flag]}
      </Pill>,
    );
  }
  if (pills.length === 0) return null;
  return <div className="flex flex-wrap gap-2">{pills}</div>;
}

function Why({ row }: { row: QueueRow }) {
  const { reasoning, rule, vendor } = row.suggestion;
  if (reasoning === null && rule === null && vendor === null) return null;
  return (
    <InfoButton label="Why this account" title="Why this account" className="max-sm:hidden">
      {rule !== null ? <p>Rule “{rule.name}”{rule.autoPost ? ", which posts on its own." : "."}</p> : null}
      {reasoning !== null ? <p>{reasoning}</p> : null}
      {vendor !== null ? <p>Vendor: {vendor.name}</p> : null}
    </InfoButton>
  );
}

export interface RowDetailProps {
  row: QueueRow;
  stage: QueueStage;
  account: AccountRef | null;
  category: Category | null;
  accounts: readonly AccountOption[];
  override: string | null;
  canApprove: boolean;
  pickerRef: React.Ref<HTMLButtonElement>;
  onPick: (accountId: string) => void;
  onPickerClosed: () => void;
  sameAccount: SameGroup | null;
  samePayee: SameGroup | null;
  /** One primary button, at most one secondary. */
  actions: React.ReactNode;
  footer?: React.ReactNode;
  /** The phone's list of every other action, under the buttons. */
  more?: React.ReactNode;
}

/**
 * One transaction: who and how much, the account as a pop-up, how sure the suggestion is, the
 * shortcut to everything else coded the same way, and the entry it will post, drawn.
 */
export function RowDetail({
  row,
  stage,
  account,
  category,
  accounts,
  override,
  canApprove,
  pickerRef,
  onPick,
  onPickerClosed,
  sameAccount,
  samePayee,
  actions,
  footer,
  more,
}: RowDetailProps) {
  const payee = payeeOf(row);
  const deciding = stage === "review" || stage === "ready";
  const current = override ?? account?.id ?? null;
  const flow = flowFor(row, account, category);
  const source = row.suggestion.source;
  const editable = canApprove && deciding && row.status !== "transfer";

  return (
    <DetailPane
      leading={
        row.status === "transfer" ? (
          <IconBadge glyph="transfer" tint="blue" size="xl" className="size-14 rounded-full max-sm:size-12" />
        ) : (
          <Monogram name={payee} size="lg" className="max-sm:size-12 max-sm:text-lg" />
        )
      }
      title={payee}
      meta={[
        mediumDate(row.txnDate),
        <>
          <Glyph name="bank" size={14} />
          {bankLabel(row)}
        </>,
      ]}
      amount={<Money cents={row.amountCents} currency signed colorPositive plain={row.amountCents < 0} />}
      status={<StatusPills row={row} stage={stage} />}
      actions={more ? undefined : actions}
      footer={footer}
    >
      <InsetGroup>
        <GroupRow label="Account">
          {row.status === "transfer" ? (
            <span className="inline-flex items-center gap-1.5 text-label">
              <Glyph name="transfer" size={14} className="text-tint-blue" />
              Transfer
            </span>
          ) : editable ? (
            <span className="flex min-w-0 items-center gap-2">
              <AccountCombobox
                accounts={accounts}
                value={current}
                trackRecents
                triggerRef={pickerRef}
                placeholder="Choose account"
                className="h-[26px] w-auto max-w-[280px] min-w-0 gap-[7px] rounded-[7px] border-0 bg-ctl pr-1.5 pl-2.5 font-medium text-label shadow-ctl max-sm:h-11 max-sm:max-w-[200px] data-[state=open]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--blue)_45%,transparent)] [&_.num]:hidden"
                onChange={onPick}
                onDismiss={onPickerClosed}
              />
            </span>
          ) : account === null ? (
            <span>—</span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-label">
              <Dot tint={category?.tint ?? "gray"} />
              <span className="truncate">{account.name}</span>
            </span>
          )}
        </GroupRow>
        {deciding && source !== null && override === null ? (
          <GroupRow label="Confidence">
            <ConfidenceMeter source={source} confidence={row.suggestion.confidence} />
            <Why row={row} />
          </GroupRow>
        ) : null}
        {override !== null ? (
          <GroupRow label="Source">
            <span className="inline-flex items-center gap-1 text-ink-blue">
              <Glyph name="pencil" size={13} />
              Your choice
            </span>
          </GroupRow>
        ) : null}
        {stage === "posted" && row.journalEntryId !== null ? (
          <GroupRow label="Entry" href={`/ledger/${row.journalEntryId}`}>
            <span className="num">#{row.entryNo}</span>
            {row.postedLineCount > 1 ? <span>· Split</span> : null}
          </GroupRow>
        ) : null}
        {sameAccount !== null && sameAccount.count > 0 ? (
          <ActionGroupRow label="Same account" onClick={sameAccount.onSelect}>
            <span className="num">{sameAccount.count} more</span>
            <span aria-hidden>·</span>
            <Money cents={sameAccount.cents} currency plain />
          </ActionGroupRow>
        ) : null}
        {samePayee !== null && samePayee.count > 0 ? (
          <ActionGroupRow label="Same payee" onClick={samePayee.onSelect}>
            <span className="num">{samePayee.count} more</span>
            <span aria-hidden>·</span>
            <Money cents={samePayee.cents} currency plain />
          </ActionGroupRow>
        ) : null}
      </InsetGroup>

      <Card className="px-5 py-[18px] max-sm:px-4">
        <FlowDiagram from={flow.from} to={flow.to} />
      </Card>

      {more ? <PhoneTail actions={actions} more={more} /> : null}
      <StatementFacts row={row} />
    </DetailPane>
  );
}

/** What the bank said, and the other leg or original charge: quiet rows, only where there is one. */
function StatementFacts({ row }: { row: QueueRow }) {
  const statement = row.description.trim();
  const showStatement = statement !== "" && statement !== payeeOf(row);
  const hasAny =
    showStatement ||
    row.reference !== null ||
    row.balanceCents !== null ||
    row.transferPartner !== null ||
    row.refundOriginal !== null ||
    Boolean(row.notes);
  if (!hasAny) return null;
  return (
    <InsetGroup className="order-last">
      {showStatement ? (
        <GroupRow label="Statement">
          <span className="max-w-[340px] truncate" title={statement}>
            {statement}
          </span>
        </GroupRow>
      ) : null}
      {row.reference ? (
        <GroupRow label="Reference">
          <span className="max-w-[340px] truncate" title={row.reference}>
            {row.reference}
          </span>
        </GroupRow>
      ) : null}
      {row.transferPartner !== null ? (
        <GroupRow label="Other leg">
          <span className="truncate">
            {shortDate(row.transferPartner.txnDate)} · {bankShortName(row.transferPartner.bankAccountName)}
          </span>
          <Money cents={row.transferPartner.amountCents} currency signed colorPositive plain={row.transferPartner.amountCents < 0} />
        </GroupRow>
      ) : null}
      {row.refundOriginal !== null ? (
        <GroupRow label="Refund of">
          <span className="truncate">
            {shortDate(row.refundOriginal.txnDate)} · {row.refundOriginal.payee ?? "Charge"}
          </span>
          <Money cents={row.refundOriginal.amountCents} currency plain />
        </GroupRow>
      ) : null}
      {row.balanceCents !== null ? (
        <GroupRow label="Balance">
          <Money cents={row.balanceCents} currency plain />
        </GroupRow>
      ) : null}
      {row.notes ? (
        <GroupRow label="Notes">
          <span className="max-w-[340px] truncate" title={row.notes}>
            {row.notes}
          </span>
        </GroupRow>
      ) : null}
    </InsetGroup>
  );
}

export interface CategoryShare {
  key: string;
  label: string;
  tint: Category["tint"];
  cents: number;
  count: number;
}

/** Several rows chosen at once: how many, in and out, and where they go. */
export function BulkDetail({
  rows,
  shares,
  actions,
  footer,
  more,
}: {
  rows: readonly QueueRow[];
  shares: CategoryShare[];
  actions: React.ReactNode;
  footer?: React.ReactNode;
  more?: React.ReactNode;
}) {
  const totals = totalsOf(rows);
  return (
    <DetailPane
      leading={<IconBadge glyph="check-circle" tint="blue" size="xl" className="size-14 rounded-full max-sm:size-12" />}
      title={`${rows.length} selected`}
      meta={[
        <>
          <Glyph name="arrow-in" size={14} className="text-ink-green" />
          <Money cents={totals.inCents} currency plain />
        </>,
        <>
          <Glyph name="arrow-out" size={14} />
          <Money cents={totals.outCents} currency plain />
        </>,
      ]}
      amount={
        <Money
          cents={totals.inCents - totals.outCents}
          currency
          signed
          colorPositive
          plain={totals.inCents - totals.outCents < 0}
        />
      }
      status={
        totals.flagged > 0 ? (
          <Pill tone="orange" glyph="flag">
            {totals.flagged} flagged
          </Pill>
        ) : null
      }
      actions={more ? undefined : actions}
      footer={footer}
    >
      {more ? <PhoneTail actions={actions} more={more} /> : null}
      {shares.length > 0 ? (
        <Card className="flex flex-col gap-3 px-5 py-[18px] max-sm:px-4">
          {shares.length > 1 ? (
            <SplitBar
              label={shares.map((s) => `${s.label} ${dollars(s.cents)}`).join(", ")}
              segments={shares.map((s) => ({ label: s.key, value: s.cents, tint: s.tint }))}
            />
          ) : null}
          <CategoryBars rows={shares.map((s) => ({ key: s.key, label: s.label, tint: s.tint, cents: s.cents, count: s.count }))} />
        </Card>
      ) : null}
    </DetailPane>
  );
}

/** One payee in the By-payee view: its rows, where they go, and one button for all of them. */
export function PayeeDetail({
  group,
  actions,
  footer,
}: {
  group: PayeeGroup;
  actions: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <DetailPane
      leading={<Monogram name={group.payee} size="lg" className="max-sm:size-12 max-sm:text-lg" />}
      title={group.payee}
      meta={[`${group.rows.length} transaction${group.rows.length === 1 ? "" : "s"}`]}
      amount={<Money cents={group.netCents} currency signed colorPositive plain={group.netCents < 0} />}
      status={
        group.flagged > 0 ? (
          <Pill tone="orange" glyph="flag">
            {group.flagged} flagged
          </Pill>
        ) : null
      }
      actions={actions}
      footer={footer}
    >
      <InsetGroup>
        {group.accounts.map((a) => (
          <GroupRow key={a.label} label={a.label}>
            <span className="num">{a.count}</span>
          </GroupRow>
        ))}
      </InsetGroup>
    </DetailPane>
  );
}

/** The detail side with nothing chosen. */
export function NothingChosen({ className }: { className?: string }) {
  return (
    <div className={cn("grid h-full place-items-center text-label3", className)}>
      <div className="flex flex-col items-center gap-2">
        <Glyph name="tray" size={44} weight={1.4} />
        <p className="text-sm font-medium text-label2">No transaction chosen</p>
      </div>
    </div>
  );
}

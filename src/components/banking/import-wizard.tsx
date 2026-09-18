"use client";

import * as React from "react";
import Link from "next/link";
import { SplitBar } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Dot, IconBadge, LegendItem } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { Input } from "@/components/ui/input";
import { GroupRow, InsetGroup, ListRow } from "@/components/ui/inset-group";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { categoryForCode } from "@/lib/ui/categories";
import { dollars } from "@/lib/ui/format";
import { TINT_TEXT, type Tint } from "@/lib/ui/tints";
import {
  cancelStatement,
  commitStatement,
  previewStatement,
  saveStatementMapping,
} from "@/app/(app)/banking/actions";

import { shortDate } from "./review-logic";
import type {
  BankAccountTab,
  ImportCommitView,
  ImportDecisionView,
  ImportIssueView,
  ImportPreviewView,
  MappingView,
} from "./types";

const NONE = "__none__";
const MAX_BYTES = 950 * 1024;
const ACCEPT = ".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Relay names its exports `Relay 2026-03-01 #9726.csv`: the account is in the filename. */
export function accountFromFilename(filename: string, accounts: readonly BankAccountTab[]): string | null {
  const match = /#(\d{4})\b/.exec(filename);
  if (match === null) return null;
  return accounts.find((account) => account.mask === match[1])?.id ?? null;
}

type Phase =
  | { kind: "choose" }
  | { kind: "preview"; preview: ImportPreviewView }
  | { kind: "done"; result: ImportCommitView; filename: string; bank: string };

export function ImportWizard({ accounts }: { accounts: readonly BankAccountTab[] }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [bankAccountId, setBankAccountId] = React.useState<string>("");
  const [guessed, setGuessed] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>({ kind: "choose" });
  const [decisions, setDecisions] = React.useState<Readonly<Record<number, ImportDecisionView["choice"]>>>({});
  const [pending, startTransition] = React.useTransition();
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const pick = (next: File | null) => {
    if (next === null) return;
    if (next.size > MAX_BYTES) {
      toast.error("That file is larger than 950 KB. Export a shorter date range and import it in parts.");
      return;
    }
    setFile(next);
    const guess = accountFromFilename(next.name, accounts);
    setGuessed(guess !== null);
    if (guess !== null) setBankAccountId(guess);
    setPhase({ kind: "choose" });
  };

  const runPreview = (profileId: string | null, previousBatchId: string | null) => {
    if (file === null || bankAccountId === "") return;
    const form = new FormData();
    form.set("file", file);
    form.set("bankAccountId", bankAccountId);
    if (profileId !== null) form.set("profileId", profileId);
    if (previousBatchId !== null) form.set("previousBatchId", previousBatchId);
    startTransition(async () => {
      const result = await previewStatement(form);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      setDecisions({});
      setPhase({ kind: "preview", preview: result.value });
    });
  };

  const reset = () => {
    setFile(null);
    setGuessed(false);
    setPhase({ kind: "choose" });
    setDecisions({});
    if (inputRef.current !== null) inputRef.current.value = "";
  };

  if (phase.kind === "done") {
    return <ImportResult result={phase.result} filename={phase.filename} bank={phase.bank} onAgain={reset} />;
  }

  if (phase.kind === "preview") {
    const preview = phase.preview;
    return (
      <PreviewPanel
        preview={preview}
        decisions={decisions}
        pending={pending}
        onDecide={(rowIndex, choice) => setDecisions((current) => ({ ...current, [rowIndex]: choice }))}
        onRemap={(profileId) => runPreview(profileId, preview.batchId)}
        onCancel={() =>
          startTransition(async () => {
            const result = await cancelStatement(preview.batchId);
            if (!result.ok) toast.error(result.error.message);
            reset();
          })
        }
        onCommit={() => {
          if (file === null) return;
          const form = new FormData();
          form.set("file", file);
          form.set("batchId", preview.batchId);
          form.set(
            "decisions",
            JSON.stringify(Object.entries(decisions).map(([rowIndex, choice]) => ({ rowIndex: Number(rowIndex), choice }))),
          );
          startTransition(async () => {
            const result = await commitStatement(form);
            if (!result.ok) {
              toast.error(result.error.message);
              return;
            }
            toast.success(`Imported ${result.value.inserted} transaction${result.value.inserted === 1 ? "" : "s"}`);
            setPhase({
              kind: "done",
              result: result.value,
              filename: preview.filename,
              bank: preview.bankAccountMask === null ? preview.bankAccountName : `••${preview.bankAccountMask}`,
            });
          });
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="Choose a statement file, or drop one here"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          pick(event.dataTransfer.files.item(0));
        }}
        className={cn(
          "flex min-h-[220px] cursor-default flex-col items-center justify-center gap-2.5 rounded-2xl border-[1.5px] border-dashed border-sep px-4 py-10 text-center transition-colors outline-none focus-ring hover:border-tint-blue hover:text-ink-blue focus-visible:border-tint-blue max-md:min-h-[180px] max-md:rounded-[22px]",
          dragging ? "border-tint-blue bg-tint-blue/8 text-ink-blue" : "text-label2",
          file !== null && "border-solid border-transparent bg-card shadow-card",
        )}
      >
        {file === null ? (
          <>
            <Glyph name="import" size={44} weight={1.4} />
            <p className="text-lg font-semibold text-label">Drop a statement</p>
            <p className="text-xs font-medium">CSV or Excel · 950 KB</p>
          </>
        ) : (
          <>
            <IconBadge glyph="doc-text" tint="green" size="xl" />
            <p className="text-lg font-semibold break-all text-label">{file.name}</p>
            <p className="num text-xs font-medium">{(file.size / 1024).toFixed(1)} KB</p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => pick(event.target.files?.item(0) ?? null)}
        />
      </div>

      <InsetGroup>
        <GroupRow label="Account" htmlFor="import-account">
          {guessed ? (
            <Pill tone="blue" glyph="check" className="max-sm:hidden">
              From name
            </Pill>
          ) : null}
          <Select value={bankAccountId} onValueChange={setBankAccountId}>
            <SelectTrigger id="import-account" className="h-[26px] w-auto min-w-44 max-sm:h-11">
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </GroupRow>
      </InsetGroup>

      <div className="flex items-center gap-2">
        <Button
          className="max-md:flex-1"
          disabled={file === null || bankAccountId === "" || pending}
          onClick={() => runPreview(null, null)}
        >
          <Glyph name="doc-text" />
          {pending ? "Reading…" : "Preview import"}
        </Button>
        <InfoButton label="About importing" align="start">
          <p>The preview writes nothing to the books. You see every row first.</p>
          <p>
            Imported transactions land in the review queue; only rows an owner-marked auto-post rule codes can post
            without review. Relay exports name their account in the filename.
          </p>
        </InfoButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: ImportIssueView["severity"][] = ["fatal", "error", "warn", "info"];
const SEVERITY_LABEL = { fatal: "Blocks import", error: "Needs a decision", warn: "Warning", info: "Note" } as const;
const SEVERITY_BADGE: Record<ImportIssueView["severity"], { glyph: GlyphName; tint: Tint }> = {
  fatal: { glyph: "xmark-circle", tint: "red" },
  error: { glyph: "warning", tint: "red" },
  warn: { glyph: "warning", tint: "orange" },
  info: { glyph: "info", tint: "gray" },
};

/** A small figure: a quiet label over the number. The label and the number share a parent. */
function Stat({ label, children, glyph, className }: { label: string; children: React.ReactNode; glyph?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 px-4", className)}>
      <span className="flex items-center gap-1 text-xs font-semibold text-label2">
        {glyph}
        {label}
      </span>
      <span className="text-[1.1875rem] font-bold tracking-[-0.02em]">{children}</span>
    </div>
  );
}

function PreviewPanel({
  preview,
  decisions,
  pending,
  onDecide,
  onRemap,
  onCancel,
  onCommit,
}: {
  preview: ImportPreviewView;
  decisions: Readonly<Record<number, ImportDecisionView["choice"]>>;
  pending: boolean;
  onDecide: (rowIndex: number, choice: ImportDecisionView["choice"]) => void;
  onRemap: (profileId: string) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const undecided = preview.decisionsRequired.filter((rowIndex) => decisions[rowIndex] === undefined);
  const canCommit = !preview.blocked && !preview.profileConfirmationRequired && undecided.length === 0 && preview.counts.new > 0;
  const rows = showAll ? preview.rows : preview.rows.filter((row) => row.class === "new");
  const issues = [...preview.issues].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  const blocker = preview.blocked
    ? "Blocked — see problems"
    : preview.profileConfirmationRequired
      ? "Confirm the mapping"
      : undecided.length > 0
        ? `Decide ${undecided.length} row${undecided.length === 1 ? "" : "s"}`
        : preview.counts.new === 0
          ? "Nothing new"
          : null;
  const bank = preview.bankAccountMask === null ? preview.bankAccountName : `••${preview.bankAccountMask} ${preview.bankAccountName}`;
  const { counts, totals } = preview;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      {/* The file */}
      <Card className="flex flex-wrap items-center gap-3 px-5 py-4 max-sm:px-4">
        <IconBadge glyph="doc-text" tint="green" size="xl" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold break-all">{preview.filename}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-medium text-label2">
            <span>{preview.importerLabel}</span>
            <span aria-hidden className="size-[3px] rounded-full bg-label3" />
            <span className="num">{Math.round(preview.detectionConfidence * 100)}%</span>
            <span aria-hidden className="size-[3px] rounded-full bg-label3" />
            <span className="inline-flex items-center gap-1">
              <Glyph name="bank" size={14} />
              {bank}
            </span>
            {preview.dateRange === null ? null : (
              <>
                <span aria-hidden className="size-[3px] rounded-full bg-label3" />
                <span className="num">
                  {shortDate(preview.dateRange.min)} – {shortDate(preview.dateRange.max)}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
          <Button variant="secondary" onClick={onCancel} disabled={pending} className="max-sm:flex-1">
            Cancel
          </Button>
          <Button onClick={onCommit} disabled={!canCommit || pending} className="max-sm:flex-1">
            <Glyph name="import" />
            {pending ? "Importing…" : `Import ${counts.new} new`}
          </Button>
        </div>
        {blocker !== null || preview.partial || preview.priorImport !== null ? (
          <div className="flex w-full flex-wrap gap-2">
            {blocker !== null ? (
              <Pill tone="orange" glyph="warning">
                {blocker}
              </Pill>
            ) : null}
            {preview.partial ? <Pill glyph="calendar">Partial month</Pill> : null}
            {preview.priorImport !== null ? (
              <span className="inline-flex items-center gap-1">
                <Pill tone="blue" glyph="refresh">
                  Imported before
                </Pill>
                <InfoButton label="About the earlier import">
                  <p>
                    This exact file was imported before ({preview.priorImport.importedCount} rows). Re-importing is safe:
                    duplicates are counted and skipped.
                  </p>
                </InfoButton>
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-3">
        {/* New, duplicate, skipped */}
        <Card className="flex flex-col gap-3 px-5 py-4 max-sm:px-4">
          <h3 className="text-sm font-semibold text-label2">Rows</h3>
          <p className="num text-3xl font-bold tracking-[-0.028em]">{counts.total}</p>
          <SplitBar
            label={`${counts.new} new, ${counts.duplicate} already imported, ${counts.skipped} skipped`}
            segments={[
              { label: "new", value: counts.new, tint: "blue" },
              { label: "duplicate", value: counts.duplicate, tint: "gray" },
              { label: "skipped", value: counts.skipped, tint: "orange" },
            ]}
          />
          <div className="flex flex-wrap gap-x-3.5 gap-y-1">
            <LegendItem tint="blue">
              New <b className="num text-label">{counts.new}</b>
            </LegendItem>
            <LegendItem tint="gray">
              Duplicate <b className="num text-label">{counts.duplicate}</b>
            </LegendItem>
            <LegendItem tint="orange">
              Skipped <b className="num text-label">{counts.skipped}</b>
            </LegendItem>
          </div>
          <div className="mt-auto flex flex-wrap gap-x-3.5 gap-y-1 hairline-t pt-2.5 text-xs font-medium text-label2">
            <span className="inline-flex items-center gap-1">
              <Glyph name="tray" size={13} className="text-tint-orange" />
              Review <b className="num text-label">{counts.needsReview}</b>
            </span>
            <span className="inline-flex items-center gap-1">
              <Glyph name="wand" size={13} className="text-tint-purple" />
              Auto-post <b className="num text-label">{counts.autoPost}</b>
            </span>
            <span className="inline-flex items-center gap-1">
              <Glyph name="exclude" size={13} />
              Excluded <b className="num text-label">{counts.excluded}</b>
            </span>
          </div>
        </Card>

        <BalanceChainCard preview={preview} />

        {/* In and out */}
        <Card className="flex flex-col gap-3 px-5 py-4 max-sm:px-4">
          <h3 className="text-sm font-semibold text-label2">In & out</h3>
          <Money cents={totals.netCents} currency signed colorPositive plain={totals.netCents < 0} className="text-3xl font-bold tracking-[-0.028em]" />
          <SplitBar
            label={`In ${dollars(totals.inflowCents)}, out ${dollars(Math.abs(totals.outflowCents))}`}
            segments={[
              { label: "in", value: totals.inflowCents, tint: "green" },
              { label: "out", value: Math.abs(totals.outflowCents), tint: "red", muted: true },
            ]}
          />
          <div className="flex justify-between text-xs font-medium text-label2">
            <span className="inline-flex items-center gap-1">
              <Glyph name="arrow-in" size={12} weight={2.2} className="text-ink-green" />
              <Money cents={totals.inflowCents} currency plain />
            </span>
            <span className="inline-flex items-center gap-1">
              <Glyph name="arrow-out" size={12} weight={2.2} />
              <Money cents={Math.abs(totals.outflowCents)} currency plain />
            </span>
          </div>
        </Card>
      </div>

      {issues.length > 0 ? (
        <InsetGroup
          header="Problems"
          separatorInset={52}
          headerAccessory={
            <span className="flex gap-1.5 text-xs font-semibold text-label2">
              {SEVERITY_ORDER.map((severity) =>
                preview.issueCounts[severity] > 0 ? (
                  <span key={severity} className="inline-flex items-center gap-0.5">
                    <Glyph name={SEVERITY_BADGE[severity].glyph} size={13} className={TINT_TEXT[SEVERITY_BADGE[severity].tint]} />
                    <span className="num">{preview.issueCounts[severity]}</span>
                    <span className="sr-only">{severity}</span>
                  </span>
                ) : null,
              )}
            </span>
          }
        >
          <div className="max-h-80 overflow-y-auto">
            {issues.map((issue, index) => (
              <ListRow
                key={`${issue.code}-${index}`}
                leading={<IconBadge glyph={SEVERITY_BADGE[issue.severity].glyph} tint={SEVERITY_BADGE[issue.severity].tint} size="lg" />}
                title={<span className="whitespace-normal">{issue.message}</span>}
                subtitle={issue.remedy === null ? SEVERITY_LABEL[issue.severity] : <span className="whitespace-normal">{issue.remedy}</span>}
                detail={issue.rowIndex === null ? undefined : <span className="num">Row {issue.rowIndex + 1}</span>}
              />
            ))}
          </div>
        </InsetGroup>
      ) : null}

      {preview.profileConfirmationRequired || preview.mappingEditable ? (
        <MappingEditor preview={preview} pending={pending} onSaved={onRemap} />
      ) : null}

      {preview.decisionsRequired.length > 0 ? (
        <InsetGroup header="Decide" separatorInset={16}>
          {preview.decisionsRequired.map((rowIndex) => {
            const row = preview.rows.find((r) => r.rowIndex === rowIndex);
            if (row === undefined) return null;
            return (
              <div key={rowIndex} className="relative flex flex-wrap items-center gap-3 px-4 py-2.5 before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-sep first:before:hidden">
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate font-semibold">{row.payee}</span>
                  <span className="block text-xs text-label2">
                    {row.txnDate === "" ? "—" : shortDate(row.txnDate)} · {row.decisionRequired}
                  </span>
                </span>
                <Money cents={row.amountCents} currency signed colorPositive plain={row.amountCents < 0} className="font-semibold" />
                <Select
                  value={decisions[rowIndex] ?? undefined}
                  onValueChange={(value) => onDecide(rowIndex, value as ImportDecisionView["choice"])}
                >
                  <SelectTrigger className="h-[26px] w-40 max-sm:h-11" aria-label={`Decision for row ${rowIndex + 1}`}>
                    <SelectValue placeholder="Decide" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="exclude">Exclude — money never moved</SelectItem>
                    <SelectItem value="review">Import for review</SelectItem>
                    <SelectItem value="skip">Leave out of the import</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </InsetGroup>
      ) : null}

      <InsetGroup
        header={showAll ? "Every row" : "New rows"}
        separatorInset={57}
        headerAccessory={
          <SegmentedControl
            aria-label="Rows shown"
            value={showAll ? "all" : "new"}
            onValueChange={(v) => setShowAll(v === "all")}
            options={[
              { value: "new", label: "New" },
              { value: "all", label: "All" },
            ]}
          />
        }
      >
        <div className="max-h-[32rem] overflow-y-auto">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm font-medium text-label2">No new rows</p>
          ) : (
            rows.map((row) => (
              <ListRow
                key={row.rowIndex}
                className={row.class !== "new" ? "opacity-60" : undefined}
                leading={<Monogram name={row.payee || "?"} />}
                title={row.payee}
                trailing={<Money cents={row.amountCents} currency signed colorPositive plain={row.amountCents < 0} />}
                subtitle={
                  row.suggestion?.accountLabel ? (
                    <>
                      <Dot tint={categoryForCode(row.suggestion.accountLabel.slice(0, 4)).tint} size={7} />
                      <span className="truncate">{row.suggestion.accountLabel}</span>
                      {row.suggestion.source === "ai" ? (
                        <Glyph name="sparkle" size={12} label={`AI ${Math.round(row.suggestion.confidence * 100)}%`} className="shrink-0 text-tint-purple" />
                      ) : (
                        <span className="sr-only">
                          {row.suggestion.source} {Math.round(row.suggestion.confidence * 100)}%
                        </span>
                      )}
                      {row.suggestion.autoPost ? <Glyph name="wand" size={12} label="Auto-post" className="shrink-0 text-tint-purple" /> : null}
                    </>
                  ) : (
                    <>
                      <Dot tint="quiet" size={7} />
                      <span className="italic">{row.proposedStatus === "excluded" ? "Excluded" : "For review"}</span>
                    </>
                  )
                }
                detail={
                  <span className="inline-flex items-center gap-1.5">
                    {row.class === "new" ? null : (
                      <span className="rounded-[5px] bg-fill2 px-1.5 text-2xs font-semibold">{row.class === "duplicate" ? "Imported" : "Skipped"}</span>
                    )}
                    {row.txnDate === "" ? "—" : shortDate(row.txnDate)}
                  </span>
                }
              />
            ))
          )}
        </div>
      </InsetGroup>
    </div>
  );
}

/** The file's own arithmetic, as one tick: the running balance ties, or it breaks. */
function BalanceChainCard({ preview }: { preview: ImportPreviewView }) {
  const chain = preview.balanceChain;
  const state = chain === null ? "none" : chain.ok ? "ok" : "broken";
  return (
    <Card className="flex flex-col gap-3 px-5 py-4 max-sm:px-4">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-label2">Balance</h3>
        <InfoButton label="About the balance check">
          {chain === null ? (
            <p>This file has no balance column, so its arithmetic cannot be checked row by row.</p>
          ) : (
            <p>
              Each row&apos;s amount is added to the previous balance and compared with the balance the bank printed.{" "}
              {chain.checked} rows checked.
            </p>
          )}
        </InfoButton>
      </div>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "grid size-12 shrink-0 place-items-center rounded-full text-white",
            state === "ok" ? "bg-tint-green" : state === "broken" ? "bg-tint-red" : "bg-tint-gray",
          )}
        >
          <Glyph name={state === "ok" ? "check" : state === "broken" ? "xmark" : "minus"} size={24} weight={2.4} />
        </span>
        <span className="text-xl font-bold tracking-[-0.02em]">
          {state === "ok" ? "Ties" : state === "broken" && chain !== null ? `${chain.breaks.length} break${chain.breaks.length === 1 ? "" : "s"}` : "Not in file"}
        </span>
      </div>
      {chain !== null ? (
        <div className="flex justify-between text-xs font-medium text-label2">
          <span>
            Open {chain.openingBalanceCents === null ? "—" : <Money cents={chain.openingBalanceCents} currency plain className="text-label" />}
          </span>
          <span>
            Close {chain.closingBalanceCents === null ? "—" : <Money cents={chain.closingBalanceCents} currency plain className="text-label" />}
          </span>
        </div>
      ) : null}
      {chain !== null && chain.breaks.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-ink-red">
          {chain.breaks.slice(0, 6).map((b) => (
            <li key={b.rowIndex}>
              Row {b.rowIndex + 1}: expected <Money cents={b.expectedCents} currency plain />, bank <Money cents={b.actualCents} currency plain /> (
              <Money cents={b.deltaCents} currency signed plain />)
            </li>
          ))}
        </ul>
      ) : null}
      {preview.assertions.length > 0 ? (
        <ul className="mt-auto flex flex-col gap-1 hairline-t pt-2.5 text-xs font-medium">
          {preview.assertions.map((assertion) => (
            <li key={assertion.id} className="flex items-start gap-1.5">
              <Glyph
                name={assertion.passed ? "check-circle" : "xmark-circle"}
                size={14}
                label={assertion.passed ? "Passed" : "Failed"}
                className={cn("mt-px shrink-0", assertion.passed ? "text-ink-green" : "text-ink-red")}
              />
              <span>
                {assertion.label}
                {assertion.detail !== null && !assertion.passed ? (
                  <span className="block text-label2">{assertion.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function ColumnSelect({
  label,
  value,
  headers,
  optional,
  onChange,
}: {
  label: string;
  value: string | null;
  headers: readonly string[];
  optional?: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <GroupRow label={label}>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
        <SelectTrigger aria-label={label} className="h-[26px] w-auto min-w-36 max-w-56 max-sm:h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{optional ? "Not in file" : "Choose"}</SelectItem>
          {headers.map((header) => (
            <SelectItem key={header} value={header}>
              {header}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </GroupRow>
  );
}

function MappingEditor({
  preview,
  pending,
  onSaved,
}: {
  preview: ImportPreviewView;
  pending: boolean;
  onSaved: (profileId: string) => void;
}) {
  const [mapping, setMapping] = React.useState<MappingView>(preview.mapping);
  const [saving, startSaving] = React.useTransition();
  const set = <K extends keyof MappingView>(key: K, value: MappingView[K]) =>
    setMapping((current) => ({ ...current, [key]: value }));
  const headers = preview.headers;
  const field = "h-[26px] w-40 text-right max-sm:h-11";

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-4 pt-3">
        <h3 className="flex-1 text-sm font-semibold text-label2">
          Columns
          <InfoButton label="About the column mapping" className="ml-1 inline-grid align-middle">
            {preview.profileConfirmationRequired
              ? "Proposed from the file's headers. Correct anything wrong, then save it for this account."
              : `Using “${preview.profileName ?? "saved mapping"}”. Change it and save to re-read the file.`}
          </InfoButton>
        </h3>
        <Button
          size="sm"
          disabled={pending || saving}
          onClick={() =>
            startSaving(async () => {
              const result = await saveStatementMapping(preview.bankAccountId, preview.baseMapping, mapping, preview.profileId);
              if (!result.ok) {
                toast.error(result.error.message);
                return;
              }
              toast.success(`Saved mapping “${result.value.name}”. Reading the file again…`);
              onSaved(result.value.profileId);
            })
          }
        >
          <Glyph name="refresh" />
          Save and re-read
        </Button>
      </div>
      <div className="grid gap-3.5 lg:grid-cols-2">
        <InsetGroup>
          <ColumnSelect label="Date" value={mapping.date_column} headers={headers} onChange={(v) => set("date_column", v ?? "")} />
          <GroupRow label="Date format" htmlFor="mapping-date-format">
            <Input
              id="mapping-date-format"
              className={cn("num", field)}
              placeholder="Detect"
              value={mapping.date_format ?? ""}
              onChange={(e) => set("date_format", e.target.value === "" ? null : e.target.value)}
            />
          </GroupRow>
          <ColumnSelect
            label="Payee"
            optional
            value={mapping.counterparty_column}
            headers={headers}
            onChange={(v) => set("counterparty_column", v)}
          />
          <ColumnSelect
            label="Description"
            optional
            value={mapping.description_columns[0] ?? null}
            headers={headers}
            onChange={(v) => set("description_columns", v === null ? [] : [v, ...mapping.description_columns.slice(1)])}
          />
          <ColumnSelect
            label="Reference"
            optional
            value={mapping.reference_column}
            headers={headers}
            onChange={(v) => set("reference_column", v)}
          />
        </InsetGroup>
        <InsetGroup>
          <GroupRow label="Amounts">
            <Select value={mapping.mode} onValueChange={(v) => set("mode", v as MappingView["mode"])}>
              <SelectTrigger aria-label="Amount layout" className="h-[26px] w-auto min-w-36 max-sm:h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="signed">One signed column</SelectItem>
                <SelectItem value="debit_credit">Separate out and in columns</SelectItem>
                <SelectItem value="amount_with_type">An amount and a type column</SelectItem>
              </SelectContent>
            </Select>
          </GroupRow>
          {mapping.mode === "debit_credit" ? (
            <>
              <ColumnSelect label="Money out" value={mapping.debit_column} headers={headers} onChange={(v) => set("debit_column", v)} />
              <ColumnSelect label="Money in" value={mapping.credit_column} headers={headers} onChange={(v) => set("credit_column", v)} />
            </>
          ) : (
            <ColumnSelect label="Amount" value={mapping.amount_column} headers={headers} onChange={(v) => set("amount_column", v)} />
          )}
          {mapping.mode === "amount_with_type" ? (
            <>
              <ColumnSelect label="Type" value={mapping.type_column} headers={headers} onChange={(v) => set("type_column", v)} />
              <GroupRow label="Means out" htmlFor="mapping-debit-types">
                <Input
                  id="mapping-debit-types"
                  className={field}
                  value={mapping.debit_type_values.join(", ")}
                  placeholder="DEBIT, DR"
                  onChange={(e) => set("debit_type_values", e.target.value.split(",").map((v) => v.trim()))}
                />
              </GroupRow>
              <GroupRow label="Means in" htmlFor="mapping-credit-types">
                <Input
                  id="mapping-credit-types"
                  className={field}
                  value={mapping.credit_type_values.join(", ")}
                  placeholder="CREDIT, CR"
                  onChange={(e) => set("credit_type_values", e.target.value.split(",").map((v) => v.trim()))}
                />
              </GroupRow>
            </>
          ) : null}
          <ColumnSelect
            label="Balance"
            optional
            value={mapping.balance_column}
            headers={headers}
            onChange={(v) => set("balance_column", v)}
          />
          <GroupRow label="Flip signs" htmlFor="mapping-invert">
            <Checkbox id="mapping-invert" checked={mapping.invert_sign} onCheckedChange={(v) => set("invert_sign", v === true)} />
          </GroupRow>
        </InsetGroup>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function ImportResult({
  result,
  filename,
  bank,
  onAgain,
}: {
  result: ImportCommitView;
  filename: string;
  bank: string;
  onAgain: () => void;
}) {
  const ai = result.ai;
  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <Card className="flex flex-col items-center gap-2 px-5 pt-8 pb-6 text-center">
        <span className="grid size-16 place-items-center rounded-full bg-tint-green text-white">
          <Glyph name="check" size={32} weight={2.4} />
        </span>
        <h2 className="text-2xl font-bold tracking-[-0.022em]">Imported {result.inserted}</h2>
        <p className="flex flex-wrap items-center justify-center gap-1.5 text-sm font-medium break-all text-label2">
          <span>{filename}</span>
          <span aria-hidden className="size-[3px] rounded-full bg-label3" />
          <span className="inline-flex items-center gap-1">
            <Glyph name="bank" size={14} />
            {bank}
          </span>
          <InfoButton label="About this import">
            <p>Nothing has posted. The new rows are waiting in the review queue.</p>
          </InfoButton>
        </p>
        <div className="mt-3 grid w-full max-w-2xl grid-cols-2 gap-y-3 sm:grid-cols-4">
          <Stat label="Imported">
            <span className="num">{result.inserted}</span>
          </Stat>
          <Stat label="Already imported" className="hairline-l">
            <span className="num text-label2">{result.duplicates}</span>
          </Stat>
          <Stat label="Transfers paired" glyph={<Glyph name="transfer" size={13} className="text-tint-blue" />} className="sm:hairline-l">
            <span className="num">{result.transferPairsLinked}</span>
          </Stat>
          <Stat label="Returns paired" glyph={<Glyph name="undo" size={13} />} className="hairline-l">
            <span className="num">{result.returnedPairsLinked}</span>
          </Stat>
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href="/banking/review">
              <Glyph name="tray" />
              Review
            </Link>
          </Button>
          <Button variant="secondary" onClick={onAgain}>
            <Glyph name="refresh" />
            Import another
          </Button>
        </div>
      </Card>

      <InsetGroup separatorInset={52}>
        <ListRow
          leading={<IconBadge glyph="sparkle" tint="purple" size="lg" />}
          title="AI suggestions"
          subtitle={
            ai === null ? (
              "Not needed"
            ) : ai.skippedReason !== null ? (
              <span className="whitespace-normal">Not run: {ai.skippedReason}</span>
            ) : (
              <span className="num">
                {ai.written} of {ai.attempted}
                {ai.discarded > 0 ? ` · ${ai.discarded} refused` : ""}
                {ai.unanswered > 0 ? ` · ${ai.unanswered} unanswered` : ""}
              </span>
            )
          }
          detail={ai?.modelId ?? undefined}
        />
        {ai !== null
          ? ai.failures.map((failure) => (
              <ListRow
                key={failure}
                leading={<IconBadge glyph="warning" tint="red" size="lg" />}
                title={<span className="whitespace-normal">{failure}</span>}
              />
            ))
          : null}
        {result.issues.map((issue, index) => (
          <ListRow
            key={`${issue.code}-${index}`}
            leading={<IconBadge glyph={SEVERITY_BADGE[issue.severity].glyph} tint={SEVERITY_BADGE[issue.severity].tint} size="lg" />}
            title={<span className="whitespace-normal">{issue.message}</span>}
            subtitle={SEVERITY_LABEL[issue.severity]}
          />
        ))}
      </InsetGroup>
    </div>
  );
}

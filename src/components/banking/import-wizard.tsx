"use client";

import * as React from "react";
import Link from "next/link";
import {
  CircleCheck,
  CircleX,
  FileSpreadsheet,
  ListChecks,
  RotateCcw,
  Save,
  TriangleAlert,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  cancelStatement,
  commitStatement,
  previewStatement,
  saveStatementMapping,
} from "@/app/(app)/banking/actions";

import { Figure, InCell, OutCell, Th } from "./parts";
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
    <Card>
      <CardContent className="flex flex-col gap-4">
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
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-strong bg-surface-sunken/40 px-4 py-10 text-center transition-colors hover:bg-muted",
            dragging && "border-primary bg-primary/6",
          )}
        >
          {file === null ? (
            <>
              <Upload className="size-5 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">Drop a bank statement here, or choose a file</p>
              <p className="text-xs text-muted-foreground">CSV or Excel, up to 950 KB. Relay exports are recognised by name.</p>
            </>
          ) : (
            <>
              <FileSpreadsheet className="size-5 text-primary" aria-hidden />
              <p className="text-sm font-medium break-all">{file.name}</p>
              <p className="num text-xs text-muted-foreground">
                {(file.size / 1024).toFixed(1)} KB · choose a different file
              </p>
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

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-60 flex-1 flex-col gap-1.5">
            <Label htmlFor="import-account" hint={guessed ? "read from the filename" : undefined}>
              Bank account
            </Label>
            <Select value={bankAccountId} onValueChange={setBankAccountId}>
              <SelectTrigger id="import-account">
                <SelectValue placeholder="Which account is this statement for?" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button disabled={file === null || bankAccountId === "" || pending} onClick={() => runPreview(null, null)}>
            {pending ? "Reading…" : "Preview import"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The preview writes nothing to the books. Imported transactions land in the review queue; only rows an
          owner-marked auto-post rule codes can post without review.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: ImportIssueView["severity"][] = ["fatal", "error", "warn", "info"];
const SEVERITY_TONE = { fatal: "negative", error: "negative", warn: "warning", info: "neutral" } as const;
const SEVERITY_LABEL = { fatal: "Blocks import", error: "Needs a decision", warn: "Warning", info: "Note" } as const;

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
    ? "This file cannot be imported as it is. The problems marked “Blocks import” say why."
    : preview.profileConfirmationRequired
      ? "Confirm the column mapping below before importing: this bank's format has not been seen before."
      : undecided.length > 0
        ? `Decide the ${undecided.length} row${undecided.length === 1 ? "" : "s"} marked below before importing.`
        : preview.counts.new === 0
          ? "Every row in this file is already in the books. There is nothing new to import."
          : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle className="break-all">{preview.filename}</CardTitle>
            <CardDescription>
              {preview.importerLabel} · {Math.round(preview.detectionConfidence * 100)}% sure ·{" "}
              {preview.bankAccountMask === null ? preview.bankAccountName : `••${preview.bankAccountMask} ${preview.bankAccountName}`}
              {preview.partial ? " · partial month" : ""}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={onCommit} disabled={!canCommit || pending}>
              <Upload />
              {pending ? "Importing…" : `Import ${preview.counts.new} new`}
            </Button>
          </div>
        </CardHeader>
        {blocker !== null ? (
          <p className="flex gap-2 border-b border-border bg-warning/8 px-4 py-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {blocker}
          </p>
        ) : null}
        {preview.priorImport !== null ? (
          <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
            This exact file was imported before ({preview.priorImport.importedCount} rows). Re-importing is safe:
            duplicates are counted and skipped.
          </p>
        ) : null}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="New">
            <span className="num">{preview.counts.new}</span>
          </Figure>
          <Figure label="Already imported" className="border-l">
            <span className="num text-muted-foreground">{preview.counts.duplicate}</span>
          </Figure>
          <Figure label="Skipped" className="border-t sm:border-t-0 sm:border-l">
            <span className="num text-muted-foreground">{preview.counts.skipped}</span>
          </Figure>
          <Figure label="Dates" className="border-t border-l lg:border-t-0">
            <span className="num text-sm">
              {preview.dateRange === null ? "—" : `${shortDate(preview.dateRange.min)} – ${shortDate(preview.dateRange.max)}`}
            </span>
          </Figure>
          <Figure label="Money in" className="border-t sm:border-l lg:border-t-0">
            <Money cents={preview.totals.inflowCents} currency colorPositive />
          </Figure>
          <Figure label="Money out" className="border-t border-l lg:border-t-0">
            <Money cents={-Math.abs(preview.totals.outflowCents)} currency />
          </Figure>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>
            <span className="num text-foreground">{preview.counts.needsReview}</span> will need review
          </span>
          <span>
            <span className="num text-foreground">{preview.counts.autoPost}</span> coded by an auto-post rule
          </span>
          <span>
            <span className="num text-foreground">{preview.counts.excluded}</span> excluded (money never moved)
          </span>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <BalanceChainCard preview={preview} />
        <Card>
          <CardHeader>
            <CardTitle>Problems and notes</CardTitle>
            <div className="flex gap-1">
              {SEVERITY_ORDER.map((severity) =>
                preview.issueCounts[severity] > 0 ? (
                  <Badge key={severity} tone={SEVERITY_TONE[severity]}>
                    {preview.issueCounts[severity]} {severity}
                  </Badge>
                ) : null,
              )}
            </div>
          </CardHeader>
          {issues.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">Nothing to report: every row read cleanly.</p>
          ) : (
            <ul className="relative max-h-72 divide-y divide-border overflow-y-auto">
              {issues.map((issue, index) => (
                <li key={`${issue.code}-${index}`} className="flex flex-col gap-0.5 px-4 py-2 text-xs">
                  <span className="flex items-center gap-2">
                    <Badge tone={SEVERITY_TONE[issue.severity]} size="sm">
                      {SEVERITY_LABEL[issue.severity]}
                    </Badge>
                    {issue.rowIndex === null ? null : <span className="num text-muted-foreground">row {issue.rowIndex + 1}</span>}
                  </span>
                  <span className="text-foreground">{issue.message}</span>
                  {issue.remedy === null ? null : <span className="text-muted-foreground">{issue.remedy}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {preview.profileConfirmationRequired || preview.mappingEditable ? (
        <MappingEditor preview={preview} pending={pending} onSaved={onRemap} />
      ) : null}

      {preview.decisionsRequired.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Rows that need your decision</CardTitle>
            <CardDescription>The file alone cannot say what these are.</CardDescription>
          </CardHeader>
          <ul className="divide-y divide-border">
            {preview.decisionsRequired.map((rowIndex) => {
              const row = preview.rows.find((r) => r.rowIndex === rowIndex);
              if (row === undefined) return null;
              return (
                <li key={rowIndex} className="flex flex-wrap items-center gap-3 px-4 py-2">
                  <span className="num text-xs text-muted-foreground">{row.txnDate === "" ? "—" : shortDate(row.txnDate)}</span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block truncate font-medium">{row.payee}</span>
                    <span className="block text-xs text-muted-foreground">{row.decisionRequired}</span>
                  </span>
                  <Money cents={row.amountCents} signed colorPositive />
                  <Select
                    value={decisions[rowIndex] ?? undefined}
                    onValueChange={(value) => onDecide(rowIndex, value as ImportDecisionView["choice"])}
                  >
                    <SelectTrigger className="w-44" aria-label={`Decision for row ${rowIndex + 1}`}>
                      <SelectValue placeholder="Decide…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="exclude">Exclude — money never moved</SelectItem>
                      <SelectItem value="review">Import for review</SelectItem>
                      <SelectItem value="skip">Leave out of the import</SelectItem>
                    </SelectContent>
                  </Select>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{showAll ? "Every row in the file" : "New rows"}</CardTitle>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={showAll} onCheckedChange={(value) => setShowAll(value === true)} />
            Show already-imported and skipped rows
          </label>
        </CardHeader>
        <div className="relative max-h-[32rem] overflow-auto">
          <table className="w-full min-w-[50rem] border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10">
              <tr>
                <Th className="w-16">Date</Th>
                <Th>Payee</Th>
                <Th className="w-[30%]">Proposed</Th>
                <Th className="w-24">Row</Th>
                <Th className="w-28 text-right">Money in</Th>
                <Th className="rule-gutter w-28 text-right">Money out</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-xs text-muted-foreground">
                    No new rows in this file.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.rowIndex} className={cn("align-top", row.class !== "new" && "text-muted-foreground")}>
                    <td className="rule-row num px-3 py-1.5 text-xs whitespace-nowrap">
                      {row.txnDate === "" ? "—" : shortDate(row.txnDate)}
                    </td>
                    <td className="rule-row max-w-0 px-3 py-1.5">
                      <p className="truncate">{row.payee}</p>
                      {row.reference ? <p className="truncate text-2xs text-muted-foreground">{row.reference}</p> : null}
                    </td>
                    <td className="rule-row max-w-0 px-3 py-1.5 text-xs">
                      {row.suggestion?.accountLabel ? (
                        <p className="truncate">
                          {row.suggestion.accountLabel}{" "}
                          <span className="text-muted-foreground">
                            · {row.suggestion.source} {Math.round(row.suggestion.confidence * 100)}%
                          </span>
                          {row.suggestion.autoPost ? (
                            <Badge tone="primary" size="sm" className="ml-1">
                              Auto-post
                            </Badge>
                          ) : null}
                        </p>
                      ) : (
                        <span className="text-muted-foreground">{row.proposedStatus === "excluded" ? "Excluded" : "For review"}</span>
                      )}
                    </td>
                    <td className="rule-row px-3 py-1.5">
                      <Badge tone={row.class === "new" ? "info" : "neutral"} size="sm">
                        {row.class === "duplicate" ? "Imported" : row.class}
                      </Badge>
                    </td>
                    <InCell cents={row.amountCents} className="rule-row" />
                    <OutCell cents={row.amountCents} className="rule-row" />
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function BalanceChainCard({ preview }: { preview: ImportPreviewView }) {
  const chain = preview.balanceChain;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Running balance</CardTitle>
        {chain === null ? (
          <Badge>Not in file</Badge>
        ) : chain.ok ? (
          <Badge tone="positive">
            <CircleCheck />
            Ties
          </Badge>
        ) : (
          <Badge tone="negative">
            <CircleX />
            {chain.breaks.length} break{chain.breaks.length === 1 ? "" : "s"}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        {chain === null ? (
          <p className="text-muted-foreground">
            This file has no balance column, so its arithmetic cannot be checked row by row.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground">
              {chain.checked} rows checked. Opens at{" "}
              {chain.openingBalanceCents === null ? "—" : <Money cents={chain.openingBalanceCents} currency plain />}, closes at{" "}
              {chain.closingBalanceCents === null ? "—" : <Money cents={chain.closingBalanceCents} currency plain />}.
            </p>
            {chain.breaks.slice(0, 6).map((b) => (
              <p key={b.rowIndex} className="text-negative">
                Row {b.rowIndex + 1}: expected <Money cents={b.expectedCents} currency plain />, the bank printed{" "}
                <Money cents={b.actualCents} currency plain /> (off by <Money cents={b.deltaCents} currency signed plain />).
              </p>
            ))}
          </>
        )}
        {preview.assertions.length > 0 ? (
          <ul className="flex flex-col gap-1 border-t border-border pt-2">
            {preview.assertions.map((assertion) => (
              <li key={assertion.id} className="flex items-start gap-1.5">
                {assertion.passed ? (
                  <CircleCheck className="mt-px size-3.5 shrink-0 text-positive" aria-label="Passed" />
                ) : (
                  <CircleX className="mt-px size-3.5 shrink-0 text-negative" aria-label="Failed" />
                )}
                <span>
                  {assertion.label}
                  {assertion.detail !== null && !assertion.passed ? (
                    <span className="block text-muted-foreground">{assertion.detail}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
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
    <div className="flex flex-col gap-1.5">
      <Label hint={optional ? "optional" : undefined}>{label}</Label>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{optional ? "Not in this file" : "Choose a column"}</SelectItem>
          {headers.map((header) => (
            <SelectItem key={header} value={header}>
              {header}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
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

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Column mapping</CardTitle>
          <CardDescription>
            {preview.profileConfirmationRequired
              ? "Proposed from the file's headers. Correct anything wrong, then save it for this account."
              : `Using “${preview.profileName ?? "saved mapping"}”. Change it and save to re-read the file.`}
          </CardDescription>
        </div>
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
          <Save />
          Save and re-read
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ColumnSelect label="Date" value={mapping.date_column} headers={headers} onChange={(v) => set("date_column", v ?? "")} />
        <div className="flex flex-col gap-1.5">
          <Label hint="blank to detect">Date format</Label>
          <Input
            className="num"
            placeholder="M/D/YYYY"
            value={mapping.date_format ?? ""}
            onChange={(e) => set("date_format", e.target.value === "" ? null : e.target.value)}
          />
        </div>
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
        <div className="flex flex-col gap-1.5">
          <Label>Amounts are</Label>
          <Select value={mapping.mode} onValueChange={(v) => set("mode", v as MappingView["mode"])}>
            <SelectTrigger aria-label="Amount layout">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="signed">One signed column</SelectItem>
              <SelectItem value="debit_credit">Separate out and in columns</SelectItem>
              <SelectItem value="amount_with_type">An amount and a type column</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
            <div className="flex flex-col gap-1.5">
              <Label hint="comma separated">Type means out</Label>
              <Input
                value={mapping.debit_type_values.join(", ")}
                placeholder="DEBIT, DR"
                onChange={(e) => set("debit_type_values", e.target.value.split(",").map((v) => v.trim()))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label hint="comma separated">Type means in</Label>
              <Input
                value={mapping.credit_type_values.join(", ")}
                placeholder="CREDIT, CR"
                onChange={(e) => set("credit_type_values", e.target.value.split(",").map((v) => v.trim()))}
              />
            </div>
          </>
        ) : null}
        <ColumnSelect
          label="Running balance"
          optional
          value={mapping.balance_column}
          headers={headers}
          onChange={(v) => set("balance_column", v)}
        />
        <ColumnSelect
          label="Reference"
          optional
          value={mapping.reference_column}
          headers={headers}
          onChange={(v) => set("reference_column", v)}
        />
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <Checkbox checked={mapping.invert_sign} onCheckedChange={(v) => set("invert_sign", v === true)} />
          Flip every sign (card statements)
        </label>
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="break-all">Imported {filename}</CardTitle>
          <CardDescription>Into {bank}. Nothing has posted; the new rows are waiting in the review queue.</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onAgain}>
            <RotateCcw />
            Import another
          </Button>
          <Button asChild size="sm">
            <Link href="/banking/review">
              <ListChecks />
              Review them
            </Link>
          </Button>
        </div>
      </CardHeader>
      <div className="grid grid-cols-2 sm:grid-cols-4">
        <Figure label="Imported">
          <span className="num">{result.inserted}</span>
        </Figure>
        <Figure label="Already imported" className="border-l">
          <span className="num text-muted-foreground">{result.duplicates}</span>
        </Figure>
        <Figure label="Transfers paired" className="border-t sm:border-t-0 sm:border-l">
          <span className="num">{result.transferPairsLinked}</span>
        </Figure>
        <Figure label="Returns paired" className="border-t border-l sm:border-t-0">
          <span className="num">{result.returnedPairsLinked}</span>
        </Figure>
      </div>
      <CardContent className="flex flex-col gap-2 border-t border-border text-sm">
        <p className="eyebrow">AI suggestions</p>
        {ai === null ? (
          <p className="text-xs text-muted-foreground">Not run: every new row already had a rule or history suggestion.</p>
        ) : ai.skippedReason !== null ? (
          <p className="text-xs text-muted-foreground">Not run: {ai.skippedReason}</p>
        ) : (
          <p className="text-xs">
            Asked about <span className="num">{ai.attempted}</span> row{ai.attempted === 1 ? "" : "s"}
            {ai.modelId === null ? "" : ` (${ai.modelId})`}: <span className="num">{ai.written}</span> suggested,{" "}
            <span className="num">{ai.discarded}</span> answers refused by the guardrails,{" "}
            <span className={cn("num", ai.unanswered > 0 && "text-warning")}>{ai.unanswered}</span> unanswered.
            {ai.unanswered > 0 ? " Unanswered rows wait in the queue with no suggestion." : ""}
          </p>
        )}
        {ai !== null && ai.failures.length > 0 ? (
          <ul className="list-disc pl-5 text-xs text-negative">
            {ai.failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        ) : null}
        {result.issues.length > 0 ? (
          <ul className="flex flex-col gap-1 border-t border-border pt-2 text-xs">
            {result.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <Badge tone={SEVERITY_TONE[issue.severity]} size="sm" className="mr-1.5">
                  {issue.severity}
                </Badge>
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

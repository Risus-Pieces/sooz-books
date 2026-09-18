"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, FileSpreadsheet, TriangleAlert, Upload, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { importSettlementFile, previewSettlementFile } from "@/app/(app)/channels/actions";

import { Figure, Notice, Td, Th, longDate } from "./parts";
import { PROVIDER_GUIDE } from "./providers";
import { PROVIDER_KEYS, PROVIDER_NAME, type ProviderKey, type SettlementPreviewView } from "./types";

const MAX_BYTES = 950 * 1024;

const SEVERITY_TONE = { fatal: "negative", error: "negative", warn: "warning", info: "neutral" } as const;
const SEVERITY_LABEL = { fatal: "Blocks import", error: "Error", warn: "Warning", info: "Note" } as const;

function FilePick({
  id,
  file,
  accept,
  prompt,
  hint,
  onPick,
  compact = false,
}: {
  id: string;
  file: File | null;
  accept: string;
  prompt: string;
  hint: string;
  onPick: (file: File | null) => void;
  compact?: boolean;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  React.useEffect(() => {
    if (file === null && ref.current !== null) ref.current.value = "";
  }, [file]);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={prompt}
      onClick={() => ref.current?.click()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          ref.current?.click();
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
        onPick(event.dataTransfer.files.item(0));
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border-strong bg-surface-sunken/40 px-4 text-center transition-colors hover:bg-muted",
        compact ? "py-4" : "py-8",
        dragging && "border-primary bg-primary/6",
      )}
    >
      {file === null ? (
        <>
          <Upload className="size-4 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">{prompt}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </>
      ) : (
        <>
          <FileSpreadsheet className="size-4 text-primary" aria-hidden />
          <p className="text-sm font-medium break-all">{file.name}</p>
          <p className="num text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB · choose a different file</p>
        </>
      )}
      <input
        id={id}
        ref={ref}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => onPick(event.target.files?.item(0) ?? null)}
      />
    </div>
  );
}

/**
 * Loading a channel's settlement export: choose the channel, choose the file, see every
 * settlement in it with its identity check and its deposit, then import. Importing records
 * the settlements; nothing posts until someone opens one and posts it.
 */
export function SettlementImport({ initialProvider, canImport }: { initialProvider: ProviderKey; canImport: boolean }) {
  const router = useRouter();
  const [provider, setProvider] = React.useState<ProviderKey>(initialProvider);
  const [file, setFile] = React.useState<File | null>(null);
  const [orders, setOrders] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<SettlementPreviewView | null>(null);
  const [pending, startTransition] = React.useTransition();
  const guide = PROVIDER_GUIDE[provider];

  const choose = (next: ProviderKey) => {
    setProvider(next);
    setFile(null);
    setOrders(null);
    setPreview(null);
  };

  const pick = (setter: (f: File | null) => void) => (next: File | null) => {
    if (next === null) return;
    if (next.size > MAX_BYTES) {
      toast.error("That file is larger than 950 KB. Export a shorter date range and import it in parts.");
      return;
    }
    setter(next);
    setPreview(null);
  };

  const form = (): FormData => {
    const data = new FormData();
    data.set("provider", provider);
    if (file !== null) data.set("file", file);
    if (orders !== null) data.set("orders", orders);
    return data;
  };

  const check = () =>
    startTransition(async () => {
      const result = await previewSettlementFile(form());
      if (!result.ok) {
        toast.error("File not read", { description: result.error.message });
        return;
      }
      setPreview(result.value);
    });

  const commit = () =>
    startTransition(async () => {
      const result = await importSettlementFile(form());
      if (!result.ok) {
        toast.error("Nothing imported", { description: result.error.message });
        return;
      }
      const v = result.value;
      toast.success(`Imported ${v.inserted} ${PROVIDER_NAME[v.provider]} settlement${v.inserted === 1 ? "" : "s"}`, {
        description: [
          v.alreadyImported > 0 ? `${v.alreadyImported} already in the books.` : null,
          v.depositsLinked > 0 ? `${v.depositsLinked} matched to a bank deposit.` : null,
          "Open each one to see its entry and post it.",
        ]
          .filter(Boolean)
          .join(" "),
      });
      setFile(null);
      setOrders(null);
      setPreview(null);
      router.refresh();
    });

  return (
    <Card id="import" className="scroll-mt-4">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Import a settlement file</CardTitle>
          <CardDescription>Checked to the cent before anything is written. Importing never posts.</CardDescription>
        </div>
      </CardHeader>

      <div className="flex flex-col gap-4 p-4">
        <div role="radiogroup" aria-label="Channel" className="flex flex-wrap gap-1.5">
          {PROVIDER_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={provider === key}
              onClick={() => choose(key)}
              className={cn(
                "h-7 rounded-sm border px-3 text-xs font-medium transition-colors max-sm:h-10",
                provider === key
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border-strong bg-surface-raised text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {PROVIDER_NAME[key]}
            </button>
          ))}
        </div>

        <div className="grid gap-3 text-xs sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <p className="eyebrow">File</p>
            <p className="mt-0.5 text-sm font-medium">{guide.file}</p>
          </div>
          <div>
            <p className="eyebrow">Where to get it</p>
            <p className="mt-0.5 text-muted-foreground">{guide.path}</p>
          </div>
        </div>

        {!canImport ? (
          <p className="text-xs text-muted-foreground">Importing is not part of your role. Ask the owner or the bookkeeper to load the file.</p>
        ) : (
          <>
            <div className={cn("grid gap-3", guide.secondary !== null && "md:grid-cols-[2fr_1fr]")}>
              <FilePick
                id="settlement-file"
                file={file}
                accept={guide.accept}
                prompt={`Drop the ${PROVIDER_NAME[provider]} ${guide.file.replace(/ \(.*\)$/, "").toLowerCase()} here, or choose it`}
                hint={`${guide.note} Up to 950 KB.`}
                onPick={pick(setFile)}
              />
              {guide.secondary === null ? null : (
                <FilePick
                  id="settlement-orders"
                  file={orders}
                  accept={guide.accept}
                  prompt={guide.secondary.label}
                  hint={guide.secondary.path}
                  onPick={pick(setOrders)}
                  compact
                />
              )}
            </div>
            {preview === null ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">Checking writes nothing to the books.</p>
                <Button disabled={file === null || pending} onClick={check}>
                  {pending ? "Checking…" : "Check file"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {preview === null ? null : <PreviewPanel preview={preview} pending={pending} onCancel={() => setPreview(null)} onCommit={commit} />}
    </Card>
  );
}

function PreviewPanel({
  preview,
  pending,
  onCancel,
  onCommit,
}: {
  preview: SettlementPreviewView;
  pending: boolean;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const failed = preview.settlements.filter((s) => !s.ties).length;
  const blocker = !preview.ok
    ? failed > 0
      ? `${failed} settlement${failed === 1 ? " does" : "s do"} not tie, so nothing in this file can be imported. Re-export it; never adjust a figure to make it tie.`
      : "This file cannot be imported as it is. The problems below say why."
    : preview.newCount === 0
      ? "Every settlement in this file is already in the books. There is nothing new to import."
      : null;
  const issues = preview.issues.filter((i) => i.severity !== "info");

  return (
    <div className="border-t border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-semibold break-all">{preview.filename}</p>
          <p className="text-xs text-muted-foreground">
            {PROVIDER_NAME[preview.provider]} · <span className="num">{preview.rowCount}</span> rows
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={onCommit} disabled={!preview.ok || preview.newCount === 0 || pending}>
            <Upload />
            {pending ? "Importing…" : `Import ${preview.newCount} new`}
          </Button>
        </div>
      </div>
      {blocker === null ? null : (
        <Notice tone={preview.ok ? "plain" : "negative"} icon={<TriangleAlert />} className="border-t">
          {blocker}
        </Notice>
      )}
      <div className="grid grid-cols-2 border-t border-border sm:grid-cols-4">
        <Figure label="Settlements">
          <span className="num">{preview.settlements.length}</span>
        </Figure>
        <Figure label="New" className="border-l">
          <span className="num">{preview.newCount}</span>
        </Figure>
        <Figure label="Already imported" className="border-t sm:border-t-0 sm:border-l">
          <span className="num text-muted-foreground">{preview.alreadyCount}</span>
        </Figure>
        <Figure label="Net to the bank" className="border-t border-l sm:border-t-0">
          <Money cents={preview.netTotalCents} currency />
        </Figure>
      </div>

      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[46rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Settlements in {preview.filename}</caption>
          <thead>
            <tr>
              <Th>Settlement</Th>
              <Th className="w-28">Date</Th>
              <Th className="w-28 text-right">Gross</Th>
              <Th className="w-28 text-right">Fees</Th>
              <Th className="w-28 text-right">Net</Th>
              <Th className="w-40">Deposit</Th>
            </tr>
          </thead>
          <tbody>
            {preview.settlements.map((s) => (
              <React.Fragment key={s.key}>
                <tr>
                  <Td className="pb-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="num text-xs break-all">{s.key}</span>
                      {s.outcome === "already_imported" ? <Badge size="sm">Already imported</Badge> : null}
                    </div>
                  </Td>
                  <Td className="num pb-0.5 text-xs whitespace-nowrap text-muted-foreground">{longDate(s.periodEnd)}</Td>
                  <Td className="pb-0.5 text-right">
                    <Money cents={s.grossCents} plain />
                  </Td>
                  <Td className="pb-0.5 text-right">
                    {s.feesCents === null ? <span className="text-muted-foreground">—</span> : <Money cents={s.feesCents} plain zeroDash />}
                  </Td>
                  <Td className="pb-0.5 text-right">
                    <Money cents={s.netCents} plain className="font-medium" />
                  </Td>
                  <Td className="pb-0.5">
                    <Badge tone={s.deposit.status === "matched" ? "positive" : s.deposit.status === "none" ? "neutral" : "warning"} size="sm">
                      {s.deposit.status === "matched" ? "Deposit found" : s.deposit.status === "none" ? "Not yet in bank" : s.deposit.status}
                    </Badge>
                  </Td>
                </tr>
                <tr>
                  <td colSpan={6} className="rule-row px-3 pb-2">
                    <ul className="flex flex-col gap-0.5">
                      {s.checks.map((c, index) => (
                        <li key={`${c.label}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                          {c.passed ? (
                            <Check className="size-3 shrink-0 self-center text-positive" aria-label="Passed" />
                          ) : (
                            <X className={cn("size-3 shrink-0 self-center", c.severity === "fatal" ? "text-negative" : "text-warning")} aria-label="Failed" />
                          )}
                          <span className={cn(c.passed ? "text-muted-foreground" : "text-foreground")}>{c.label}</span>
                          <span className="num text-muted-foreground">
                            <Money cents={c.actualCents} plain /> {c.passed ? "=" : "≠"} <Money cents={c.expectedCents} plain />
                          </span>
                          {c.passed ? null : (
                            <span className={cn(c.severity === "fatal" ? "text-negative" : "text-warning")}>
                              off by <Money cents={c.differenceCents} plain />
                              {c.detail === null ? "" : ` — ${c.detail}`}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {issues.length === 0 ? null : (
        <ul className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} className="flex flex-wrap items-baseline gap-2 text-xs">
              <Badge tone={SEVERITY_TONE[issue.severity]} size="sm">
                {SEVERITY_LABEL[issue.severity]}
              </Badge>
              <span className="min-w-0 flex-1">
                {issue.message}
                {issue.remedy === null ? null : <span className="text-muted-foreground"> {issue.remedy}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

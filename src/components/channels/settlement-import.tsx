"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { importSettlementFile, previewSettlementFile } from "@/app/(app)/channels/actions";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";

import { longDate } from "./parts";
import { PROVIDER_GUIDE } from "./providers";
import { PROVIDER_KEYS, PROVIDER_NAME, type ProviderKey, type SettlementPreviewView } from "./types";

const MAX_BYTES = 950 * 1024;

const SEVERITY_TONE = { fatal: "red", error: "red", warn: "orange", info: "neutral" } as const;
const SEVERITY_LABEL = { fatal: "Blocks import", error: "Error", warn: "Warning", info: "Note" } as const;

// ---------------------------------------------------------------------------
// Open from anywhere on the page: the toolbar, an empty state, or a link ending in #import
// ---------------------------------------------------------------------------

const ImportContext = React.createContext<(() => void) | null>(null);

/**
 * Holds the import sheet for the Payouts page. Anything inside can open it with
 * <SettlementImportButton/>; arriving at the page with #import (the Channels page's Import links)
 * opens it too.
 */
export function SettlementImportProvider({
  initialProvider,
  canImport,
  children,
}: {
  initialProvider: ProviderKey;
  canImport: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const show = React.useCallback(() => setOpen(true), []);

  React.useEffect(() => {
    const check = () => {
      if (window.location.hash === "#import") setOpen(true);
    };
    check();
    const late = window.setTimeout(check, 60);
    window.addEventListener("hashchange", check);
    return () => {
      window.clearTimeout(late);
      window.removeEventListener("hashchange", check);
    };
  }, []);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && window.location.hash === "#import") {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  };

  return (
    <ImportContext.Provider value={show}>
      {children}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent title="Import settlements" width="lg" description="Checked to the cent before anything is written. Importing never posts.">
          <SettlementImport key={initialProvider} initialProvider={initialProvider} canImport={canImport} onDone={() => onOpenChange(false)} />
        </SheetContent>
      </Sheet>
    </ImportContext.Provider>
  );
}

export function SettlementImportButton({ appearance = "toolbar", label = "Import settlements" }: { appearance?: "toolbar" | "button"; label?: string }) {
  const open = React.useContext(ImportContext);
  if (appearance === "toolbar") {
    return <ToolbarButton glyph="import" label={label} onClick={() => open?.()} />;
  }
  return (
    <Button onClick={() => open?.()}>
      <Glyph name="import" />
      {label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

function FilePick({
  id,
  file,
  accept,
  prompt,
  onPick,
  compact = false,
}: {
  id: string;
  file: File | null;
  accept: string;
  prompt: string;
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
        "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed border-label3/60 bg-card px-4 text-center outline-none focus-ring transition-colors hover:bg-fill2 focus-visible:border-tint-blue",
        compact ? "py-4" : "py-8",
        dragging && "border-tint-blue bg-tint-blue/6",
      )}
    >
      {file === null ? (
        <>
          <Glyph name="doc" size={compact ? 22 : 30} weight={1.4} className="text-label3" />
          <p className="text-sm font-semibold">{prompt}</p>
        </>
      ) : (
        <>
          <Glyph name="doc-text" size={compact ? 22 : 30} weight={1.4} className="text-ink-blue" />
          <p className="text-sm font-semibold break-all">{file.name}</p>
          <p className="num text-xs text-label2">{(file.size / 1024).toFixed(1)} KB</p>
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
 * Loading a channel's settlement export: choose the channel and the file, see every settlement in
 * it with its identity check and its deposit, then import. Importing records the settlements;
 * nothing posts until someone opens one and posts it.
 */
export function SettlementImport({
  initialProvider,
  canImport,
  onDone,
}: {
  initialProvider: ProviderKey;
  canImport: boolean;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [provider, setProvider] = React.useState<ProviderKey>(initialProvider);
  const [file, setFile] = React.useState<File | null>(null);
  const [orders, setOrders] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<SettlementPreviewView | null>(null);
  const [pending, startTransition] = React.useTransition();
  const guide = PROVIDER_GUIDE[provider];

  const choose = (next: string) => {
    const key = PROVIDER_KEYS.find((k) => k === next);
    if (key === undefined) return;
    setProvider(key);
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
      onDone?.();
    });

  return (
    <div className="flex flex-col gap-4 pt-1">
      <SegmentedControl
        aria-label="Channel"
        fill
        value={provider}
        onValueChange={choose}
        options={PROVIDER_KEYS.map((key) => ({ value: key, label: PROVIDER_NAME[key] }))}
      />

      <div className="flex items-center gap-2 rounded-[14px] bg-card px-4 py-3 shadow-card">
        <Glyph name="doc-text" size={18} className="text-label2" />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{guide.file}</p>
        <InfoButton label="Where to get the file" title={guide.file}>
          <p>{guide.path}</p>
          {guide.secondary === null ? null : (
            <p>
              Optional: {guide.secondary.label} — {guide.secondary.path}
            </p>
          )}
          <p className="text-label2">{guide.note} Up to 950 KB.</p>
        </InfoButton>
      </div>

      {!canImport ? (
        <p className="flex items-center gap-2 px-1 text-sm text-label2">
          <Glyph name="lock" size={15} />
          Import needs the owner or bookkeeper
        </p>
      ) : (
        <>
          <div className={cn("grid gap-3", guide.secondary !== null && "sm:grid-cols-[2fr_1fr]")}>
            <FilePick id="settlement-file" file={file} accept={guide.accept} prompt={`Drop the ${PROVIDER_NAME[provider]} file`} onPick={pick(setFile)} />
            {guide.secondary === null ? null : (
              <FilePick id="settlement-orders" file={orders} accept={guide.accept} prompt="Orders (optional)" onPick={pick(setOrders)} compact />
            )}
          </div>
          {preview === null ? (
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto flex items-center gap-1.5 text-xs text-label2">
                <Glyph name="shield" size={13} />
                Checking writes nothing
              </span>
              <Button disabled={file === null || pending} onClick={check}>
                {pending ? "Checking…" : "Check file"}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {preview === null ? null : <PreviewPanel preview={preview} pending={pending} onCancel={() => setPreview(null)} onCommit={commit} />}
    </div>
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
      ? "Every settlement in this file is already in the books."
      : null;
  const issues = preview.issues.filter((i) => i.severity !== "info");

  return (
    <section aria-label="Preview" className="flex flex-col gap-3">
      <dl className="grid grid-cols-4 overflow-hidden rounded-[11px] bg-inset">
        {[
          { label: "Found", value: <span className="num">{preview.settlements.length}</span> },
          { label: "New", value: <span className="num">{preview.newCount}</span> },
          { label: "Already in", value: <span className="num text-label2">{preview.alreadyCount}</span> },
          { label: "Net", value: <Money cents={preview.netTotalCents} currency plain /> },
        ].map((f, index) => (
          <div key={f.label} className={cn("px-3 py-2", index > 0 && "hairline-l")}>
            <dt className="text-2xs font-semibold text-label2">{f.label}</dt>
            <dd className="text-sm font-semibold">{f.value}</dd>
          </div>
        ))}
      </dl>

      {blocker === null ? null : (
        <p className={cn("flex items-start gap-2 rounded-[11px] px-3 py-2 text-sm", preview.ok ? "bg-fill2 text-label2" : "bg-tint-red/10 text-ink-red")}>
          <Glyph name="warning" size={15} className="mt-0.5 shrink-0" />
          {blocker}
        </p>
      )}

      <ul className="overflow-hidden rounded-[14px] bg-card shadow-card">
        {preview.settlements.map((s, index) => {
          const failedChecks = s.checks.filter((c) => !c.passed);
          return (
            <li key={s.key} className={cn("flex flex-col gap-1 px-4 py-2.5", index > 0 && "hairline-t")}>
              <div className="flex items-center gap-2.5">
                <Glyph
                  name={s.ties ? "check-circle" : "xmark-circle"}
                  size={18}
                  className={s.ties ? "text-ink-green" : "text-ink-red"}
                  label={s.ties ? "Ties" : "Does not tie"}
                />
                <span className="min-w-0 flex-1">
                  <span className="num block truncate text-sm font-semibold">{s.key}</span>
                  <span className="block text-xs text-label2">
                    {longDate(s.periodEnd)} · gross <Money cents={s.grossCents} plain />
                    {s.feesCents === null ? null : (
                      <>
                        {" "}
                        · fees <Money cents={s.feesCents} plain />
                      </>
                    )}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <Money cents={s.netCents} currency plain className="text-sm font-semibold" />
                  {s.outcome === "already_imported" ? (
                    <span className="text-2xs font-semibold text-label2">Already in</span>
                  ) : (
                    <span className={cn("text-2xs font-semibold", s.deposit.status === "matched" ? "text-ink-green" : s.deposit.status === "none" ? "text-label2" : "text-ink-orange")}>
                      {s.deposit.status === "matched" ? "Deposit found" : s.deposit.status === "none" ? "Not in bank yet" : `Deposit ${s.deposit.status}`}
                    </span>
                  )}
                </span>
              </div>
              {failedChecks.length === 0 ? null : (
                <ul className="flex flex-col gap-0.5 pl-7">
                  {failedChecks.map((c, i) => (
                    <li key={`${c.label}-${i}`} className={cn("text-xs", c.severity === "fatal" ? "text-ink-red" : "text-ink-orange")}>
                      {c.label}: <Money cents={c.actualCents} plain /> ≠ <Money cents={c.expectedCents} plain />
                      {c.detail === null ? "" : ` — ${c.detail}`}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {issues.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} className="flex flex-wrap items-start gap-2 text-sm">
              <Pill tone={SEVERITY_TONE[issue.severity]}>{SEVERITY_LABEL[issue.severity]}</Pill>
              <span className="min-w-0 flex-1 leading-[1.45]">
                {issue.message}
                {issue.remedy === null ? null : <span className="text-label2"> {issue.remedy}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={onCommit} disabled={!preview.ok || preview.newCount === 0 || pending}>
          <Glyph name="import" />
          {pending ? "Importing…" : `Import ${preview.newCount} new`}
        </Button>
      </div>
    </section>
  );
}

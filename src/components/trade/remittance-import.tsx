"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { postRemittance, previewRemittance } from "@/app/(app)/trade/actions";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { Pill, type PillTone } from "@/components/ui/pill";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ToolbarButton } from "@/components/ui/toolbar";
import { Money } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import { TREATMENT_LABEL, longDate, shortDate } from "./labels";
import { RemittanceFileGuide } from "./workflow";
import { Disclosure, EntryLines, Field, SplitLedger } from "./parts";
import type { AdvicePreviewView, IssueView, RemittanceFormOptions, RemittancePostView, RemittancePreviewView } from "./types";

const MAX_BYTES = 950 * 1024;
const SOURCES = [
  { value: "auto", label: "Read it from the file" },
  { value: "KEHE", label: "KeHE" },
  { value: "UNFI", label: "UNFI" },
  { value: "DPI", label: "DPI" },
] as const;

const SEVERITY_TONE: Record<string, PillTone> = { fatal: "red", error: "red", warn: "orange", info: "neutral" };
const SEVERITY_LABEL: Record<string, string> = { fatal: "Blocks posting", error: "Error", warn: "Warning", info: "Note" };

function Issues({ issues, className }: { issues: IssueView[]; className?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1.5", className)}>
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className="flex flex-wrap items-start gap-2 text-sm">
          <Pill tone={SEVERITY_TONE[issue.severity] ?? "neutral"}>{SEVERITY_LABEL[issue.severity] ?? issue.severity}</Pill>
          <span className="min-w-0 flex-1 leading-[1.45]">
            {issue.message}
            {issue.remedy ? <span className="text-label2"> {issue.remedy}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FilePick({ file, onPick, disabled }: { file: File | null; onPick: (file: File | null) => void; disabled: boolean }) {
  const ref = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  React.useEffect(() => {
    if (file === null && ref.current !== null) ref.current.value = "";
  }, [file]);
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="Choose the remittance file"
      aria-disabled={disabled || undefined}
      onClick={() => (disabled ? null : ref.current?.click())}
      onKeyDown={(event) => {
        if (!disabled && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          ref.current?.click();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) onPick(event.dataTransfer.files.item(0));
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed border-label3/60 bg-card px-4 py-8 text-center outline-none focus-ring transition-colors focus-visible:border-tint-blue",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-fill2",
        dragging && "border-tint-blue bg-tint-blue/6",
      )}
    >
      {file === null ? (
        <>
          <Glyph name="doc" size={30} weight={1.4} className="text-label3" />
          <p className="text-sm font-semibold">Drop the remittance</p>
          <p className="text-xs text-label2">CSV or XLSX · 950 KB</p>
        </>
      ) : (
        <>
          <Glyph name="doc-text" size={30} weight={1.4} className="text-ink-blue" />
          <p className="text-sm font-semibold break-all">{file.name}</p>
          <p className="num text-xs text-label2">{(file.size / 1024).toFixed(1)} KB</p>
        </>
      )}
      <input
        ref={ref}
        type="file"
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => onPick(event.target.files?.item(0) ?? null)}
      />
    </div>
  );
}

const STATUS_BADGE: Record<AdvicePreviewView["status"], { tone: PillTone; label: string; glyph: "check-circle" | "warning" | "minus" }> = {
  ready: { tone: "green", label: "Ready", glyph: "check-circle" },
  quarantined: { tone: "red", label: "Held", glyph: "warning" },
  already_imported: { tone: "neutral", label: "Already posted", glyph: "minus" },
};

function AdvicePreview({ advice, depositLabel }: { advice: AdvicePreviewView; depositLabel: string }) {
  const badge = STATUS_BADGE[advice.status];
  return (
    <section aria-label={`Payment ${advice.paymentNumber}`} className="flex flex-col gap-3 rounded-[14px] bg-card px-4 py-3.5 shadow-card">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h3 className="num truncate text-sm font-semibold">{advice.paymentNumber}</h3>
          <p className="text-xs text-label2">
            {longDate(advice.paymentDate)}
            {advice.paymentMethod ? ` · ${advice.paymentMethod}` : ""}
            {advice.regionDc ? ` · DC ${advice.regionDc}` : ""} · {advice.lineCount} lines
          </p>
        </div>
        <Money cents={advice.totalCents} currency plain className="text-lg font-bold tracking-[-0.01em]" />
        <Pill tone={badge.tone} glyph={badge.glyph}>
          {badge.label}
        </Pill>
      </header>
      {advice.note ? <p className="text-xs text-label2">{advice.note}</p> : null}
      <Issues issues={advice.issues} />
      {advice.split !== null ? (
        <SplitLedger
          split={advice.split}
          depositLabel={depositLabel}
          contraLabel={[...new Set((advice.entry?.lines ?? []).filter((l) => l.accountCode.startsWith("45") && l.debitCents > 0).map((l) => `${l.accountCode} ${l.accountName}`))].join(" · ")}
        />
      ) : null}
      {advice.deductions.length > 0 ? (
        <div className="-mx-4 hairline-t">
          <Disclosure
            summary={
              <>
                Deductions<span className="font-normal text-label2">· {advice.deductions.length}</span>
              </>
            }
          >
            <ul className="flex flex-col pb-1">
              {advice.deductions.map((d, index) => (
                <li key={d.deductionNo} className={index > 0 ? "flex items-center gap-3 hairline-t px-5 py-2 max-sm:px-4" : "flex items-center gap-3 px-5 py-2 max-sm:px-4"}>
                  <span className="min-w-0 flex-1">
                    <span className="num block truncate text-sm font-semibold">{d.deductionNo}</span>
                    <span className="block truncate text-xs text-label2">
                      {d.reasonLabel ?? <span className="text-ink-orange">Unmapped “{d.sourceReasonCode ?? "—"}”</span>} · {TREATMENT_LABEL[d.treatment] ?? d.treatment}
                      {d.accrualChargedCents > 0 && d.accrualChargedCents < d.amountCents ? (
                        <>
                          {" "}
                          · <Money cents={d.accrualChargedCents} plain /> accrual
                        </>
                      ) : null}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end">
                    <Money cents={d.amountCents} currency plain className="text-sm font-semibold" />
                    <span className="text-2xs text-label2">{d.disputeDeadline === null ? "—" : `By ${shortDate(d.disputeDeadline)}`}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      ) : null}
      {advice.entry !== null ? (
        <div className="-mx-4 -mb-3.5 hairline-t">
          <Disclosure
            summary={
              <>
                Entry<span className="font-normal text-label2">· {advice.entry.lines.length} lines</span>
              </>
            }
          >
            <div className="pb-2">
              <EntryLines lines={advice.entry.lines} caption={`Entry for payment ${advice.paymentNumber}`} />
            </div>
          </Disclosure>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Open from anywhere on the page: the toolbar, an empty state, or a link ending in #import
// ---------------------------------------------------------------------------

const ImportContext = React.createContext<(() => void) | null>(null);

/**
 * Holds the import sheet for the Remittances page. <RemittanceImportButton/> opens it; arriving
 * with #import (the Deductions page's Import links) opens it too.
 */
export function RemittanceImportProvider({
  options,
  canPost,
  children,
}: {
  options: RemittanceFormOptions | null;
  canPost: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const show = React.useCallback(() => setOpen(true), []);

  React.useEffect(() => {
    if (options === null) return;
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
  }, [options]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && window.location.hash === "#import") {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  };

  return (
    <ImportContext.Provider value={options === null ? null : show}>
      {children}
      {options === null ? null : (
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent
            title="Import remittance"
            width="lg"
            description="Every payment is split and checked to the cent before anything posts."
            actions={
              <InfoButton label="What a distributor sends" title="What a distributor sends">
                <RemittanceFileGuide />
              </InfoButton>
            }
          >
            <RemittanceImport options={options} canPost={canPost} />
          </SheetContent>
        </Sheet>
      )}
    </ImportContext.Provider>
  );
}

export function RemittanceImportButton({ appearance = "toolbar", label = "Import remittance" }: { appearance?: "toolbar" | "button"; label?: string }) {
  const open = React.useContext(ImportContext);
  if (open === null) return null;
  if (appearance === "toolbar") return <ToolbarButton glyph="import" label={label} onClick={open} />;
  return (
    <Button onClick={open}>
      <Glyph name="import" />
      {label}
    </Button>
  );
}

/**
 * Importing a distributor remittance: choose the distributor and the file, see every payment
 * in it split into cash, AR relieved, trade spend and deductions receivable, then post. The
 * preview and the posting run the same plan; posting only adds the writes.
 */
export function RemittanceImport({ options, canPost }: { options: RemittanceFormOptions; canPost: boolean }) {
  const router = useRouter();
  const [customerId, setCustomerId] = React.useState(options.customers.length === 1 ? options.customers[0].value : "");
  const [depositId, setDepositId] = React.useState(options.defaultDepositId ?? "");
  const [source, setSource] = React.useState("auto");
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<RemittancePreviewView | null>(null);
  const [posted, setPosted] = React.useState<RemittancePostView | null>(null);
  const [pending, startTransition] = React.useTransition();
  const noCustomers = options.customers.length === 0;

  const reset = () => {
    setPreview(null);
    setPosted(null);
  };

  const form = (): FormData | null => {
    if (file === null) return null;
    const data = new FormData();
    data.set("customerId", customerId);
    data.set("depositAccountId", depositId);
    data.set("sourceSystem", source === "auto" ? "" : source);
    data.set("file", file);
    return data;
  };

  const check = () => {
    const data = form();
    if (data === null) return;
    if (file !== null && file.size > MAX_BYTES) {
      toast.error("File too large", { description: "Export fewer payments at a time; the limit is 950 KB." });
      return;
    }
    startTransition(async () => {
      const result = await previewRemittance(data);
      if (!result.ok) {
        toast.error("Could not read the file", { description: result.error.message });
        return;
      }
      setPosted(null);
      setPreview(result.value);
    });
  };

  const ready = preview?.advices.filter((a) => a.status === "ready") ?? [];
  const post = () => {
    const data = form();
    if (data === null) return;
    startTransition(async () => {
      const result = await postRemittance(data);
      if (!result.ok) {
        toast.error("Not posted", { description: [result.error.message, ...(result.error.details ?? [])].join(" ") });
        return;
      }
      setPosted(result.value);
      setPreview(null);
      setFile(null);
      const n = result.value.posted.length;
      if (n > 0) toast.success(`Posted ${n} ${n === 1 ? "payment" : "payments"}`);
      router.refresh();
    });
  };

  const readyCash = ready.reduce((s, a) => s + (a.split?.cashCents ?? 0), 0);
  const readyDeductions = ready.reduce((s, a) => s + a.deductions.length, 0);

  return (
    <div className="flex flex-col gap-4 pt-1">
      {noCustomers ? (
        <div className="flex items-center gap-2.5 rounded-[14px] bg-tint-orange/10 px-4 py-3 text-sm">
          <Glyph name="warning" size={16} className="shrink-0 text-ink-orange" />
          <span className="min-w-0 flex-1">No distributor yet</span>
          <Button asChild size="sm" variant="secondary">
            <Link href="/sales/customers">Add customer</Link>
          </Button>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Distributor" htmlFor="remit-customer" required>
          <Select
            value={customerId === "" ? undefined : customerId}
            onValueChange={(v) => {
              setCustomerId(v);
              reset();
            }}
            disabled={pending || noCustomers}
          >
            <SelectTrigger id="remit-customer">
              <SelectValue placeholder={noCustomers ? "None yet" : "Choose"} />
            </SelectTrigger>
            <SelectContent>
              {options.customers.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                  {c.hint ? <span className="ml-1.5 text-2xs text-label2">{c.hint}</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Layout" htmlFor="remit-source">
          <Select
            value={source}
            onValueChange={(v) => {
              setSource(v);
              reset();
            }}
            disabled={pending}
          >
            <SelectTrigger id="remit-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Cash to" htmlFor="remit-deposit" required>
          <Select
            value={depositId === "" ? undefined : depositId}
            onValueChange={(v) => {
              setDepositId(v);
              reset();
            }}
            disabled={pending}
          >
            <SelectTrigger id="remit-deposit">
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent>
              {options.deposits.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.code} {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <FilePick
        file={file}
        disabled={pending}
        onPick={(next) => {
          setFile(next);
          reset();
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto flex items-center gap-1.5 text-xs text-label2">
          <Glyph name="shield" size={13} />
          Checking writes nothing
        </span>
        <Button variant={preview === null ? "default" : "secondary"} onClick={check} disabled={pending || file === null || customerId === "" || depositId === ""}>
          {pending && preview === null ? "Checking…" : preview === null ? "Check file" : "Check again"}
        </Button>
      </div>

      {posted !== null ? (
        <ul className="flex flex-col overflow-hidden rounded-[14px] bg-card text-sm shadow-card">
          {posted.posted.map((p, index) => (
            <li key={p.paymentNumber} className={index > 0 ? "flex items-center gap-2.5 hairline-t px-4 py-2.5" : "flex items-center gap-2.5 px-4 py-2.5"}>
              <Glyph name="check-circle" size={16} className="text-ink-green" />
              <span className="num min-w-0 flex-1 truncate font-semibold">{p.paymentNumber}</span>
              <span className="text-xs text-label2">
                {p.deductions} {p.deductions === 1 ? "deduction" : "deductions"}
              </span>
              <Link href={`/ledger/${p.entryId}`} className="num text-xs font-semibold text-ink-blue hover:underline">
                #{p.entryNo}
              </Link>
            </li>
          ))}
          {posted.skipped.map((p) => (
            <li key={p.paymentNumber} className="flex items-start gap-2.5 hairline-t px-4 py-2.5 text-label2 first:border-t-0">
              <Glyph name="minus" size={16} className="mt-0.5 shrink-0" />
              {p.message}
            </li>
          ))}
          {posted.quarantined.map((p) => (
            <li key={p.paymentNumber} className="flex items-start gap-2.5 hairline-t px-4 py-2.5 text-ink-orange first:border-t-0">
              <Glyph name="warning" size={16} className="mt-0.5 shrink-0" />
              <span>
                <span className="num font-semibold">{p.paymentNumber}</span> held: {p.reasons.join(" ") || "its lines do not add up to the payment."}
              </span>
            </li>
          ))}
          {posted.posted.length > 0 ? (
            <li className="hairline-t px-4 py-2.5">
              <Link href="/trade/deductions" className="inline-flex items-center gap-1 text-sm font-semibold text-ink-blue hover:underline">
                Work the deductions
                <Glyph name="chevron-right" size={12} weight={2.4} />
              </Link>
            </li>
          ) : null}
        </ul>
      ) : null}

      {preview !== null ? (
        <section aria-label="Preview" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-1 text-xs text-label2">
            <span className="min-w-0 truncate">
              <span className="font-semibold text-label">{preview.filename}</span>
              {preview.sourceSystem ? ` · ${preview.sourceSystem}` : ""} · {preview.customerName}
            </span>
            <span>
              {ready.length} of {preview.advices.length} ready
            </span>
          </div>
          <Issues issues={preview.issues} />
          {preview.advices.length === 0 && preview.issues.length === 0 ? <p className="py-6 text-center text-sm text-label2">No payments in file</p> : null}
          {preview.advices.map((advice) => (
            <AdvicePreview key={advice.paymentKey} advice={advice} depositLabel={preview.depositLabel} />
          ))}
          <div className="flex flex-col gap-2 pt-1">
            {ready.length > 0 ? (
              <p className="px-1 text-sm">
                Posts {ready.length} {ready.length === 1 ? "entry" : "entries"}: <Money cents={readyCash} currency plain className="font-semibold" /> of cash to{" "}
                {preview.depositLabel} and {readyDeductions} {readyDeductions === 1 ? "deduction" : "deductions"}. Held and already-posted payments are left alone.
              </p>
            ) : (
              <p className="px-1 text-sm text-label2">Nothing here can post</p>
            )}
            <div className="flex justify-end">
              <Button onClick={post} disabled={pending || !canPost || ready.length === 0}>
                {pending ? "Posting…" : `Post ${ready.length} ${ready.length === 1 ? "payment" : "payments"}`}
              </Button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

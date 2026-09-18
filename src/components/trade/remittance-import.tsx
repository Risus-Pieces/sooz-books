"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Upload } from "lucide-react";

import { postRemittance, previewRemittance } from "@/app/(app)/trade/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import { TREATMENT_LABEL, longDate, shortDate } from "./labels";
import { EntryTable, Field, SplitLedger, Table, TableScroll, Td, Th } from "./parts";
import type { AdvicePreviewView, IssueView, RemittanceFormOptions, RemittancePostView, RemittancePreviewView } from "./types";

const MAX_BYTES = 950 * 1024;
const SOURCES = [
  { value: "auto", label: "Read it from the file" },
  { value: "KEHE", label: "KeHE" },
  { value: "UNFI", label: "UNFI" },
  { value: "DPI", label: "DPI" },
] as const;

const SEVERITY_TONE: Record<string, "negative" | "warning" | "neutral"> = { fatal: "negative", error: "negative", warn: "warning", info: "neutral" };
const SEVERITY_LABEL: Record<string, string> = { fatal: "Blocks posting", error: "Error", warn: "Warning", info: "Note" };

function Issues({ issues, className }: { issues: IssueView[]; className?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1.5", className)}>
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className="flex items-start gap-2 text-xs">
          <Badge tone={SEVERITY_TONE[issue.severity] ?? "neutral"} size="sm" className="mt-px">
            {SEVERITY_LABEL[issue.severity] ?? issue.severity}
          </Badge>
          <span className="min-w-0 text-muted-foreground">
            <span className="text-foreground">{issue.message}</span>
            {issue.remedy ? <span> {issue.remedy}</span> : null}
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
        "flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border-strong bg-surface-sunken/40 px-4 py-7 text-center transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted",
        dragging && "border-primary bg-primary/6",
      )}
    >
      {file === null ? (
        <>
          <Upload className="size-4 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">Drop the remittance here, or choose it</p>
          <p className="text-xs text-muted-foreground">CSV or XLSX from KeHE CONNECT or the UNFI Dispute Center. Up to 950 KB.</p>
        </>
      ) : (
        <>
          <FileSpreadsheet className="size-4 text-primary" aria-hidden />
          <p className="text-sm font-medium break-all">{file.name}</p>
          <p className="num text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB · choose a different file</p>
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

const STATUS_BADGE: Record<AdvicePreviewView["status"], { tone: "positive" | "negative" | "neutral"; label: string }> = {
  ready: { tone: "positive", label: "Ready to post" },
  quarantined: { tone: "negative", label: "Held for review" },
  already_imported: { tone: "neutral", label: "Already posted" },
};

function AdvicePreview({ advice, depositLabel }: { advice: AdvicePreviewView; depositLabel: string }) {
  const badge = STATUS_BADGE[advice.status];
  return (
    <section className="flex flex-col border-t border-border first:border-t-0">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="num text-sm font-semibold text-foreground">Payment {advice.paymentNumber}</h3>
          <span className="text-xs text-muted-foreground">
            {longDate(advice.paymentDate)}
            {advice.paymentMethod ? ` · ${advice.paymentMethod}` : ""}
            {advice.regionDc ? ` · DC ${advice.regionDc}` : ""} · {advice.lineCount} lines
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Money cents={advice.totalCents} currency plain className="text-sm font-semibold" />
          <Badge tone={badge.tone} size="sm">
            {badge.label}
          </Badge>
        </div>
      </header>
      <div className="flex flex-col gap-4 px-4 pb-4">
        {advice.note ? <p className="text-xs text-muted-foreground">{advice.note}</p> : null}
        <Issues issues={advice.issues} />
        {advice.split !== null ? (
          <SplitLedger
            split={advice.split}
            depositLabel={depositLabel}
            contraLabel={[...new Set((advice.entry?.lines ?? []).filter((l) => l.accountCode.startsWith("45") && l.debitCents > 0).map((l) => `${l.accountCode} ${l.accountName}`))].join(" · ")}
          />
        ) : null}
        {advice.deductions.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="eyebrow">Deductions it creates</p>
            <div className="rounded-md border border-border">
              <TableScroll>
                <Table caption="Deductions the payment creates" className="min-w-[40rem]">
                  <thead>
                    <tr>
                      <Th>Deduction</Th>
                      <Th>Reason</Th>
                      <Th>Books as</Th>
                      <Th align="right">Amount</Th>
                      <Th>Dispute by</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {advice.deductions.map((d) => (
                      <tr key={d.deductionNo} className="rule-row">
                        <Td className="num text-xs">
                          {d.deductionNo}
                          {d.invoiceNo ? <span className="block text-2xs text-muted-foreground">on {d.invoiceNo}</span> : null}
                        </Td>
                        <Td className="text-xs">
                          {d.reasonLabel ?? <span className="text-warning">Unmapped “{d.sourceReasonCode ?? "—"}”</span>}
                          <span className="num block text-2xs text-muted-foreground">{d.reasonCode ?? d.sourceReasonCode}</span>
                        </Td>
                        <Td className="text-xs">
                          {TREATMENT_LABEL[d.treatment] ?? d.treatment}
                          {d.accrualChargedCents > 0 && d.accrualChargedCents < d.amountCents ? (
                            <span className="block text-2xs text-muted-foreground">
                              <Money cents={d.accrualChargedCents} plain className="text-2xs" /> from the accrual
                            </span>
                          ) : null}
                        </Td>
                        <Td align="right">
                          <Money cents={d.amountCents} plain />
                        </Td>
                        <Td className="num text-xs text-muted-foreground">{d.disputeDeadline === null ? "—" : shortDate(d.disputeDeadline)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableScroll>
            </div>
          </div>
        ) : null}
        {advice.entry !== null ? (
          <details className="rounded-md border border-border bg-surface-raised/50">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-primary">The journal entry, line by line</summary>
            <EntryTable entry={advice.entry} caption={`Entry for payment ${advice.paymentNumber}`} />
          </details>
        ) : null}
      </div>
    </section>
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
    <Card id="import">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Import a remittance</CardTitle>
          <CardDescription>Every payment is split and checked to the cent before anything posts.</CardDescription>
        </div>
      </CardHeader>
      <div className="flex flex-col gap-4 px-4 py-4">
        {noCustomers ? (
          <p className="rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-muted-foreground">
            A remittance belongs to a customer, and there are none yet.{" "}
            <Link href="/sales/customers" className="text-primary hover:underline">
              Add the distributor as a customer
            </Link>{" "}
            on the Distributor channel first; its invoices are what the remittance pays.
          </p>
        ) : null}
        <div className="grid gap-3 md:grid-cols-3">
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
                <SelectValue placeholder={noCustomers ? "No customers yet" : "Choose the customer"} />
              </SelectTrigger>
              <SelectContent>
                {options.customers.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                    {c.hint ? <span className="ml-1.5 text-2xs text-muted-foreground">{c.hint}</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Sent by" htmlFor="remit-source" hint="the file layout">
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
          <Field label="Cash lands in" htmlFor="remit-deposit" hint="until the bank line matches">
            <Select
              value={depositId === "" ? undefined : depositId}
              onValueChange={(v) => {
                setDepositId(v);
                reset();
              }}
              disabled={pending}
            >
              <SelectTrigger id="remit-deposit">
                <SelectValue placeholder="Choose an account" />
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Checking writes nothing to the books.</p>
          <Button size="sm" variant={preview === null ? "default" : "secondary"} onClick={check} disabled={pending || file === null || customerId === "" || depositId === ""}>
            {pending && preview === null ? "Checking…" : preview === null ? "Check file" : "Check again"}
          </Button>
        </div>
      </div>

      {posted !== null ? (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-xs">
          {posted.posted.map((p) => (
            <p key={p.paymentNumber}>
              Payment <span className="num">{p.paymentNumber}</span> posted as{" "}
              <Link href={`/ledger/${p.entryId}`} className="num text-primary hover:underline">
                JE #{p.entryNo}
              </Link>{" "}
              with {p.deductions} {p.deductions === 1 ? "deduction" : "deductions"}.
            </p>
          ))}
          {posted.skipped.map((p) => (
            <p key={p.paymentNumber} className="text-muted-foreground">
              {p.message}
            </p>
          ))}
          {posted.quarantined.map((p) => (
            <p key={p.paymentNumber} className="text-warning">
              Payment <span className="num">{p.paymentNumber}</span> held for review: {p.reasons.join(" ") || "its lines do not add up to the payment."}
            </p>
          ))}
          {posted.posted.length > 0 ? (
            <Link href="/trade/deductions" className="font-medium text-primary hover:underline">
              Work the new deductions
            </Link>
          ) : null}
        </div>
      ) : null}

      {preview !== null ? (
        <div className="border-t border-border">
          <div className="flex flex-wrap items-baseline justify-between gap-3 bg-surface-sunken/60 px-4 py-2.5">
            <p className="text-xs text-muted-foreground">
              <span className="text-foreground">{preview.filename}</span>
              {preview.sourceSystem ? ` · ${preview.sourceSystem}` : ""} · {preview.customerName} · cash to {preview.depositLabel}
            </p>
            <p className="text-xs text-muted-foreground">
              {preview.advices.length} {preview.advices.length === 1 ? "payment" : "payments"} · {ready.length} ready
            </p>
          </div>
          <Issues issues={preview.issues} className="px-4 py-3" />
          {preview.advices.length === 0 && preview.issues.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">The file holds no payments.</p>
          ) : null}
          {preview.advices.map((advice) => (
            <AdvicePreview key={advice.paymentKey} advice={advice} depositLabel={preview.depositLabel} />
          ))}
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {ready.length === 0 ? (
                "Nothing in this file can post."
              ) : (
                <>
                  Posts {ready.length} {ready.length === 1 ? "entry" : "entries"}: <Money cents={readyCash} currency plain className="text-xs text-foreground" /> of cash and{" "}
                  {readyDeductions} {readyDeductions === 1 ? "deduction" : "deductions"}. Held and already-posted payments are left alone.
                </>
              )}
            </p>
            <Button size="sm" onClick={post} disabled={pending || !canPost || ready.length === 0}>
              {pending ? "Posting…" : `Post ${ready.length} ${ready.length === 1 ? "payment" : "payments"}`}
            </Button>
          </footer>
        </div>
      ) : null}
    </Card>
  );
}

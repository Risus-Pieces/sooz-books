"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { reverseJournalEntry } from "@/app/(app)/ledger/actions";

import { AuditDiff } from "./audit-diff";
import {
  sourceLabel,
  SOURCE_ROUTES,
  type AuditEntryRow,
  type EntryDetailRow,
  type JournalLineRow,
} from "./types";

export interface EntryDetailProps {
  entry: EntryDetailRow;
  lines: readonly JournalLineRow[];
  /** Every audit row touching this entry or its lines, newest first. */
  audit: readonly AuditEntryRow[];
  canPost: boolean;
}

/**
 * A posted entry as the ledger holds it: the lines, who put them there, and what
 * has happened to the entry since. Nothing on this page can change the entry —
 * a posted entry is immutable — so the only action offered is the correction the
 * ledger actually supports, which is a reversal.
 */
export function EntryDetail({ entry, lines, audit, canPost }: EntryDetailProps) {
  const debitCents = lines.reduce((sum, line) => sum + line.debitCents, 0);
  const creditCents = lines.reduce((sum, line) => sum + line.creditCents, 0);

  const sourceRoute = SOURCE_ROUTES[entry.sourceType];
  const hasSource = entry.sourceType !== "manual";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Entry #{entry.entryNo}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {entry.status === "posted" ? (
              <Badge tone="neutral">Posted</Badge>
            ) : (
              <Badge tone="warning">Draft</Badge>
            )}
            {entry.reversedByEntryNo === null ? null : (
              <Badge tone="info">Reversed by #{entry.reversedByEntryNo}</Badge>
            )}
            {entry.reversesEntryNo === null ? null : (
              <Badge tone="info">Reverses #{entry.reversesEntryNo}</Badge>
            )}
            <Button asChild variant="secondary" size="sm">
              <Link href={`/ledger/new?from=${entry.id}`}>
                <Copy />
                Duplicate
              </Link>
            </Button>
            {entry.status === "posted" && entry.reversedById === null ? (
              <ReverseAction entryId={entry.id} entryNo={entry.entryNo} date={entry.date} canPost={canPost} />
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Date" value={<span className="num">{entry.date}</span>} />
          <Fact
            label="Source"
            value={
              hasSource ? (
                sourceRoute === undefined ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex cursor-not-allowed items-center gap-1 text-muted-foreground">
                        {sourceLabel(entry.sourceType)}
                        <ExternalLink className="size-3" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      The {sourceLabel(entry.sourceType).toLowerCase()} register is not built yet.
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Link
                    href={entry.sourceId === null ? sourceRoute : `${sourceRoute}/${entry.sourceId}`}
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {sourceLabel(entry.sourceType)}
                    <ExternalLink className="size-3" />
                  </Link>
                )
              ) : (
                <span className="text-muted-foreground">Manual entry</span>
              )
            }
          />
          <Fact
            label="Created"
            value={
              <span className="text-xs">
                {entry.createdAtLabel}
                {entry.createdByLabel === null ? null : ` · ${entry.createdByLabel}`}
              </span>
            }
          />
          <Fact
            label="Posted"
            value={
              entry.postedAtLabel === null ? (
                <span className="text-muted-foreground">Not posted</span>
              ) : (
                <span className="text-xs">
                  {entry.postedAtLabel}
                  {entry.postedByLabel === null ? null : ` · ${entry.postedByLabel}`}
                </span>
              )
            }
          />
          <div className="sm:col-span-2 lg:col-span-4">
            <p className="eyebrow">Memo</p>
            <p className="mt-1 text-sm">
              {entry.memo ?? <span className="text-muted-foreground">No memo</span>}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full min-w-3xl border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Lines of entry {entry.entryNo}</caption>
            <thead>
              <tr>
                <Th className="w-8 text-right">#</Th>
                <Th>Account</Th>
                <Th>Memo</Th>
                <Th className="w-28">Channel</Th>
                <Th className="w-32">Product</Th>
                <Th className="w-32 text-right">Debit</Th>
                <Th className="w-32 rule-gutter text-right">Credit</Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="rule-row align-middle">
                  <Td className="num text-right text-xs text-muted-foreground">{line.lineNo}</Td>
                  <Td>
                    <Link
                      href={`/ledger?accountId=${line.accountId}`}
                      className="inline-flex items-baseline gap-2 hover:underline"
                    >
                      <span className="num text-xs text-muted-foreground">{line.accountCode}</span>
                      {line.accountName}
                    </Link>
                  </Td>
                  <Td className="text-xs text-muted-foreground">{line.memo ?? "—"}</Td>
                  <Td className="text-xs text-muted-foreground">{line.channelCode ?? "—"}</Td>
                  <Td className="num text-xs text-muted-foreground">{line.productSku ?? "—"}</Td>
                  <Td className="text-right">
                    <Money cents={line.debitCents} plain zeroDash />
                  </Td>
                  <Td className="rule-gutter text-right">
                    <Money cents={line.creditCents} plain zeroDash />
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="rule-subtotal rule-total px-3 py-1.5 text-right text-xs font-semibold tracking-wide uppercase">
                  Totals
                </td>
                <td className="rule-subtotal rule-total px-3 py-1.5 text-right text-sm font-semibold">
                  <Money cents={debitCents} plain />
                </td>
                <td className="rule-subtotal rule-total rule-gutter px-3 py-1.5 text-right text-sm font-semibold">
                  <Money cents={creditCents} plain />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <p className="text-xs text-muted-foreground">
            Straight from <span className="num">audit_log</span>, which every write to this entry
            lands in.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {audit.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing recorded — this entry predates the audit trail.
            </p>
          ) : (
            audit.map((row) => (
              <div key={row.id} className="rule-row pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={row.op === "DELETE" ? "negative" : row.op === "INSERT" ? "positive" : "info"}>
                    {row.op}
                  </Badge>
                  <span className="num text-xs text-muted-foreground">{row.tableName}</span>
                  <span className="text-xs text-muted-foreground">{row.atLabel}</span>
                  <span className="text-xs text-foreground">{row.actorLabel ?? "System"}</span>
                </div>
                <AuditDiff op={row.op} before={row.before} after={row.after} className="mt-1.5" />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ReverseAction({
  entryId,
  entryNo,
  date,
  canPost,
}: {
  entryId: string;
  entryNo: number;
  date: string;
  canPost: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reverseDate, setReverseDate] = React.useState(date);
  const [memo, setMemo] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  if (!canPost) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="secondary" size="sm" disabled>
              <Undo2 />
              Reverse
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Your role may not post to the ledger.</TooltipContent>
      </Tooltip>
    );
  }

  const submit = () => {
    startTransition(async () => {
      const result = await reverseJournalEntry(entryId, reverseDate, memo === "" ? null : memo);
      if (!result.ok) {
        toast.error("Not reversed", { description: result.error.message });
        return;
      }
      setOpen(false);
      toast.success(`Entry #${entryNo} reversed by #${result.value.entryNo}`, {
        description:
          result.value.movedFrom === null
            ? undefined
            : `${result.value.movedFrom} is in a closed period, so the reversal was dated ${result.value.date}.`,
      });
      router.push(`/ledger/${result.value.entryId}`);
    });
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Undo2 />
        Reverse
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Reverse entry #{entryNo}</DialogTitle>
            <DialogDescription>
              A posted entry cannot be edited or deleted. Reversing posts its mirror image and links
              the two together.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reverse-date" required>
                Reversal date
              </Label>
              <DateInput
                id="reverse-date"
                value={reverseDate}
                onValueChange={setReverseDate}
                disabled={pending}
              />
              <p className="text-xs text-muted-foreground">
                If that month is closed the reversal moves to the first open one and says so in its
                memo.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reverse-memo">Memo</Label>
              <Input
                id="reverse-memo"
                value={memo}
                disabled={pending}
                placeholder={`Reversal of #${entryNo}`}
                onChange={(event) => setMemo(event.target.value)}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={pending} onClick={submit}>
              Post reversal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="eyebrow">{label}</p>
      <div className="mt-1 text-sm">{value}</div>
    </div>
  );
}

function Th({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head bg-surface-sunken px-3 py-1.5 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={cn("px-3 py-1.5 align-middle", className)}>{children}</td>;
}

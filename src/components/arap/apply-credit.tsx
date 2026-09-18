"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Link2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { isCalendarDate } from "@/lib/dates";

import { Td, Th } from "./doc-status";
import { applyOldestFirst, readMoney } from "./math";
import { MoneyInput, centsOf, textOf } from "./money-input";
import type { ActionResult, ApplicationForm, DocRef, OpenDoc } from "./types";

/**
 * Applies money already received (or paid) and left unapplied to open
 * documents of the same party. No ledger entry moves — the money is already on
 * the account — so this only records which documents it settled, and when.
 */
export function ApplyCredit({
  side,
  unappliedCents,
  docs,
  minDate,
  today,
  onApply,
}: {
  side: "ar" | "ap";
  unappliedCents: number;
  docs: readonly OpenDoc[];
  minDate: string;
  today: string;
  onApply: (date: string | null, apps: ApplicationForm[]) => Promise<ActionResult<DocRef>>;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [date, setDate] = React.useState(today < minDate ? minDate : today);
  const [amounts, setAmounts] = React.useState<Record<string, string>>(() => {
    const spread = applyOldestFirst(unappliedCents, docs);
    return Object.fromEntries(docs.map((d) => [d.id, textOf(spread.get(d.id) ?? 0)]));
  });

  const total = docs.reduce((sum, d) => sum + centsOf(amounts[d.id] ?? ""), 0);
  const bad = docs.some((d) => {
    const parsed = readMoney(amounts[d.id] ?? "");
    return parsed.error !== null || (parsed.cents ?? 0) > d.balanceCents;
  });
  const problem = !isCalendarDate(date)
    ? "Enter the date."
    : date < minDate
      ? `Not before ${minDate}.`
      : bad
        ? "An amount is unreadable or more than is open."
        : total === 0
          ? "Enter what to apply."
          : total > unappliedCents
            ? "More than is unapplied."
            : null;

  const submit = () =>
    start(async () => {
      const apps = docs
        .map((d) => ({ docId: d.id, amountCents: centsOf(amounts[d.id] ?? ""), discountCents: 0 }))
        .filter((a) => a.amountCents > 0);
      const result = await onApply(date, apps);
      if (!result.ok) {
        toast.error("Not applied", { description: result.error.message });
        return;
      }
      toast.success(`Applied from ${result.value.docNo}`);
      router.refresh();
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Apply the unapplied {side === "ar" ? "credit" : "prepayment"}</CardTitle>
        <Money cents={unappliedCents} currency className="text-sm font-semibold" />
      </CardHeader>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[32rem] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <Th>{side === "ar" ? "Invoice" : "Bill"}</Th>
              <Th>Due</Th>
              <Th align="right">Open</Th>
              <Th align="right" className="w-36">
                Apply
              </Th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <Td className="num">{d.docNo}</Td>
                <Td className="num">{d.dueDate}</Td>
                <Td align="right">
                  <Money cents={d.balanceCents} />
                </Td>
                <Td>
                  <MoneyInput
                    className="h-7"
                    aria-label={`Apply to ${d.docNo}`}
                    value={amounts[d.id] ?? ""}
                    onValueChange={(v) => setAmounts((a) => ({ ...a, [d.id]: v }))}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border px-4 py-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="apply-date" hint="the aging moves on this date">
            Applied on
          </Label>
          <DateInput id="apply-date" value={date} min={minDate} onValueChange={setDate} />
        </div>
        <div className="flex items-center gap-2">
          {problem ? <span className="text-xs text-muted-foreground">{problem}</span> : null}
          <Button size="sm" onClick={submit} disabled={pending || problem !== null}>
            <Link2 />
            Apply <Money cents={total} currency plain />
          </Button>
        </div>
      </div>
    </Card>
  );
}

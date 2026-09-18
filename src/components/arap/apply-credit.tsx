"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Glyph } from "@/components/ui/glyph";
import { Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { isCalendarDate } from "@/lib/dates";
import { shortDate } from "@/lib/ui/format";

import { applyOldestFirst, readMoney } from "./math";
import { MoneyInput, centsOf, textOf } from "./money-input";
import { FormSection, Grid, GridFigure, GridTd, GridTh, cellField } from "./sheet-grid";
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
    <FormSection
      title={side === "ar" ? "Apply the credit" : "Apply the prepayment"}
      accessory={
        <span className="text-sm font-semibold">
          <Money cents={unappliedCents} currency plain />
        </span>
      }
    >
      <Grid
        caption="Open documents"
        minWidth="min-w-[30rem]"
        head={
          <>
            <GridTh>{side === "ar" ? "Invoice" : "Bill"}</GridTh>
            <GridTh>Due</GridTh>
            <GridTh align="right">Open</GridTh>
            <GridTh className="w-36" align="right">
              Apply
            </GridTh>
          </>
        }
      >
        {docs.map((d) => (
          <tr key={d.id}>
            <GridTd className="num px-2.5 font-medium">{d.docNo}</GridTd>
            <GridTd className="num px-2.5 text-label2">{shortDate(d.dueDate)}</GridTd>
            <GridTd>
              <GridFigure>
                <Money cents={d.balanceCents} plain />
              </GridFigure>
            </GridTd>
            <GridTd>
              <MoneyInput
                className={cellField}
                aria-label={`Apply to ${d.docNo}`}
                value={amounts[d.id] ?? ""}
                onValueChange={(v) => setAmounts((a) => ({ ...a, [d.id]: v }))}
              />
            </GridTd>
          </tr>
        ))}
      </Grid>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        <label htmlFor="apply-date" className="text-sm font-medium">
          Applied on
        </label>
        <DateInput id="apply-date" value={date} min={minDate} onValueChange={setDate} />
        {problem ? <span className="text-xs font-medium text-label2">{problem}</span> : null}
        <Button onClick={submit} disabled={pending || problem !== null}>
          <Glyph name="link" size={15} />
          Apply <Money cents={total} currency plain />
        </Button>
      </div>
    </FormSection>
  );
}

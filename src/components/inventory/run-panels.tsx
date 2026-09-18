"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { Dot, IconBadge } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { ToolbarButton } from "@/components/ui/toolbar";
import { Input } from "@/components/ui/input";
import { formatCents, Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { allocateCents, parseMoney } from "@/lib/money";
import {
  addStockCostAction,
  allocateBillLineAction,
  costRunAction,
  recordOutputAction,
  removeLandedCostAction,
  reopenRunAction,
} from "@/app/(app)/inventory/actions";
import type { OpenBillLine, OpenRunOption, RunDetail } from "@/app/(app)/inventory/queries";

import { EntryPreview } from "./entry-preview";
import { StackBar } from "./stack-bar";
import { Field, NativeSelect, Segmented } from "./fields";
import { Table, TableScroll, Td, Th } from "./table";
import { COMPONENT_KEYS, COMPONENT_LABELS, COMPONENT_STYLE, formatUnits, type CostComponentKey } from "./types";

function unitsText(hundredths: number): string {
  return hundredths === 0 ? "" : formatUnits(hundredths).replaceAll(",", "");
}

function tryMoney(text: string): number | null {
  if (text.trim() === "") return null;
  try {
    return parseMoney(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ output */

export function RecordOutputButton({ run }: { run: RunDetail }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [produced, setProduced] = React.useState(unitsText(run.unitsProduced));
  const [rejected, setRejected] = React.useState(unitsText(run.unitsRejected));
  const [pending, startTransition] = React.useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await recordOutputAction(run.id, produced, rejected);
      if (!result.ok) {
        toast.error("Output not recorded", { description: result.error.message });
        return;
      }
      toast.success(`Output recorded for ${run.runNo}`);
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <>
      <ToolbarButton
        glyph={run.goodUnits === 0 ? "check" : "pencil"}
        label={run.goodUnits === 0 ? "Record output" : "Edit output"}
        showLabel={run.goodUnits === 0}
        tone={run.goodUnits === 0 ? "accent" : "default"}
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>Output of {run.runNo}</DialogTitle>
              <DialogDescription>From the co-packer’s yield report.</DialogDescription>
            </DialogHeader>
            <DialogBody className="grid grid-cols-2 gap-3">
              <Field id="out-produced" label="Produced" required hint={run.product.unit}>
                <Input id="out-produced" value={produced} onChange={(e) => setProduced(e.target.value)} numeric inputMode="decimal" autoFocus />
              </Field>
              <Field id="out-rejected" label="Rejected" hint={run.product.unit} note="Their cost spreads over the good units.">
                <Input id="out-rejected" value={rejected} onChange={(e) => setRejected(e.target.value)} numeric inputMode="decimal" placeholder="0" />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending || produced.trim() === ""}>
                Save output
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ----------------------------------------------------------------- costing */

/**
 * The unit cost the run will strike, split by component, and the entry that moves its value into
 * Finished Goods — drawn as a flow before the button that posts it.
 */
export function CostingCard({ run, canManage }: { run: RunDetail; canManage: boolean }) {
  const router = useRouter();
  const [date, setDate] = React.useState(run.runDate);
  const [confirming, setConfirming] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const preview = run.preview;

  const cost = () => {
    startTransition(async () => {
      const result = await costRunAction(run.id, date);
      if (!result.ok) {
        toast.error("Run not costed", { description: result.error.message });
        return;
      }
      toast.success(`${run.runNo} costed at ${formatCents(result.value.unitCostCents, { currency: true })} a unit`);
      setConfirming(false);
      router.refresh();
    });
  };

  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex items-center gap-2 px-5 pt-[18px] max-sm:px-4 max-sm:pt-4">
        <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">Costing</h2>
        <InfoButton label="About costing">
          <p>Costing strikes the unit cost — landed cost over good units — and posts one entry that moves the run’s value out of the accounts it sits in and into Finished Goods (1310).</p>
          <p>Any rounding goes to 5050 Co-Man Variance, so Finished Goods holds exactly the unit cost times the good units.</p>
        </InfoButton>
      </div>
      {preview === null ? (
        <p className="flex items-center gap-2 px-5 pt-3 pb-6 text-sm font-medium text-label2 max-sm:px-4">
          <Glyph name="hourglass" size={16} />
          {run.previewBlocker}
        </p>
      ) : (
        <>
          <div className="px-5 pt-3 pb-4 max-sm:px-4">
            <ComponentBreakdown
              unitCostCents={preview.unitCostCents}
              caption={
                <>
                  <Money cents={preview.totalCents} currency plain /> ÷ <span className="num">{formatUnits(preview.goodUnits)}</span> good
                  units
                  {preview.roundingVarianceCents !== 0 ? (
                    <>
                      {" · "}
                      <Money cents={preview.roundingVarianceCents} signed plain /> rounding
                    </>
                  ) : null}
                </>
              }
              rows={preview.components.map((c) => ({ component: c.component, perUnitCents: c.perUnitCents, totalCents: c.totalCents }))}
            />
          </div>
          <div className="hairline-t">
            <EntryPreview entry={{ ...preview.entry, date }} caption="Costing entry" className="pt-1" />
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-center justify-between gap-3 hairline-t bg-inset px-5 py-3 max-sm:px-4">
              <label htmlFor="cost-date" className="flex items-center gap-3 text-sm font-medium">
                Effective
                <DateInput id="cost-date" value={date} onValueChange={setDate} />
              </label>
              {confirming ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                  <Button disabled={pending} onClick={cost}>
                    Post and cost {run.runNo}
                  </Button>
                </div>
              ) : (
                <Button onClick={() => setConfirming(true)}>
                  <Glyph name="check" />
                  Cost this run
                </Button>
              )}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * The unit cost as one stacked bar by component, then the components as rows: dot, name, run total,
 * per unit and share. The bar is the chart; the rows are its legend.
 */
export function ComponentBreakdown({
  unitCostCents,
  rows,
  caption,
}: {
  unitCostCents: number;
  rows: ReadonlyArray<{ component: CostComponentKey; perUnitCents: number; totalCents?: number }>;
  caption?: React.ReactNode;
}) {
  const showTotals = rows.some((r) => r.totalCents !== undefined);
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Money cents={unitCostCents} currency plain className="text-3xl leading-tight font-bold tracking-[-0.028em]" />
        <span className="text-sm font-medium text-label2">a unit</span>
        {caption ? <span className="ml-auto text-xs font-medium text-label2">{caption}</span> : null}
      </div>
      <StackBar
        className="mt-3"
        height={12}
        label="Unit cost by component"
        segments={rows.map((r) => ({
          key: r.component,
          label: COMPONENT_LABELS[r.component],
          cents: r.perUnitCents,
          tint: COMPONENT_STYLE[r.component].tint,
        }))}
      />
      <ul className="mt-3 flex flex-col">
        {rows.map((r, index) => (
          <li
            key={r.component}
            className={cn("grid grid-cols-[minmax(0,1fr)_auto_auto_3.25rem] items-center gap-x-4 py-1.5 text-sm", index > 0 && "hairline-t")}
          >
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <Dot tint={COMPONENT_STYLE[r.component].tint} />
              <span className="truncate">{COMPONENT_LABELS[r.component]}</span>
            </span>
            <span className="text-right text-label2">{showTotals ? <Money cents={r.totalCents ?? 0} currency plain /> : null}</span>
            <Money cents={r.perUnitCents} currency plain className="text-right font-semibold" />
            <span className="num text-right text-xs text-label2">
              {unitCostCents > 0 ? `${((r.perUnitCents / unitCostCents) * 100).toFixed(0)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReopenRunButton({ run }: { run: RunDetail }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const reopen = () => {
    startTransition(async () => {
      const result = await reopenRunAction(run.id);
      if (!result.ok) {
        toast.error("Run not reopened", { description: result.error.message });
        return;
      }
      toast.success(`${run.runNo} reopened`);
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <>
      <ToolbarButton glyph="undo" label="Reopen run" tone="danger" onClick={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Reopen {run.runNo}</DialogTitle>
            <DialogDescription>
              Reverses the costing entry{run.costEntry ? ` (#${run.costEntry.entryNo})` : ""}, withdraws the unit cost and
              sets the run back to open so its costs can be corrected. Refused if a posted COGS month already used this
              cost; reverse that month first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" disabled={pending} onClick={reopen}>
              Reverse and reopen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ----------------------------------------------------------- landed costs */

export interface LandedCostsCardProps {
  run: RunDetail;
  canManage: boolean;
  billLines: readonly OpenBillLine[];
  openRuns: readonly OpenRunOption[];
  stock: ReadonlyArray<{ code: string; name: string; cents: number }>;
}

/** The toolbar items that attach cost to an open run: materials from stock, a line of a posted bill. */
export function LandedCostActions({ run, billLines, openRuns, stock }: Omit<LandedCostsCardProps, "canManage">) {
  return (
    <>
      <BillLineDialog run={run} billLines={billLines} openRuns={openRuns} />
      <StockCostDialog run={run} stock={stock} />
    </>
  );
}

/**
 * What went into the batch: one stacked bar by component, then each cost as a row — its component
 * badge, what it was, where it is relieved from, and the amount.
 */
export function LandedCostsCard({ run, canManage }: Pick<LandedCostsCardProps, "run" | "canManage">) {
  const editable = canManage && run.status === "open";
  const total = run.landedCosts.reduce((s, c) => s + c.amountCents, 0);
  const byComponent = COMPONENT_KEYS.map((k) => ({
    key: k,
    label: COMPONENT_LABELS[k],
    cents: run.landedCosts.filter((c) => c.component === k).reduce((s, c) => s + c.amountCents, 0),
    tint: COMPONENT_STYLE[k].tint,
  }));

  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex items-center gap-2 px-5 pt-[18px] max-sm:px-4 max-sm:pt-4">
        <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">Landed cost</h2>
        <Money cents={total} currency plain className="text-lg font-semibold" />
      </div>
      {run.landedCosts.length === 0 ? (
        <EmptyState
          glyph="paperclip"
          title="No costs attached"
          description="Attach what went into this batch: the co-packer’s tolling invoice and freight from posted bills, and the ingredients and packaging it consumed from stock in 1320 and 1330."
          className="py-8"
        />
      ) : (
        <>
          <div className="px-5 pt-3 pb-2 max-sm:px-4">
            <StackBar label="Landed cost by component" height={12} segments={byComponent} />
          </div>
          <ul className="flex flex-col pb-1.5">
            {run.landedCosts.map((c, index) => (
              <li
                key={c.id}
                className={cn(
                  "relative flex min-h-14 items-center gap-3 px-5 py-2 max-sm:px-4",
                  index > 0 && "before:absolute before:top-0 before:right-0 before:left-[60px] before:border-t-[0.5px] before:border-sep",
                )}
              >
                <IconBadge glyph={COMPONENT_STYLE[c.component].glyph} tint={COMPONENT_STYLE[c.component].tint} size="lg" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold max-sm:text-lg max-sm:font-medium">
                    {c.description ?? COMPONENT_LABELS[c.component]}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-label2 max-sm:text-sm">
                    {COMPONENT_LABELS[c.component]}
                    <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-label3" />
                    {c.billNo ? (
                      <span className="inline-flex min-w-0 items-center gap-1 truncate">
                        <Glyph name="doc" size={12} />
                        {c.billVendor} {c.billNo}
                        {c.basis && c.basis !== "manual" ? ` · by ${c.basis}` : ""}
                      </span>
                    ) : (
                      <span className="truncate">
                        <span className="num">{c.sourceCode}</span> {c.sourceName}
                      </span>
                    )}
                  </span>
                </span>
                <Money cents={c.amountCents} currency plain className="shrink-0 text-sm font-semibold max-sm:text-lg" />
                {editable ? <RemoveCostButton runId={run.id} costId={c.id} /> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function RemoveCostButton({ runId, costId }: { runId: string; costId: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Remove this cost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await removeLandedCostAction(runId, costId);
          if (!result.ok) {
            toast.error("Cost not removed", { description: result.error.message });
            return;
          }
          toast.success("Cost removed");
          router.refresh();
        })
      }
    >
      <Glyph name="trash" />
    </Button>
  );
}

function StockCostDialog({ run, stock }: { run: RunDetail; stock: LandedCostsCardProps["stock"] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<"ingredients" | "packaging">("ingredients");
  const [amount, setAmount] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const source = stock.find((s) => s.code === (kind === "ingredients" ? "1320" : "1330"));
  const cents = tryMoney(amount);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await addStockCostAction({ runId: run.id, component: kind, amount, description });
      if (!result.ok) {
        toast.error("Cost not attached", { description: result.error.message });
        return;
      }
      toast.success("Materials attached");
      setOpen(false);
      setAmount("");
      setDescription("");
      router.refresh();
    });
  };

  return (
    <>
      <ToolbarButton glyph="leaf" label="Materials from stock" onClick={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>Materials from stock</DialogTitle>
              <DialogDescription>
                Costing moves this amount out of the inventory account it sits in and into Finished Goods.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-3">
              <Segmented
                label="Material"
                value={kind}
                onChange={setKind}
                options={[
                  { value: "ingredients", label: "Ingredients · 1320" },
                  { value: "packaging", label: "Packaging · 1330" },
                ]}
              />
              {source ? (
                <p className="flex items-center gap-1.5 text-sm text-label2">
                  <Dot tint={kind === "ingredients" ? "teal" : "brown"} />
                  {source.name}
                  <Money cents={source.cents} currency plain className="ml-auto font-semibold text-label" />
                  {cents !== null && cents > source.cents ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-ink-orange">
                      <Glyph name="warning" size={13} />
                      More than held
                    </span>
                  ) : null}
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                <Field id="stock-amount" label="Amount" required hint="USD">
                  <Input id="stock-amount" value={amount} onChange={(e) => setAmount(e.target.value)} numeric inputMode="decimal" placeholder="0.00" autoFocus />
                </Field>
                <Field id="stock-desc" label="Description" hint="optional">
                  <Input id="stock-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Allulose, 25 kg" />
                </Field>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending || cents === null || cents <= 0}>
                Attach to {run.runNo}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

type Basis = "units" | "value" | "manual";

function BillLineDialog({
  run,
  billLines,
  openRuns,
}: {
  run: RunDetail;
  billLines: readonly OpenBillLine[];
  openRuns: readonly OpenRunOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [lineId, setLineId] = React.useState(billLines[0]?.id ?? "");
  const [kind, setKind] = React.useState<CostComponentKey>("tolling");
  const [basis, setBasis] = React.useState<Basis>("units");
  const [selected, setSelected] = React.useState<string[]>([run.id]);
  const [weights, setWeights] = React.useState<Record<string, string>>({});
  const [amount, setAmount] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const line = billLines.find((l) => l.id === lineId);
  const runs = openRuns.filter((r) => selected.includes(r.id));
  const amountCents = amount.trim() === "" ? (line?.remainingCents ?? 0) : tryMoney(amount);

  const typedWeights = runs.map((r) => tryMoney(weights[r.id] ?? "") ?? 0);
  const manualTotal = typedWeights.reduce((s, w) => s + w, 0);
  const allocate = basis === "manual" ? manualTotal : (amountCents ?? 0);
  const weightList = basis === "units" ? runs.map((r) => r.unitsWeight) : typedWeights;

  let shares: number[] | null = null;
  let problem: string | null = null;
  if (!line) problem = "Choose a bill line.";
  else if (runs.length === 0) problem = "Choose at least one run.";
  else if (allocate <= 0) problem = basis === "manual" ? "Enter each run’s share." : "Enter the amount to allocate.";
  else if (allocate > line.remainingCents) problem = `Only ${formatCents(line.remainingCents, { currency: true })} of this line is unallocated.`;
  else if (weightList.every((w) => w === 0))
    problem = basis === "units" ? "None of these runs has produced or planned units to weigh by." : "Enter a weight for each run.";
  else shares = allocateCents(allocate, weightList);

  const toggle = (id: string) =>
    setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!line || shares === null) return;
    startTransition(async () => {
      const result = await allocateBillLineAction({
        billLineId: line.id,
        component: kind,
        basis,
        runs: runs.map((r) => ({ runId: r.id, weight: weights[r.id] ?? "" })),
        amount: basis === "manual" ? formatCents(manualTotal) : amount,
        description: "",
      });
      if (!result.ok) {
        toast.error("Bill line not attached", { description: result.error.message });
        return;
      }
      toast.success(
        `${formatCents(result.value.amountCents, { currency: true })} attached to ${result.value.runs} ${result.value.runs === 1 ? "run" : "runs"}`,
      );
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <>
      <ToolbarButton glyph="paperclip" label="Attach bill line" onClick={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>Attach a bill line</DialogTitle>
              <DialogDescription>
                A line from a posted bill, spread over one or more open runs. The shares add up to the line to the cent.
              </DialogDescription>
            </DialogHeader>
            {billLines.length === 0 ? (
              <DialogBody>
                <EmptyState
                  glyph="paperclip"
                  title="No bill lines to attach"
                  description="Enter the co-packer’s invoice under Purchases as a bill and post it; its lines then appear here. Materials Sooz bought through the bank are attached with Materials from stock instead."
                  className="py-6"
                />
              </DialogBody>
            ) : (
              <DialogBody className="flex flex-col gap-4">
                <Field id="bill-line" label="Bill line" required>
                  <NativeSelect id="bill-line" value={lineId} onChange={(e) => setLineId(e.target.value)}>
                    {billLines.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.vendorName} {l.billNo} · {l.description} · {l.accountCode} · {formatCents(l.remainingCents, { currency: true })} left
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field id="bill-kind" label="Cost component" required>
                    <NativeSelect id="bill-kind" value={kind} onChange={(e) => setKind(e.target.value as CostComponentKey)}>
                      {COMPONENT_KEYS.map((c) => (
                        <option key={c} value={c}>
                          {COMPONENT_LABELS[c]}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field id="bill-amount" label="Amount" hint={basis === "manual" ? "sum of shares" : "blank = all that is left"}>
                    <Input
                      id="bill-amount"
                      value={basis === "manual" ? formatCents(manualTotal) : amount}
                      onChange={(e) => setAmount(e.target.value)}
                      disabled={basis === "manual"}
                      numeric
                      inputMode="decimal"
                      placeholder={line ? formatCents(line.remainingCents) : "0.00"}
                    />
                  </Field>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Split by</span>
                    <Segmented
                      label="Split by"
                      value={basis}
                      onChange={setBasis}
                      options={[
                        { value: "units", label: "Units" },
                        { value: "value", label: "Value" },
                        { value: "manual", label: "Manual" },
                      ]}
                    />
                  </div>
                </div>

                <div className="overflow-hidden rounded-[12px] bg-inset">
                  <TableScroll>
                    <Table caption="Allocation preview" className="min-w-[30rem]">
                      <thead>
                        <tr>
                          <Th className="w-10" />
                          <Th>Run</Th>
                          <Th align="right">{basis === "units" ? "Units" : basis === "value" ? "Weight ($)" : "Share ($)"}</Th>
                          <Th align="right">Allocated</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {openRuns.map((r) => {
                          const index = runs.findIndex((x) => x.id === r.id);
                          const on = index !== -1;
                          return (
                            <tr key={r.id} className={cn("[&>td]:rule-row", !on && "text-label2")}>
                              <Td>
                                <input
                                  type="checkbox"
                                  aria-label={`Include ${r.runNo}`}
                                  checked={on}
                                  onChange={() => toggle(r.id)}
                                  className="size-4 accent-[var(--blue)]"
                                />
                              </Td>
                              <Td>
                                <span className="num font-medium">{r.runNo}</span>
                                <span className="num ml-2 text-xs text-label2">{r.sku}</span>
                                {r.id === run.id ? <Badge tone="primary" size="sm" className="ml-2">This run</Badge> : null}
                              </Td>
                              <Td align="right">
                                {basis === "units" ? (
                                  <span className="num">{r.unitsWeight === 0 ? "—" : formatUnits(r.unitsWeight)}</span>
                                ) : (
                                  <Input
                                    aria-label={`Weight for ${r.runNo}`}
                                    value={weights[r.id] ?? ""}
                                    onChange={(e) => setWeights((w) => ({ ...w, [r.id]: e.target.value }))}
                                    disabled={!on}
                                    numeric
                                    inputMode="decimal"
                                    className="ml-auto h-7 w-28"
                                    placeholder="0.00"
                                  />
                                )}
                              </Td>
                              <Td align="right">
                                {on && shares ? <Money cents={shares[index] ?? 0} plain /> : <span className="text-label2">—</span>}
                              </Td>
                            </tr>
                          );
                        })}
                        <tr className="font-semibold">
                          <Td className="rule-subtotal" colSpan={3}>
                            {line ? `${line.vendorName} ${line.billNo} — relieved from ${line.accountCode} ${line.accountName}` : ""}
                          </Td>
                          <Td align="right" className="rule-subtotal rule-total">
                            {shares ? <Money cents={shares.reduce((s, x) => s + x, 0)} plain /> : "—"}
                          </Td>
                        </tr>
                      </tbody>
                    </Table>
                  </TableScroll>
                </div>
                {problem ? (
                  <p className="flex items-center gap-1.5 text-sm font-medium text-ink-orange">
                    <Glyph name="warning" size={14} />
                    {problem}
                  </p>
                ) : null}
              </DialogBody>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending || shares === null}>
                Attach
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CostedSummary({ run }: { run: RunDetail }) {
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-5 pt-[18px] max-sm:px-4 max-sm:pt-4">
        <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">Unit cost</h2>
        <span className="text-xs font-medium text-label2">
          {run.costDate ? <span className="num">{run.costDate}</span> : null}
          {run.costEntry ? (
            <>
              {" · "}
              <Link href={`/ledger/${run.costEntry.id}`} className="text-ink-blue hover:underline">
                Entry #{run.costEntry.entryNo}
              </Link>
            </>
          ) : null}
        </span>
      </div>
      <div className="px-5 pt-3 pb-4 max-sm:px-4">
        {run.costedBreakdown.length > 0 && run.unitCostCents !== null ? (
          <ComponentBreakdown
            unitCostCents={run.unitCostCents}
            rows={run.costedBreakdown}
            caption={
              run.roundingVarianceCents !== 0 ? (
                <>
                  <Money cents={run.roundingVarianceCents} signed plain /> rounding to 5050
                </>
              ) : undefined
            }
          />
        ) : (
          <p className="text-sm">
            <Money cents={run.unitCostCents ?? 0} currency plain className="text-3xl font-bold" /> a unit
          </p>
        )}
      </div>
    </Card>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Calculator, FileText, Layers, PackageOpen, Trash2, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Field, NativeSelect, Segmented } from "./fields";
import { Table, TableScroll, Td, Th } from "./table";
import { COMPONENT_KEYS, COMPONENT_LABELS, formatUnits, type CostComponentKey } from "./types";

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
      <Button size="sm" variant={run.goodUnits === 0 ? "default" : "secondary"} onClick={() => setOpen(true)}>
        <PackageOpen />
        {run.goodUnits === 0 ? "Record output" : "Edit output"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>Output of {run.runNo}</DialogTitle>
              <DialogDescription>
                From the co-packer’s yield report. Rejected units carry no cost of their own: their share is spread over
                the good units.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="grid grid-cols-2 gap-3">
              <Field id="out-produced" label="Units produced" required hint={run.product.unit}>
                <Input id="out-produced" value={produced} onChange={(e) => setProduced(e.target.value)} numeric inputMode="decimal" autoFocus />
              </Field>
              <Field id="out-rejected" label="Units rejected" hint={run.product.unit}>
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
 * The unit cost the run will strike and the entry that moves its value into
 * Finished Goods, shown in full before the button that posts it.
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
      <CardHeader>
        <CardTitle>Unit cost</CardTitle>
        {preview ? (
          <span className="text-xs text-muted-foreground">
            <Money cents={preview.totalCents} currency plain /> over {formatUnits(preview.goodUnits)} good units
          </span>
        ) : null}
      </CardHeader>
      {preview === null ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{run.previewBlocker}</p>
      ) : (
        <>
          <div className="grid lg:grid-cols-[2fr_3fr]">
            <div className="flex min-w-0 flex-col">
              <ComponentBreakdown
                unitCostCents={preview.unitCostCents}
                rows={preview.components.map((c) => ({ component: c.component, perUnitCents: c.perUnitCents, totalCents: c.totalCents }))}
              />
              {preview.roundingVarianceCents !== 0 ? (
                <p className="border-t border-border px-4 py-2 text-2xs leading-relaxed text-muted-foreground">
                  <Money cents={preview.roundingVarianceCents} signed plain /> of rounding goes to 5050 Co-Man Variance, so
                  Finished Goods holds exactly the unit cost times the good units and empties to the cent as they ship.
                </p>
              ) : null}
            </div>
            <div className="min-w-0 border-t border-border lg:border-t-0 lg:border-l">
              <p className="eyebrow px-3 pt-3">Entry costing will post</p>
              <EntryPreview entry={{ ...preview.entry, date }} caption="Costing entry" />
            </div>
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border bg-surface-sunken/40 px-4 py-3">
              <Field id="cost-date" label="Costing date" note="The unit cost takes effect on this date.">
                <DateInput id="cost-date" value={date} onValueChange={setDate} />
              </Field>
              {confirming ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">Post this entry?</span>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={pending} onClick={cost}>
                    Post and cost {run.runNo}
                  </Button>
                </div>
              ) : (
                <Button size="sm" onClick={() => setConfirming(true)}>
                  <Calculator />
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

export function ComponentBreakdown({
  unitCostCents,
  rows,
}: {
  unitCostCents: number;
  rows: ReadonlyArray<{ component: CostComponentKey; perUnitCents: number; totalCents?: number }>;
}) {
  const showTotals = rows.some((r) => r.totalCents !== undefined);
  return (
    <div className="flex flex-col">
      <div className="flex h-2 w-full overflow-hidden bg-muted" role="img" aria-label="Unit cost by component">
        {rows.map((r, index) => (
          <span
            key={r.component}
            className={cn("h-full", ["bg-primary/80", "bg-info/70", "bg-warning/70", "bg-positive/60", "bg-border-strong"][index % 5])}
            style={{ width: unitCostCents > 0 ? `${(r.perUnitCents / unitCostCents) * 100}%` : "0%" }}
          />
        ))}
      </div>
      <TableScroll>
        <Table caption="Unit cost by component" className="min-w-[22rem]">
          <thead>
            <tr>
              <Th>Component</Th>
              {showTotals ? <Th align="right">Run total</Th> : null}
              <Th align="right">Per unit</Th>
              <Th align="right" className="w-20">
                Share
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, index) => (
              <tr key={r.component} className="rule-row">
                <Td>
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={cn("size-2 rounded-[1px]", ["bg-primary/80", "bg-info/70", "bg-warning/70", "bg-positive/60", "bg-border-strong"][index % 5])}
                    />
                    {COMPONENT_LABELS[r.component]}
                  </span>
                </Td>
                {showTotals ? (
                  <Td align="right">
                    <Money cents={r.totalCents ?? 0} plain />
                  </Td>
                ) : null}
                <Td align="right">
                  <Money cents={r.perUnitCents} plain />
                </Td>
                <Td align="right" className="num text-muted-foreground">
                  {unitCostCents > 0 ? `${((r.perUnitCents / unitCostCents) * 100).toFixed(1)}%` : "—"}
                </Td>
              </tr>
            ))}
            <tr className="font-semibold">
              <Td className="rule-subtotal">Unit cost</Td>
              {showTotals ? (
                <Td align="right" className="rule-subtotal">
                  <Money cents={rows.reduce((s, r) => s + (r.totalCents ?? 0), 0)} plain />
                </Td>
              ) : null}
              <Td align="right" className="rule-subtotal rule-total text-base">
                <Money cents={unitCostCents} currency plain />
              </Td>
              <Td className="rule-subtotal" />
            </tr>
          </tbody>
        </Table>
      </TableScroll>
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
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Undo2 />
        Reopen
      </Button>
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

export function LandedCostsCard({ run, canManage, billLines, openRuns, stock }: LandedCostsCardProps) {
  const editable = canManage && run.status === "open";
  const total = run.landedCosts.reduce((s, c) => s + c.amountCents, 0);

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader>
        <CardTitle>Landed costs</CardTitle>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <StockCostDialog run={run} stock={stock} />
            <BillLineDialog run={run} billLines={billLines} openRuns={openRuns} />
          </div>
        ) : null}
      </CardHeader>
      {run.landedCosts.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="No costs attached"
          description="Attach what went into this batch: the co-packer’s tolling invoice and freight from posted bills, and the ingredients and packaging it consumed from Sooz’s own stock in 1320 and 1330."
          className="py-8"
        />
      ) : (
        <TableScroll>
          <Table caption="Landed costs" className="min-w-[40rem]">
            <thead>
              <tr>
                <Th className="w-28">Component</Th>
                <Th>Description</Th>
                <Th>Relieved from</Th>
                <Th align="right" className="w-32">
                  Amount
                </Th>
                {editable ? <Th className="w-10" /> : null}
              </tr>
            </thead>
            <tbody>
              {run.landedCosts.map((c) => (
                <tr key={c.id} className="rule-row">
                  <Td className="whitespace-nowrap">{COMPONENT_LABELS[c.component]}</Td>
                  <Td className="text-muted-foreground">
                    {c.description ?? "—"}
                    {c.billNo ? (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs">
                        <FileText className="size-3" aria-hidden />
                        {c.billVendor} {c.billNo}
                        {c.basis && c.basis !== "manual" ? ` · by ${c.basis}` : ""}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <span className="num mr-1.5 text-muted-foreground">{c.sourceCode}</span>
                    {c.sourceName}
                  </Td>
                  <Td align="right">
                    <Money cents={c.amountCents} plain />
                  </Td>
                  {editable ? (
                    <Td align="right">
                      <RemoveCostButton runId={run.id} costId={c.id} />
                    </Td>
                  ) : null}
                </tr>
              ))}
              <tr className="font-semibold">
                <Td className="rule-subtotal" colSpan={3}>
                  Total landed cost
                </Td>
                <Td align="right" className="rule-subtotal rule-total">
                  <Money cents={total} currency plain />
                </Td>
                {editable ? <Td className="rule-subtotal" /> : null}
              </tr>
            </tbody>
          </Table>
        </TableScroll>
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
      <Trash2 />
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
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Materials from stock
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>Materials from stock</DialogTitle>
              <DialogDescription>
                Ingredients or packaging Sooz already owns that went into {run.runNo}. Costing moves this amount out of
                the inventory account it sits in and into Finished Goods.
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
                <p className="text-xs text-muted-foreground">
                  {source.name} holds <Money cents={source.cents} currency plain className="text-foreground" /> today.
                  {cents !== null && cents > source.cents ? (
                    <span className="text-warning"> This is more than the account holds.</span>
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
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <FileText />
        Attach a bill line
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>Attach a bill line</DialogTitle>
              <DialogDescription>
                A tolling, freight or material invoice line from a posted bill. One line can be spread over several open
                runs; the shares always add up to the line to the cent.
              </DialogDescription>
            </DialogHeader>
            {billLines.length === 0 ? (
              <DialogBody>
                <EmptyState
                  icon={<FileText />}
                  title="No posted bill has anything left to allocate"
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
                    <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Split by</span>
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

                <div className="overflow-hidden rounded-sm border border-border">
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
                            <tr key={r.id} className={cn("rule-row", !on && "text-muted-foreground")}>
                              <Td>
                                <input
                                  type="checkbox"
                                  aria-label={`Include ${r.runNo}`}
                                  checked={on}
                                  onChange={() => toggle(r.id)}
                                  className="size-3.5 accent-[var(--color-primary)]"
                                />
                              </Td>
                              <Td>
                                <span className="num font-medium">{r.runNo}</span>
                                <span className="num ml-2 text-xs text-muted-foreground">{r.sku}</span>
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
                                {on && shares ? <Money cents={shares[index] ?? 0} plain /> : <span className="text-muted-foreground">—</span>}
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
                {problem ? <p className="text-xs text-warning">{problem}</p> : null}
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
      <CardHeader>
        <CardTitle>Unit cost</CardTitle>
        <span className="text-xs text-muted-foreground">
          Effective <span className="num">{run.costDate ?? "—"}</span>
          {run.costEntry ? (
            <>
              {" · "}
              <Link href={`/ledger/${run.costEntry.id}`} className="text-primary hover:underline">
                entry #{run.costEntry.entryNo}
              </Link>
            </>
          ) : null}
        </span>
      </CardHeader>
      {run.costedBreakdown.length > 0 && run.unitCostCents !== null ? (
        <ComponentBreakdown unitCostCents={run.unitCostCents} rows={run.costedBreakdown} />
      ) : (
        <p className="px-4 py-6 text-sm">
          <Money cents={run.unitCostCents ?? 0} currency plain /> a unit, with no component split recorded.
        </p>
      )}
      {run.roundingVarianceCents !== 0 ? (
        <p className="border-t border-border px-4 py-2 text-2xs text-muted-foreground">
          <Money cents={run.roundingVarianceCents} signed plain /> of rounding was booked to 5050 at costing.
        </p>
      ) : null}
    </Card>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DateInput, todayIso } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { postAdjustmentAction, previewAdjustmentAction } from "@/app/(app)/inventory/actions";

import { EntryPreview } from "./entry-preview";
import { Field, NativeSelect, Segmented } from "./fields";
import {
  REASON_KEYS,
  REASON_LABELS,
  STAGE_LABELS,
  type AdjustmentFormInput,
  type AdjustmentPreviewData,
  type AdjustmentReasonKey,
  type ChannelOption,
  type ProductOption,
  type StageKey,
} from "./types";

const STAGES: readonly StageKey[] = ["finished", "raw", "packaging", "in_transit"];

/** Where the value goes, in words, so the reason picker explains itself. */
const REASON_NOTE: Record<AdjustmentReasonKey, string> = {
  samples: "Given away on purpose — 5070 Samples & Demo Product.",
  demo: "Poured at a demo — 5070 Samples & Demo Product.",
  donation: "Donated — 5070 Samples & Demo Product.",
  spoilage: "Spoiled — 5060 Inventory Write-offs & Spoilage.",
  damage: "Damaged — 5060 Inventory Write-offs & Spoilage.",
  expiry: "Past date — 5060 Inventory Write-offs & Spoilage.",
  theft: "Lost or stolen — 5060 Inventory Write-offs & Spoilage.",
  count_variance: "A count that disagrees with the books — 5060.",
  rework: "Reworked — 5060 Inventory Write-offs & Spoilage.",
  revaluation: "A change in carrying value — 5060.",
  opening_balance: "Stock on hand when the books began — 3990 Opening Balance Equity.",
};

/**
 * Records stock that left (or came back) outside a sale. The entry it will post
 * is recomputed as the form changes and shown before the post button, so the
 * accounts and the value are checked before anything reaches the ledger.
 */
export function AdjustmentForm({
  products,
  channels,
}: {
  products: readonly ProductOption[];
  channels: readonly ChannelOption[];
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<AdjustmentFormInput>({
    date: todayIso(),
    productId: products[0]?.id ?? "",
    reason: "spoilage",
    stage: "finished",
    quantity: "",
    direction: "out",
    unitCost: "",
    value: "",
    channelId: null,
    memo: "",
  });
  // Each preview remembers the form it was computed from, so a stale one is
  // never shown beside the post button.
  const [preview, setPreview] = React.useState<{ key: string; data: AdjustmentPreviewData } | null>(null);
  const [problem, setProblem] = React.useState<{ key: string; message: string } | null>(null);
  const [posting, startPost] = React.useTransition();
  const [, startPreview] = React.useTransition();

  const set = <K extends keyof AdjustmentFormInput>(key: K, value: AdjustmentFormInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const product = products.find((p) => p.id === form.productId);
  const ready = form.productId !== "" && form.quantity.trim() !== "" && form.date !== "";

  const formKey = JSON.stringify(form);

  React.useEffect(() => {
    if (!ready) return;
    let live = true;
    const key = JSON.stringify(form);
    const timer = window.setTimeout(() => {
      startPreview(async () => {
        const result = await previewAdjustmentAction(form);
        if (!live) return;
        if (result.ok) setPreview({ key, data: result.value });
        else setProblem({ key, message: result.error.message });
      });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [form, ready]);

  const shownPreview = ready && preview?.key === formKey ? preview.data : null;
  const shownProblem = ready && problem?.key === formKey ? problem.message : null;

  const post = () =>
    startPost(async () => {
      const result = await postAdjustmentAction(form);
      if (!result.ok) {
        toast.error("Adjustment not posted", { description: result.error.message });
        return;
      }
      toast.success(`${result.value.adjustmentNo} posted`);
      setForm((f) => ({ ...f, quantity: "", unitCost: "", value: "", memo: "" }));
      setPreview(null);
      router.refresh();
    });

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader>
        <CardTitle>Record an adjustment</CardTitle>
      </CardHeader>
      <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="adj-product" label="Product" required className="sm:col-span-2">
          <NativeSelect id="adj-product" value={form.productId} onChange={(e) => set("productId", e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} · {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="adj-date" label="Date" required>
          <DateInput id="adj-date" value={form.date} onValueChange={(v) => set("date", v)} className="w-full" />
        </Field>
        <Field id="adj-stage" label="Stage" required>
          <NativeSelect id="adj-stage" value={form.stage} onChange={(e) => set("stage", e.target.value as StageKey)}>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <Field id="adj-reason" label="Reason" required note={REASON_NOTE[form.reason]} className="sm:col-span-2">
          <NativeSelect id="adj-reason" value={form.reason} onChange={(e) => set("reason", e.target.value as AdjustmentReasonKey)}>
            {REASON_KEYS.map((r) => (
              <option key={r} value={r}>
                {REASON_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Direction</span>
          <Segmented
            label="Direction"
            value={form.direction}
            onChange={(v) => set("direction", v)}
            options={[
              { value: "out", label: "Remove from stock" },
              { value: "in", label: "Add to stock" },
            ]}
          />
        </div>

        <Field id="adj-qty" label="Quantity" required hint={product?.unit}>
          <Input id="adj-qty" value={form.quantity} onChange={(e) => set("quantity", e.target.value)} numeric inputMode="decimal" placeholder="0" />
        </Field>
        <Field
          id="adj-cost"
          label="Unit cost"
          hint="USD"
          note={
            form.stage === "finished"
              ? product?.unitCostCents != null
                ? `Blank uses the book cost, ${formatCents(product.unitCostCents, { currency: true })} today.`
                : "This product has no book cost yet; enter one."
              : "Materials carry no product cost; enter one, or the value."
          }
        >
          <Input id="adj-cost" value={form.unitCost} onChange={(e) => set("unitCost", e.target.value)} numeric inputMode="decimal" placeholder="0.00" />
        </Field>
        <Field id="adj-value" label="Or total value" hint="USD" note="Overrides quantity × unit cost.">
          <Input id="adj-value" value={form.value} onChange={(e) => set("value", e.target.value)} numeric inputMode="decimal" placeholder="0.00" />
        </Field>
        <Field id="adj-channel" label="Channel" hint="optional">
          <NativeSelect id="adj-channel" value={form.channelId ?? ""} onChange={(e) => set("channelId", e.target.value || null)}>
            <option value="">None</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="adj-memo" label="Memo" hint="optional" className="sm:col-span-2 lg:col-span-4">
          <Input id="adj-memo" value={form.memo} onChange={(e) => set("memo", e.target.value)} placeholder="12 cans to the Heights farmers market tasting" />
        </Field>
      </div>

      <div className="border-t border-border">
        <p className="eyebrow px-3 pt-3">Entry this will post</p>
        {shownPreview ? (
          <EntryPreview entry={shownPreview.entry} caption="Adjustment entry" />
        ) : (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {shownProblem ?? "Choose a product and enter a quantity to see the entry."}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border bg-surface-sunken/40 px-4 py-3">
        {shownPreview ? (
          <span className="text-xs text-muted-foreground">
            {shownPreview.valueCents < 0 ? "Takes" : "Adds"}{" "}
            <span className="num text-foreground">{formatCents(Math.abs(shownPreview.valueCents), { currency: true })}</span>{" "}
            {shownPreview.valueCents < 0 ? "out of" : "to"} inventory
          </span>
        ) : null}
        <Button size="sm" disabled={posting || shownPreview === null} onClick={post}>
          <Send />
          Post adjustment
        </Button>
      </div>
    </Card>
  );
}

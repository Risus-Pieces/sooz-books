"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DateInput, todayIso } from "@/components/ui/date-input";
import { Glyph } from "@/components/ui/glyph";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/components/ui/money";
import { PopUpButton } from "@/components/ui/pop-up-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";
import { postAdjustmentAction, previewAdjustmentAction } from "@/app/(app)/inventory/actions";

import { EntryPreview } from "./entry-preview";
import {
  REASON_KEYS,
  REASON_LABELS,
  REASON_STYLE,
  STAGE_LABELS,
  STAGE_STYLE,
  type AdjustmentFormInput,
  type AdjustmentPreviewData,
  type AdjustmentReasonKey,
  type ChannelOption,
  type ProductOption,
  type StageKey,
} from "./types";

const STAGES: readonly StageKey[] = ["finished", "raw", "packaging", "in_transit"];
const NO_CHANNEL = "none";

/** Where the value goes, as the account it posts to. */
const REASON_ACCOUNT: Record<AdjustmentReasonKey, string> = {
  samples: "5070 Samples & Demo",
  demo: "5070 Samples & Demo",
  donation: "5070 Samples & Demo",
  spoilage: "5060 Write-offs",
  damage: "5060 Write-offs",
  expiry: "5060 Write-offs",
  theft: "5060 Write-offs",
  count_variance: "5060 Write-offs",
  rework: "5060 Write-offs",
  revaluation: "5060 Write-offs",
  opening_balance: "3990 Opening Equity",
};

const field = "h-8 w-40 border-transparent bg-transparent text-right shadow-none hover:bg-fill2 focus-visible:bg-ctl max-sm:h-11 max-sm:w-36";

/**
 * Records stock that left (or came back) outside a sale, in a sheet: the facts as grouped rows,
 * then the entry it will post, recomputed as the form changes and drawn as a flow before the button
 * that posts it, so the accounts and the value are checked before anything reaches the ledger.
 */
export function AdjustmentSheet({
  products,
  channels,
  trigger = "toolbar",
}: {
  products: readonly ProductOption[];
  channels: readonly ChannelOption[];
  /** A toolbar item, or the button of an empty state. */
  trigger?: "toolbar" | "button";
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      {trigger === "toolbar" ? (
        <ToolbarButton glyph="plus" label="New adjustment" onClick={() => setOpen(true)} />
      ) : (
        <Button onClick={() => setOpen(true)}>
          <Glyph name="plus" />
          New adjustment
        </Button>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent title="New adjustment" width="lg" description="Record stock that left or came back outside a sale.">
          <AdjustmentForm products={products} channels={channels} onPosted={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}

export function AdjustmentForm({
  products,
  channels,
  onPosted,
}: {
  products: readonly ProductOption[];
  channels: readonly ChannelOption[];
  onPosted?: () => void;
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
  // Each preview remembers the form it was computed from, so a stale one is never shown beside the
  // post button.
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
      onPosted?.();
    });

  const costHint =
    form.stage === "finished"
      ? product?.unitCostCents != null
        ? `Blank: ${formatCents(product.unitCostCents, { currency: true })}`
        : "Required"
      : "Required";

  return (
    <div className="flex flex-col gap-1 pt-1">
      <SegmentedControl
        aria-label="Direction"
        fill
        value={form.direction}
        onValueChange={(v) => set("direction", v === "in" ? "in" : "out")}
        options={[
          { value: "out", label: "Remove", glyph: "minus" },
          { value: "in", label: "Add", glyph: "plus" },
        ]}
      />

      <InsetGroup header="Stock">
        <GroupRow label="Product">
          <PopUpButton
            aria-label="Product"
            value={form.productId}
            onValueChange={(v) => set("productId", v)}
            options={products.map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}` }))}
            className="max-w-56"
          />
        </GroupRow>
        <GroupRow label="Stage">
          <PopUpButton
            aria-label="Stage"
            value={form.stage}
            onValueChange={(v) => {
              const stage = STAGES.find((s) => s === v);
              if (stage) set("stage", stage);
            }}
            options={STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s], tint: STAGE_STYLE[s].tint }))}
          />
        </GroupRow>
        <GroupRow label="Reason">
          <PopUpButton
            aria-label="Reason"
            value={form.reason}
            onValueChange={(v) => {
              const reason = REASON_KEYS.find((r) => r === v);
              if (reason) set("reason", reason);
            }}
            options={REASON_KEYS.map((r) => ({ value: r, label: REASON_LABELS[r], tint: REASON_STYLE[r].tint }))}
          />
        </GroupRow>
        <GroupRow label="Posts to">
          <span className="text-xs">{REASON_ACCOUNT[form.reason]}</span>
        </GroupRow>
        <GroupRow label="Date" htmlFor="adj-date">
          <DateInput id="adj-date" value={form.date} onValueChange={(v) => set("date", v)} className={field} />
        </GroupRow>
      </InsetGroup>

      <InsetGroup header="Value">
        <GroupRow label={`Quantity${product ? ` (${product.unit})` : ""}`} htmlFor="adj-qty">
          <Input
            id="adj-qty"
            value={form.quantity}
            onChange={(e) => set("quantity", e.target.value)}
            numeric
            inputMode="decimal"
            placeholder="0"
            className={field}
          />
        </GroupRow>
        <GroupRow label="Unit cost" htmlFor="adj-cost">
          <Input
            id="adj-cost"
            value={form.unitCost}
            onChange={(e) => set("unitCost", e.target.value)}
            numeric
            inputMode="decimal"
            placeholder={costHint}
            className={field}
          />
        </GroupRow>
        <GroupRow label="Or total" htmlFor="adj-value">
          <Input
            id="adj-value"
            value={form.value}
            onChange={(e) => set("value", e.target.value)}
            numeric
            inputMode="decimal"
            placeholder="0.00"
            className={field}
          />
        </GroupRow>
      </InsetGroup>

      <InsetGroup header="Details">
        <GroupRow label="Channel">
          <PopUpButton
            aria-label="Channel"
            value={form.channelId ?? NO_CHANNEL}
            onValueChange={(v) => set("channelId", v === NO_CHANNEL ? null : v)}
            options={[{ value: NO_CHANNEL, label: "None" }, ...channels.map((c) => ({ value: c.id, label: c.name }))]}
          />
        </GroupRow>
        <GroupRow label="Memo" htmlFor="adj-memo">
          <Input
            id="adj-memo"
            value={form.memo}
            onChange={(e) => set("memo", e.target.value)}
            placeholder="Farmers market tasting"
            className={cn(field, "w-56 max-sm:w-44")}
          />
        </GroupRow>
      </InsetGroup>

      <InsetGroup header="Entry">
        {shownPreview ? (
          <EntryPreview entry={shownPreview.entry} caption="Adjustment entry" className="pt-1" />
        ) : (
          <p className={cn("flex items-center gap-2 px-4 py-4 text-sm font-medium", shownProblem ? "text-ink-orange" : "text-label2")}>
            <Glyph name={shownProblem ? "warning" : "doc"} size={15} />
            {shownProblem ?? "Enter a quantity"}
          </p>
        )}
      </InsetGroup>

      <div className="flex flex-wrap items-center justify-end gap-3 pt-4">
        {shownPreview ? (
          <span className="text-sm text-label2">
            {shownPreview.valueCents < 0 ? "Takes" : "Adds"}{" "}
            <span className="num font-semibold text-label">{formatCents(Math.abs(shownPreview.valueCents), { currency: true })}</span>{" "}
            {shownPreview.valueCents < 0 ? "out of" : "to"} inventory
          </span>
        ) : null}
        <Button disabled={posting || shownPreview === null} onClick={post}>
          <Glyph name="check" />
          Post adjustment
        </Button>
      </div>
    </div>
  );
}

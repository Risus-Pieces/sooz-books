"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { ToolbarButton } from "@/components/ui/toolbar";
import { DateInput, todayIso } from "@/components/ui/date-input";
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
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { createProductAction, createRunAction } from "@/app/(app)/inventory/actions";

import { Field, NativeSelect } from "./fields";
import type { ProductOption, VendorOption } from "./types";

export interface NewRunDialogProps {
  products: readonly ProductOption[];
  vendors: readonly VendorOption[];
  /** Suggested run number, e.g. the next in sequence. */
  suggestedRunNo: string;
  defaultOpen?: boolean;
  /** A button (empty state), a toolbar item, or nothing (opened by `defaultOpen`). */
  trigger?: "button" | "toolbar" | "none";
}

/**
 * Opens a production run: what the co-packer is making, when, and how many were
 * planned. Costs and output are recorded on the run afterwards, as the invoices
 * and the co-packer's yield report arrive.
 */
export function NewRunDialog({ products, vendors, suggestedRunNo, defaultOpen = false, trigger = "button" }: NewRunDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(defaultOpen);
  const [pending, startTransition] = React.useTransition();
  const [productList, setProductList] = React.useState<readonly ProductOption[]>(products);
  const [addingProduct, setAddingProduct] = React.useState(products.length === 0);

  const [runNo, setRunNo] = React.useState(suggestedRunNo);
  const [productId, setProductId] = React.useState(products[0]?.id ?? "");
  const [runDate, setRunDate] = React.useState(todayIso());
  const [vendorId, setVendorId] = React.useState(vendors.find((v) => v.isCoMan)?.id ?? "");
  const [lotCode, setLotCode] = React.useState("");
  const [planned, setPlanned] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const [sku, setSku] = React.useState("");
  const [name, setName] = React.useState("");
  const [unit, setUnit] = React.useState("each");

  const close = (next: boolean) => {
    setOpen(next);
    if (!next && defaultOpen) router.replace("/inventory/production", { scroll: false });
  };

  const addProduct = () => {
    startTransition(async () => {
      const result = await createProductAction({ sku, name, unit });
      if (!result.ok) {
        toast.error("Product not added", { description: result.error.message });
        return;
      }
      setProductList((list) => [...list, result.value].sort((a, b) => a.sku.localeCompare(b.sku)));
      setProductId(result.value.id);
      setAddingProduct(false);
      setSku("");
      setName("");
      toast.success(`${result.value.sku} added`);
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await createRunAction({
        runNo,
        productId,
        runDate,
        coManVendorId: vendorId || null,
        lotCode,
        unitsPlanned: planned,
        notes,
      });
      if (!result.ok) {
        toast.error("Run not created", { description: result.error.message });
        return;
      }
      toast.success(`Run ${runNo.trim()} created`);
      setOpen(false);
      router.push(`/inventory/production/${result.value.runId}`);
    });
  };

  const coMen = vendors.filter((v) => v.isCoMan);
  const others = vendors.filter((v) => !v.isCoMan);

  return (
    <>
      {trigger === "button" ? (
        <Button onClick={() => setOpen(true)}>
          <Glyph name="plus" />
          New run
        </Button>
      ) : trigger === "toolbar" ? (
        <ToolbarButton glyph="plus" label="New production run" onClick={() => setOpen(true)} />
      ) : null}
      <Dialog open={open} onOpenChange={close}>
        <DialogContent size="md">
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>New production run</DialogTitle>
              <DialogDescription className="sr-only">
                One batch the co-packer makes. Attach its costs and record its output on the run once they are known.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="grid gap-3 sm:grid-cols-2">
              <Field id="run-no" label="Run number" required>
                <Input id="run-no" value={runNo} onChange={(e) => setRunNo(e.target.value)} className="num" autoComplete="off" />
              </Field>
              <Field id="run-date" label="Run date" required>
                <DateInput id="run-date" value={runDate} onValueChange={setRunDate} className="w-full" />
              </Field>

              <div className="flex flex-col gap-2 sm:col-span-2">
                {addingProduct ? (
                  <div className="flex flex-col gap-3 rounded-[12px] bg-inset p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm font-semibold">New product</p>
                      {productList.length > 0 ? (
                        <button type="button" className="text-xs font-medium text-ink-blue hover:underline" onClick={() => setAddingProduct(false)}>
                          Choose existing
                        </button>
                      ) : null}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[1fr_2fr_6rem]">
                      <Field id="new-sku" label="SKU" required>
                        <Input id="new-sku" value={sku} onChange={(e) => setSku(e.target.value)} className="num uppercase" placeholder="MB-POUCH" autoComplete="off" />
                      </Field>
                      <Field id="new-name" label="Name" required>
                        <Input id="new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mango Breeze Pouch" />
                      </Field>
                      <Field id="new-unit" label="Unit">
                        <Input id="new-unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
                      </Field>
                    </div>
                    <div>
                      <Button type="button" size="sm" variant="secondary" disabled={pending || sku.trim() === "" || name.trim() === ""} onClick={addProduct}>
                        <Glyph name="plus" />
                        Add product
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Field
                    id="run-product"
                    label="Product"
                    required
                    note={
                      <button type="button" className="font-medium text-ink-blue hover:underline" onClick={() => setAddingProduct(true)}>
                        New product
                      </button>
                    }
                  >
                    <NativeSelect id="run-product" value={productId} onChange={(e) => setProductId(e.target.value)}>
                      {productList.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} · {p.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                )}
              </div>

              <Field
                id="run-coman"
                label="Co-packer"
                className="sm:col-span-2"
                
              >
                <NativeSelect id="run-coman" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                  <option value="">Not recorded</option>
                  {coMen.length > 0 ? (
                    <optgroup label="Co-manufacturers">
                      {coMen.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  <optgroup label="Other vendors">
                    {others.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                </NativeSelect>
              </Field>
              <Field id="run-planned" label="Units planned" hint="optional">
                <Input id="run-planned" value={planned} onChange={(e) => setPlanned(e.target.value)} numeric inputMode="decimal" placeholder="0" />
              </Field>
              <Field id="run-lot" label="Lot code" hint="optional">
                <Input id="run-lot" value={lotCode} onChange={(e) => setLotCode(e.target.value)} className="num" autoComplete="off" />
              </Field>
              <Field id="run-notes" label="Notes" hint="optional" className="sm:col-span-2">
                <Textarea id="run-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending || addingProduct || productId === "" || runNo.trim() === ""}>
                Create run
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

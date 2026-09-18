"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";

import { createPromotionAction, previewPromotionPlan } from "@/app/(app)/trade/actions";
import { MoneyInput } from "@/components/arap/money-input";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";

import { monthLabel } from "./labels";
import { Field, Table, TableScroll, Td, Th } from "./parts";
import type { PlanPreviewView, PromotionDraft, PromotionFormOptions } from "./types";

const BLANK_LINE = { productId: "", plannedUnits: "", allowancePerUnit: "" };

/**
 * Planning a promotion: who it runs with, what kind it is, when it runs and ships, and what it
 * costs — per product or for the whole deal, plus any fixed fee. The accrual schedule beside it
 * is the engine's own month-by-month split of that cost, recomputed as the plan changes.
 */
export function PromotionForm({ options, today }: { options: PromotionFormOptions; today: string }) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<PromotionDraft>({
    name: "",
    customerId: options.customers.length === 1 ? options.customers[0].value : "",
    promoType: "mcb",
    startDate: today,
    endDate: today,
    shipStartDate: "",
    shipEndDate: "",
    authorizationNo: "",
    plannedUnits: "",
    allowancePerUnit: "",
    fixedFee: "",
    notes: "",
    products: options.products.length > 0 ? [{ ...BLANK_LINE }] : [],
  });
  const [preview, setPreview] = React.useState<PlanPreviewView | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const type = options.promoTypes.find((t) => t.value === draft.promoType) ?? options.promoTypes[0];
  const set = <K extends keyof PromotionDraft>(key: K, value: PromotionDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setLine = (index: number, patch: Partial<PromotionDraft["products"][number]>) =>
    setDraft((d) => ({ ...d, products: d.products.map((l, i) => (i === index ? { ...l, ...patch } : l)) }));

  React.useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void previewPromotionPlan(draft).then((result) => {
        if (!live) return;
        if (result.ok) {
          setPreview(result.value);
          setPreviewError(null);
        } else {
          setPreview(null);
          setPreviewError(result.error.message);
        }
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft]);

  const submit = () =>
    startTransition(async () => {
      const result = await createPromotionAction(draft);
      if (!result.ok) {
        toast.error("Not saved", { description: result.error.message });
        return;
      }
      toast.success("Promotion planned");
      router.push(`/trade/promotions/${result.value.id}`);
    });

  const noCustomers = options.customers.length === 0;

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card className="min-w-0">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>The deal</CardTitle>
            <CardDescription>Nothing posts when you save. The accrual posts month by month from the promotion’s page.</CardDescription>
          </div>
        </CardHeader>
        <div className="flex flex-col gap-4 px-4 py-4">
          {noCustomers ? (
            <p className="rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-muted-foreground">
              A promotion runs with a customer, and there are none yet.{" "}
              <Link href="/sales/customers" className="text-primary hover:underline">
                Add the distributor as a customer
              </Link>{" "}
              first.
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="promo-name" required>
              <Input id="promo-name" value={draft.name} maxLength={120} onChange={(e) => set("name", e.target.value)} placeholder="Spring MCB, sparkling 12-pack" disabled={pending} />
            </Field>
            <Field label="Customer" htmlFor="promo-customer" required>
              <Select value={draft.customerId === "" ? undefined : draft.customerId} onValueChange={(v) => set("customerId", v)} disabled={pending || noCustomers}>
                <SelectTrigger id="promo-customer">
                  <SelectValue placeholder={noCustomers ? "No customers yet" : "Choose the customer"} />
                </SelectTrigger>
                <SelectContent>
                  {options.customers.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Kind" htmlFor="promo-type" required>
              <Select value={draft.promoType} onValueChange={(v) => set("promoType", v)} disabled={pending}>
                <SelectTrigger id="promo-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.promoTypes.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Deal number" htmlFor="promo-auth" hint="what the distributor will quote">
              <Input id="promo-auth" value={draft.authorizationNo} maxLength={60} onChange={(e) => set("authorizationNo", e.target.value)} className="num" disabled={pending} />
            </Field>
          </div>
          {type ? (
            <p className="-mt-1 text-xs text-muted-foreground">
              {type.hint} Accrues to <span className="num text-foreground">{type.accountCode}</span> {type.accountName}.
            </p>
          ) : null}

          <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <legend className="eyebrow mb-2">Dates</legend>
            <Field label="Starts" htmlFor="promo-start" required>
              <DateInput id="promo-start" value={draft.startDate} onValueChange={(v) => set("startDate", v)} disabled={pending} />
            </Field>
            <Field label="Ends" htmlFor="promo-end" required>
              <DateInput id="promo-end" value={draft.endDate} onValueChange={(v) => set("endDate", v)} disabled={pending} />
            </Field>
            <Field label="Ships from" htmlFor="promo-ship-start" hint="optional">
              <DateInput id="promo-ship-start" value={draft.shipStartDate} onValueChange={(v) => set("shipStartDate", v)} disabled={pending} />
            </Field>
            <Field label="Ships to" htmlFor="promo-ship-end" hint="optional">
              <DateInput id="promo-ship-end" value={draft.shipEndDate} onValueChange={(v) => set("shipEndDate", v)} disabled={pending} />
            </Field>
            <p className="col-span-2 text-xs text-muted-foreground sm:col-span-4">
              The accrual follows the ship window when there is one: that is when the discounted sales happen.
            </p>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="eyebrow mb-2">Allowance</legend>
            {options.products.length === 0 ? (
              <>
                <p className="text-xs text-muted-foreground">
                  No products are in the catalog yet, so plan the deal as a whole. Products arrive with the Peasy inventory import.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Planned units" htmlFor="promo-units" hint="cases or eaches">
                    <Input id="promo-units" inputMode="decimal" numeric value={draft.plannedUnits} onChange={(e) => set("plannedUnits", e.target.value)} placeholder="0" disabled={pending} />
                  </Field>
                  <Field label="Allowance per unit" htmlFor="promo-allowance">
                    <MoneyInput id="promo-allowance" value={draft.allowancePerUnit} onValueChange={(v) => set("allowancePerUnit", v)} disabled={pending} />
                  </Field>
                </div>
              </>
            ) : (
              <div className="rounded-md border border-border">
                <TableScroll>
                  <Table caption="Products on the promotion" className="min-w-[34rem]">
                    <thead>
                      <tr>
                        <Th>Product</Th>
                        <Th align="right" className="w-28">
                          Units
                        </Th>
                        <Th align="right" className="w-32">
                          Per unit
                        </Th>
                        <Th className="w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {draft.products.map((l, index) => (
                        <tr key={index} className="rule-row">
                          <Td className="min-w-52 py-1">
                            <Select value={l.productId === "" ? undefined : l.productId} onValueChange={(v) => setLine(index, { productId: v })} disabled={pending}>
                              <SelectTrigger aria-label={`Product on line ${index + 1}`}>
                                <SelectValue placeholder="Choose a product" />
                              </SelectTrigger>
                              <SelectContent>
                                {options.products.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    <span className="num mr-1.5 text-muted-foreground">{p.sku}</span>
                                    {p.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </Td>
                          <Td className="py-1">
                            <Input aria-label={`Units on line ${index + 1}`} inputMode="decimal" numeric value={l.plannedUnits} onChange={(e) => setLine(index, { plannedUnits: e.target.value })} disabled={pending} />
                          </Td>
                          <Td className="py-1">
                            <MoneyInput aria-label={`Allowance per unit on line ${index + 1}`} value={l.allowancePerUnit} onValueChange={(v) => setLine(index, { allowancePerUnit: v })} disabled={pending} />
                          </Td>
                          <Td className="py-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove line ${index + 1}`}
                              onClick={() => setDraft((d) => ({ ...d, products: d.products.filter((_, i) => i !== index) }))}
                              disabled={pending || draft.products.length === 1}
                            >
                              <Trash2 />
                            </Button>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </TableScroll>
                <div className="px-3 py-2">
                  <Button variant="ghost" size="sm" onClick={() => setDraft((d) => ({ ...d, products: [...d.products, { ...BLANK_LINE }] }))} disabled={pending}>
                    <Plus />
                    Add a product
                  </Button>
                </div>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Fixed fee" htmlFor="promo-fee" hint={`admin fee floor, slotting · ${options.feeAccount.code}`}>
                <MoneyInput id="promo-fee" value={draft.fixedFee} onValueChange={(v) => set("fixedFee", v)} disabled={pending} />
              </Field>
            </div>
          </fieldset>

          <Field label="Notes" htmlFor="promo-notes" hint="optional">
            <Textarea id="promo-notes" rows={2} value={draft.notes} maxLength={2000} onChange={(e) => set("notes", e.target.value)} disabled={pending} />
          </Field>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/trade/promotions">Cancel</Link>
            </Button>
            <Button size="sm" onClick={submit} disabled={pending || noCustomers || draft.name.trim() === "" || draft.customerId === "" || preview === null || preview.totalCents === 0}>
              {pending ? "Saving…" : "Save promotion"}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="min-w-0 xl:sticky xl:top-4">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Accrual schedule</CardTitle>
            <CardDescription>Spread across the window by days, to the cent. Each month-end posts one entry.</CardDescription>
          </div>
        </CardHeader>
        {preview === null ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">{previewError ?? "Working out the schedule…"}</p>
        ) : preview.totalCents === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">Give units and an allowance, or a fixed fee, to see the schedule.</p>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-3 px-4 py-3">
              <div>
                <dt className="eyebrow">Allowance</dt>
                <dd className="text-sm">
                  <Money cents={preview.allowanceCents} plain />
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Fixed fees</dt>
                <dd className="text-sm">
                  <Money cents={preview.feeCents} plain zeroDash />
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Planned</dt>
                <dd className="text-sm font-semibold">
                  <Money cents={preview.totalCents} currency plain />
                </dd>
              </div>
            </dl>
            <TableScroll>
              <Table caption="Accrual by month" className="min-w-[24rem]">
                <thead>
                  <tr>
                    <Th>Month</Th>
                    <Th align="right">Days</Th>
                    <Th align="right">Dr {type?.accountCode}</Th>
                    <Th align="right">Dr {options.feeAccount.code}</Th>
                    <Th align="right" className="rule-gutter">
                      Cr 2120
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {preview.months.map((m) => (
                    <tr key={m.periodEnd} className="rule-row">
                      <Td className="num text-xs whitespace-nowrap">{monthLabel(m.periodEnd)}</Td>
                      <Td align="right" className="num text-xs text-muted-foreground">
                        {m.days}
                      </Td>
                      <Td align="right">
                        <Money cents={m.allowanceCents} plain zeroDash />
                      </Td>
                      <Td align="right">
                        <Money cents={m.feeCents} plain zeroDash />
                      </Td>
                      <Td align="right" className="rule-gutter">
                        <Money cents={m.allowanceCents + m.feeCents} plain />
                      </Td>
                    </tr>
                  ))}
                  <tr>
                    <Td className="rule-subtotal text-xs font-semibold text-muted-foreground" colSpan={2}>
                      {preview.months.length} {preview.months.length === 1 ? "month" : "months"}
                    </Td>
                    <Td align="right" className="rule-subtotal rule-total font-semibold">
                      <Money cents={preview.allowanceCents} plain />
                    </Td>
                    <Td align="right" className="rule-subtotal rule-total font-semibold">
                      <Money cents={preview.feeCents} plain zeroDash />
                    </Td>
                    <Td align="right" className="rule-subtotal rule-total rule-gutter font-semibold">
                      <Money cents={preview.totalCents} plain />
                    </Td>
                  </tr>
                </tbody>
              </Table>
            </TableScroll>
          </>
        )}
      </Card>
    </div>
  );
}

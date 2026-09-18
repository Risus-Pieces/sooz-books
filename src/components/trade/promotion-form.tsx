"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { createPromotionAction, previewPromotionPlan } from "@/app/(app)/trade/actions";
import { MoneyInput } from "@/components/arap/money-input";
import { Sparkbars } from "@/components/charts";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";

import { monthLabel } from "./labels";
import { dollars } from "@/lib/ui/format";
import { Field, Table, Td, Th } from "./parts";
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

  const canSave = !pending && !noCustomers && draft.name.trim() !== "" && draft.customerId !== "" && preview !== null && preview.totalCents > 0;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="New promotion"
        back={{ href: "/trade/promotions", label: "Promotions" }}
        phoneTitleRow
        info={
          <>
            <p>Record the deal as agreed. Its cost is spread over the ship window and accrued at each month-end, so the deductions that follow are charged against it.</p>
            <p>Nothing posts when you save. The accrual posts month by month from the promotion&apos;s page.</p>
          </>
        }
        actions={
          <div className="flex items-center gap-2 max-md:hidden">
            <Button asChild variant="secondary">
              <Link href="/trade/promotions">Cancel</Link>
            </Button>
            <Button onClick={submit} disabled={!canSave}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      />

      <div className="grid items-start gap-3.5 max-md:gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-3.5 max-md:gap-3">
          {noCustomers ? (
            <div className="flex items-center gap-2.5 rounded-[14px] bg-tint-orange/10 px-4 py-3 text-sm">
              <Glyph name="warning" size={16} className="shrink-0 text-ink-orange" />
              <span className="min-w-0 flex-1">No customers yet</span>
              <Button asChild size="sm" variant="secondary">
                <Link href="/sales/customers">Add distributor</Link>
              </Button>
            </div>
          ) : null}

          <section aria-labelledby="deal" className="rounded-2xl bg-card px-5 pt-4 pb-5 shadow-card max-md:rounded-[22px] max-md:p-4">
            <h2 id="deal" className="mb-3 text-lg font-semibold tracking-[-0.01em]">
              Deal
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="promo-name" required>
                <Input id="promo-name" value={draft.name} maxLength={120} onChange={(e) => set("name", e.target.value)} placeholder="Spring MCB, sparkling 12-pack" disabled={pending} />
              </Field>
              <Field label="Customer" htmlFor="promo-customer" required>
                <Select value={draft.customerId === "" ? undefined : draft.customerId} onValueChange={(v) => set("customerId", v)} disabled={pending || noCustomers}>
                  <SelectTrigger id="promo-customer">
                    <SelectValue placeholder={noCustomers ? "No customers yet" : "Choose"} />
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
                <div className="flex items-center gap-1">
                  <Select value={draft.promoType} onValueChange={(v) => set("promoType", v)} disabled={pending}>
                    <SelectTrigger id="promo-type" className="flex-1">
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
                  {type ? (
                    <InfoButton label="About this kind" title={type.label}>
                      <p>{type.hint}</p>
                      <p className="text-label2">
                        Accrues to <span className="num">{type.accountCode}</span> {type.accountName}.
                      </p>
                    </InfoButton>
                  ) : null}
                </div>
              </Field>
              <Field label="Deal number" htmlFor="promo-auth">
                <Input id="promo-auth" value={draft.authorizationNo} maxLength={60} onChange={(e) => set("authorizationNo", e.target.value)} className="num" disabled={pending} placeholder="As the distributor quotes it" />
              </Field>
            </div>
          </section>

          <section aria-labelledby="dates" className="rounded-2xl bg-card px-5 pt-4 pb-5 shadow-card max-md:rounded-[22px] max-md:p-4">
            <h2 id="dates" className="mb-3 flex items-center gap-1 text-lg font-semibold tracking-[-0.01em]">
              Dates
              <InfoButton label="About the ship window" align="start">
                <p>The accrual follows the ship window when there is one: that is when the discounted sales happen.</p>
              </InfoButton>
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Starts" htmlFor="promo-start" required>
                <DateInput id="promo-start" value={draft.startDate} onValueChange={(v) => set("startDate", v)} disabled={pending} />
              </Field>
              <Field label="Ends" htmlFor="promo-end" required>
                <DateInput id="promo-end" value={draft.endDate} onValueChange={(v) => set("endDate", v)} disabled={pending} />
              </Field>
              <Field label="Ships from" htmlFor="promo-ship-start">
                <DateInput id="promo-ship-start" value={draft.shipStartDate} onValueChange={(v) => set("shipStartDate", v)} disabled={pending} />
              </Field>
              <Field label="Ships to" htmlFor="promo-ship-end">
                <DateInput id="promo-ship-end" value={draft.shipEndDate} onValueChange={(v) => set("shipEndDate", v)} disabled={pending} />
              </Field>
            </div>
          </section>

          <section aria-labelledby="allowance" className="rounded-2xl bg-card px-5 pt-4 pb-5 shadow-card max-md:rounded-[22px] max-md:p-4">
            <h2 id="allowance" className="mb-3 flex items-center gap-1 text-lg font-semibold tracking-[-0.01em]">
              Allowance
              {options.products.length === 0 ? (
                <InfoButton label="About the allowance" align="start">
                  <p>No products are in the catalog yet, so plan the deal as a whole. Products arrive with the Peasy inventory import.</p>
                </InfoButton>
              ) : null}
            </h2>
            {options.products.length === 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Units" htmlFor="promo-units">
                  <Input id="promo-units" inputMode="decimal" numeric value={draft.plannedUnits} onChange={(e) => set("plannedUnits", e.target.value)} placeholder="0" disabled={pending} />
                </Field>
                <Field label="Per unit" htmlFor="promo-allowance">
                  <MoneyInput id="promo-allowance" value={draft.allowancePerUnit} onValueChange={(v) => set("allowancePerUnit", v)} disabled={pending} />
                </Field>
              </div>
            ) : (
              <div className="-mx-5 max-md:-mx-4">
                <Table caption="Products on the promotion" className="min-w-[30rem]">
                  <thead>
                    <tr>
                      <Th>Product</Th>
                      <Th align="right" className="w-28">
                        Units
                      </Th>
                      <Th align="right" className="w-32">
                        Per unit
                      </Th>
                      <Th className="w-12" />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.products.map((l, index) => (
                      <tr key={index}>
                        <Td className="rule-row min-w-48 py-1.5">
                          <Select value={l.productId === "" ? undefined : l.productId} onValueChange={(v) => setLine(index, { productId: v })} disabled={pending}>
                            <SelectTrigger aria-label={`Product on line ${index + 1}`}>
                              <SelectValue placeholder="Choose a product" />
                            </SelectTrigger>
                            <SelectContent>
                              {options.products.map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  <span className="num mr-1.5 text-label2">{p.sku}</span>
                                  {p.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Td>
                        <Td className="rule-row py-1.5">
                          <Input aria-label={`Units on line ${index + 1}`} inputMode="decimal" numeric value={l.plannedUnits} onChange={(e) => setLine(index, { plannedUnits: e.target.value })} disabled={pending} />
                        </Td>
                        <Td className="rule-row py-1.5">
                          <MoneyInput aria-label={`Allowance per unit on line ${index + 1}`} value={l.allowancePerUnit} onValueChange={(v) => setLine(index, { allowancePerUnit: v })} disabled={pending} />
                        </Td>
                        <Td className="rule-row py-1.5">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove line ${index + 1}`}
                            onClick={() => setDraft((d) => ({ ...d, products: d.products.filter((_, i) => i !== index) }))}
                            disabled={pending || draft.products.length === 1}
                          >
                            <Glyph name="trash" />
                          </Button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="px-3 pt-2">
                  <Button variant="ghost" size="sm" onClick={() => setDraft((d) => ({ ...d, products: [...d.products, { ...BLANK_LINE }] }))} disabled={pending}>
                    <Glyph name="plus" />
                    Add product
                  </Button>
                </div>
              </div>
            )}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Fixed fee" htmlFor="promo-fee" hint={options.feeAccount.code}>
                <MoneyInput id="promo-fee" value={draft.fixedFee} onValueChange={(v) => set("fixedFee", v)} disabled={pending} />
              </Field>
            </div>
          </section>

          <div className="rounded-2xl bg-card px-5 pt-4 pb-5 shadow-card max-md:rounded-[22px] max-md:p-4">
            <Field label="Notes" htmlFor="promo-notes">
              <Textarea id="promo-notes" rows={2} value={draft.notes} maxLength={2000} onChange={(e) => set("notes", e.target.value)} disabled={pending} />
            </Field>
          </div>

        </div>

        <section aria-labelledby="schedule" className="min-w-0 rounded-2xl bg-card px-5 pt-4 pb-4 shadow-card max-md:rounded-[22px] max-md:p-4 xl:sticky xl:top-[72px]">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 id="schedule" className="flex flex-1 items-center gap-1 text-lg font-semibold tracking-[-0.01em]">
              Accrual
              <InfoButton label="About the schedule" align="start">
                <p>Spread across the window by days, to the cent. Each month-end posts one entry: Dr the contra account, Cr 2120 Accrued Trade Spend.</p>
              </InfoButton>
            </h2>
            {preview !== null && preview.totalCents > 0 ? <Money cents={preview.totalCents} currency plain className="text-2xl font-bold tracking-[-0.022em]" /> : null}
          </div>
          {preview === null ? (
            <p className="py-8 text-center text-sm text-label2">{previewError ?? "Working…"}</p>
          ) : preview.totalCents === 0 ? (
            <div className="flex flex-col items-center py-8 text-center">
              <Glyph name="hourglass" size={40} weight={1.4} className="mb-2 text-label3" />
              <p className="text-sm font-semibold text-label2">Add units or a fee</p>
            </div>
          ) : (
            <>
              <Sparkbars
                values={preview.months.map((m) => m.allowanceCents + m.feeCents)}
                tint="cyan"
                width={320}
                height={56}
                label="Accrual by month"
                format={dollars}
              />
              <ul className="mt-3 flex flex-col">
                {preview.months.map((m, index) => (
                  <li key={m.periodEnd} className={index > 0 ? "flex items-center gap-3 hairline-t py-2 text-sm" : "flex items-center gap-3 py-2 text-sm"}>
                    <span className="flex-1 font-medium">
                      {monthLabel(m.periodEnd)} <span className="num text-xs text-label2">· {m.days}d</span>
                    </span>
                    {m.feeCents > 0 ? (
                      <span className="text-xs text-label2">
                        fee <Money cents={m.feeCents} plain />
                      </span>
                    ) : null}
                    <Money cents={m.allowanceCents + m.feeCents} currency plain className="font-semibold" />
                  </li>
                ))}
              </ul>
              <dl className="mt-2 grid grid-cols-2 overflow-hidden rounded-[11px] bg-inset">
                <div className="px-3 py-2">
                  <dt className="text-2xs font-semibold text-label2">Allowance · {type?.accountCode}</dt>
                  <dd className="text-sm font-semibold">
                    <Money cents={preview.allowanceCents} currency plain />
                  </dd>
                </div>
                <div className="hairline-l px-3 py-2">
                  <dt className="text-2xs font-semibold text-label2">Fees · {options.feeAccount.code}</dt>
                  <dd className="text-sm font-semibold">
                    <Money cents={preview.feeCents} currency plain zeroDash />
                  </dd>
                </div>
              </dl>
            </>
          )}
        </section>
      </div>

      <div className="flex items-center justify-end gap-2 md:hidden">
        <Button asChild variant="secondary">
          <Link href="/trade/promotions">Cancel</Link>
        </Button>
        <Button onClick={submit} disabled={!canSave}>
          {pending ? "Saving…" : "Save promotion"}
        </Button>
      </div>
    </div>
  );
}

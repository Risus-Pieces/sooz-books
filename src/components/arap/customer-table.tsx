"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Search, Store } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { saveCustomer } from "@/app/(app)/sales/actions";

import { Td, Th } from "./doc-status";
import { readMoney, termsLabel } from "./math";
import { MoneyInput, textOf } from "./money-input";
import {
  CUSTOMER_TYPES,
  CUSTOMER_TYPE_LABELS,
  type CustomerForm,
  type CustomerRow,
  type CustomerType,
  type Option,
} from "./types";

const FROM_TYPE = "__type__";

/** The terms small food and beverage buyers actually ask for. */
const TERM_PRESETS: readonly { label: string; net: number; pct: string; days: number }[] = [
  { label: "Due on receipt", net: 0, pct: "0", days: 0 },
  { label: "Net 15", net: 15, pct: "0", days: 0 },
  { label: "Net 30", net: 30, pct: "0", days: 0 },
  { label: "2/10 net 30", net: 30, pct: "2", days: 10 },
  { label: "Net 45", net: 45, pct: "0", days: 0 },
];

function blankForm(): CustomerForm {
  return {
    name: "",
    displayName: "",
    customerType: "foodservice",
    channelId: null,
    email: "",
    phone: "",
    termsDays: 30,
    termsDiscountPct: "0",
    termsDiscountDays: 0,
    creditLimitCents: null,
    notes: "",
    active: true,
  };
}

function formOf(row: CustomerRow): CustomerForm {
  return {
    name: row.name,
    displayName: row.displayName ?? "",
    customerType: row.customerType,
    channelId: row.channelId,
    email: row.email ?? "",
    phone: row.phone ?? "",
    termsDays: row.termsDays,
    termsDiscountPct: row.termsDiscountPct,
    termsDiscountDays: row.termsDiscountDays,
    creditLimitCents: row.creditLimitCents,
    notes: row.notes ?? "",
    active: row.active,
  };
}

export function CustomerTable({
  rows,
  channels,
  canManage,
  openNew,
}: {
  rows: readonly CustomerRow[];
  channels: readonly Option[];
  canManage: boolean;
  openNew: boolean;
}) {
  const [editing, setEditing] = React.useState<CustomerRow | "new" | null>(openNew && canManage ? "new" : null);
  const [query, setQuery] = React.useState("");

  const shown = rows.filter((row) => row.name.toLowerCase().includes(query.trim().toLowerCase()));

  const addButton = canManage ? (
    <Button size="sm" onClick={() => setEditing("new")}>
      <Plus />
      New customer
    </Button>
  ) : null;

  return (
    <>
      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Store />}
            title="No customers yet"
            description="A customer is anyone you invoice: a restaurant buying cases, a shop on net terms, a distributor. Square sales at markets don't need one — they arrive through Square Clearing. Set each customer's terms here (2/10 net 30 included) and every invoice picks them up."
            action={addButton ?? undefined}
          />
        </Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a customer"
                aria-label="Find a customer"
                className="pl-7"
              />
            </div>
            {addButton}
          </div>
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[52rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Customers</caption>
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Type</Th>
                  <Th>Channel</Th>
                  <Th>Terms</Th>
                  <Th align="right">Open</Th>
                  <Th align="right">Overdue</Th>
                  <Th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/60">
                    <Td>
                      <Link href={`/sales/invoices?customer=${row.id}`} className="font-medium hover:underline">
                        {row.name}
                      </Link>
                      {row.active ? null : (
                        <Badge tone="neutral" size="sm" className="ml-2">
                          Inactive
                        </Badge>
                      )}
                      {row.email ? <span className="block text-2xs text-muted-foreground">{row.email}</span> : null}
                    </Td>
                    <Td className="text-xs text-muted-foreground">{CUSTOMER_TYPE_LABELS[row.customerType]}</Td>
                    <Td className="text-xs">{row.channelName ?? <span className="text-muted-foreground">From type</span>}</Td>
                    <Td className="text-xs whitespace-nowrap">
                      {termsLabel(row.termsDays, row.termsDiscountPct, row.termsDiscountDays)}
                    </Td>
                    <Td align="right">
                      <Money cents={row.openCents} zeroDash />
                      {row.openInvoiceCount > 0 ? (
                        <span className="num block text-2xs text-muted-foreground">{row.openInvoiceCount} open</span>
                      ) : null}
                    </Td>
                    <Td align="right">
                      <Money cents={row.overdueCents} zeroDash className={row.overdueCents > 0 ? "text-negative" : undefined} />
                    </Td>
                    <Td align="right">
                      {canManage ? (
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.name}`} onClick={() => setEditing(row)}>
                          <Pencil />
                        </Button>
                      ) : null}
                    </Td>
                  </tr>
                ))}
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-xs text-muted-foreground">
                      No customer matches &ldquo;{query}&rdquo;.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editing !== null ? (
        <CustomerDialog
          key={editing === "new" ? "new" : editing.id}
          customer={editing === "new" ? null : editing}
          channels={channels}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function CustomerDialog({
  customer,
  channels,
  onClose,
}: {
  customer: CustomerRow | null;
  channels: readonly Option[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [form, setForm] = React.useState<CustomerForm>(() => (customer === null ? blankForm() : formOf(customer)));
  const [creditLimit, setCreditLimit] = React.useState(textOf(customer?.creditLimitCents ?? null));

  const set = <K extends keyof CustomerForm>(key: K, value: CustomerForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const pct = Number(form.termsDiscountPct || "0");
  const discountMismatch = pct > 0 !== form.termsDiscountDays > 0;
  const problem =
    form.name.trim() === ""
      ? "Name the customer."
      : discountMismatch
        ? "An early-payment discount needs both a percentage and days."
        : form.termsDiscountDays > form.termsDays
          ? "The discount window is longer than the net terms."
          : readMoney(creditLimit).error !== null
            ? "The credit limit is not an amount."
            : null;

  const preset = TERM_PRESETS.find(
    (p) => p.net === form.termsDays && Number(p.pct) === pct && p.days === form.termsDiscountDays,
  );

  const submit = () => {
    start(async () => {
      const result = await saveCustomer(customer?.id ?? null, {
        ...form,
        creditLimitCents: readMoney(creditLimit).cents,
      });
      if (!result.ok) {
        toast.error("Customer not saved", { description: result.error.message });
        return;
      }
      toast.success(customer === null ? `${form.name.trim()} added` : `${form.name.trim()} saved`);
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{customer === null ? "New customer" : `Edit ${customer.name}`}</DialogTitle>
          <DialogDescription>
            Terms set here default onto new invoices. Invoices already issued keep the terms they went out on.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required htmlFor="c-name" className="sm:col-span-2">
            <Input id="c-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Blacksmith Coffee" autoFocus />
          </Field>
          <Field label="Type" htmlFor="c-type" hint="sets the default channel">
            <Select value={form.customerType} onValueChange={(v) => set("customerType", v as CustomerType)}>
              <SelectTrigger id="c-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CUSTOMER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {CUSTOMER_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Sales channel" htmlFor="c-channel" hint="where its revenue reports">
            <Select value={form.channelId ?? FROM_TYPE} onValueChange={(v) => set("channelId", v === FROM_TYPE ? null : v)}>
              <SelectTrigger id="c-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FROM_TYPE}>
                  <span className="text-muted-foreground">From the customer type</span>
                </SelectItem>
                {channels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Email" htmlFor="c-email" hint="for sending invoices">
            <Input id="c-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="Phone" htmlFor="c-phone">
            <Input id="c-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </Field>

          <fieldset className="flex flex-col gap-2 rounded-sm border border-border p-3 sm:col-span-2">
            <legend className="eyebrow px-1">Payment terms</legend>
            <div className="flex flex-wrap gap-1.5">
              {TERM_PRESETS.map((p) => (
                <Button
                  key={p.label}
                  type="button"
                  size="sm"
                  variant={preset?.label === p.label ? "default" : "secondary"}
                  onClick={() => setForm((f) => ({ ...f, termsDays: p.net, termsDiscountPct: p.pct, termsDiscountDays: p.days }))}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Net days" htmlFor="c-net">
                <Input id="c-net" numeric inputMode="numeric" value={String(form.termsDays)} onChange={(e) => set("termsDays", Number(e.target.value.replace(/\D/g, "") || "0"))} />
              </Field>
              <Field label="Discount %" htmlFor="c-pct">
                <Input id="c-pct" numeric inputMode="decimal" value={form.termsDiscountPct} onChange={(e) => set("termsDiscountPct", e.target.value.replace(/[^\d.]/g, ""))} />
              </Field>
              <Field label="If paid in" htmlFor="c-ddays" hint="days">
                <Input id="c-ddays" numeric inputMode="numeric" value={String(form.termsDiscountDays)} onChange={(e) => set("termsDiscountDays", Number(e.target.value.replace(/\D/g, "") || "0"))} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              Reads as <span className="font-medium text-foreground">{termsLabel(form.termsDays, form.termsDiscountPct || "0", form.termsDiscountDays)}</span>. Early-payment discounts taken post to 4580.
            </p>
          </fieldset>

          <Field label="Credit limit" htmlFor="c-limit" hint="optional">
            <MoneyInput id="c-limit" value={creditLimit} onValueChange={setCreditLimit} />
          </Field>
          {customer !== null ? (
            <div className="flex items-end gap-2 pb-1.5">
              <Checkbox id="c-active" checked={form.active} onCheckedChange={(c) => set("active", c === true)} />
              <Label htmlFor="c-active">Active</Label>
            </div>
          ) : null}
          <Field label="Notes" htmlFor="c-notes" className="sm:col-span-2">
            <Textarea id="c-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} />
          </Field>
        </DialogBody>
        <DialogFooter>
          {problem ? <span className="mr-auto text-xs text-muted-foreground">{problem}</span> : null}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={pending || problem !== null}>
            {customer === null ? "Add customer" : "Save customer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor} hint={hint} required={required}>
        {label}
      </Label>
      {children}
    </div>
  );
}

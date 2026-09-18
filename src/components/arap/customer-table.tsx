"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { SplitBar } from "@/components/charts";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DetailPane } from "@/components/ui/detail-pane";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { Input } from "@/components/ui/input";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Label } from "@/components/ui/label";
import { Monogram } from "@/components/ui/monogram";
import { Money } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/ui/format";
import { saveCustomer } from "@/app/(app)/sales/actions";

import { Directory } from "./directory";
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

/** Who you invoice: a searchable list beside the chosen customer's card, and the form in a sheet. */
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
  const [selectedId, setSelectedId] = React.useState<string | null>(rows[0]?.id ?? null);
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
  const active = rows.filter((r) => r.active).length;

  const editButton =
    canManage && selected ? <ToolbarButton glyph="pencil" label={`Edit ${selected.name}`} onClick={() => setEditing(selected)} /> : null;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Customers"
        subtitle={rows.length > 0 ? <>{active} active</> : undefined}
        info={
          <p>
            Who you invoice, on what terms, and which sales channel their revenue reports under. Square sales at markets
            don&rsquo;t need a customer; they arrive through Square Clearing. Terms set here default onto new invoices.
          </p>
        }
        actions={
          canManage ? (
            <ToolbarGroup>
              <ToolbarButton glyph="plus" label="New customer" onClick={() => setEditing("new")} />
              {editButton ? <span className="max-lg:hidden">{editButton}</span> : null}
            </ToolbarGroup>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            glyph="people"
            title="No customers yet"
            description="A customer is anyone you invoice: a restaurant buying cases, a shop on net terms, a distributor. Set each customer's terms (2/10 net 30 included) and every invoice picks them up."
            action={canManage ? <Button onClick={() => setEditing("new")}>New customer</Button> : undefined}
          />
        </Card>
      ) : (
        <Directory
          rows={rows}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          noMatch="No match"
          sheetActions={editButton}
          row={(r) => ({
            leading: <Monogram name={r.name} />,
            subtitle: (
              <>
                {r.overdueCents > 0 ? <Dot tint="red" size={7} /> : null}
                <span className="truncate">{termsLabel(r.termsDays, r.termsDiscountPct, r.termsDiscountDays)}</span>
              </>
            ),
            trailing: r.openCents !== 0 ? <Money cents={r.openCents} currency plain /> : undefined,
            detail: r.openInvoiceCount > 0 ? `${r.openInvoiceCount} open` : undefined,
          })}
          detail={selected ? <CustomerDetail customer={selected} canManage={canManage} /> : null}
        />
      )}

      {editing !== null ? (
        <CustomerSheet
          key={editing === "new" ? "new" : editing.id}
          customer={editing === "new" ? null : editing}
          channels={channels}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function CustomerDetail({ customer, canManage }: { customer: CustomerRow; canManage: boolean }) {
  const current = customer.openCents - customer.overdueCents;
  return (
    <DetailPane
      leading={<Monogram name={customer.name} size="lg" />}
      title={customer.name}
      meta={[CUSTOMER_TYPE_LABELS[customer.customerType], ...(customer.channelName ? [customer.channelName] : [])]}
      amount={<Money cents={customer.openCents} currency plain />}
      status={
        customer.overdueCents > 0 ? (
          <Pill tone="red" glyph="flag">
            <Money cents={customer.overdueCents} currency plain /> late
          </Pill>
        ) : !customer.active ? (
          <Pill glyph="exclude">Inactive</Pill>
        ) : customer.openCents === 0 ? (
          <Pill tone="green" glyph="check-circle">
            Nothing owed
          </Pill>
        ) : null
      }
      actions={
        canManage && customer.active ? (
          <>
            <Button asChild>
              <Link href={`/sales/invoices/new?customer=${customer.id}`}>
                <Glyph name="plus" size={15} weight={2} />
                New invoice
              </Link>
            </Button>
            {customer.openCents > 0 ? (
              <Button asChild variant="secondary">
                <Link href={`/sales/receipts/new?customer=${customer.id}`}>Record receipt</Link>
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {customer.openCents > 0 ? (
        <Card className="flex flex-col gap-2 px-5 py-4 max-sm:px-4">
          <SplitBar
            label={`Current ${dollars(current)}, late ${dollars(customer.overdueCents)}`}
            segments={[
              { label: "Current", value: Math.max(0, current), tint: "blue" },
              { label: "Late", value: customer.overdueCents, tint: "red" },
            ]}
          />
          <div aria-hidden className="flex justify-between gap-3 text-xs font-medium text-label2">
            <span className="inline-flex items-center gap-1.5">
              <Dot tint="blue" size={7} />
              Current <Money cents={current} currency plain className="text-label" />
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Dot tint="red" size={7} />
              Late <Money cents={customer.overdueCents} currency plain className="text-label" />
            </span>
          </div>
        </Card>
      ) : null}
      <InsetGroup>
        <GroupRow label="Invoices" href={`/sales/invoices?customer=${customer.id}`}>
          {customer.openInvoiceCount > 0 ? `${customer.openInvoiceCount} open` : "All"}
        </GroupRow>
        <GroupRow label="Terms">{termsLabel(customer.termsDays, customer.termsDiscountPct, customer.termsDiscountDays)}</GroupRow>
        <GroupRow label="Channel">{customer.channelName ?? "From type"}</GroupRow>
        {customer.email ? (
          <GroupRow label="Email">
            <a href={`mailto:${customer.email}`} className="truncate text-ink-blue hover:underline">
              {customer.email}
            </a>
          </GroupRow>
        ) : null}
        {customer.phone ? (
          <GroupRow label="Phone">
            <a href={`tel:${customer.phone}`} className="text-ink-blue hover:underline">
              {customer.phone}
            </a>
          </GroupRow>
        ) : null}
        {customer.creditLimitCents !== null ? (
          <GroupRow label="Credit limit">
            <Money cents={customer.creditLimitCents} currency plain />
          </GroupRow>
        ) : null}
      </InsetGroup>
      {customer.notes ? (
        <InsetGroup header="Notes">
          <p className="px-4 py-3 text-sm whitespace-pre-line">{customer.notes}</p>
        </InsetGroup>
      ) : null}
    </DetailPane>
  );
}

function CustomerSheet({
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
    <Sheet open onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent
        title={customer === null ? "New customer" : `Edit ${customer.name}`}
        description="Terms set here default onto new invoices. Invoices already issued keep the terms they went out on."
      >
        <div className="flex flex-col gap-1">
          <InsetGroup>
            <SheetField label="Name" htmlFor="c-name">
              <Input id="c-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Blacksmith Coffee" autoFocus className="w-56" />
            </SheetField>
            <SheetField label="Type" htmlFor="c-type">
              <Select value={form.customerType} onValueChange={(v) => set("customerType", v as CustomerType)}>
                <SelectTrigger id="c-type" className="w-56">
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
            </SheetField>
            <SheetField label="Channel" htmlFor="c-channel">
              <Select value={form.channelId ?? FROM_TYPE} onValueChange={(v) => set("channelId", v === FROM_TYPE ? null : v)}>
                <SelectTrigger id="c-channel" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FROM_TYPE}>From the type</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SheetField>
            <SheetField label="Email" htmlFor="c-email">
              <Input id="c-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className="w-56" />
            </SheetField>
            <SheetField label="Phone" htmlFor="c-phone">
              <Input id="c-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} className="w-56" />
            </SheetField>
          </InsetGroup>

          <InsetGroup header="Terms" footer={<>Reads as {termsLabel(form.termsDays, form.termsDiscountPct || "0", form.termsDiscountDays)}. Discounts taken post to 4580.</>}>
            <div role="group" aria-label="Common terms" className="flex flex-wrap gap-1.5 px-4 py-3">
              {TERM_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  aria-pressed={preset?.label === p.label}
                  onClick={() => setForm((f) => ({ ...f, termsDays: p.net, termsDiscountPct: p.pct, termsDiscountDays: p.days }))}
                  className={cn(
                    "h-7 rounded-full px-3 text-xs font-semibold transition-colors max-sm:h-9 max-sm:text-sm",
                    preset?.label === p.label ? "bg-accent-fill text-white" : "bg-fill2 text-label hover:bg-fill",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <SheetField label="Net days" htmlFor="c-net">
              <Input
                id="c-net"
                numeric
                inputMode="numeric"
                className="w-24"
                value={String(form.termsDays)}
                onChange={(e) => set("termsDays", Number(e.target.value.replace(/\D/g, "") || "0"))}
              />
            </SheetField>
            <SheetField label="Discount %" htmlFor="c-pct">
              <Input
                id="c-pct"
                numeric
                inputMode="decimal"
                className="w-24"
                value={form.termsDiscountPct}
                onChange={(e) => set("termsDiscountPct", e.target.value.replace(/[^\d.]/g, ""))}
              />
            </SheetField>
            <SheetField label="If paid in" htmlFor="c-ddays">
              <Input
                id="c-ddays"
                numeric
                inputMode="numeric"
                className="w-24"
                value={String(form.termsDiscountDays)}
                onChange={(e) => set("termsDiscountDays", Number(e.target.value.replace(/\D/g, "") || "0"))}
              />
            </SheetField>
          </InsetGroup>

          <InsetGroup>
            <SheetField label="Credit limit" htmlFor="c-limit">
              <MoneyInput id="c-limit" className="w-32" value={creditLimit} onValueChange={setCreditLimit} placeholder="None" />
            </SheetField>
            {customer !== null ? (
              <SheetField label="Active" htmlFor="c-active">
                <Checkbox id="c-active" checked={form.active} onCheckedChange={(c) => set("active", c === true)} />
              </SheetField>
            ) : null}
          </InsetGroup>

          <InsetGroup header={<Label htmlFor="c-notes">Notes</Label>}>
            <Textarea
              id="c-notes"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
              className="rounded-none border-0 bg-transparent shadow-none focus-visible:shadow-[inset_0_0_0_2px_var(--blue)]"
            />
          </InsetGroup>

          <SheetFooter problem={problem} pending={pending} onCancel={onClose} onSubmit={submit} submitLabel={customer === null ? "Add customer" : "Save customer"} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A labelled field in a sheet, System Settings style: label left, control right. */
export function SheetField({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <GroupRow label={label} htmlFor={htmlFor} className="[&>span:last-child]:text-label">
      {children}
    </GroupRow>
  );
}

/** The sheet's closing row: a short reason the button is off, Cancel, and the one blue button. */
export function SheetFooter({
  problem,
  pending,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  problem: string | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-5">
      {problem ? <span className="mr-auto text-xs font-medium text-label2">{problem}</span> : null}
      <Button variant="secondary" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
      <Button onClick={onSubmit} disabled={pending || problem !== null}>
        {submitLabel}
      </Button>
    </div>
  );
}

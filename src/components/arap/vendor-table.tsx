"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Search, Truck } from "lucide-react";

import { AccountCombobox } from "@/components/ledger/account-combobox";
import type { AccountOption } from "@/components/ledger/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cn } from "@/lib/cn";
import { saveVendor } from "@/app/(app)/purchases/actions";

import { Field } from "./customer-table";
import { Td, Th } from "./doc-status";
import { termsLabel } from "./math";
import { VENDOR_TYPES, VENDOR_TYPE_LABELS, type VendorForm, type VendorRow, type VendorType } from "./types";

type View = "all" | "1099" | "needs_w9";

function blankForm(): VendorForm {
  return {
    name: "",
    displayName: "",
    vendorType: "ingredients",
    email: "",
    phone: "",
    termsDays: 30,
    defaultExpenseAccountId: null,
    is1099: false,
    w9OnFile: false,
    w9ReceivedAt: null,
    taxIdLast4: "",
    legalName: "",
    notes: "",
    active: true,
  };
}

function formOf(row: VendorRow): VendorForm {
  return {
    name: row.name,
    displayName: row.displayName ?? "",
    vendorType: row.vendorType,
    email: row.email ?? "",
    phone: row.phone ?? "",
    termsDays: row.termsDays,
    defaultExpenseAccountId: row.defaultExpenseAccountId,
    is1099: row.is1099,
    w9OnFile: row.w9OnFile,
    w9ReceivedAt: row.w9ReceivedAt,
    taxIdLast4: row.taxIdLast4 ?? "",
    legalName: row.legalName ?? "",
    notes: row.notes ?? "",
    active: row.active,
  };
}

function W9Status({ row }: { row: VendorRow }) {
  if (row.w9OnFile) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge tone="positive" size="sm">
          On file
        </Badge>
        {row.w9ReceivedAt ? <span className="num text-2xs text-muted-foreground">{row.w9ReceivedAt}</span> : null}
      </span>
    );
  }
  if (row.is1099) {
    return (
      <Badge tone="warning" size="sm">
        Request W-9
      </Badge>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

export function VendorTable({
  rows,
  accounts,
  canManage,
  openNew,
}: {
  rows: readonly VendorRow[];
  accounts: readonly AccountOption[];
  canManage: boolean;
  openNew: boolean;
}) {
  const [editing, setEditing] = React.useState<VendorRow | "new" | null>(openNew && canManage ? "new" : null);
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<View>("all");

  const counts = {
    all: rows.length,
    "1099": rows.filter((r) => r.is1099).length,
    needs_w9: rows.filter((r) => r.is1099 && !r.w9OnFile).length,
  };
  const shown = rows.filter(
    (row) =>
      row.name.toLowerCase().includes(query.trim().toLowerCase()) &&
      (view === "all" || (view === "1099" ? row.is1099 : row.is1099 && !row.w9OnFile)),
  );

  const addButton = canManage ? (
    <Button size="sm" onClick={() => setEditing("new")}>
      <Plus />
      New vendor
    </Button>
  ) : null;

  return (
    <>
      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Truck />}
            title="No vendors yet"
            description="Vendors are who you buy from. Each carries a default account, so bills and bank lines land in the right place, and a 1099 flag for contractors."
            action={addButton ?? undefined}
          />
        </Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full max-w-xs sm:w-60">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a vendor"
                  aria-label="Find a vendor"
                  className="pl-7"
                />
              </div>
              <div className="flex items-center gap-1" role="group" aria-label="Show">
                {(
                  [
                    ["all", "All"],
                    ["1099", "1099"],
                    ["needs_w9", "Needs W-9"],
                  ] as const
                ).map(([key, label]) => (
                  <Button
                    key={key}
                    size="sm"
                    variant={view === key ? "default" : "ghost"}
                    aria-pressed={view === key}
                    onClick={() => setView(key)}
                  >
                    {label}
                    <span className="num text-2xs opacity-70">{counts[key]}</span>
                  </Button>
                ))}
              </div>
            </div>
            {addButton}
          </div>
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[56rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Vendors</caption>
              <thead>
                <tr>
                  <Th>Vendor</Th>
                  <Th>Type</Th>
                  <Th>Usually posts to</Th>
                  <Th>Terms</Th>
                  <Th align="center">1099</Th>
                  <Th>W-9</Th>
                  <Th align="right">Open bills</Th>
                  <Th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id} className={cn("hover:bg-muted/60", !row.active && "opacity-60")}>
                    <Td>
                      <Link href={`/purchases/bills?vendor=${row.id}`} className="font-medium hover:underline">
                        {row.name}
                      </Link>
                      {row.active ? null : (
                        <Badge tone="neutral" size="sm" className="ml-2">
                          Inactive
                        </Badge>
                      )}
                      {row.legalName ? <span className="block text-2xs text-muted-foreground">{row.legalName}</span> : null}
                    </Td>
                    <Td className="text-xs text-muted-foreground">{VENDOR_TYPE_LABELS[row.vendorType]}</Td>
                    <Td className="text-xs">
                      {row.defaultAccountLabel ?? <span className="text-muted-foreground">No default</span>}
                    </Td>
                    <Td className="text-xs whitespace-nowrap">{termsLabel(row.termsDays)}</Td>
                    <Td align="center">
                      {row.is1099 ? (
                        <Badge tone="primary" size="sm">
                          1099
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td className="text-xs">
                      <W9Status row={row} />
                    </Td>
                    <Td align="right">
                      <Money cents={row.openCents} zeroDash />
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
                    <td colSpan={8} className="px-3 py-8 text-center text-xs text-muted-foreground">
                      {view === "needs_w9"
                        ? "Every 1099 vendor has a W-9 on file."
                        : view === "1099"
                          ? "No vendor is flagged for 1099 yet. Flag contractors and professionals you pay by bank transfer or check."
                          : `No vendor matches “${query}”.`}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editing !== null ? (
        <VendorDialog
          key={editing === "new" ? "new" : editing.id}
          vendor={editing === "new" ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function VendorDialog({
  vendor,
  accounts,
  onClose,
}: {
  vendor: VendorRow | null;
  accounts: readonly AccountOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [form, setForm] = React.useState<VendorForm>(() => (vendor === null ? blankForm() : formOf(vendor)));
  const set = <K extends keyof VendorForm>(key: K, value: VendorForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const problem =
    form.name.trim() === ""
      ? "Name the vendor."
      : form.taxIdLast4 !== "" && !/^\d{4}$/.test(form.taxIdLast4)
        ? "Only the last four digits of the tax id are kept."
        : null;

  const submit = () => {
    start(async () => {
      const result = await saveVendor(vendor?.id ?? null, form);
      if (!result.ok) {
        toast.error("Vendor not saved", { description: result.error.message });
        return;
      }
      toast.success(vendor === null ? `${form.name.trim()} added` : `${form.name.trim()} saved`);
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{vendor === null ? "New vendor" : `Edit ${vendor.name}`}</DialogTitle>
          <DialogDescription>
            The default account is where this vendor&rsquo;s bills and bank lines land unless you say otherwise.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required htmlFor="v-name" className="sm:col-span-2">
            <Input id="v-name" value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus />
          </Field>
          <Field label="Type" htmlFor="v-type">
            <Select value={form.vendorType} onValueChange={(v) => set("vendorType", v as VendorType)}>
              <SelectTrigger id="v-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VENDOR_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {VENDOR_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Terms" htmlFor="v-terms" hint="net days">
            <Input
              id="v-terms"
              numeric
              inputMode="numeric"
              value={String(form.termsDays)}
              onChange={(e) => set("termsDays", Number(e.target.value.replace(/\D/g, "") || "0"))}
            />
          </Field>
          <Field label="Default account" htmlFor="v-account" className="sm:col-span-2" hint="ingredients → 1320, packaging → 1330">
            <AccountCombobox
              id="v-account"
              accounts={accounts}
              value={form.defaultExpenseAccountId}
              onChange={(id) => set("defaultExpenseAccountId", id)}
              placeholder="Choose an account"
              className="h-8"
            />
          </Field>
          <Field label="Email" htmlFor="v-email">
            <Input id="v-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="Phone" htmlFor="v-phone">
            <Input id="v-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </Field>

          <fieldset className="grid gap-3 rounded-sm border border-border p-3 sm:col-span-2 sm:grid-cols-2">
            <legend className="eyebrow px-1">1099 and W-9</legend>
            <div className="flex items-start gap-2 sm:col-span-2">
              <Checkbox id="v-1099" checked={form.is1099} onCheckedChange={(c) => set("is1099", c === true)} className="mt-0.5" />
              <div>
                <Label htmlFor="v-1099">Report on a 1099-NEC</Label>
                <p className="text-xs text-muted-foreground">
                  For individuals and LLCs you pay for services by bank transfer or check. Card payments are never counted.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="v-w9"
                checked={form.w9OnFile}
                onCheckedChange={(c) => setForm((f) => ({ ...f, w9OnFile: c === true, w9ReceivedAt: c === true ? f.w9ReceivedAt : null }))}
              />
              <Label htmlFor="v-w9">W-9 on file</Label>
            </div>
            <Field label="Received" htmlFor="v-w9-date">
              <DateInput
                id="v-w9-date"
                value={form.w9ReceivedAt ?? ""}
                disabled={!form.w9OnFile}
                onValueChange={(v) => set("w9ReceivedAt", v === "" ? null : v)}
              />
            </Field>
            <Field label="Legal name" htmlFor="v-legal" hint="as on the W-9">
              <Input id="v-legal" value={form.legalName} onChange={(e) => set("legalName", e.target.value)} />
            </Field>
            <Field label="Tax id, last four" htmlFor="v-tin" hint="never the full number">
              <Input
                id="v-tin"
                numeric
                inputMode="numeric"
                maxLength={4}
                value={form.taxIdLast4}
                invalid={form.taxIdLast4 !== "" && !/^\d{4}$/.test(form.taxIdLast4)}
                onChange={(e) => set("taxIdLast4", e.target.value.replace(/\D/g, "").slice(0, 4))}
              />
            </Field>
          </fieldset>

          {vendor !== null ? (
            <div className="flex items-center gap-2">
              <Checkbox id="v-active" checked={form.active} onCheckedChange={(c) => set("active", c === true)} />
              <Label htmlFor="v-active">Active</Label>
            </div>
          ) : null}
          <Field label="Notes" htmlFor="v-notes" className="sm:col-span-2">
            <Textarea id="v-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} />
          </Field>
        </DialogBody>
        <DialogFooter>
          {problem ? <span className="mr-auto text-xs text-muted-foreground">{problem}</span> : null}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={pending || problem !== null}>
            {vendor === null ? "Add vendor" : "Save vendor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

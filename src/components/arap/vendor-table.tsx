"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { AccountCombobox } from "@/components/ledger/account-combobox";
import type { AccountOption } from "@/components/ledger/types";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
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
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { categoryForCode } from "@/lib/ui/categories";
import { mediumDate } from "@/lib/ui/format";
import { saveVendor } from "@/app/(app)/purchases/actions";

import { SheetField, SheetFooter } from "./customer-table";
import { Directory } from "./directory";
import { splitAccountLabel } from "./flows";
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

/** The vendor's usual account as a category: its colour, and the account's own name. */
function usual(row: VendorRow): { tint: ReturnType<typeof categoryForCode>["tint"]; name: string } | null {
  if (row.defaultAccountLabel === null) return null;
  const { code, name } = splitAccountLabel(row.defaultAccountLabel);
  return { tint: categoryForCode(code).tint, name };
}

/** Who Sooz buys from: a searchable list beside the chosen vendor's card, and the form in a sheet. */
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
  const [view, setView] = React.useState<View>("all");
  const [selectedId, setSelectedId] = React.useState<string | null>(rows[0]?.id ?? null);
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  const counts = {
    all: rows.length,
    "1099": rows.filter((r) => r.is1099).length,
    needs_w9: rows.filter((r) => r.is1099 && !r.w9OnFile).length,
  };
  const editButton =
    canManage && selected ? <ToolbarButton glyph="pencil" label={`Edit ${selected.name}`} onClick={() => setEditing(selected)} /> : null;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Vendors"
        subtitle={
          rows.length > 0 ? (
            <>
              {rows.filter((r) => r.active).length} active · {counts["1099"]} on 1099
            </>
          ) : undefined
        }
        info={
          <p>
            Who Sooz buys from, where their spending usually lands, and who needs a 1099. The bank review matches
            statement lines to these vendors, and a vendor&rsquo;s usual account is where its bills and bank lines land
            unless you say otherwise.
          </p>
        }
        actions={
          canManage ? (
            <ToolbarGroup>
              <ToolbarButton glyph="plus" label="New vendor" onClick={() => setEditing("new")} />
              {editButton ? <span className="max-lg:hidden">{editButton}</span> : null}
            </ToolbarGroup>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            glyph="people"
            title="No vendors yet"
            description="Vendors are who you buy from. Each carries a usual account, so bills and bank lines land in the right place, and a 1099 flag for contractors."
            action={canManage ? <Button onClick={() => setEditing("new")}>New vendor</Button> : undefined}
          />
        </Card>
      ) : (
        <Directory
          rows={rows}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          filter={(r) => view === "all" || (view === "1099" ? r.is1099 : r.is1099 && !r.w9OnFile)}
          noMatch={view === "needs_w9" ? "Every W-9 is on file" : view === "1099" ? "Nobody flagged" : "No match"}
          sheetActions={editButton}
          above={
            <SegmentedControl
              aria-label="Show"
              fill
              value={view}
              onValueChange={(v) => setView(v as View)}
              options={[
                { value: "all", label: "All" },
                { value: "1099", label: counts["1099"] > 0 ? `1099 ${counts["1099"]}` : "1099" },
                { value: "needs_w9", label: counts.needs_w9 > 0 ? `No W-9 ${counts.needs_w9}` : "No W-9" },
              ]}
            />
          }
          row={(r) => {
            const u = usual(r);
            return {
              leading: <Monogram name={r.name} />,
              subtitle: (
                <>
                  {u ? <Dot tint={u.tint} size={7} /> : null}
                  <span className="truncate">{u ? u.name : VENDOR_TYPE_LABELS[r.vendorType]}</span>
                  {r.is1099 ? (
                    <span className={r.w9OnFile ? "shrink-0" : "shrink-0 text-ink-orange"}>
                      · 1099{r.w9OnFile ? "" : " · no W-9"}
                    </span>
                  ) : null}
                </>
              ),
              trailing: r.openCents !== 0 ? <Money cents={r.openCents} currency plain /> : undefined,
              detail: r.openBillCount > 0 ? `${r.openBillCount} open` : undefined,
            };
          }}
          detail={selected ? <VendorDetail vendor={selected} canManage={canManage} /> : null}
        />
      )}

      {editing !== null ? (
        <VendorSheet
          key={editing === "new" ? "new" : editing.id}
          vendor={editing === "new" ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function VendorDetail({ vendor, canManage }: { vendor: VendorRow; canManage: boolean }) {
  const u = usual(vendor);
  return (
    <DetailPane
      leading={<Monogram name={vendor.name} size="lg" />}
      title={vendor.name}
      meta={[VENDOR_TYPE_LABELS[vendor.vendorType], ...(vendor.legalName ? [vendor.legalName] : [])]}
      amount={vendor.openCents !== 0 ? <Money cents={vendor.openCents} currency plain /> : undefined}
      status={
        vendor.is1099 || !vendor.active ? (
          <div className="flex flex-wrap gap-1.5">
            {!vendor.active ? <Pill glyph="exclude">Inactive</Pill> : null}
            {vendor.is1099 ? (
              <Pill tone="purple" glyph="doc-text">
                1099
              </Pill>
            ) : null}
            {vendor.is1099 ? (
              vendor.w9OnFile ? (
                <Pill tone="green" glyph="check-circle">
                  W-9 on file
                </Pill>
              ) : (
                <Pill tone="orange" glyph="warning">
                  Request W-9
                </Pill>
              )
            ) : null}
          </div>
        ) : null
      }
      actions={
        canManage && vendor.active ? (
          <>
            <Button asChild>
              <Link href={`/purchases/bills/new?vendor=${vendor.id}`}>
                <Glyph name="plus" size={15} weight={2} />
                New bill
              </Link>
            </Button>
            {vendor.openCents > 0 ? (
              <Button asChild variant="secondary">
                <Link href={`/purchases/payments/new?vendor=${vendor.id}`}>Pay bills</Link>
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <InsetGroup>
        <GroupRow label="Bills" href={`/purchases/bills?vendor=${vendor.id}`}>
          {vendor.openBillCount > 0 ? `${vendor.openBillCount} open` : "All"}
        </GroupRow>
        <GroupRow label="Usually">
          {u ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Dot tint={u.tint} size={7} />
              <span className="truncate">{u.name}</span>
            </span>
          ) : (
            "None"
          )}
        </GroupRow>
        <GroupRow label="Terms">{termsLabel(vendor.termsDays)}</GroupRow>
        {vendor.email ? (
          <GroupRow label="Email">
            <a href={`mailto:${vendor.email}`} className="truncate text-ink-blue hover:underline">
              {vendor.email}
            </a>
          </GroupRow>
        ) : null}
        {vendor.phone ? (
          <GroupRow label="Phone">
            <a href={`tel:${vendor.phone}`} className="text-ink-blue hover:underline">
              {vendor.phone}
            </a>
          </GroupRow>
        ) : null}
      </InsetGroup>
      {vendor.is1099 ? (
        <InsetGroup header="Tax">
          <GroupRow label="Tax id">{vendor.taxIdLast4 ? <span className="num">••{vendor.taxIdLast4}</span> : "None"}</GroupRow>
          <GroupRow label="W-9">{vendor.w9ReceivedAt ? mediumDate(vendor.w9ReceivedAt) : vendor.w9OnFile ? "On file" : "Missing"}</GroupRow>
          <GroupRow label="1099 report" href="/purchases/1099">
            Open
          </GroupRow>
        </InsetGroup>
      ) : null}
      {vendor.notes ? (
        <InsetGroup header="Notes">
          <p className="px-4 py-3 text-sm whitespace-pre-line">{vendor.notes}</p>
        </InsetGroup>
      ) : null}
    </DetailPane>
  );
}

function VendorSheet({
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
    <Sheet open onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent
        title={vendor === null ? "New vendor" : `Edit ${vendor.name}`}
        description="The usual account is where this vendor's bills and bank lines land unless you say otherwise."
      >
        <div className="flex flex-col gap-1">
          <InsetGroup>
            <SheetField label="Name" htmlFor="v-name">
              <Input id="v-name" value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus className="w-56" />
            </SheetField>
            <SheetField label="Type" htmlFor="v-type">
              <Select value={form.vendorType} onValueChange={(v) => set("vendorType", v as VendorType)}>
                <SelectTrigger id="v-type" className="w-56">
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
            </SheetField>
            <SheetField label="Usual account" htmlFor="v-account">
              <div className="w-56">
                <AccountCombobox
                  id="v-account"
                  accounts={accounts}
                  value={form.defaultExpenseAccountId}
                  onChange={(id) => set("defaultExpenseAccountId", id)}
                  placeholder="Choose"
                  className="h-8"
                />
              </div>
            </SheetField>
            <SheetField label="Net days" htmlFor="v-terms">
              <Input
                id="v-terms"
                numeric
                inputMode="numeric"
                className="w-24"
                value={String(form.termsDays)}
                onChange={(e) => set("termsDays", Number(e.target.value.replace(/\D/g, "") || "0"))}
              />
            </SheetField>
            <SheetField label="Email" htmlFor="v-email">
              <Input id="v-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className="w-56" />
            </SheetField>
            <SheetField label="Phone" htmlFor="v-phone">
              <Input id="v-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} className="w-56" />
            </SheetField>
          </InsetGroup>

          <InsetGroup header="1099" footer="Individuals and LLCs paid for services by bank transfer or check. Card payments never count.">
            <SheetField label="Report on 1099-NEC" htmlFor="v-1099">
              <Checkbox id="v-1099" checked={form.is1099} onCheckedChange={(c) => set("is1099", c === true)} />
            </SheetField>
            <SheetField label="W-9 on file" htmlFor="v-w9">
              <Checkbox
                id="v-w9"
                checked={form.w9OnFile}
                onCheckedChange={(c) => setForm((f) => ({ ...f, w9OnFile: c === true, w9ReceivedAt: c === true ? f.w9ReceivedAt : null }))}
              />
            </SheetField>
            <SheetField label="Received" htmlFor="v-w9-date">
              <DateInput
                id="v-w9-date"
                value={form.w9ReceivedAt ?? ""}
                disabled={!form.w9OnFile}
                onValueChange={(v) => set("w9ReceivedAt", v === "" ? null : v)}
              />
            </SheetField>
            <SheetField label="Legal name" htmlFor="v-legal">
              <Input id="v-legal" value={form.legalName} placeholder="As on the W-9" onChange={(e) => set("legalName", e.target.value)} className="w-56" />
            </SheetField>
            <SheetField label="Tax id" htmlFor="v-tin">
              <Input
                id="v-tin"
                numeric
                inputMode="numeric"
                maxLength={4}
                placeholder="Last four"
                className="w-28"
                value={form.taxIdLast4}
                invalid={form.taxIdLast4 !== "" && !/^\d{4}$/.test(form.taxIdLast4)}
                onChange={(e) => set("taxIdLast4", e.target.value.replace(/\D/g, "").slice(0, 4))}
              />
            </SheetField>
          </InsetGroup>

          {vendor !== null ? (
            <InsetGroup>
              <SheetField label="Active" htmlFor="v-active">
                <Checkbox id="v-active" checked={form.active} onCheckedChange={(c) => set("active", c === true)} />
              </SheetField>
            </InsetGroup>
          ) : null}

          <InsetGroup header={<Label htmlFor="v-notes">Notes</Label>}>
            <Textarea
              id="v-notes"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
              className="rounded-none border-0 bg-transparent shadow-none focus-visible:shadow-[inset_0_0_0_2px_var(--blue)]"
            />
          </InsetGroup>

          <SheetFooter problem={problem} pending={pending} onCancel={onClose} onSubmit={submit} submitLabel={vendor === null ? "Add vendor" : "Save vendor"} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

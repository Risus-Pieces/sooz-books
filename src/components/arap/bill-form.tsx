"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { FlowDiagram, SplitBar, type FlowTarget } from "@/components/charts";
import { AccountCombobox } from "@/components/ledger/account-combobox";
import { PageToolbar } from "@/components/shell/page-toolbar";
import type { AccountOption } from "@/components/ledger/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import { Glyph } from "@/components/ui/glyph";
import { Dot } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { GroupRow, InsetGroup } from "@/components/ui/inset-group";
import { Kbd } from "@/components/ui/keycap";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { addDays, isCalendarDate } from "@/lib/dates";
import { CATEGORIES, categoryForCode } from "@/lib/ui/categories";
import { dollars } from "@/lib/ui/format";
import { saveBill } from "@/app/(app)/purchases/actions";

import { extendCents, readMoney, scaledQuantity, termsLabel } from "./math";
import { MoneyInput, centsOf, textOf } from "./money-input";
import { PartyCombobox } from "./party-combobox";
import { FormSection, Grid, GridFigure, GridRowNo, GridTd, GridTh, TotalRow, Totals, cellField, stackRow } from "./sheet-grid";
import type { BillForm, VendorPick } from "./types";

interface LineState {
  key: string;
  description: string;
  accountId: string | null;
  capitalize: boolean;
  quantity: string;
  unitCost: string;
  amount: string;
}

let sequence = 0;
function blankLine(accountId: string | null, capitalize: boolean): LineState {
  sequence += 1;
  return { key: `b${sequence}`, description: "", accountId, capitalize, quantity: "", unitCost: "", amount: "" };
}

function isBlank(line: LineState): boolean {
  return line.description.trim() === "" && line.amount.trim() === "" && line.unitCost.trim() === "";
}

/** Quantity × unit cost when both are given; otherwise the typed amount. */
function lineAmount(line: LineState): number | null {
  if (line.quantity.trim() !== "" && line.unitCost.trim() !== "") {
    return extendCents(line.quantity, centsOf(line.unitCost));
  }
  const parsed = readMoney(line.amount, { allowNegative: true });
  return parsed.error === null ? parsed.cents : null;
}

export interface BillFormProps {
  billId: string | null;
  vendors: readonly VendorPick[];
  /** Postable accounts a bill line can land on: expenses, COGS, inventory, prepaid, fixed assets. */
  accounts: readonly AccountOption[];
  initial: BillForm;
  dueDateOverridden: boolean;
  canManage: boolean;
  /** Whether this person may also approve — approval posts the bill to payables. */
  canApprove: boolean;
  /** The page's toolbar: the form draws it, so Save and Approve sit in it. */
  toolbar: { title: string; back: { href: string; label: string }; info?: React.ReactNode; subtitle?: React.ReactNode };
}

/**
 * Entering a vendor's bill. Each line says what was bought and where it lands;
 * a line marked Capitalize goes to an inventory account (1320 Raw Ingredients,
 * 1330 Packaging …) and sits on the balance sheet until production relieves it,
 * which is the owner's rule for ingredients and packaging. Everything else
 * expenses. Saving keeps a draft; approving posts it to Accounts Payable.
 */
export function BillFormView({
  billId,
  vendors,
  accounts,
  initial,
  dueDateOverridden,
  canManage,
  canApprove,
  toolbar,
}: BillFormProps) {
  const router = useRouter();
  const [pending, start] = React.useTransition();

  const byId = React.useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const isInventoryAccount = React.useCallback(
    (id: string | null) => id !== null && byId.get(id)?.subtype === "inventory",
    [byId],
  );
  const inventoryAccounts = React.useMemo(() => accounts.filter((a) => a.subtype === "inventory"), [accounts]);
  const otherAccounts = React.useMemo(() => accounts.filter((a) => a.subtype !== "inventory"), [accounts]);

  const [vendorId, setVendorId] = React.useState<string | null>(initial.vendorId || null);
  const [billNo, setBillNo] = React.useState(initial.billNo);
  const [billDate, setBillDate] = React.useState(initial.billDate);
  const [dueDate, setDueDate] = React.useState(initial.dueDate ?? "");
  const [dueTouched, setDueTouched] = React.useState(dueDateOverridden);
  const [poNumber, setPoNumber] = React.useState(initial.poNumber);
  const [memo, setMemo] = React.useState(initial.memo);

  const vendor = vendors.find((v) => v.id === vendorId) ?? null;
  const vendorDefault = vendor?.defaultExpenseAccountId ?? null;

  const [lines, setLines] = React.useState<LineState[]>(() =>
    initial.lines.length === 0
      ? [blankLine(null, false)]
      : initial.lines.map((line) => ({
          ...blankLine(line.accountId, line.isInventory || isInventoryAccount(line.accountId)),
          description: line.description,
          quantity: line.quantity,
          unitCost: line.unitCostCents === null ? "" : textOf(line.unitCostCents),
          amount: line.quantity.trim() !== "" && line.unitCostCents !== null ? "" : textOf(line.amountCents),
        })),
  );

  // A new vendor re-seeds lines that have not been given an account yet with its default.
  const pickVendor = (id: string) => {
    setVendorId(id);
    const next = vendors.find((v) => v.id === id);
    const fallback = next?.defaultExpenseAccountId ?? null;
    setLines((current) =>
      current.map((line) =>
        line.accountId === null || isBlank(line)
          ? { ...line, accountId: fallback, capitalize: isInventoryAccount(fallback) }
          : line,
      ),
    );
  };

  const effectiveDue =
    dueTouched || vendor === null || !isCalendarDate(billDate) ? dueDate : addDays(billDate, vendor.termsDays);

  const filled = lines.filter((line) => !isBlank(line));
  const total = filled.reduce((sum, line) => sum + (lineAmount(line) ?? 0), 0);
  const capitalized = filled.filter((l) => l.capitalize).reduce((sum, line) => sum + (lineAmount(line) ?? 0), 0);

  const lineErrors = new Map<string, string>();
  for (const line of filled) {
    const amount = lineAmount(line);
    if (line.description.trim() === "") lineErrors.set(line.key, "Describe what was bought.");
    else if (line.accountId === null)
      lineErrors.set(line.key, line.capitalize ? "Choose the inventory account it capitalizes to." : "Choose an account.");
    else if (line.quantity.trim() !== "" && scaledQuantity(line.quantity) === null)
      lineErrors.set(line.key, "Quantity must be a number with at most four decimals.");
    else if (amount === null || amount === 0) lineErrors.set(line.key, "Enter an amount, or a quantity and a unit cost.");
  }

  const problem = !canManage
    ? "Your role may not enter bills."
    : vendor === null
      ? "Choose the vendor."
      : billNo.trim() === ""
        ? "Enter the vendor's invoice number."
        : !isCalendarDate(billDate)
          ? "Enter the bill date."
          : effectiveDue !== "" && effectiveDue < billDate
            ? "The due date is before the bill date."
            : filled.length === 0
              ? "Add at least one line."
              : lineErrors.size > 0
                ? "Fix the lines marked in red."
                : total <= 0
                  ? "A bill must total more than zero."
                  : null;

  const patch = (key: string, change: Partial<LineState>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...change } : line)));

  const addAfter = (key: string | null) =>
    setLines((current) => {
      const index = key === null ? -1 : current.findIndex((line) => line.key === key);
      const next = [...current];
      next.splice(index === -1 ? next.length : index + 1, 0, blankLine(vendorDefault, isInventoryAccount(vendorDefault)));
      return next;
    });

  const submit = (intent: "draft" | "approve") => {
    if (vendor === null) return;
    const form: BillForm = {
      vendorId: vendor.id,
      billNo,
      billDate,
      dueDate: dueTouched && effectiveDue !== "" ? effectiveDue : null,
      poNumber,
      memo,
      lines: filled.map((line) => ({
        description: line.description,
        accountId: line.accountId,
        quantity: line.quantity.trim(),
        unitCostCents: line.unitCost.trim() === "" ? null : centsOf(line.unitCost),
        amountCents: lineAmount(line) ?? 0,
        isInventory: line.capitalize,
      })),
    };
    start(async () => {
      const result = await saveBill(billId, form, intent);
      if (!result.ok) {
        toast.error(intent === "approve" ? "Bill not approved" : "Draft not saved", { description: result.error.message });
        return;
      }
      toast.success(intent === "approve" ? `Bill ${result.value.docNo} approved` : `Bill ${result.value.docNo} saved as a draft`);
      router.push(`/purchases/bills/${result.value.id}`);
    });
  };

  const saveDisabled = pending || !canManage || vendor === null || filled.length === 0;
  const approveDisabled = pending || problem !== null || !canApprove;
  const buttons = (phone: boolean) => (
    <>
      <Button type="button" variant="secondary" className={phone ? "flex-1" : undefined} disabled={saveDisabled} onClick={() => submit("draft")}>
        Save draft
      </Button>
      <Button
        type="button"
        className={phone ? "flex-1" : undefined}
        disabled={approveDisabled}
        title={canApprove ? undefined : "Your role may save drafts but not approve them."}
        onClick={() => submit("approve")}
      >
        <Glyph name="check" size={15} weight={2.2} />
        Approve bill
      </Button>
    </>
  );

  // What approving posts: payables into each line's account, one arrow per account.
  const targets = new Map<string, FlowTarget>();
  for (const line of filled) {
    const account = line.accountId === null ? undefined : byId.get(line.accountId);
    const cents = lineAmount(line) ?? 0;
    if (account === undefined || cents <= 0) continue;
    const existing = targets.get(account.id);
    if (existing) existing.cents += cents;
    else {
      const category = categoryForCode(account.code);
      targets.set(account.id, { label: account.name, glyph: category.glyph, tint: category.tint, cents });
    }
  }

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={toolbar.title}
        subtitle={toolbar.subtitle}
        back={toolbar.back}
        info={toolbar.info}
        phoneTitleRow
        actions={<div className="flex items-center gap-2 max-md:hidden">{buttons(false)}</div>}
      />

      <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-2">
        <InsetGroup>
          <GroupRow label="Vendor" htmlFor="bill-vendor">
            <div className="flex w-64 flex-col items-end gap-1 max-sm:w-48">
              <PartyCombobox
                id="bill-vendor"
                options={vendors.map((v) => ({ id: v.id, name: v.name, note: v.is1099 ? "1099" : undefined }))}
                value={vendorId}
                onChange={pickVendor}
                placeholder="Choose"
                emptyText="No vendor by that name."
                disabled={pending}
              />
              <Link href="/purchases/vendors?new=1" className="text-xs font-medium text-ink-blue hover:underline">
                Add vendor
              </Link>
            </div>
          </GroupRow>
          <GroupRow label="Their number" htmlFor="bill-no">
            <Input id="bill-no" className="w-64 max-sm:w-48" value={billNo} placeholder="Required" onChange={(e) => setBillNo(e.target.value)} disabled={pending} />
          </GroupRow>
          <GroupRow label="Our PO" htmlFor="bill-po">
            <Input id="bill-po" className="w-64 max-sm:w-48" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} disabled={pending} />
          </GroupRow>
          <GroupRow label="Memo" htmlFor="bill-memo">
            <Input
              id="bill-memo"
              className="w-64 max-sm:w-48"
              value={memo}
              placeholder="Pilot batch, lot 26-09"
              onChange={(e) => setMemo(e.target.value)}
              disabled={pending}
            />
          </GroupRow>
        </InsetGroup>

        <InsetGroup>
          <GroupRow label="Date" htmlFor="bill-date">
            <DateInput id="bill-date" value={billDate} onValueChange={setBillDate} disabled={pending} />
          </GroupRow>
          <GroupRow label="Due" htmlFor="bill-due">
            <span className="text-xs text-label2 max-sm:hidden">{dueTouched ? "Set by hand" : "From terms"}</span>
            <DateInput
              id="bill-due"
              value={effectiveDue}
              onValueChange={(value) => {
                setDueTouched(true);
                setDueDate(value);
              }}
              disabled={pending}
            />
          </GroupRow>
          <GroupRow label="Terms">{vendor ? termsLabel(vendor.termsDays) : "—"}</GroupRow>
          <GroupRow label="Usually">
            <span className="truncate">
              {vendorDefault && byId.get(vendorDefault) ? `${byId.get(vendorDefault)?.code} ${byId.get(vendorDefault)?.name}` : "—"}
            </span>
          </GroupRow>
        </InsetGroup>
      </div>

      <FormSection
        title="Lines"
        accessory={
          <InfoButton label="About lines">
            <p>
              Tick the cube to capitalize a line: it lands in an inventory account (1320 Raw Ingredients, 1330 Packaging)
              on the balance sheet until production relieves it. Everything else expenses. Enter adds a line.
            </p>
          </InfoButton>
        }
      >
        <Grid
          caption="Bill lines"
          minWidth="min-w-[56rem]"
          stack
          head={
            <>
              <GridTh className="w-9" align="right">
                <span className="sr-only">Line</span>
              </GridTh>
              <GridTh className="min-w-52">Description</GridTh>
              <GridTh className="w-12" align="center">
                <span className="inline-flex items-center text-tint-teal" title="Capitalize to inventory">
                  <Glyph name="cube" size={14} />
                  <span className="sr-only">Capitalize</span>
                </span>
              </GridTh>
              <GridTh className="w-64">Account</GridTh>
              <GridTh className="w-20" align="right">
                Qty
              </GridTh>
              <GridTh className="w-28" align="right">
                Unit cost
              </GridTh>
              <GridTh className="w-32" align="right">
                Amount
              </GridTh>
              <GridTh className="w-10">
                <span className="sr-only">Remove</span>
              </GridTh>
            </>
          }
          after={
            <button
              type="button"
              disabled={pending}
              onClick={() => addAfter(null)}
              className="flex h-10 w-full items-center gap-2 px-3 text-sm font-medium text-ink-blue transition-colors hover:bg-fill2 disabled:opacity-50 max-sm:h-11"
            >
              <Glyph name="plus" size={14} weight={2.2} />
              Add line
              <Kbd className="ml-1 max-sm:hidden">⏎</Kbd>
            </button>
          }
        >
          {lines.map((line, index) => {
            const extended = line.quantity.trim() !== "" && line.unitCost.trim() !== "";
            const amount = lineAmount(line);
            const error = lineErrors.get(line.key);
            return (
              <React.Fragment key={line.key}>
                <tr
                  className={cn(stackRow, line.capitalize && "[&>td]:bg-tint-teal/6 max-md:bg-tint-teal/8")}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.defaultPrevented) return;
                    if ((event.target as HTMLElement).closest("[cmdk-root]") !== null) return;
                    event.preventDefault();
                    addAfter(line.key);
                  }}
                >
                  <GridRowNo n={index + 1} />
                  <GridTd label="Description" className="max-md:order-1 max-md:col-span-6">
                    <Input
                      className={cellField}
                      value={line.description}
                      placeholder="Hibiscus flower, 5 kg"
                      aria-label={`Description, line ${index + 1}`}
                      disabled={pending}
                      invalid={error === "Describe what was bought."}
                      onChange={(e) => patch(line.key, { description: e.target.value })}
                    />
                  </GridTd>
                  <GridTd label="Inventory" className="text-center max-md:order-7 max-md:col-span-3 max-md:in-data-stack:flex max-md:min-h-11 max-md:flex-row-reverse max-md:items-center max-md:justify-end max-md:gap-2 max-md:[&>span]:mb-0 max-md:[&>span]:text-sm">
                    <Checkbox
                      checked={line.capitalize}
                      disabled={pending}
                      aria-label={`Capitalize line ${index + 1} to inventory`}
                      onCheckedChange={(checked) => {
                        const capitalize = checked === true;
                        if (capitalize === isInventoryAccount(line.accountId)) {
                          patch(line.key, { capitalize });
                          return;
                        }
                        // The flag and the account must agree: switching sides asks for the account again,
                        // offering the vendor's usual one when it is on the right side.
                        const fallback = isInventoryAccount(vendorDefault) === capitalize ? vendorDefault : null;
                        patch(line.key, { capitalize, accountId: fallback });
                      }}
                    />
                  </GridTd>
                  <GridTd label="Account" className="max-md:order-2 max-md:col-span-6">
                    <AccountCombobox
                      accounts={line.capitalize ? inventoryAccounts : otherAccounts}
                      value={line.accountId}
                      disabled={pending}
                      invalid={error?.startsWith("Choose") ?? false}
                      placeholder={line.capitalize ? "Inventory account" : "Expense account"}
                      onChange={(accountId) => patch(line.key, { accountId, capitalize: isInventoryAccount(accountId) })}
                      className={cellField}
                    />
                  </GridTd>
                  <GridTd label="Qty" className="max-md:order-4 max-md:col-span-2">
                    <Input
                      numeric
                      inputMode="decimal"
                      className={cellField}
                      value={line.quantity}
                      placeholder="—"
                      aria-label={`Quantity, line ${index + 1}`}
                      disabled={pending}
                      invalid={line.quantity.trim() !== "" && scaledQuantity(line.quantity) === null}
                      onChange={(e) => patch(line.key, { quantity: e.target.value })}
                    />
                  </GridTd>
                  <GridTd label="Unit cost" className="max-md:order-5 max-md:col-span-2">
                    <MoneyInput
                      className={cellField}
                      value={line.unitCost}
                      placeholder="—"
                      aria-label={`Unit cost, line ${index + 1}`}
                      disabled={pending}
                      onValueChange={(unitCost) => patch(line.key, { unitCost })}
                    />
                  </GridTd>
                  <GridTd label="Amount" className={cn("max-md:order-6 max-md:col-span-2", extended && "bg-fill2/50")}>
                    {extended ? (
                      <GridFigure>{amount === null ? <span className="text-label3">—</span> : <Money cents={amount} plain />}</GridFigure>
                    ) : (
                      <MoneyInput
                        className={cellField}
                        value={line.amount}
                        allowNegative
                        aria-label={`Amount, line ${index + 1}`}
                        disabled={pending}
                        onValueChange={(value) => patch(line.key, { amount: value })}
                      />
                    )}
                  </GridTd>
                  <GridTd className="text-center max-md:order-8 max-md:col-span-3 max-md:in-data-stack:flex max-md:justify-end">
                    <button
                      type="button"
                      aria-label={`Remove line ${index + 1}`}
                      disabled={pending || (lines.length === 1 && isBlank(line))}
                      onClick={() =>
                        setLines((current) => {
                          const rest = current.filter((l) => l.key !== line.key);
                          return rest.length === 0 ? [blankLine(vendorDefault, isInventoryAccount(vendorDefault))] : rest;
                        })
                      }
                      className="grid size-8 place-items-center rounded-full text-label3 transition-colors hover:bg-fill2 hover:text-ink-red disabled:opacity-30 max-sm:size-11 max-md:flex max-md:h-11 max-md:w-auto max-md:gap-1.5 max-md:px-3 max-md:text-sm max-md:font-medium max-md:text-ink-red"
                    >
                      <Glyph name="minus" size={14} weight={2.2} />
                      <span className="md:hidden">Remove</span>
                    </button>
                  </GridTd>
                </tr>
                {error ? (
                  <tr className="max-md:-mt-1 max-md:mb-2.5 max-md:block">
                    <td className="max-md:hidden" />
                    <td colSpan={7} className="border-b-[0.5px] border-sep px-2.5 py-1.5 text-xs font-medium text-ink-red max-md:block max-md:border-0 max-md:px-3">
                      {error}
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </Grid>

        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <div className="min-w-0 rounded-[12px] bg-inset px-4 py-3.5 max-lg:order-last">
            <p className="mb-2.5 text-xs font-semibold text-label2">Approving posts</p>
            {targets.size === 0 ? (
              <p className="py-2 text-sm text-label2">Lines with an account appear here.</p>
            ) : (
              <FlowDiagram
                from={{ label: "Payables", glyph: CATEGORIES.payables.glyph, tint: CATEGORIES.payables.tint }}
                to={[...targets.values()]}
                className="[&_span.bg-card]:bg-inset"
              />
            )}
          </div>
          <div className="flex flex-col gap-2">
            {total > 0 ? (
              <SplitBar
                label={`Inventory ${dollars(capitalized)}, expense ${dollars(total - capitalized)}`}
                segments={[
                  { label: "Inventory", value: capitalized, tint: "teal" },
                  { label: "Expense", value: Math.max(0, total - capitalized), tint: "gray" },
                ]}
                className="mb-1"
              />
            ) : null}
            <Totals>
              <TotalRow
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <Dot tint="teal" size={7} />
                    Inventory
                  </span>
                }
              >
                <Money cents={capitalized} plain zeroDash />
              </TotalRow>
              <TotalRow
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <Dot tint="gray" size={7} />
                    Expense
                  </span>
                }
              >
                <Money cents={total - capitalized} plain zeroDash />
              </TotalRow>
              <TotalRow label="Total" strong>
                <Money cents={total} currency plain />
              </TotalRow>
            </Totals>
            {problem === null ? null : (
              <p role="status" className="flex items-center justify-end gap-1.5 text-xs font-medium text-label2">
                <Glyph name="info" size={13} />
                {problem}
              </p>
            )}
          </div>
        </div>
      </FormSection>

      <div className="flex gap-2 rounded-[22px] bg-card p-3 shadow-card md:hidden">{buttons(true)}</div>
    </div>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCheck, Plus, Trash2 } from "lucide-react";

import { AccountCombobox } from "@/components/ledger/account-combobox";
import type { AccountOption } from "@/components/ledger/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { addDays, isCalendarDate } from "@/lib/dates";
import { saveBill } from "@/app/(app)/purchases/actions";

import { extendCents, readMoney, scaledQuantity, termsLabel } from "./math";
import { MoneyInput, centsOf, textOf } from "./money-input";
import { PartyCombobox } from "./party-combobox";
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

  return (
    <div className="flex flex-col gap-4 pb-28">
      <Card>
        <CardHeader>
          <CardTitle>{billId === null ? "New bill" : `Draft bill ${initial.billNo}`}</CardTitle>
          {vendor ? (
            <span className="text-xs text-muted-foreground">
              Terms {termsLabel(vendor.termsDays)}
              {vendorDefault && byId.get(vendorDefault)
                ? ` · usually ${byId.get(vendorDefault)?.code} ${byId.get(vendorDefault)?.name}`
                : null}
            </span>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,2fr)_minmax(8rem,1fr)_10rem_10rem_minmax(8rem,1fr)]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bill-vendor" required>
              Vendor
            </Label>
            <PartyCombobox
              id="bill-vendor"
              options={vendors.map((v) => ({ id: v.id, name: v.name, note: v.is1099 ? "1099" : undefined }))}
              value={vendorId}
              onChange={pickVendor}
              placeholder="Choose a vendor"
              emptyText="No vendor by that name."
              disabled={pending}
            />
            <p className="text-2xs text-muted-foreground">
              Not listed?{" "}
              <Link href="/purchases/vendors?new=1" className="text-primary hover:underline">
                Add a vendor
              </Link>
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bill-no" required hint="theirs">
              Invoice no.
            </Label>
            <Input id="bill-no" value={billNo} onChange={(e) => setBillNo(e.target.value)} disabled={pending} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bill-date" required>
              Bill date
            </Label>
            <DateInput id="bill-date" value={billDate} onValueChange={setBillDate} disabled={pending} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bill-due" hint={dueTouched ? "set by hand" : "from terms"}>
              Due
            </Label>
            <DateInput
              id="bill-due"
              value={effectiveDue}
              onValueChange={(value) => {
                setDueTouched(true);
                setDueDate(value);
              }}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bill-po">Our PO</Label>
            <Input id="bill-po" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} disabled={pending} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-5">
            <Label htmlFor="bill-memo">Memo</Label>
            <Input
              id="bill-memo"
              value={memo}
              placeholder="e.g. Pilot batch ingredients, lot 26-09"
              onChange={(e) => setMemo(e.target.value)}
              disabled={pending}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
          <span className="text-xs text-muted-foreground">
            Capitalize puts a line on the balance sheet in inventory instead of the P&amp;L
          </span>
        </CardHeader>
        <div className="relative overflow-x-auto p-3">
          <table className="w-full min-w-[54rem] border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Bill lines</caption>
            <thead>
              <tr>
                <GridTh className="w-7 text-right">#</GridTh>
                <GridTh className="min-w-52">Description</GridTh>
                <GridTh className="w-24 text-center">Capitalize</GridTh>
                <GridTh className="w-60">Account</GridTh>
                <GridTh className="w-20 text-right">Qty</GridTh>
                <GridTh className="w-28 text-right">Unit cost</GridTh>
                <GridTh className="w-32 text-right">Amount</GridTh>
                <GridTh className="w-8">
                  <span className="sr-only">Remove</span>
                </GridTh>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const extended = line.quantity.trim() !== "" && line.unitCost.trim() !== "";
                const amount = lineAmount(line);
                const error = lineErrors.get(line.key);
                return (
                  <React.Fragment key={line.key}>
                    <tr
                      className={cn("align-middle", line.capitalize && "bg-info/5")}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.defaultPrevented) return;
                        if ((event.target as HTMLElement).closest("[cmdk-root]") !== null) return;
                        event.preventDefault();
                        addAfter(line.key);
                      }}
                    >
                      <GridTd className="num text-right text-xs text-muted-foreground">{index + 1}</GridTd>
                      <GridTd>
                        <Input
                          className="h-7"
                          value={line.description}
                          placeholder="e.g. Hibiscus flower, 5 kg"
                          aria-label={`Description, line ${index + 1}`}
                          disabled={pending}
                          invalid={error === "Describe what was bought."}
                          onChange={(e) => patch(line.key, { description: e.target.value })}
                        />
                      </GridTd>
                      <GridTd className="text-center">
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
                      <GridTd>
                        <AccountCombobox
                          accounts={line.capitalize ? inventoryAccounts : otherAccounts}
                          value={line.accountId}
                          disabled={pending}
                          invalid={error?.startsWith("Choose") ?? false}
                          placeholder={line.capitalize ? "Inventory account" : "Expense account"}
                          onChange={(accountId) => patch(line.key, { accountId, capitalize: isInventoryAccount(accountId) })}
                          className="h-7"
                        />
                      </GridTd>
                      <GridTd>
                        <Input
                          numeric
                          inputMode="decimal"
                          className="h-7"
                          value={line.quantity}
                          placeholder="—"
                          aria-label={`Quantity, line ${index + 1}`}
                          disabled={pending}
                          invalid={line.quantity.trim() !== "" && scaledQuantity(line.quantity) === null}
                          onChange={(e) => patch(line.key, { quantity: e.target.value })}
                        />
                      </GridTd>
                      <GridTd>
                        <MoneyInput
                          className="h-7"
                          value={line.unitCost}
                          placeholder="—"
                          aria-label={`Unit cost, line ${index + 1}`}
                          disabled={pending}
                          onValueChange={(unitCost) => patch(line.key, { unitCost })}
                        />
                      </GridTd>
                      <GridTd>
                        {extended ? (
                          <div className="flex h-7 items-center justify-end px-2.5">
                            {amount === null ? <span className="text-muted-foreground">—</span> : <Money cents={amount} plain />}
                          </div>
                        ) : (
                          <MoneyInput
                            className="h-7"
                            value={line.amount}
                            allowNegative
                            aria-label={`Amount, line ${index + 1}`}
                            disabled={pending}
                            onValueChange={(value) => patch(line.key, { amount: value })}
                          />
                        )}
                      </GridTd>
                      <GridTd className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove line ${index + 1}`}
                          disabled={pending || (lines.length === 1 && isBlank(line))}
                          onClick={() =>
                            setLines((current) => {
                              const rest = current.filter((l) => l.key !== line.key);
                              return rest.length === 0 ? [blankLine(vendorDefault, isInventoryAccount(vendorDefault))] : rest;
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </GridTd>
                    </tr>
                    {error ? (
                      <tr>
                        <td />
                        <td colSpan={7} className="pb-1 text-xs text-negative">
                          {error}
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <div className="pt-2">
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => addAfter(null)}>
              <Plus />
              Add line
              <span className="text-2xs text-muted-foreground">or press Enter</span>
            </Button>
          </div>
        </div>
        <div className="flex justify-end border-t border-border p-4">
          <dl className="grid w-full max-w-xs grid-cols-[1fr_8rem] gap-y-1.5 text-sm [&>dd]:pl-4">
            <dt className="text-muted-foreground">Capitalized to inventory</dt>
            <dd className="text-right">
              <Money cents={capitalized} plain zeroDash />
            </dd>
            <dt className="text-muted-foreground">Expensed</dt>
            <dd className="text-right">
              <Money cents={total - capitalized} plain zeroDash />
            </dd>
            <dt className="rule-subtotal pt-1.5 font-semibold">Total</dt>
            <dd className="rule-subtotal rule-total pt-1.5 pb-0.5 text-right">
              <Money cents={total} currency plain className="font-semibold" />
            </dd>
          </dl>
        </div>
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border-strong bg-surface-raised/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[104rem] flex-wrap items-center justify-between gap-3 px-4 py-2.5 lg:px-6">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="eyebrow">Total</span>
            <Money cents={total} currency plain className="font-semibold" />
            {capitalized > 0 ? <Badge tone="info">{Math.round((capitalized * 100) / Math.max(total, 1))}% inventory</Badge> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {problem === null ? null : <span className="max-w-sm text-xs text-muted-foreground">{problem}</span>}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending || !canManage || vendor === null || filled.length === 0}
              onClick={() => submit("draft")}
            >
              Save draft
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending || problem !== null || !canApprove}
              title={canApprove ? undefined : "Your role may save drafts but not approve them."}
              onClick={() => submit("approve")}
            >
              <CheckCheck />
              Approve bill
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GridTh({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head px-1.5 pb-1 text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </th>
  );
}

function GridTd({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={cn("px-1.5 py-1 align-middle", className)}>{children}</td>;
}

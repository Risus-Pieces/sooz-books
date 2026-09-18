"use client";

import * as React from "react";
import { Pencil, Plus, Search, Zap } from "lucide-react";

import { AccountCombobox } from "@/components/ledger/account-combobox";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money, formatCents } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { parseMoney } from "@/lib/money";
import { previewRuleDraft, saveRuleDraft, setRuleEnabled } from "@/app/(app)/banking/actions";

import { Th } from "./parts";
import { AutoPostWarning, ConditionRows, DIRECTION_LABEL, FIELD_LABEL, OP_LABEL } from "./review-dialogs";
import { shortDate } from "./review-logic";
import type {
  AccountOption,
  BankAccountTab,
  RuleDirection,
  RuleDraft,
  RulePreview,
  RuleRow,
  VendorOption,
} from "./types";

const ALL = "__all__";
const NONE = "__none__";

function draftOf(rule: RuleRow | null, nextPriority: number): RuleDraft {
  if (rule === null) {
    return {
      id: null,
      name: "",
      priority: nextPriority,
      bankAccountId: null,
      conditions: [{ field: "payee", op: "contains", value: "" }],
      direction: "out",
      amountMinCents: null,
      amountMaxCents: null,
      accountId: null,
      vendorId: null,
      memoTemplate: null,
      autoPost: false,
      active: true,
    };
  }
  return {
    id: rule.id,
    name: rule.name,
    priority: rule.priority,
    bankAccountId: rule.bankAccountId,
    conditions: rule.conditions.map((c) => ({ ...c })),
    direction: rule.direction,
    amountMinCents: rule.amountMinCents,
    amountMaxCents: rule.amountMaxCents,
    accountId: rule.accountId,
    vendorId: rule.vendorId,
    memoTemplate: rule.memoTemplate,
    autoPost: rule.autoPost,
    active: rule.active,
  };
}

function describeConditions(rule: RuleRow): string {
  return rule.conditions.map((c) => `${FIELD_LABEL[c.field]} ${OP_LABEL[c.op]} “${c.value}”`).join(" and ");
}

export function RulesManager({
  rules,
  accounts,
  vendors,
  banks,
  mayAutoPost,
  canEdit,
}: {
  rules: readonly RuleRow[];
  accounts: readonly AccountOption[];
  vendors: readonly VendorOption[];
  banks: readonly BankAccountTab[];
  mayAutoPost: boolean;
  canEdit: boolean;
}) {
  const [editing, setEditing] = React.useState<RuleDraft | null>(null);
  const [query, setQuery] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const nextPriority = rules.reduce((max, rule) => Math.max(max, rule.priority), 0) + 10;

  const text = query.trim().toLowerCase();
  const shown = text === ""
    ? rules
    : rules.filter((rule) =>
        [rule.name, rule.accountName, rule.vendorName, ...rule.conditions.map((c) => c.value)]
          .filter((part): part is string => part !== null)
          .some((part) => part.toLowerCase().includes(text)),
      );

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-0 flex-[1_1_14rem]">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search rules"
              placeholder="Search by name, payee text or account"
              className="pl-7"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <p className="num text-xs text-muted-foreground">
            {rules.filter((r) => r.active).length} active · {rules.filter((r) => r.autoPost && r.active).length} auto-post
          </p>
          {canEdit ? (
            <Button className="ml-auto" onClick={() => setEditing(draftOf(null, nextPriority))}>
              <Plus />
              New rule
            </Button>
          ) : null}
        </div>
        <div className="relative overflow-x-auto border-t border-border">
          <table className="w-full min-w-[60rem] border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Categorization rules in the order they are tried</caption>
            <thead>
              <tr>
                <Th className="w-14 text-right">Order</Th>
                <Th>Rule</Th>
                <Th className="w-[26%]">Codes to</Th>
                <Th className="w-20 text-right">Hits</Th>
                <Th className="w-24 text-right">Suggesting</Th>
                <Th className="w-20">Active</Th>
                <Th className="w-16">
                  <span className="sr-only">Edit</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((rule) => (
                <tr key={rule.id} className={cn("align-top", !rule.active && "text-muted-foreground")}>
                  <td className="rule-row num px-3 py-1.5 text-right text-xs leading-5 text-muted-foreground">{rule.priority}</td>
                  <td className="rule-row max-w-0 px-3 py-1.5">
                    <p className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{rule.name}</span>
                      {rule.autoPost ? (
                        <Badge tone="primary" size="sm">
                          <Zap />
                          Auto-post
                        </Badge>
                      ) : null}
                    </p>
                    <p className="truncate text-2xs text-muted-foreground" title={describeConditions(rule)}>
                      {DIRECTION_LABEL[rule.direction]} · {describeConditions(rule)}
                      {rule.amountMinCents !== null || rule.amountMaxCents !== null ? (
                        <>
                          {" "}
                          · {rule.amountMinCents === null ? "up to" : formatCents(rule.amountMinCents, { currency: true })}
                          {rule.amountMinCents !== null && rule.amountMaxCents !== null ? "–" : " "}
                          {rule.amountMaxCents === null ? "and up" : formatCents(rule.amountMaxCents, { currency: true })}
                        </>
                      ) : null}
                      {rule.bankAccountLabel === null ? null : <> · only {rule.bankAccountLabel}</>}
                    </p>
                  </td>
                  <td className="rule-row max-w-0 px-3 py-1.5">
                    {rule.accountCode === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <p className="flex items-baseline gap-1.5">
                        <span className="num shrink-0 text-xs text-muted-foreground">{rule.accountCode}</span>
                        <span className="truncate">{rule.accountName}</span>
                      </p>
                    )}
                    {rule.vendorName === null ? null : <p className="truncate text-2xs text-muted-foreground">{rule.vendorName}</p>}
                  </td>
                  <td className="rule-row num px-3 py-1.5 text-right" title={rule.lastHit === null ? "Never matched" : `Last matched ${rule.lastHit}`}>
                    {rule.hitCount}
                  </td>
                  <td className="rule-row num px-3 py-1.5 text-right">{rule.currentMatches}</td>
                  <td className="rule-row px-3 py-1.5">
                    <Checkbox
                      aria-label={`${rule.active ? "Turn off" : "Turn on"} ${rule.name}`}
                      checked={rule.active}
                      disabled={!canEdit || pending || (rule.autoPost && !mayAutoPost)}
                      onCheckedChange={(value) =>
                        startTransition(async () => {
                          const result = await setRuleEnabled(rule.id, value === true);
                          if (!result.ok) toast.error(result.error.message);
                        })
                      }
                    />
                  </td>
                  <td className="rule-row px-3 py-1">
                    {canEdit ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Edit ${rule.name}`}
                        onClick={() => setEditing(draftOf(rule, nextPriority))}
                      >
                        <Pencil />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    {rules.length === 0 ? "No rules yet. Create one, or press r on a row in the review queue." : "No rule matches that search."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <RuleEditor
        key={editing === null ? "closed" : (editing.id ?? "new")}
        draft={editing}
        accounts={accounts}
        vendors={vendors}
        banks={banks}
        mayAutoPost={mayAutoPost}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

function amountText(cents: number | null): string {
  return cents === null ? "" : formatCents(cents);
}

function amountValue(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  try {
    const cents = parseMoney(text);
    return cents < 0 ? "invalid" : cents;
  } catch {
    return "invalid";
  }
}

function RuleEditor({
  draft: initial,
  accounts,
  vendors,
  banks,
  mayAutoPost,
  onClose,
}: {
  draft: RuleDraft | null;
  accounts: readonly AccountOption[];
  vendors: readonly VendorOption[];
  banks: readonly BankAccountTab[];
  mayAutoPost: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = React.useState<RuleDraft | null>(initial);
  const [minText, setMinText] = React.useState(amountText(initial?.amountMinCents ?? null));
  const [maxText, setMaxText] = React.useState(amountText(initial?.amountMaxCents ?? null));
  const [preview, setPreview] = React.useState<RulePreview | null>(null);
  const [pending, startTransition] = React.useTransition();

  const min = amountValue(minText);
  const max = amountValue(maxText);
  const effective: RuleDraft | null =
    draft === null
      ? null
      : { ...draft, amountMinCents: min === "invalid" ? null : min, amountMaxCents: max === "invalid" ? null : max };
  const key = effective === null ? "" : JSON.stringify(effective);

  // The preview runs a moment after the last keystroke, not on every one.
  React.useEffect(() => {
    if (key === "") return;
    const snapshot = JSON.parse(key) as RuleDraft;
    let live = true;
    const timer = window.setTimeout(() => {
      void previewRuleDraft(snapshot).then((result) => {
        if (!live) return;
        if (result.ok) setPreview(result.value);
      });
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [key]);

  if (draft === null) return null;
  const set = <K extends keyof RuleDraft>(field: K, value: RuleDraft[K]) =>
    setDraft((current) => (current === null ? current : { ...current, [field]: value }));
  const lockedAutoPost = draft.id !== null && initial?.autoPost === true && !mayAutoPost;

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (effective === null || min === "invalid" || max === "invalid") return;
            startTransition(async () => {
              const result = await saveRuleDraft(effective);
              if (result.ok) {
                toast.success(`Saved “${result.value.name}”`, { description: "It applies from the next import on." });
                onClose();
              } else {
                toast.error(result.error.message);
              }
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{draft.id === null ? "New rule" : `Edit “${initial?.name ?? ""}”`}</DialogTitle>
            <DialogDescription>
              Rules are tried in order, lowest number first; the first that matches suggests the account. Saving never
              changes a transaction already imported.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="flex min-w-0 flex-col gap-4">
              {lockedAutoPost ? (
                <p className="rounded-sm border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                  This rule posts without review, so only the owner can change it.
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rule-name" hint="optional">
                    Name
                  </Label>
                  <Input id="rule-name" value={draft.name} placeholder="Named after its first condition" onChange={(e) => set("name", e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rule-priority">Order</Label>
                  <Input
                    id="rule-priority"
                    numeric
                    inputMode="numeric"
                    value={String(draft.priority)}
                    onChange={(e) => set("priority", Number.parseInt(e.target.value.replace(/\D/g, "") || "0", 10))}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>When</Label>
                <ConditionRows conditions={draft.conditions} onChange={(next) => set("conditions", next)} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Direction</Label>
                  <Select value={draft.direction} onValueChange={(v) => set("direction", v as RuleDirection)}>
                    <SelectTrigger aria-label="Direction">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(DIRECTION_LABEL) as RuleDirection[]).map((d) => (
                        <SelectItem key={d} value={d}>
                          {DIRECTION_LABEL[d]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rule-min" hint="optional">
                    From $
                  </Label>
                  <Input id="rule-min" numeric inputMode="decimal" placeholder="0.00" value={minText} invalid={min === "invalid"} onChange={(e) => setMinText(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rule-max" hint="optional">
                    To $
                  </Label>
                  <Input id="rule-max" numeric inputMode="decimal" placeholder="no limit" value={maxText} invalid={max === "invalid"} onChange={(e) => setMaxText(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Bank account</Label>
                  <Select value={draft.bankAccountId ?? ALL} onValueChange={(v) => set("bankAccountId", v === ALL ? null : v)}>
                    <SelectTrigger aria-label="Bank account">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>Every account</SelectItem>
                      {banks.map((bank) => (
                        <SelectItem key={bank.id} value={bank.id}>
                          {bank.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label>Code to</Label>
                  <AccountCombobox accounts={accounts} value={draft.accountId} trackRecents className="h-8" onChange={(v) => set("accountId", v)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Vendor</Label>
                  <Select value={draft.vendorId ?? NONE} onValueChange={(v) => set("vendorId", v === NONE ? null : v)}>
                    <SelectTrigger aria-label="Vendor">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>No vendor</SelectItem>
                      {vendors.map((vendor) => (
                        <SelectItem key={vendor.id} value={vendor.id}>
                          {vendor.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rule-memo" hint="optional">
                  Memo
                </Label>
                <Input id="rule-memo" value={draft.memoTemplate ?? ""} placeholder="The payee" onChange={(e) => set("memoTemplate", e.target.value === "" ? null : e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={draft.active} onCheckedChange={(v) => set("active", v === true)} />
                  Active
                </label>
                <label className={cn("flex items-center gap-2 text-sm", !mayAutoPost && "text-muted-foreground")}>
                  <Checkbox checked={draft.autoPost} disabled={!mayAutoPost} onCheckedChange={(v) => set("autoPost", v === true)} />
                  Post matches without review
                  {mayAutoPost ? null : <span className="text-xs">(owner only)</span>}
                </label>
                {draft.autoPost ? <AutoPostWarning /> : null}
              </div>
            </div>
            <RulePreviewPanel preview={preview} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending || lockedAutoPost || min === "invalid" || max === "invalid"}>
              Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RulePreviewPanel({ preview }: { preview: RulePreview | null }) {
  return (
    <aside className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface-sunken/40 p-3" aria-live="polite">
      <p className="eyebrow">Would match</p>
      {preview === null ? (
        <p className="text-xs text-muted-foreground">Checking your transactions…</p>
      ) : preview.problems.length > 0 ? (
        <ul className="list-disc pl-4 text-xs text-warning">
          {preview.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : (
        <>
          <p className="text-sm">
            <span className="num text-2xl font-semibold">{preview.matched}</span>{" "}
            <span className="text-muted-foreground">of your transactions</span>
          </p>
          <p className="text-xs text-muted-foreground">
            It would win <span className="num text-foreground">{preview.wins}</span>; an earlier rule takes{" "}
            <span className="num text-foreground">{preview.matched - preview.wins}</span>.
            {preview.posted > 0 ? ` ${preview.posted} already posted — a rule never changes those.` : ""}
          </p>
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {preview.sample.map((row) => (
              <li key={row.id} className="flex items-baseline gap-2 py-1 text-xs">
                <span className="num w-12 shrink-0 text-muted-foreground">{shortDate(row.txnDate)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{row.payee}</span>
                  {row.wonBy === null ? null : <span className="block truncate text-2xs text-muted-foreground">won by {row.wonBy}</span>}
                </span>
                <Money cents={row.amountCents} colorPositive className="text-xs" />
              </li>
            ))}
          </ul>
          {preview.matched > preview.sample.length ? (
            <p className="text-2xs text-muted-foreground">and {preview.matched - preview.sample.length} more</p>
          ) : null}
        </>
      )}
    </aside>
  );
}

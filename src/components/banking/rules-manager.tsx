"use client";

import * as React from "react";

import { AccountCombobox } from "@/components/ledger/account-combobox";
import { SplitBar } from "@/components/charts";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Button } from "@/components/ui/button";
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
import { Glyph } from "@/components/ui/glyph";
import { Dot, IconBadge } from "@/components/ui/icon-badge";
import { Input } from "@/components/ui/input";
import { InsetGroup } from "@/components/ui/inset-group";
import { Label } from "@/components/ui/label";
import { Money, formatCents } from "@/components/ui/money";
import { Pill } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";
import { parseMoney } from "@/lib/money";
import { categoryForCode } from "@/lib/ui/categories";
import { previewRuleDraft, saveRuleDraft, setRuleEnabled } from "@/app/(app)/banking/actions";

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

  const active = rules.filter((r) => r.active).length;
  const autoPost = rules.filter((r) => r.autoPost && r.active).length;

  return (
    <>
      <PageToolbar
        title="Rules"
        subtitle={
          <>
            <span className="num">{active} active</span>
            {autoPost > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span className="num inline-flex items-center gap-1">
                  <Glyph name="wand" size={12} className="text-tint-purple" />
                  {autoPost} auto-post
                </span>
              </>
            ) : null}
          </>
        }
        info="How imported transactions are coded before anyone looks at them. Rules are tried in order, lowest number first; the first that matches suggests the account. Only a rule the owner marks auto-post lets a match post without review."
        search={
          <SearchField
            appearance="toolbar"
            aria-label="Search rules"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        }
        actions={
          canEdit ? (
            <ToolbarGroup>
              <ToolbarButton glyph="plus" label="New rule" onClick={() => setEditing(draftOf(null, nextPriority))} />
            </ToolbarGroup>
          ) : undefined
        }
      />

      {shown.length === 0 ? (
        <EmptyState
          glyph="wand"
          title={rules.length === 0 ? "No rules yet" : "Nothing matches"}
          description={rules.length === 0 ? "Create one here, or press R on a row in the review queue." : undefined}
          action={
            rules.length === 0 && canEdit ? (
              <Button onClick={() => setEditing(draftOf(null, nextPriority))}>
                <Glyph name="plus" />
                New rule
              </Button>
            ) : undefined
          }
        />
      ) : (
        <InsetGroup separatorInset={60}>
          {shown.map((rule) => {
            const category = categoryForCode(rule.accountCode);
            const amount =
              rule.amountMinCents !== null || rule.amountMaxCents !== null
                ? ` · ${rule.amountMinCents === null ? "up to " : formatCents(rule.amountMinCents, { currency: true })}${
                    rule.amountMinCents !== null && rule.amountMaxCents !== null ? "–" : " "
                  }${rule.amountMaxCents === null ? "and up" : formatCents(rule.amountMaxCents, { currency: true })}`
                : "";
            const conditions = `${describeConditions(rule)}${amount}${rule.bankAccountLabel === null ? "" : ` · ${rule.bankAccountLabel}`}`;
            return (
              <div
                key={rule.id}
                className={cn(
                  "relative flex min-h-[58px] items-center gap-3 pr-4 before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[60px] before:border-t-[0.5px] before:border-sep first:before:hidden",
                  !rule.active && "[&_[data-slot=icon-badge]]:opacity-45",
                )}
              >
                <button
                  type="button"
                  disabled={!canEdit}
                  aria-label={`Edit ${rule.name}`}
                  onClick={() => setEditing(draftOf(rule, nextPriority))}
                  className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left outline-none focus-ring-inset transition-colors hover:bg-fill2 focus-visible:bg-fill2 disabled:hover:bg-transparent"
                >
                  <IconBadge glyph={rule.accountCode === null ? "question" : category.glyph} tint={rule.accountCode === null ? "gray" : category.tint} size="lg" />
                  <span className="min-w-0 flex-1">
                    <span className={cn("flex items-center gap-1.5 text-sm font-semibold max-sm:text-[1rem] max-sm:font-medium", !rule.active && "text-label2")}>
                      <span className="truncate">{rule.name}</span>
                      {rule.autoPost ? <Glyph name="wand" size={13} label="Auto-post" className="shrink-0 text-tint-purple" /> : null}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-label2 max-sm:text-sm">
                      <Glyph
                        name={rule.direction === "in" ? "arrow-in" : rule.direction === "out" ? "arrow-out" : "transfer"}
                        size={12}
                        weight={2.2}
                        label={DIRECTION_LABEL[rule.direction]}
                        className="shrink-0"
                      />
                      <span className="truncate" title={conditions}>
                        {conditions}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-label2 lg:hidden">
                      <Dot tint={rule.accountCode === null ? "quiet" : category.tint} size={7} />
                      <span className="truncate">{rule.accountName ?? "No account"}</span>
                    </span>
                  </span>
                  <span className="hidden w-[30%] min-w-0 items-center gap-1.5 text-sm lg:flex">
                    <Dot tint={rule.accountCode === null ? "quiet" : category.tint} size={7} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{rule.accountName ?? "—"}</span>
                      {rule.vendorName === null ? null : <span className="block truncate text-xs text-label2">{rule.vendorName}</span>}
                    </span>
                  </span>
                  <span
                    className="flex w-16 shrink-0 flex-col items-end"
                    title={rule.lastHit === null ? "Never matched" : `Last matched ${rule.lastHit}`}
                  >
                    <span className="num text-sm font-semibold">{rule.hitCount}</span>
                    <span className="num text-2xs text-label2">
                      {rule.currentMatches > 0 ? `${rule.currentMatches} now` : `#${rule.priority}`}
                    </span>
                  </span>
                </button>
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
              </div>
            );
          })}
        </InsetGroup>
      )}

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
              Saving never changes a transaction already imported.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="flex min-w-0 flex-col gap-4">
              {lockedAutoPost ? (
                <Pill glyph="lock">Owner only</Pill>
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
                <label className={cn("flex items-center gap-2 text-sm", !mayAutoPost && "text-label2")}>
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
    <aside className="flex min-w-0 flex-col gap-2 rounded-[14px] bg-inset p-3.5" aria-live="polite">
      <p className="text-xs font-semibold text-label2">Would match</p>
      {preview === null ? (
        <p className="text-xs text-label2">Checking…</p>
      ) : preview.problems.length > 0 ? (
        <ul className="list-disc pl-4 text-xs text-ink-orange">
          {preview.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : (
        <>
          <p className="num text-3xl font-bold tracking-[-0.028em]">{preview.matched}</p>
          {preview.matched > 0 ? (
            <SplitBar
              label={`Wins ${preview.wins}, earlier rule ${preview.matched - preview.wins}`}
              segments={[
                { label: "wins", value: preview.wins, tint: "purple" },
                { label: "earlier", value: preview.matched - preview.wins, tint: "gray" },
              ]}
            />
          ) : null}
          <p className="text-xs text-label2">
            It would win <span className="num text-label">{preview.wins}</span>; an earlier rule takes{" "}
            <span className="num text-label">{preview.matched - preview.wins}</span>.
            {preview.posted > 0 ? ` ${preview.posted} already posted — a rule never changes those.` : ""}
          </p>
          <ul className="flex flex-col divide-y divide-sep hairline-t">
            {preview.sample.map((row) => (
              <li key={row.id} className="flex items-baseline gap-2 py-1 text-xs">
                <span className="num w-12 shrink-0 text-label2">{shortDate(row.txnDate)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{row.payee}</span>
                  {row.wonBy === null ? null : <span className="block truncate text-2xs text-label2">won by {row.wonBy}</span>}
                </span>
                <Money cents={row.amountCents} colorPositive className="text-xs" />
              </li>
            ))}
          </ul>
          {preview.matched > preview.sample.length ? (
            <p className="text-2xs text-label2">and {preview.matched - preview.sample.length} more</p>
          ) : null}
        </>
      )}
    </aside>
  );
}

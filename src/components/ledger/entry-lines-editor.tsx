"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/cn";

import { AccountCombobox } from "./account-combobox";
import {
  blankLine,
  isLineEmpty,
  lineAmounts,
  setAmount,
  type AmountSide,
  type DraftLineState,
  type EntryTotals,
} from "./entry-math";
import type { AccountOption, ChannelOption, ProductOption } from "./types";

/** Radix Select refuses an empty value, so "no dimension" needs a token of its own. */
const NONE = "__none__";

export interface EntryLinesEditorProps {
  lines: DraftLineState[];
  onChange: (lines: DraftLineState[]) => void;
  accounts: readonly AccountOption[];
  channels: readonly ChannelOption[];
  products: readonly ProductOption[];
  totals: EntryTotals;
  /** Called with every account a bookkeeper picks, to keep the recents list warm. */
  onAccountUsed: (accountId: string) => void;
  /** The line the auto-balance action would fill; tracked by the form. */
  focusedKey: string | null;
  onFocusLine: (key: string) => void;
  disabled?: boolean;
}

/**
 * The line grid. Everything here is keyboard-first, because a bookkeeper enters
 * hundreds of these a day and never reaches for the mouse:
 *
 *   Tab   account → debit → credit → memo → channel → product, then the next row
 *   Enter adds a row below and lands on its account picker
 *   a debit clears the credit on that line, and the other way round
 *
 * Amounts stay as typed while the field has focus and are formatted on blur, so
 * `1234.5` reads back as `1,234.50` without fighting the person mid-keystroke.
 */
export function EntryLinesEditor({
  lines,
  onChange,
  accounts,
  channels,
  products,
  totals,
  onAccountUsed,
  focusedKey,
  onFocusLine,
  disabled = false,
}: EntryLinesEditorProps) {
  const accountTriggers = React.useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = React.useRef<string | null>(null);

  // A row added by Enter lands on its account picker. The target is held in a
  // ref rather than in state: it is a one-shot instruction to the DOM, and
  // putting it in state would spend a render on clearing it again.
  React.useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    pendingFocus.current = null;
    accountTriggers.current.get(key)?.focus();
  });

  const registerTrigger = React.useCallback((key: string, node: HTMLButtonElement | null) => {
    if (node === null) accountTriggers.current.delete(key);
    else accountTriggers.current.set(key, node);
  }, []);

  const patchLine = React.useCallback(
    (key: string, patch: (line: DraftLineState) => DraftLineState) => {
      onChange(lines.map((line) => (line.key === key ? patch(line) : line)));
    },
    [lines, onChange],
  );

  const addLineAfter = React.useCallback(
    (key: string | null) => {
      const created = blankLine();
      const index = key === null ? -1 : lines.findIndex((line) => line.key === key);
      const next = [...lines];
      if (index === -1) next.push(created);
      else next.splice(index + 1, 0, created);
      onChange(next);
      pendingFocus.current = created.key;
    },
    [lines, onChange],
  );

  const removeLine = React.useCallback(
    (key: string) => {
      const remaining = lines.filter((line) => line.key !== key);
      // The grid always offers somewhere to type; an empty table is a dead end.
      onChange(remaining.length === 0 ? [blankLine()] : remaining);
    },
    [lines, onChange],
  );

  /**
   * Enter means "another line". It is caught on the row rather than on each
   * field so it works from every cell, and it is left alone inside the account
   * popover, where Enter picks the highlighted account.
   */
  const onRowKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTableRowElement>, key: string) => {
      if (event.key !== "Enter" || event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target.closest("[cmdk-root]") !== null) return;
      event.preventDefault();
      addLineAfter(key);
    },
    [addLineAfter],
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-4xl border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Journal entry lines</caption>
        <thead>
          <tr>
            <Th className="w-8 text-right">#</Th>
            <Th className="min-w-56">Account</Th>
            <Th className="w-32 text-right">Debit</Th>
            <Th className="w-32 rule-gutter text-right">Credit</Th>
            <Th className="min-w-48">Memo</Th>
            <Th className="w-36">Channel</Th>
            <Th className="w-40">Product</Th>
            <Th className="w-8">
              <span className="sr-only">Remove</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const error = totals.lineErrors[line.key];
            const amounts = lineAmounts(line);
            return (
              <React.Fragment key={line.key}>
                <tr
                  onKeyDown={(event) => onRowKeyDown(event, line.key)}
                  onFocus={() => onFocusLine(line.key)}
                  className={cn("align-middle", focusedKey === line.key && "bg-primary/5")}
                >
                  <Td className="num text-right text-xs text-muted-foreground">{index + 1}</Td>
                  <Td>
                    <AccountCombobox
                      accounts={accounts}
                      value={line.accountId}
                      trackRecents
                      disabled={disabled}
                      invalid={error === "Choose an account for this line."}
                      onChange={(accountId) => {
                        patchLine(line.key, (current) => ({ ...current, accountId }));
                        onAccountUsed(accountId);
                      }}
                      className="h-7"
                      id={`account-${line.key}`}
                      // The trigger is where Enter lands after a row is added.
                      triggerRef={(node) => registerTrigger(line.key, node)}
                    />
                  </Td>
                  <AmountCell
                    side="debit"
                    line={line}
                    disabled={disabled}
                    invalid={amounts.error !== null}
                    onChange={patchLine}
                  />
                  <AmountCell
                    side="credit"
                    line={line}
                    disabled={disabled}
                    invalid={amounts.error !== null}
                    gutter
                    onChange={patchLine}
                  />
                  <Td>
                    <Input
                      value={line.memo}
                      disabled={disabled}
                      placeholder="Line memo"
                      aria-label={`Memo, line ${index + 1}`}
                      className="h-7"
                      onChange={(event) =>
                        patchLine(line.key, (current) => ({ ...current, memo: event.target.value }))
                      }
                    />
                  </Td>
                  <Td>
                    <DimensionSelect
                      label={`Channel, line ${index + 1}`}
                      placeholder="Channel"
                      value={line.channelId}
                      disabled={disabled}
                      options={channels.map((channel) => ({
                        value: channel.id,
                        label: channel.name,
                      }))}
                      onChange={(channelId) =>
                        patchLine(line.key, (current) => ({ ...current, channelId }))
                      }
                    />
                  </Td>
                  <Td>
                    <DimensionSelect
                      label={`Product, line ${index + 1}`}
                      placeholder="Product"
                      value={line.productId}
                      disabled={disabled}
                      options={products.map((product) => ({
                        value: product.id,
                        label: `${product.sku} · ${product.name}`,
                      }))}
                      onChange={(productId) =>
                        patchLine(line.key, (current) => ({ ...current, productId }))
                      }
                    />
                  </Td>
                  <Td className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled || (lines.length === 1 && isLineEmpty(line))}
                      aria-label={`Remove line ${index + 1}`}
                      onClick={() => removeLine(line.key)}
                    >
                      <Trash2 />
                    </Button>
                  </Td>
                </tr>
                {error === undefined ? null : (
                  <tr>
                    <td />
                    <td colSpan={7} className="pb-1 text-xs text-negative">
                      {error}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      <div className="pt-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => addLineAfter(null)}
        >
          <Plus />
          Add line
          <span className="text-2xs text-muted-foreground">or press Enter</span>
        </Button>
      </div>
    </div>
  );
}

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
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

function Td({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={cn("px-1.5 py-1 align-middle", className)}>{children}</td>;
}

function AmountCell({
  side,
  line,
  disabled,
  invalid,
  gutter,
  onChange,
}: {
  side: AmountSide;
  line: DraftLineState;
  disabled: boolean;
  invalid: boolean;
  gutter?: boolean;
  onChange: (key: string, patch: (line: DraftLineState) => DraftLineState) => void;
}) {
  const value = side === "debit" ? line.debit : line.credit;

  /**
   * On blur the field shows what the ledger will store. The amount is read back
   * out of `lineAmounts`, so a `(50)` that belongs on the other side is not
   * quietly rewritten in place — it stays as typed until the other column
   * catches it on the next render.
   */
  const normalise = React.useCallback(() => {
    if (value.trim() === "") return;
    const amounts = lineAmounts(line);
    if (amounts.error !== null) return;
    const cents = side === "debit" ? amounts.debitCents : amounts.creditCents;
    if (cents === 0) return;
    const formatted = formatCents(cents);
    if (formatted !== value) {
      onChange(line.key, (current) => setAmount(current, side, formatted));
    }
  }, [line, onChange, side, value]);

  return (
    <td className={cn("px-1.5 py-1 align-middle", gutter && "rule-gutter")}>
      <Input
        numeric
        inputMode="decimal"
        autoComplete="off"
        value={value}
        disabled={disabled}
        invalid={invalid}
        aria-label={side === "debit" ? "Debit" : "Credit"}
        placeholder="0.00"
        className="h-7"
        onChange={(event) => onChange(line.key, (current) => setAmount(current, side, event.target.value))}
        onBlur={normalise}
      />
    </td>
  );
}

function DimensionSelect({
  label,
  placeholder,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string | null;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <Select
      value={value ?? NONE}
      disabled={disabled || options.length === 0}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
    >
      <SelectTrigger aria-label={label} className="h-7">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          <span className="text-muted-foreground">{placeholder}: none</span>
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

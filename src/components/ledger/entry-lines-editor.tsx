"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
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
    <div>
      <table className="w-full border-separate border-spacing-0 text-sm md:min-w-[860px]">
        <caption className="sr-only">Journal entry lines</caption>
        <thead className="max-md:sr-only">
          <tr>
            <Th className="w-10 pl-5 text-right">#</Th>
            <Th className="min-w-56">Account</Th>
            <Th className="w-32 text-right">Debit</Th>
            <Th className="w-32 text-right">Credit</Th>
            <Th className="min-w-44">Memo</Th>
            <Th className="w-36">Channel</Th>
            <Th className="w-40">Product</Th>
            <Th className="w-10 pr-4">
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
                  className={cn(
                    "align-middle transition-colors",
                    "max-md:mx-4 max-md:mb-2.5 max-md:grid max-md:grid-cols-2 max-md:gap-2 max-md:rounded-[14px] max-md:bg-inset max-md:p-3",
                    focusedKey === line.key && "md:bg-tint-blue/[0.06]",
                  )}
                >
                  <Td className="num pl-5 text-right text-xs text-label2 max-md:hidden">{index + 1}</Td>
                  <Td className="max-md:col-span-2">
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
                      className={cn(CELL, "md:h-8")}
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
                    onChange={patchLine}
                  />
                  <Td className="max-md:col-span-2">
                    <Input
                      value={line.memo}
                      disabled={disabled}
                      placeholder="Memo"
                      aria-label={`Memo, line ${index + 1}`}
                      className={CELL}
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
                  <Td className="pr-4 text-right max-md:col-span-2 max-md:text-left">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled || (lines.length === 1 && isLineEmpty(line))}
                      aria-label={`Remove line ${index + 1}`}
                      onClick={() => removeLine(line.key)}
                      className="text-label2 hover:text-ink-red max-md:w-full max-md:gap-1.5 max-md:text-sm"
                    >
                      <Glyph name="trash" size={15} />
                      <span className="md:hidden">Remove</span>
                    </Button>
                  </Td>
                </tr>
                {error === undefined ? null : (
                  <tr className="max-md:block max-md:px-4 max-md:pb-2">
                    <td className="max-md:hidden" />
                    <td colSpan={7} className="pb-1.5 text-xs font-medium text-ink-red max-md:block">
                      {error}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
        <tfoot className="max-md:hidden">
          <tr>
            <td />
            <td className="px-1.5 py-2 text-xs font-semibold text-label2">Total</td>
            <td className="num px-3.5 py-2 text-right font-bold">{formatCents(totals.debitCents)}</td>
            <td className="num px-3.5 py-2 text-right font-bold">{formatCents(totals.creditCents)}</td>
            <td colSpan={4} />
          </tr>
        </tfoot>
      </table>

      <div className="hairline-t px-3 py-2 max-md:px-4">
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => addLineAfter(null)} className="text-ink-blue">
          <Glyph name="plus" size={14} />
          Add line
          <kbd className="ml-1 hidden rounded-[4px] bg-fill2 px-1 text-2xs font-medium text-label2 md:inline">⏎</kbd>
        </Button>
      </div>
    </div>
  );
}

/** A Numbers cell: no bezel until hovered or focused. */
const CELL = "h-8 rounded-[6px] bg-transparent shadow-none hover:bg-fill2 max-md:bg-card max-md:shadow-ctl";

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className={cn(
        "rule-head bg-card px-1.5 pt-1 pb-1.5 text-left text-xs font-semibold text-label2",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={cn("rule-row px-1.5 py-0.5 align-middle max-md:border-0 max-md:p-0", className)}>{children}</td>;
}

function AmountCell({
  side,
  line,
  disabled,
  invalid,
  onChange,
}: {
  side: AmountSide;
  line: DraftLineState;
  disabled: boolean;
  invalid: boolean;
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
    <td className="rule-row px-1.5 py-0.5 align-middle max-md:border-0 max-md:p-0">
      <span className="mb-1 block text-2xs font-medium text-label2 md:hidden">{side === "debit" ? "Debit" : "Credit"}</span>
      <Input
        numeric
        inputMode="decimal"
        autoComplete="off"
        value={value}
        disabled={disabled}
        invalid={invalid}
        aria-label={side === "debit" ? "Debit" : "Credit"}
        placeholder="0.00"
        className={cn(invalid ? "h-8 rounded-[6px]" : CELL, "font-medium")}
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
      <SelectTrigger aria-label={label} className={CELL}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          <span className="text-label2">No {placeholder.toLowerCase()}</span>
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

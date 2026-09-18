/**
 * What the banking screens show for a bank line, as plain functions: the bank's short label, the
 * account a row posts to and its category, the flow a posting draws, and month grouping. No React,
 * so server pages and client components share them.
 */

import type { FlowNode, FlowTarget } from "@/components/charts";
import { categoryFor, categoryForCode, type Category } from "@/lib/ui/categories";
import { MONTHS_LONG } from "@/lib/ui/format";

import type { AccountOption, AccountRef, QueueRow, QueueStage } from "./types";

// ---------------------------------------------------------------------------
// What a row shows
// ---------------------------------------------------------------------------

/** "Relay — Operating Expenses" + "9726" → "Relay ••9726": the bank, then the card's last four. */
export function bankLabel(row: Pick<QueueRow, "bankAccountName" | "bankAccountMask">): string {
  const brand = row.bankAccountName.split(/\s+—\s+/)[0]?.trim() || row.bankAccountName;
  return row.bankAccountMask === null ? brand : `${brand} ••${row.bankAccountMask}`;
}

/** The other account's name without the bank's prefix: "Relay — Owner's Comp" → "Owner's Comp". */
export function bankShortName(name: string): string {
  return name.replace(/^[^—]*—\s*/, "") || name;
}

/** The account the row posts (or posted) to: the owner's pick, else what the engine proposed. */
export function shownAccount(
  row: QueueRow,
  stage: QueueStage,
  override: AccountOption | undefined,
): AccountRef | null {
  if (stage === "posted") return row.postedAccount;
  return override ?? row.suggestion.account ?? row.refundOriginal?.account ?? null;
}

export type AccountIndex = ReadonlyMap<string, AccountOption>;

export function indexAccounts(accounts: readonly AccountOption[]): AccountIndex {
  return new Map(accounts.map((a) => [a.id, a]));
}

/** The account's category (one tint, one glyph), from the full chart row where there is one. */
export function categoryOf(account: AccountRef | null, index: AccountIndex): Category | null {
  if (account === null) return null;
  const full = index.get(account.id);
  if (full === undefined) return categoryForCode(account.code);
  const parent = full.parentId === null ? undefined : index.get(full.parentId);
  return categoryFor({ code: full.code, subtype: full.subtype, type: full.type, parentCode: parent?.code ?? null });
}

const BANK_NODE_TINT = "green" as const;

/**
 * The flow the posting draws: money out moves from the bank (credit) to the account (debit);
 * money in the other way round. A transfer moves between the two banks.
 */
export function flowFor(
  row: QueueRow,
  account: AccountRef | null,
  category: Category | null,
): { from: FlowNode; to: FlowTarget[] } {
  const cents = Math.abs(row.amountCents);
  const bank: FlowNode = { label: bankLabel(row), glyph: "bank", tint: BANK_NODE_TINT };
  let other: FlowNode;
  if (row.status === "transfer") {
    other = {
      label: row.transferPartner === null ? "Other bank" : bankShortName(row.transferPartner.bankAccountName),
      glyph: "bank",
      tint: "blue",
    };
  } else if (account === null) {
    other = { label: "Choose account", glyph: "question", tint: "gray" };
  } else {
    const c = category ?? categoryForCode(account.code);
    other = { label: account.name, glyph: c.glyph, tint: c.tint };
  }
  return row.amountCents < 0
    ? { from: bank, to: [{ ...other, cents }] }
    : { from: other, to: [{ ...bank, cents }] };
}

/** '2026-09' → 'September' this year, 'September 2025' otherwise. */
export function monthHeader(month: string, currentYear: string): string {
  const [year, m] = month.split("-");
  const name = MONTHS_LONG[Number(m) - 1] ?? month;
  return year === currentYear ? name : `${name} ${year}`;
}

export interface MonthBucket<T> {
  month: string;
  items: T[];
}

/** Consecutive items grouped by the 'YYYY-MM' of their date, in the order given. */
export function byMonth<T>(items: readonly T[], dateOf: (item: T) => string): MonthBucket<T>[] {
  const out: MonthBucket<T>[] = [];
  for (const item of items) {
    const month = dateOf(item).slice(0, 7);
    const last = out[out.length - 1];
    if (last !== undefined && last.month === month) last.items.push(item);
    else out.push({ month, items: [item] });
  }
  return out;
}

/** "••9726 Operating Expenses" → "Operating Expenses ••9726"; a bare mask stays "••9727". */
export function accountLabel(tab: { name: string; mask: string | null }): string {
  const bare = tab.name.replace(/^••\d+\s*/, "").trim();
  if (tab.mask === null) return bare;
  return bare === "" ? `••${tab.mask}` : `${bare} ••${tab.mask}`;
}

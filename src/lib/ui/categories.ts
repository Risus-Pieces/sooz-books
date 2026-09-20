/**
 * The category system: every account in the books belongs to one category, and each category owns
 * one tint and one glyph everywhere — chart legends, list dots, review rows, pop-up buttons and
 * report rows. So a colour means the same thing on every screen.
 *
 * A category is derived, never assigned per page: first from the account's own code where the chart
 * of accounts gives that code a specific meaning (1320 Raw Ingredients), then from its parent (any
 * new account under 6100 is advertising), then from its subtype. The function is pure, so the same
 * account always resolves to the same category.
 */

import type { AccountSubtype, AccountType } from "@/lib/ledger/coa";

import type { GlyphName } from "./glyphs";
import type { Tint } from "./tints";

export type CategoryKey =
  | "cash"
  | "clearing"
  | "receivables"
  | "inventory"
  | "ingredients"
  | "packaging"
  | "prepaid"
  | "equipment"
  | "payables"
  | "cards"
  | "taxes"
  | "loans"
  | "founder"
  | "equity"
  | "revenue"
  | "trade"
  | "production"
  | "freight"
  | "fees"
  | "advertising"
  | "creative"
  | "payroll"
  | "formulation"
  | "professional"
  | "occupancy"
  | "software"
  | "travel"
  | "meals"
  | "office"
  | "compliance"
  | "other"
  | "ask";

export interface Category {
  key: CategoryKey;
  /** One or two words. */
  label: string;
  tint: Tint;
  glyph: GlyphName;
}

export const CATEGORIES: Readonly<Record<CategoryKey, Category>> = Object.freeze({
  cash: { key: "cash", label: "Cash", tint: "blue", glyph: "bank" },
  clearing: { key: "clearing", label: "Clearing", tint: "mint", glyph: "clearing" },
  receivables: { key: "receivables", label: "Receivables", tint: "green", glyph: "doc-text" },
  inventory: { key: "inventory", label: "Inventory", tint: "teal", glyph: "cube" },
  ingredients: { key: "ingredients", label: "Raw Ingredients", tint: "teal", glyph: "leaf" },
  packaging: { key: "packaging", label: "Packaging", tint: "brown", glyph: "cube" },
  prepaid: { key: "prepaid", label: "Prepaid", tint: "gray", glyph: "hourglass" },
  equipment: { key: "equipment", label: "Equipment", tint: "gray", glyph: "wrench" },
  payables: { key: "payables", label: "Payables", tint: "red", glyph: "doc" },
  cards: { key: "cards", label: "Cards", tint: "red", glyph: "credit-card" },
  taxes: { key: "taxes", label: "Taxes", tint: "gray", glyph: "doc-text" },
  loans: { key: "loans", label: "Loans", tint: "red", glyph: "bank" },
  founder: { key: "founder", label: "Founder", tint: "indigo", glyph: "person" },
  equity: { key: "equity", label: "Equity", tint: "indigo", glyph: "book" },
  revenue: { key: "revenue", label: "Revenue", tint: "green", glyph: "tag" },
  trade: { key: "trade", label: "Trade spend", tint: "cyan", glyph: "globe" },
  production: { key: "production", label: "Production", tint: "teal", glyph: "cube" },
  freight: { key: "freight", label: "Freight", tint: "cyan", glyph: "truck" },
  fees: { key: "fees", label: "Fees", tint: "gray", glyph: "percent" },
  advertising: { key: "advertising", label: "Ads", tint: "indigo", glyph: "megaphone" },
  creative: { key: "creative", label: "Creative", tint: "pink", glyph: "brush" },
  payroll: { key: "payroll", label: "Payroll", tint: "mint", glyph: "people" },
  formulation: { key: "formulation", label: "Formulation", tint: "purple", glyph: "flask" },
  professional: { key: "professional", label: "Professional", tint: "gray", glyph: "briefcase" },
  occupancy: { key: "occupancy", label: "Occupancy", tint: "brown", glyph: "building" },
  software: { key: "software", label: "Software", tint: "gray", glyph: "laptop" },
  travel: { key: "travel", label: "Travel", tint: "mint", glyph: "plane" },
  meals: { key: "meals", label: "Meals", tint: "orange", glyph: "fork-knife" },
  office: { key: "office", label: "Office Supplies", tint: "blue", glyph: "paperclip" },
  compliance: { key: "compliance", label: "Compliance", tint: "gray", glyph: "shield" },
  other: { key: "other", label: "Other", tint: "gray", glyph: "ellipsis" },
  ask: { key: "ask", label: "Ask accountant", tint: "orange", glyph: "question" },
});

/** Codes whose meaning is narrower than their subtype. */
const BY_CODE: Readonly<Record<string, CategoryKey>> = Object.freeze({
  "1220": "receivables",
  // inventory held
  "1320": "ingredients",
  "1330": "packaging",
  // founder money — the pooled accounts and each member's own beneath them
  "3000": "founder",
  "3010": "founder",
  "3015": "founder",
  "3016": "founder",
  "3017": "founder",
  "3020": "founder",
  "3021": "founder",
  "3022": "founder",
  "2550": "founder",
  // cost of goods
  "5015": "ingredients",
  "5020": "packaging",
  "5030": "freight",
  "5040": "freight",
  // fulfillment
  "5540": "fees",
  "5560": "packaging",
  // marketing
  "6170": "creative",
  // research & development
  "6330": "creative",
  // general & administrative
  "6710": "fees",
  "6720": "travel",
  "6730": "meals",
  "6740": "office",
  "6750": "software",
  "6900": "equipment",
  // other expense
  "7110": "fees",
  "7120": "fees",
});

/** A new account under one of these parents inherits the parent's meaning. */
const BY_PARENT: Readonly<Record<string, CategoryKey>> = Object.freeze({
  "1300": "inventory",
  "1500": "equipment",
  "2050": "cards",
  "5000": "production",
  "5500": "freight",
  "6100": "advertising",
  "6200": "payroll",
  "6300": "formulation",
  "6400": "professional",
  "6500": "occupancy",
  "6600": "software",
  "6700": "other",
  "6800": "compliance",
});

const BY_SUBTYPE: Readonly<Record<AccountSubtype, CategoryKey>> = Object.freeze({
  cash: "cash",
  bank: "cash",
  undeposited_funds: "cash",
  clearing: "clearing",
  accounts_receivable: "receivables",
  other_receivable: "receivables",
  contra_asset: "other",
  inventory: "inventory",
  prepaid: "prepaid",
  deposit: "prepaid",
  fixed_asset: "equipment",
  accounts_payable: "payables",
  credit_card: "cards",
  accrued_liability: "payables",
  tax_payable: "taxes",
  customer_deposit: "payables",
  deferred_revenue: "payables",
  debt: "loans",
  other_liability: "payables",
  equity: "equity",
  contra_equity: "founder",
  retained_earnings: "equity",
  opening_balance: "equity",
  sales: "revenue",
  shipping_income: "revenue",
  other_revenue: "revenue",
  contra_revenue: "trade",
  cogs: "production",
  fulfillment: "freight",
  operating_expense: "other",
  marketing: "advertising",
  payroll: "payroll",
  research_development: "formulation",
  professional_fees: "professional",
  occupancy: "occupancy",
  technology: "software",
  general_admin: "other",
  compliance: "compliance",
  depreciation: "equipment",
  other_expense: "other",
  income_tax: "taxes",
  suspense: "ask",
});

const BY_TYPE: Readonly<Record<AccountType, CategoryKey>> = Object.freeze({
  asset: "other",
  liability: "payables",
  equity: "equity",
  revenue: "revenue",
  expense: "other",
});

/** What the category function needs to know about an account. Any account row satisfies it. */
export interface CategorizableAccount {
  code: string;
  subtype?: string | null;
  parentCode?: string | null;
  type?: string | null;
}

function isSubtype(value: string): value is AccountSubtype {
  return Object.prototype.hasOwnProperty.call(BY_SUBTYPE, value);
}

function isType(value: string): value is AccountType {
  return Object.prototype.hasOwnProperty.call(BY_TYPE, value);
}

export function categoryKeyFor(account: CategorizableAccount): CategoryKey {
  const byCode = BY_CODE[account.code];
  if (byCode) return byCode;
  if (account.parentCode) {
    const byParent = BY_PARENT[account.parentCode];
    if (byParent) return byParent;
  }
  if (account.subtype && isSubtype(account.subtype)) return BY_SUBTYPE[account.subtype];
  if (account.type && isType(account.type)) return BY_TYPE[account.type];
  return "other";
}

export function categoryFor(account: CategorizableAccount): Category {
  return CATEGORIES[categoryKeyFor(account)];
}

/**
 * Best effort from a bare code, for places that only carry the code (a review suggestion, a report
 * row). Uses the code table, then the chart's numbering: the parent is the code with its last
 * significant digits zeroed, the subtype is unknown. Prefer `categoryFor` with the full row.
 */
export function categoryForCode(code: string | null | undefined): Category {
  if (!code) return CATEGORIES.other;
  const exact = BY_CODE[code];
  if (exact) return CATEGORIES[exact];
  if (!/^\d{4}$/.test(code)) return CATEGORIES.other;
  const parent = BY_PARENT[`${code.slice(0, 3)}0`] ?? BY_PARENT[`${code.slice(0, 2)}00`];
  if (parent) return CATEGORIES[parent];
  const n = Number(code);
  const range = CODE_RANGES.find(([from, to]) => n >= from && n < to);
  return CATEGORIES[range ? range[2] : "other"];
}

/** The chart's numbering plan, for codes known only as codes. [from, to) → category. */
const CODE_RANGES: ReadonlyArray<readonly [number, number, CategoryKey]> = [
  [1000, 1100, "cash"],
  [1100, 1200, "clearing"],
  [1200, 1300, "receivables"],
  [1400, 1500, "prepaid"],
  [1500, 1600, "equipment"],
  [2200, 2220, "taxes"],
  [2500, 2600, "loans"],
  [2000, 3000, "payables"],
  [3000, 3900, "founder"],
  [3900, 4000, "equity"],
  [4000, 4500, "revenue"],
  [4500, 5000, "trade"],
  [7000, 7100, "revenue"],
  [7200, 7300, "taxes"],
  [7900, 8000, "ask"],
];

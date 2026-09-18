import type { GlyphName } from "@/lib/ui/glyphs";
import type { Tint } from "@/lib/ui/tints";

import { bankingNav } from "./modules/banking";
import { channelsNav } from "./modules/channels";
import { inventoryNav } from "./modules/inventory";
import { planNav } from "./modules/plan";
import { purchasesNav } from "./modules/purchases";
import { salesNav } from "./modules/sales";
import { tradeNav } from "./modules/trade";
import type { NavGroupKey, NavModule } from "./modules/types";

export interface NavLink {
  label: string;
  href: string;
}

export interface NavSection {
  /** One word, two at most. */
  label: string;
  href: string;
  /** The white glyph on the section's coloured rounded-square badge. */
  glyph: GlyphName;
  tint: Tint;
  /** A live count shown at the trailing edge (the review queue). */
  count?: "review";
  /** Pages inside the section, listed under it while it is the current section. */
  children?: NavLink[];
}

export interface NavGroup {
  key: "top" | NavGroupKey | "footer";
  /** Quiet heading over the group. The first and footer groups have none. */
  label?: string;
  sections: NavSection[];
}

/** Remembers whether the desktop sidebar is shown. Read on the server so the shell never jumps. */
export const NAV_COLLAPSE_COOKIE = "sooz-nav-collapsed";

const MODULES: NavModule[] = [bankingNav, salesNav, purchasesNav, channelsNav, tradeNav, inventoryNav, planNav];

function shipped(group: NavGroupKey): NavSection[] {
  return MODULES.filter((m) => m.shipped && m.group === group).flatMap((m) => m.sections);
}

/** Home and Review: the two places the owner goes every day. */
export const HOME: NavSection = { label: "Home", href: "/dashboard", glyph: "home", tint: "blue" };
export const REVIEW: NavSection = {
  label: "Review",
  href: "/banking/review",
  glyph: "tray",
  tint: "orange",
  count: "review",
};
export const REPORTS: NavSection = {
  label: "Reports",
  href: "/reports",
  glyph: "chart",
  tint: "purple",
  children: [
    { label: "P&L", href: "/reports/profit-loss" },
    { label: "Balance Sheet", href: "/reports/balance-sheet" },
    { label: "Trial Balance", href: "/reports/trial-balance" },
    { label: "General Ledger", href: "/reports/general-ledger" },
    { label: "Cash Flow", href: "/reports/cash-flow" },
  ],
};
export const SETTINGS: NavSection = {
  label: "Settings",
  href: "/settings",
  glyph: "gear",
  tint: "gray",
  children: [{ label: "Users", href: "/settings/users" }],
};

/**
 * The sidebar, top to bottom: Home · Review · Banking · Business · Books · Settings. Every href must
 * be a route under `src/app/(app)` — the sidebar, the phone's More list and search all read this list
 * (nav.test.ts checks). Each operating module owns its rows in ./modules/<module>.ts.
 */
const ALL_GROUPS: NavGroup[] = [
  { key: "top", sections: [HOME, REVIEW] },
  { key: "banking", label: "Banking", sections: shipped("banking") },
  { key: "business", label: "Business", sections: shipped("business") },
  {
    key: "books",
    label: "Books",
    sections: [
      {
        label: "Ledger",
        href: "/ledger",
        glyph: "book",
        tint: "indigo",
        children: [
          { label: "Chart of Accounts", href: "/ledger/accounts" },
          { label: "Audit", href: "/ledger/audit" },
        ],
      },
      REPORTS,
      { label: "Close", href: "/close", glyph: "lock", tint: "gray" },
      ...shipped("books"),
    ],
  },
  { key: "footer", sections: [SETTINGS] },
];

/** A group whose modules have not shipped yet would render as an orphaned heading. */
export const NAV_GROUPS: NavGroup[] = ALL_GROUPS.filter((group) => group.sections.length > 0);

export const NAV_SECTIONS: NavSection[] = NAV_GROUPS.flatMap((group) => group.sections);

export function isRouteActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The one section the sidebar selects for a path: the longest href that contains it, so
 * /banking/review selects Review rather than Accounts. Child links count toward their section
 * (/reports/margin is listed under Inventory).
 */
export function activeSectionHref(pathname: string): string | null {
  let best: { href: string; length: number } | null = null;
  for (const section of NAV_SECTIONS) {
    const candidates = [section.href, ...(section.children ?? []).map((c) => c.href)];
    for (const href of candidates) {
      if (isRouteActive(pathname, href) && (best === null || href.length > best.length)) {
        best = { href: section.href, length: href.length };
      }
    }
  }
  return best?.href ?? null;
}

/** The child link the path is on, if any: the longest match. */
export function activeChildHref(pathname: string, section: NavSection): string | null {
  let best: string | null = null;
  for (const child of section.children ?? []) {
    if (isRouteActive(pathname, child.href) && (best === null || child.href.length > best.length)) best = child.href;
  }
  return best;
}

/** Label for a path, used by breadcrumbs and search. */
export function labelForPath(href: string): string | null {
  for (const section of NAV_SECTIONS) {
    if (section.href === href) return section.label;
    const child = section.children?.find((item) => item.href === href);
    if (child) return child.label;
  }
  return null;
}

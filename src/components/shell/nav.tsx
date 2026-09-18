import {
  BookOpen,
  CalendarCheck,
  ChartNoAxesColumn,
  LayoutDashboard,
  Settings,
  type LucideIcon,
} from "lucide-react";

import { bankingNav } from "./modules/banking";
import { channelsNav } from "./modules/channels";
import { inventoryNav } from "./modules/inventory";
import { planNav } from "./modules/plan";
import { purchasesNav } from "./modules/purchases";
import { salesNav } from "./modules/sales";
import { tradeNav } from "./modules/trade";
import type { NavModule } from "./modules/types";

/** Only the modules whose pages have shipped reach the rail. */
function shipped(...modules: NavModule[]): NavSection[] {
  return modules.filter((m) => m.shipped).map((m) => m.section);
}

export interface NavLink {
  label: string;
  href: string;
}

export interface NavSection {
  label: string;
  href: string;
  icon: LucideIcon;
  children?: NavLink[];
}

export interface NavGroup {
  /** Quiet heading that says what kind of work the sections below it are. */
  label?: string;
  sections: NavSection[];
}

/** Remembers the rail's width across visits. Read on the server so the shell never resizes on load. */
export const NAV_COLLAPSE_COOKIE = "sooz-nav-collapsed";

/**
 * Every href here must be a route that exists under `src/app/(app)`: the rail, the breadcrumbs and
 * the command palette all read this list, so a link to a module that has not shipped is a dead end
 * in three places at once. Each operating module owns its entry in ./modules/<module>.ts and flips
 * `shipped` in the same change that adds its pages.
 */
const ALL_GROUPS: NavGroup[] = [
  {
    sections: [{ label: "Dashboard", href: "/dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Operations",
    sections: shipped(bankingNav, salesNav, purchasesNav, channelsNav, tradeNav, inventoryNav),
  },
  {
    label: "Books",
    sections: [
      {
        label: "Ledger",
        href: "/ledger",
        icon: BookOpen,
        children: [
          { label: "Chart of Accounts", href: "/ledger/accounts" },
          { label: "Audit", href: "/ledger/audit" },
        ],
      },
      {
        label: "Reports",
        href: "/reports",
        icon: ChartNoAxesColumn,
        children: [
          { label: "P&L", href: "/reports/profit-loss" },
          { label: "Balance Sheet", href: "/reports/balance-sheet" },
          { label: "Trial Balance", href: "/reports/trial-balance" },
          { label: "General Ledger", href: "/reports/general-ledger" },
          { label: "Cash Flow", href: "/reports/cash-flow" },
        ],
      },
      { label: "Close", href: "/close", icon: CalendarCheck },
      ...shipped(planNav),
    ],
  },
  {
    sections: [
      {
        label: "Settings",
        href: "/settings",
        icon: Settings,
        children: [{ label: "Users", href: "/settings/users" }],
      },
    ],
  },
];

/** A group whose modules have not shipped yet would render as an orphaned heading. */
export const NAV_GROUPS: NavGroup[] = ALL_GROUPS.filter((group) => group.sections.length > 0);

export const NAV_SECTIONS: NavSection[] = NAV_GROUPS.flatMap((group) => group.sections);

export function isRouteActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Label for a path, used by breadcrumbs and search. Falls back to a title-cased segment. */
export function labelForPath(href: string): string | null {
  for (const section of NAV_SECTIONS) {
    if (section.href === href) return section.label;
    const child = section.children?.find((item) => item.href === href);
    if (child) return child.label;
  }
  return null;
}

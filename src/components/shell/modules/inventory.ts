import { Package } from "lucide-react";

import type { NavModule } from "./types";

/**
 * Owned by the Inventory module. Set `shipped` to true in the same change that adds these pages,
 * and trim `children` to the routes that actually exist: a link to an unshipped page is a dead
 * end in the rail, the breadcrumbs and the command palette at once.
 */
export const inventoryNav: NavModule = {
  shipped: false,
  section: {
    label: "Inventory",
    href: "/inventory",
    icon: Package,
    children: [
    { label: "Valuation", href: "/inventory/valuation" },
    { label: "Production Runs", href: "/inventory/production" },
    { label: "COGS", href: "/inventory/cogs" },
    { label: "Adjustments", href: "/inventory/adjustments" },
    ],
  },
};

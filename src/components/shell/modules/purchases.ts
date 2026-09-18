import { ShoppingCart } from "lucide-react";

import type { NavModule } from "./types";

/**
 * Owned by the Purchases module. Set `shipped` to true in the same change that adds these pages,
 * and trim `children` to the routes that actually exist: a link to an unshipped page is a dead
 * end in the rail, the breadcrumbs and the command palette at once.
 */
export const purchasesNav: NavModule = {
  shipped: false,
  section: {
    label: "Purchases",
    href: "/purchases",
    icon: ShoppingCart,
    children: [
    { label: "Bills", href: "/purchases/bills" },
    { label: "Vendors", href: "/purchases/vendors" },
    { label: "Payments", href: "/purchases/payments" },
    { label: "AP Aging", href: "/purchases/aging" },
    { label: "1099", href: "/purchases/1099" },
    ],
  },
};

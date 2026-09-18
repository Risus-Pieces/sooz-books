import { Handshake } from "lucide-react";

import type { NavModule } from "./types";

/**
 * Owned by the Trade module. Set `shipped` to true in the same change that adds these pages,
 * and trim `children` to the routes that actually exist: a link to an unshipped page is a dead
 * end in the rail, the breadcrumbs and the command palette at once.
 */
export const tradeNav: NavModule = {
  shipped: false,
  section: {
    label: "Trade",
    href: "/trade",
    icon: Handshake,
    children: [
    { label: "Promotions", href: "/trade/promotions" },
    { label: "Deductions", href: "/trade/deductions" },
    { label: "Remittances", href: "/trade/remittances" },
    ],
  },
};

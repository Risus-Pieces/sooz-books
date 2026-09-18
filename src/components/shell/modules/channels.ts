import { Store } from "lucide-react";

import type { NavModule } from "./types";

/**
 * Owned by the Channels module. Set `shipped` to true in the same change that adds these pages,
 * and trim `children` to the routes that actually exist: a link to an unshipped page is a dead
 * end in the rail, the breadcrumbs and the command palette at once.
 */
export const channelsNav: NavModule = {
  shipped: false,
  section: {
    label: "Channels",
    href: "/channels",
    icon: Store,
    children: [
    { label: "Payouts", href: "/channels/payouts" },
    { label: "Sales Tax", href: "/channels/sales-tax" },
    ],
  },
};

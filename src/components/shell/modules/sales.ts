import { Receipt } from "lucide-react";

import type { NavModule } from "./types";

/**
 * Owned by the Sales module. Set `shipped` to true in the same change that adds these pages,
 * and trim `children` to the routes that actually exist: a link to an unshipped page is a dead
 * end in the rail, the breadcrumbs and the command palette at once.
 */
export const salesNav: NavModule = {
  shipped: true,
  section: {
    label: "Sales",
    href: "/sales",
    icon: Receipt,
    children: [
    { label: "Invoices", href: "/sales/invoices" },
    { label: "Customers", href: "/sales/customers" },
    { label: "Receipts", href: "/sales/receipts" },
    { label: "AR Aging", href: "/sales/aging" },
    ],
  },
};

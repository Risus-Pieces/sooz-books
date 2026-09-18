import type { NavModule } from "./types";

/** Owned by the Sales module. List only routes that exist. */
export const salesNav: NavModule = {
  shipped: true,
  group: "business",
  sections: [
    {
      label: "Sales",
      href: "/sales",
      glyph: "tag",
      tint: "pink",
      children: [
        { label: "Invoices", href: "/sales/invoices" },
        { label: "Customers", href: "/sales/customers" },
        { label: "Receipts", href: "/sales/receipts" },
        { label: "Aging", href: "/sales/aging" },
      ],
    },
  ],
};

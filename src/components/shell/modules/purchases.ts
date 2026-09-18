import type { NavModule } from "./types";

/** Owned by the Purchases module. List only routes that exist. */
export const purchasesNav: NavModule = {
  shipped: true,
  group: "business",
  sections: [
    {
      label: "Purchases",
      href: "/purchases",
      glyph: "bag",
      tint: "red",
      children: [
        { label: "Bills", href: "/purchases/bills" },
        { label: "Vendors", href: "/purchases/vendors" },
        { label: "Payments", href: "/purchases/payments" },
        { label: "Aging", href: "/purchases/aging" },
        { label: "1099", href: "/purchases/1099" },
      ],
    },
  ],
};

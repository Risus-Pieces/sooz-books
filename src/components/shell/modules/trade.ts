import type { NavModule } from "./types";

/** Owned by the Trade module. List only routes that exist. */
export const tradeNav: NavModule = {
  shipped: true,
  group: "business",
  sections: [
    {
      label: "Trade",
      href: "/trade",
      glyph: "globe",
      tint: "cyan",
      children: [
        { label: "Promotions", href: "/trade/promotions" },
        { label: "Deductions", href: "/trade/deductions" },
        { label: "Remittances", href: "/trade/remittances" },
      ],
    },
  ],
};

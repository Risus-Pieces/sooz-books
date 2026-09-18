import type { NavModule } from "./types";

/** Owned by the Inventory module. List only routes that exist. */
export const inventoryNav: NavModule = {
  shipped: true,
  group: "business",
  sections: [
    {
      label: "Inventory",
      href: "/inventory",
      glyph: "cube",
      tint: "brown",
      children: [
        { label: "Valuation", href: "/inventory/valuation" },
        { label: "Production", href: "/inventory/production" },
        { label: "COGS", href: "/inventory/cogs" },
        { label: "Adjustments", href: "/inventory/adjustments" },
        { label: "Margin", href: "/reports/margin" },
      ],
    },
  ],
};

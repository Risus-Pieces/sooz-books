import type { NavModule } from "./types";

/** Owned by the Channels module. List only routes that exist. */
export const channelsNav: NavModule = {
  shipped: true,
  group: "business",
  sections: [
    {
      label: "Channels",
      href: "/channels",
      glyph: "storefront",
      tint: "teal",
      children: [
        { label: "Payouts", href: "/channels/payouts" },
        { label: "Sales tax", href: "/channels/sales-tax" },
      ],
    },
  ],
};

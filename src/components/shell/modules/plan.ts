import type { NavModule } from "./types";

/** Owned by the Plan module. List only routes that exist. */
export const planNav: NavModule = {
  shipped: true,
  group: "books",
  sections: [
    {
      label: "Plan",
      href: "/plan",
      glyph: "target",
      tint: "mint",
      children: [
        { label: "Forecast", href: "/plan/forecast" },
        { label: "Budget", href: "/plan/budget" },
      ],
    },
  ],
};

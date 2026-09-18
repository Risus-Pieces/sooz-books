import type { NavModule } from "./types";

/**
 * Owned by the Banking module. Review is not here: it is the sidebar's second row, beside Home,
 * with its live count (see ../nav.tsx). Import and Reconcile are reached from the Accounts toolbar
 * and stay listed as its pages so search and the phone's More list can find them.
 */
export const bankingNav: NavModule = {
  shipped: true,
  group: "banking",
  sections: [
    {
      label: "Accounts",
      href: "/banking",
      glyph: "bank",
      tint: "green",
      children: [
        { label: "Import", href: "/banking/import" },
        { label: "Reconcile", href: "/banking/reconcile" },
      ],
    },
    { label: "Rules", href: "/banking/rules", glyph: "wand", tint: "gray" },
  ],
};

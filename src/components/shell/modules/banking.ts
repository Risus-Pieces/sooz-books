import { Landmark } from "lucide-react";

import type { NavModule } from "./types";

/**
 * Owned by the Banking module. Set `shipped` to true in the same change that adds these pages,
 * and trim `children` to the routes that actually exist: a link to an unshipped page is a dead
 * end in the rail, the breadcrumbs and the command palette at once.
 */
export const bankingNav: NavModule = {
  shipped: true,
  section: {
    label: "Banking",
    href: "/banking",
    icon: Landmark,
    children: [
      { label: "Review Queue", href: "/banking/review" },
      { label: "Import", href: "/banking/import" },
      { label: "Reconcile", href: "/banking/reconcile" },
      { label: "Rules", href: "/banking/rules" },
    ],
  },
};

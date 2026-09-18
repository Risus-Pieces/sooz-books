import { TrendingUp } from "lucide-react";

import type { NavModule } from "./types";

/**
 * Owned by the Plan module. Set `shipped` to true in the same change that adds these pages,
 * and trim `children` to the routes that actually exist: a link to an unshipped page is a dead
 * end in the rail, the breadcrumbs and the command palette at once.
 */
export const planNav: NavModule = {
  shipped: true,
  section: {
    label: "Plan",
    href: "/plan",
    icon: TrendingUp,
    children: [
      { label: "Cash Forecast", href: "/plan/forecast" },
      { label: "Budget", href: "/plan/budget" },
    ],
  },
};

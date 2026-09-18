import type { ProviderKey } from "./types";

/**
 * What each channel's settlement file is and where to get it. The words follow
 * `docs/formats/*.md`: they are the menu paths the owner will actually click.
 */
export interface ProviderGuide {
  /** The file this screen imports. */
  file: string;
  /** Where to find it. */
  path: string;
  /** What the file must be to tie. */
  note: string;
  accept: string;
  /** Shopify only: the second, optional file. */
  secondary: { label: string; path: string } | null;
}

export const PROVIDER_GUIDE: Readonly<Record<ProviderKey, ProviderGuide>> = {
  square: {
    file: "Transfers report (CSV)",
    path: "Square Dashboard → Banking → View all transfers → choose the dates → Export → transaction details",
    note: "Each transfer is tied to its SQ + date deposit in Relay.",
    accept: ".csv,text/csv",
    secondary: null,
  },
  shopify: {
    file: "Balance transactions (CSV)",
    path: "Shopify admin → Finance → Payouts → Export → Balance transactions",
    note: "Add the orders export to split sales tax by state.",
    accept: ".csv,text/csv",
    secondary: { label: "Orders export (CSV, optional)", path: "Orders → Export → Plain CSV file" },
  },
  amazon: {
    file: "Settlement report, Flat File V2 (.txt)",
    path: "Seller Central → Payments → All Statements → Download Flat File V2",
    note: "Only about 90 days of settlements can be downloaded. Keep every file.",
    accept: ".txt,.tsv,text/plain,text/tab-separated-values",
    secondary: null,
  },
  faire: {
    file: "Payouts (CSV)",
    path: "Faire → Payouts → Export → Export CSV",
    note: "One settlement per payout date.",
    accept: ".csv,text/csv",
    secondary: null,
  },
};

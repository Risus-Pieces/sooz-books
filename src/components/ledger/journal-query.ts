import type { JournalFilters } from "./types";

export const EMPTY_JOURNAL_FILTERS: JournalFilters = {
  from: "",
  to: "",
  status: "",
  sourceType: "",
  accountId: "",
  minAmount: "",
  maxAmount: "",
  q: "",
};

/** The journal's URL query for a set of filters, plus anything else the link carries. */
export function journalQuery(filters: JournalFilters, extra: Readonly<Record<string, string>> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "") params.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

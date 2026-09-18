import type { NavSection } from "../nav";

/** Where a module's sections sit in the sidebar. */
export type NavGroupKey = "banking" | "business" | "books";

/** A module's contribution to the sidebar. Hidden until the module's pages ship. */
export interface NavModule {
  shipped: boolean;
  group: NavGroupKey;
  /** One or more sidebar rows, in order. */
  sections: NavSection[];
}

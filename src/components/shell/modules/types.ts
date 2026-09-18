import type { NavSection } from "../nav";

/** A module's contribution to the rail. Hidden until the module's pages ship. */
export interface NavModule {
  shipped: boolean;
  section: NavSection;
}

"use client";

import * as React from "react";

export interface ShellAccount {
  name: string;
  email: string;
  roleLabel: string;
}

export interface ShellPeriod {
  year: number;
  /** 1–12, from the period row. */
  month: number;
  status: "open" | "closed";
}

export interface ShellState {
  /** Transactions waiting in the review queue: the Review badge in the sidebar and tab bar. */
  reviewCount: number;
  account: ShellAccount | null;
  period: ShellPeriod | null;
  /** Desktop only: the sidebar has been hidden with the sidebar button. */
  sidebarHidden: boolean;
  toggleSidebar: () => void;
  /** Tablet: opens the sidebar over the content. */
  openNav: () => void;
  openSearch: () => void;
  openMore: () => void;
}

const ShellContext = React.createContext<ShellState | null>(null);

export const ShellProvider = ShellContext.Provider;

/** The shell's state, for toolbars and controls rendered inside a page. Null outside the app shell. */
export function useShell(): ShellState | null {
  return React.useContext(ShellContext);
}

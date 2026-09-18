"use client";

import * as React from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "sooz-theme";

/**
 * Runs before paint so the first frame is already in the right theme. Kept as a string because it
 * has to be inlined into <head/> ahead of React.
 */
export const themeBootstrapScript = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(p==="light"||p==="dark"){document.documentElement.setAttribute("data-theme",p)}}catch(e){}})()`;

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The preference lives in localStorage and on the <html> element, both outside React. Reading them
 * through useSyncExternalStore keeps the server render deterministic and avoids the mount-time
 * setState an effect-based read would otherwise need.
 */
const listeners = new Set<() => void>();

/** Authoritative within the page, so the toggle still works where storage is blocked. */
let memoryPreference: ThemePreference | null = null;

function isPreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function readPreference(): ThemePreference {
  if (memoryPreference) return memoryPreference;
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isPreference(raw)) return raw;
  } catch {
    // Private mode or blocked storage: follow the system.
  }
  return "system";
}

function writePreference(next: ThemePreference): void {
  memoryPreference = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // The choice holds for this session; it simply is not written down.
  }
  for (const listener of listeners) listener();
}

function subscribePreference(onChange: () => void): () => void {
  listeners.add(onChange);
  // A second tab of the same books should follow along.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function subscribeSystem(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function readSystemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

const serverPreference = (): ThemePreference => "system";
const serverSystemDark = (): boolean => false;

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const preference = React.useSyncExternalStore(
    subscribePreference,
    readPreference,
    serverPreference,
  );
  const systemDark = React.useSyncExternalStore(subscribeSystem, readSystemDark, serverSystemDark);

  const setPreference = React.useCallback((next: ThemePreference) => {
    if (next === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", next);
    }
    writePreference(next);
  }, []);

  const resolved: ResolvedTheme =
    preference === "system" ? (systemDark ? "dark" : "light") : preference;

  const value = React.useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Glyph } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";

import { NAV_GROUPS, type NavSection } from "./nav";

export interface SearchTarget {
  label: string;
  href: string;
  /** Heading this target is listed under. */
  group: string;
  /** Extra words that should match this target, e.g. "P&L income statement". */
  keywords?: string;
}

interface Target extends SearchTarget {
  section?: NavSection;
}

function navTargets(): Target[] {
  const targets: Target[] = [];
  for (const group of NAV_GROUPS) {
    for (const section of group.sections) {
      targets.push({ label: section.label, href: section.href, group: "Sections", section });
      for (const child of section.children ?? []) {
        targets.push({ label: child.label, href: child.href, group: section.label, section });
      }
    }
  }
  return targets;
}

export interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Records and reports contributed by feature modules, merged with the nav targets. */
  targets?: SearchTarget[];
}

/**
 * The ⌘K palette: jump to any section or page. Opened from the sidebar's search field, the toolbar's
 * search button on smaller screens, or ⌘K anywhere.
 */
export function GlobalSearch({ open, onOpenChange, targets }: GlobalSearchProps) {
  const router = useRouter();
  const allTargets = React.useMemo<Target[]>(() => [...navTargets(), ...(targets ?? [])], [targets]);

  const grouped = React.useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, Target[]>();
    for (const target of allTargets) {
      if (!map.has(target.group)) {
        map.set(target.group, []);
        order.push(target.group);
      }
      map.get(target.group)?.push(target);
    }
    return order.map((group) => ({ group, items: map.get(group) ?? [] }));
  }, [allTargets]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const go = React.useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [router, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        size="md"
        className="vibrancy p-0 sm:top-[16%] sm:translate-y-0 max-sm:top-3 max-sm:bottom-auto max-sm:mx-3 max-sm:rounded-[14px]"
      >
        <DialogTitle className="sr-only">Search Sooz Books</DialogTitle>
        <DialogDescription className="sr-only">Jump to any section or page.</DialogDescription>
        <Command loop>
          <CommandInput placeholder="Search" />
          <CommandList>
            <CommandEmpty>No match</CommandEmpty>
            {grouped.map(({ group, items }) => (
              <CommandGroup key={group} heading={group}>
                {items.map((item) => (
                  <CommandItem
                    key={`${group}:${item.href}`}
                    value={`${item.label} ${item.group} ${item.keywords ?? ""}`}
                    onSelect={() => go(item.href)}
                  >
                    {item.section && item.group === "Sections" ? (
                      <IconBadge glyph={item.section.glyph} tint={item.section.tint} size="sm" />
                    ) : (
                      <Glyph name="doc" size={15} />
                    )}
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

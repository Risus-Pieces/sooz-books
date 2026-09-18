"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { NAV_GROUPS } from "@/components/shell/nav";

export interface SearchTarget {
  label: string;
  href: string;
  /** Heading this target is listed under. */
  group: string;
  /** Extra words that should match this target, e.g. "P&L income statement". */
  keywords?: string;
}

function navTargets(): SearchTarget[] {
  const targets: SearchTarget[] = [];
  for (const group of NAV_GROUPS) {
    for (const section of group.sections) {
      targets.push({ label: section.label, href: section.href, group: "Sections" });
      for (const child of section.children ?? []) {
        targets.push({ label: child.label, href: child.href, group: section.label });
      }
    }
  }
  return targets;
}

export interface GlobalSearchProps {
  /** Records and reports contributed by feature modules, merged with the nav targets. */
  targets?: SearchTarget[];
  className?: string;
}

export function GlobalSearch({ targets, className }: GlobalSearchProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const allTargets = React.useMemo(() => [...navTargets(), ...(targets ?? [])], [targets]);

  const grouped = React.useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, SearchTarget[]>();
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
        setOpen((current) => !current);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const go = React.useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search"
        className={cn(
          "flex h-8 items-center gap-2 rounded-sm border border-border-strong bg-surface-raised px-2.5 max-sm:h-10 max-sm:w-10 max-sm:justify-center max-sm:px-0 text-sm text-muted-foreground transition-colors hover:border-ring hover:text-foreground",
          className,
        )}
      >
        <Search className="size-3.5 shrink-0" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="num ml-4 hidden text-2xs tracking-widest text-muted-foreground sm:inline">⌘K</kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent hideClose size="md" className="top-[18%] translate-y-0 p-0">
          <DialogTitle className="sr-only">Search Sooz Books</DialogTitle>
          <DialogDescription className="sr-only">
            Jump to any section, register or report.
          </DialogDescription>
          <Command loop>
            <CommandInput placeholder="Jump to a section, register or report" />
            <CommandList>
              <CommandEmpty>Nothing matches that. Try an account code or a report name.</CommandEmpty>
              {grouped.map(({ group, items }) => (
                <CommandGroup key={group} heading={group}>
                  {items.map((item) => (
                    <CommandItem
                      key={`${group}:${item.href}`}
                      value={`${item.label} ${item.group} ${item.keywords ?? ""}`}
                      onSelect={() => go(item.href)}
                    >
                      <span>{item.label}</span>
                      <CommandShortcut>{item.href}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}

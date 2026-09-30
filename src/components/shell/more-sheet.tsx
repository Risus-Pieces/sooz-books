"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";
import { signOut } from "@/lib/auth/actions";
import { Badge } from "@/components/ui/badge";
import { Glyph } from "@/components/ui/glyph";
import { IconBadge } from "@/components/ui/icon-badge";
import { Sheet, SheetContent } from "@/components/ui/sheet";

import { CompanyAvatar } from "./account-menu";
import { HOME, NAV_GROUPS, REVIEW, activeSectionHref, isRouteActive } from "./nav";
import { PeriodIndicator } from "./period-indicator";
import { useShell } from "./shell-context";
import { ThemeSegmented } from "./theme-toggle";

const ON_TABS = new Set([HOME.href, REVIEW.href]);

const row =
  "relative flex min-h-11 items-center gap-3 px-4 text-[1rem] outline-none focus-ring-inset transition-colors hover:bg-fill2 focus-visible:bg-fill2 before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[50px] before:border-t-[0.5px] before:border-sep first:before:hidden";

/**
 * The phone's More tab: every section the tab bar does not carry, grouped as in the sidebar, each
 * with its pages; then appearance, the working period and the account.
 */
export function MoreSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const pathname = usePathname() ?? "";
  const shell = useShell();
  const active = activeSectionHref(pathname);
  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" title="More" description="Every section of the books.">
        <div className="flex flex-col gap-5 pb-24">
          {shell?.canUseAssistant ? (
            <ul className="overflow-hidden rounded-[14px] bg-card shadow-card">
              <li className={row}>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    shell.openAssistant();
                  }}
                  className="flex min-h-11 flex-1 items-center gap-3 text-left"
                >
                  <IconBadge glyph="sparkle" tint="purple" size="lg" />
                  <span className="flex-1">Assistant</span>
                  <Glyph name="chevron-right" size={12} weight={2.4} className="text-label3" />
                </button>
              </li>
            </ul>
          ) : null}
          {NAV_GROUPS.map((group) => {
            const sections = group.sections.filter((s) => !ON_TABS.has(s.href));
            if (sections.length === 0) return null;
            return (
              <section key={group.key}>
                {group.label ? <h3 className="px-4 pb-1.5 text-sm font-semibold text-label2">{group.label}</h3> : null}
                <ul className="overflow-hidden rounded-[14px] bg-card shadow-card">
                  {sections.flatMap((section) => {
                    const on = active === section.href;
                    const items = [
                      <li key={section.href} className={row}>
                        <Link
                          href={section.href}
                          onClick={close}
                          aria-current={on && pathname === section.href ? "page" : undefined}
                          className="flex min-h-11 flex-1 items-center gap-3"
                        >
                          <IconBadge glyph={section.glyph} tint={section.tint} size="lg" />
                          <span className={cn("flex-1", on && "font-semibold")}>{section.label}</span>
                          <Glyph name="chevron-right" size={12} weight={2.4} className="text-label3" />
                        </Link>
                      </li>,
                    ];
                    for (const child of section.children ?? []) {
                      const childOn = isRouteActive(pathname, child.href);
                      items.push(
                        <li key={child.href} className={row}>
                          <Link
                            href={child.href}
                            onClick={close}
                            aria-current={childOn ? "page" : undefined}
                            className={cn(
                              "flex min-h-11 flex-1 items-center pl-10 text-[0.9375rem]",
                              childOn ? "font-semibold text-ink-blue" : "text-label2",
                            )}
                          >
                            {child.label}
                          </Link>
                        </li>,
                      );
                    }
                    return items;
                  })}
                </ul>
              </section>
            );
          })}

          <section>
            <h3 className="px-4 pb-1.5 text-sm font-semibold text-label2">Appearance</h3>
            <ThemeSegmented />
          </section>

          <section>
            <ul className="overflow-hidden rounded-[14px] bg-card shadow-card">
              <li className="flex min-h-14 items-center gap-3 px-4 py-2">
                <CompanyAvatar size={36} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[1rem] font-semibold">
                    {shell?.account?.name ?? "Sooz Beverage"}
                  </span>
                  <span className="block truncate text-sm text-label2">{shell?.account?.email ?? ""}</span>
                </span>
                {shell?.account ? <Badge tone="primary">{shell.account.roleLabel}</Badge> : null}
              </li>
              {shell?.period ? (
                <li className={row}>
                  <Link href="/close" onClick={close} className="flex min-h-11 flex-1 items-center gap-3">
                    <Glyph name="calendar" size={20} className="w-7 text-label2" />
                    <span className="flex-1">Period</span>
                    <PeriodIndicator
                      year={shell.period.year}
                      month={shell.period.month}
                      status={shell.period.status}
                      className="text-sm"
                    />
                  </Link>
                </li>
              ) : null}
              <li className={row}>
                <form action={signOut} className="flex flex-1">
                  <button type="submit" className="flex min-h-11 flex-1 items-center gap-3 text-left text-ink-red">
                    <Glyph name="sign-out" size={20} className="w-7" />
                    Sign out
                  </button>
                </form>
              </li>
            </ul>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

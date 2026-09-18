"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";
import { Glyph, type GlyphName } from "@/components/ui/glyph";

import { HOME, REPORTS, REVIEW, activeSectionHref } from "./nav";
import { useShell } from "./shell-context";

const tab =
  "relative flex flex-col items-center justify-center gap-0.5 rounded-[28px] text-[0.625rem] font-semibold outline-none focus-ring-inset transition-colors duration-150";

/**
 * The phone's floating tab bar: Home · Review (with its count) · Reports · More. More opens a sheet
 * listing every other section. It is sticky at the end of the page rather than fixed, so it floats
 * over the content while scrolling and a full-page capture shows it once, at the bottom.
 */
export function TabBar({ moreOpen }: { moreOpen: boolean }) {
  const pathname = usePathname() ?? "";
  const shell = useShell();
  const active = activeSectionHref(pathname);
  const onTab = (href: string) => !moreOpen && active === href;
  const inMore =
    !moreOpen &&
    active !== null &&
    ![HOME.href, REVIEW.href, REPORTS.href].includes(active);

  const items: Array<{
    href: string;
    label: string;
    glyph: GlyphName;
    count?: number;
  }> = [
    { href: HOME.href, label: HOME.label, glyph: HOME.glyph },
    {
      href: REVIEW.href,
      label: REVIEW.label,
      glyph: REVIEW.glyph,
      count: shell?.reviewCount,
    },
    { href: REPORTS.href, label: REPORTS.label, glyph: REPORTS.glyph },
  ];

  return (
    <div className="pointer-events-none sticky bottom-[calc(env(safe-area-inset-bottom)+14px)] z-40 mt-auto pt-7 md:hidden">
      <nav
        aria-label="Tabs"
        className="pointer-events-auto grid h-16 grid-cols-4 rounded-full vibrancy p-1 shadow-glass"
      >
        {items.map((item) => {
          const on = onTab(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={on ? "page" : undefined}
              className={cn(tab, on ? "bg-fill2 text-ink-blue" : "text-label")}
            >
              <Glyph name={item.glyph} size={24} />
              <span>{item.label}</span>
              {item.count ? (
                <span className="num absolute top-[5px] left-[calc(50%+6px)] grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger-fill px-[5px] text-[0.6875rem] font-semibold text-white">
                  <span className="sr-only">, </span>
                  {item.count}
                  <span className="sr-only"> to review</span>
                </span>
              ) : null}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={shell?.openMore}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={cn(
            tab,
            moreOpen || inMore ? "bg-fill2 text-ink-blue" : "text-label",
          )}
        >
          <Glyph name="grid" size={24} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}

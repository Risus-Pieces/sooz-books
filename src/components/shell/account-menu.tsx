"use client";

import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";
import { signOut } from "@/lib/auth/actions";
import { Badge } from "@/components/ui/badge";
import { Glyph } from "@/components/ui/glyph";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { monthShort } from "@/lib/ui/format";

import type { ShellAccount, ShellPeriod } from "./shell-context";

const COMPANY = "Sooz Beverage";

/** The company avatar: an "S" on the brand's warm gradient. */
export function CompanyAvatar({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,#ff9f0a,#ff375f)] font-semibold text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
    >
      S
    </span>
  );
}

function periodLabel(period: ShellPeriod): string {
  return `${monthShort(period.month)} ${period.year}`;
}

/**
 * The company block at the foot of the sidebar. Opens a popover with who is signed in, the working
 * period (a link to Close) and Sign out.
 */
export function AccountMenu({
  account,
  period,
  className,
}: {
  account: ShellAccount | null;
  period: ShellPeriod | null;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "flex w-full items-center gap-[9px] rounded-[8px] px-1.5 py-1.5 text-left outline-none focus-ring-inset hover:bg-fill2 data-[state=open]:bg-fill2",
          className,
        )}
        aria-label="Account and period"
      >
        <CompanyAvatar />
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-xs font-semibold">{COMPANY}</span>
          <span className="block truncate text-2xs text-label2">
            {period ? (
              <>
                {period.status === "closed" ? "Closed · " : null}
                {periodLabel(period)}
              </>
            ) : (
              "Books"
            )}
          </span>
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 p-1.5">
        {account ? (
          <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-fill text-label2">
              <Glyph name="person" size={16} />
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-semibold">{account.name}</span>
              <span className="block truncate text-xs text-label2">{account.email}</span>
            </span>
            <Badge tone="primary">{account.roleLabel}</Badge>
          </div>
        ) : null}
        <div className="flex flex-col hairline-t pt-1.5">
          {period ? (
            <Link
              href="/close"
              className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-sm hover:bg-fill2"
            >
              <Glyph name={period.status === "closed" ? "lock" : "calendar"} size={15} className="text-label2" />
              <span className="flex-1">{periodLabel(period)}</span>
              <span className={cn("text-xs font-medium", period.status === "closed" ? "text-label2" : "text-ink-green")}>
                {period.status === "closed" ? "Closed" : "Open"}
              </span>
            </Link>
          ) : null}
          <form action={signOut}>
            <button
              type="submit"
              className="flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-sm hover:bg-fill2"
            >
              <Glyph name="sign-out" size={15} className="text-label2" />
              Sign out
            </button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}

import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";
import type { AccountingBasis } from "@/lib/reports/types";

export const GENERAL_LEDGER_PATH = "/reports/general-ledger";

export interface DrilldownTarget {
  accountId: string;
  from: string;
  to: string;
  basis?: AccountingBasis;
  channelId?: string | null;
}

/** The register URL behind a figure, built in one place so every report agrees. */
export function generalLedgerHref(target: DrilldownTarget): string {
  const params = new URLSearchParams({
    account: target.accountId,
    from: target.from,
    to: target.to,
  });
  if (target.basis !== undefined) params.set("basis", target.basis);
  if (target.channelId) params.set("channel", target.channelId);
  return `${GENERAL_LEDGER_PATH}?${params.toString()}`;
}

export interface DrilldownLinkProps extends DrilldownTarget {
  children: React.ReactNode;
  className?: string;
  title?: string;
}

/**
 * Every figure on a statement has to lead back to the lines it came from. This
 * is the only way into the general ledger from a report, so the parameters stay
 * consistent no matter which statement the reader clicked.
 */
export function DrilldownLink({ children, className, title, ...target }: DrilldownLinkProps) {
  return (
    <Link
      href={generalLedgerHref(target)}
      title={title ?? "Open the general ledger for this account"}
      className={cn(
        "rounded-xs underline decoration-transparent underline-offset-2 transition-colors hover:decoration-primary/60 hover:text-primary",
        className,
      )}
    >
      {children}
    </Link>
  );
}

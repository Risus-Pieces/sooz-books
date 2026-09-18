"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";
import { labelForPath } from "@/components/shell/nav";

export interface Crumb {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps {
  /** Supply these when a page knows better than the URL — a record's name, say. */
  items?: Crumb[];
  className?: string;
}

function titleCase(segment: string): string {
  return segment
    .split("-")
    .map((word) => (word.length > 3 ? word[0].toUpperCase() + word.slice(1) : word.toUpperCase()))
    .join(" ");
}

function crumbsFromPath(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  return segments.map((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join("/")}`;
    return {
      label: labelForPath(href) ?? titleCase(segment),
      href: index === segments.length - 1 ? undefined : href,
    };
  });
}

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  const pathname = usePathname() ?? "";
  const crumbs = items ?? crumbsFromPath(pathname);

  if (crumbs.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {crumbs.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
            {index > 0 ? <ChevronRight className="size-3 shrink-0 opacity-50" aria-hidden /> : null}
            {crumb.href ? (
              <Link href={crumb.href} className="rounded-xs transition-colors hover:text-foreground">
                {crumb.label}
              </Link>
            ) : (
              <span className="text-foreground" aria-current="page">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

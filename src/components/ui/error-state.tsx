"use client";

import * as React from "react";

import { cn } from "@/lib/cn";

import { Button } from "./button";
import { Glyph, type GlyphName } from "./glyph";
import { InfoButton } from "./info-button";
import { StateTile } from "./route-states";

export interface ErrorStateProps {
  /** Six words at most. */
  title?: string;
  glyph?: GlyphName;
  /** The error boundary's `retry`: re-fetches and re-renders the segment. */
  onRetry?: () => void;
  /** Server errors carry a digest that matches the server log; it goes behind the ⓘ. */
  digest?: string;
  /** A second way out, such as a link home. */
  secondaryAction?: React.ReactNode;
  className?: string;
}

/** A failed screen: one large glyph, one line, Retry. */
export function ErrorState({
  title = "This page didn’t load",
  glyph = "warning",
  onRetry,
  digest,
  secondaryAction,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn("flex flex-col items-center justify-center px-6 py-24 text-center max-md:py-16", className)}
    >
      <StateTile glyph={glyph} tone="orange" />
      <div className="flex items-center gap-1">
        <p className="text-2xl font-bold tracking-[-0.022em] text-label">{title}</p>
        <InfoButton label="More information" align="center">
          <p>Something went wrong while this page was loading. Retry loads it again.</p>
          {digest ? (
            <p className="text-label2">
              Reference <span className="num font-mono text-xs">{digest}</span>
            </p>
          ) : null}
        </InfoButton>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {onRetry ? (
          <Button onClick={onRetry}>
            <Glyph name="refresh" />
            Retry
          </Button>
        ) : null}
        {secondaryAction}
      </div>
    </div>
  );
}

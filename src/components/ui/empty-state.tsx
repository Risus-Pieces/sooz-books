import * as React from "react";

import { cn } from "@/lib/cn";

import { Glyph, type GlyphName } from "./glyph";
import { InfoButton } from "./info-button";

export interface EmptyStateProps extends Omit<React.ComponentPropsWithRef<"div">, "title"> {
  /** A glyph from the kit. Preferred over `icon`. */
  glyph?: GlyphName;
  /** Any other large icon. */
  icon?: React.ReactNode;
  /** Six words at most. */
  title: string;
  /** Not shown on the screen: it goes behind an ⓘ beside the title. */
  description?: string;
  /** The one next step. */
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
}

/** An empty screen: one large glyph, a few words, one button. */
export function EmptyState({
  className,
  glyph,
  icon,
  title,
  description,
  action,
  secondaryAction,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center px-6 py-12 text-center",
        // Inside a table wider than a phone, centre on what is visible rather than on the full
        // scroll width, which would push the message and its button off the right edge.
        "[td_&]:sticky [td_&]:left-0 [td_&]:max-w-[calc(100vw-2.125rem)]",
        className,
      )}
      {...props}
    >
      {glyph ? (
        <Glyph name={glyph} size={48} weight={1.4} className="mb-3 text-label3" />
      ) : icon ? (
        <div className="mb-3 text-label3 [&_svg]:size-12 [&_svg]:stroke-[1.4]">{icon}</div>
      ) : null}
      <div className="flex items-center gap-1">
        <p className="text-lg font-semibold text-label">{title}</p>
        {description ? (
          <InfoButton label="More information" align="center">
            {description}
          </InfoButton>
        ) : null}
      </div>
      {action || secondaryAction ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}

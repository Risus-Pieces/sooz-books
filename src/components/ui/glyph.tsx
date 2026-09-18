import * as React from "react";

import { cn } from "@/lib/cn";
import { GLYPHS, type GlyphName, type GlyphShape } from "@/lib/ui/glyphs";

export type { GlyphName };

export interface GlyphProps extends Omit<React.ComponentPropsWithRef<"svg">, "children"> {
  name: GlyphName;
  /** Pixel size; defaults to 16. Also settable with a size-* class. */
  size?: number;
  /** Stroke weight; 1.7 matches SF Symbols at regular weight. */
  weight?: number;
  /** A spoken name. Without one the glyph is decorative and hidden from assistive technology. */
  label?: string;
}

/**
 * An SF-Symbols-style line icon from the set in src/lib/ui/glyphs.ts. Inherits the text colour.
 */
export function Glyph({ name, size = 16, weight = 1.7, label, className, ...props }: GlyphProps) {
  const shapes: readonly GlyphShape[] = GLYPHS[name];
  return (
    <svg
      data-slot="glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      className={cn("shrink-0", className)}
      {...props}
    >
      {shapes.map((shape, index) => {
        if (shape.kind === "circle") {
          return (
            <circle
              key={index}
              cx={shape.cx}
              cy={shape.cy}
              r={shape.r}
              fill={shape.fill ? "currentColor" : undefined}
              stroke={shape.fill ? "none" : undefined}
            />
          );
        }
        if (shape.kind === "rect") {
          return <rect key={index} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} />;
        }
        return (
          <path
            key={index}
            d={shape.d}
            fill={shape.fill ? "currentColor" : undefined}
            strokeWidth={shape.strokeWidth}
          />
        );
      })}
    </svg>
  );
}

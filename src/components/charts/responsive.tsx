import * as React from "react";

/**
 * Two renderings of one chart: the regular one from `md` up, the compact one on a phone. Charts
 * are SVG with a fixed viewBox, so text stays legible only if each width gets its own drawing.
 * The hidden one is display:none, so assistive technology reads only the visible one.
 */
export function Responsive({ desktop, phone }: { desktop: React.ReactNode; phone: React.ReactNode }) {
  return (
    <>
      <div className="max-md:hidden">{desktop}</div>
      <div className="md:hidden">{phone}</div>
    </>
  );
}

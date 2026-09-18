/** Shared SVG text styling for the charts: 10.5px, medium, secondary label colour. */
export const axisText = {
  fontSize: 10.5,
  fontWeight: 500,
  fill: "var(--label2)",
  fontFamily: "inherit",
} as const;

export const gridLine = { stroke: "var(--sep)", strokeWidth: 0.6 } as const;
export const zeroLine = { stroke: "var(--label3)", strokeWidth: 0.8 } as const;

/** A stable id fragment from a chart's key props, so two instances never share a gradient id. */
export function chartId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}-${parts.join("-").replace(/[^a-zA-Z0-9-]/g, "")}`;
}

import { SegmentedNav } from "@/components/ui/segmented-control";

/**
 * The Plan section's three views, as a segmented control whose choice lives in the URL. The
 * budget views keep the chosen version.
 */
export function PlanTabs({
  current,
  budgetHref = "/plan/budget",
  varianceHref,
}: {
  current: "forecast" | "budget" | "variance";
  budgetHref?: string;
  /** Hidden when there is no budget to compare against. */
  varianceHref?: string | null;
}) {
  return (
    <SegmentedNav
      aria-label="Plan"
      current={current}
      className="self-start max-sm:w-full"
      fill={false}
      items={[
        { value: "forecast", label: "Forecast", href: "/plan/forecast" },
        { value: "budget", label: "Budget", href: budgetHref },
        ...(varianceHref ? [{ value: "variance", label: "Vs actual", href: varianceHref }] : []),
      ]}
    />
  );
}

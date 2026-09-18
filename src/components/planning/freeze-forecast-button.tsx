"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Snowflake } from "lucide-react";

import { freezeForecast } from "@/app/(app)/plan/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

/**
 * Freezes today's forecast so it can be scored against what the bank shows
 * happened. Refreezing the same day replaces that day's snapshot only when the
 * person says so.
 */
export function FreezeForecastButton({ frozenToday }: { frozenToday: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const freeze = () => {
    if (frozenToday && !window.confirm("Today's forecast is already frozen. Replace it with the forecast as it stands now?")) {
      return;
    }
    startTransition(async () => {
      const result = await freezeForecast(frozenToday);
      if (!result.ok) {
        toast.error("Forecast not frozen", { description: result.error.message });
        return;
      }
      toast.success(`Forecast frozen as of ${result.value.asOfDate}`);
      router.refresh();
    });
  };

  return (
    <Button variant="secondary" size="sm" disabled={pending} onClick={freeze}>
      <Snowflake />
      {frozenToday ? "Refreeze today" : "Freeze this forecast"}
    </Button>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Sheet, SheetContent } from "@/components/ui/sheet";

const NARROW = "(max-width: 1023px)";

/**
 * Below 1024px the split view shows only the list, so the chosen row's detail rises in a sheet
 * instead. The choice lives in the URL; closing the sheet goes back to the plain list.
 */
export function DetailSheet({
  selected,
  closeHref,
  title,
  children,
}: {
  /** True when the URL names a row (a deliberate pick, not the desktop's default selection). */
  selected: boolean;
  closeHref: string;
  title: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [narrow, setNarrow] = React.useState(false);

  React.useEffect(() => {
    const query = window.matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <Sheet
      open={selected && narrow}
      onOpenChange={(open) => {
        if (!open) router.replace(closeHref, { scroll: false });
      }}
    >
      <SheetContent title={title} hideTitle width="md">
        {children}
      </SheetContent>
    </Sheet>
  );
}

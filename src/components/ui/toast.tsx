"use client";

import * as React from "react";
import { Toaster as SonnerToaster, toast } from "sonner";

import { useTheme } from "@/components/ui/theme";

export type ToasterProps = React.ComponentProps<typeof SonnerToaster>;

export function Toaster(props: ToasterProps) {
  const { resolved } = useTheme();

  return (
    <SonnerToaster
      theme={resolved}
      position="bottom-right"
      mobileOffset={{ bottom: 100 }}
      offset={16}
      gap={8}
      visibleToasts={4}
      toastOptions={{
        classNames: {
          toast:
            "!rounded-[12px] !border-0 vibrancy !text-label !shadow-glass !font-sans !text-sm",
          title: "!text-sm !font-semibold",
          description: "!text-xs !text-label2",
          actionButton: "!rounded-[7px] !bg-accent-fill !text-white !text-xs !font-semibold",
          cancelButton: "!rounded-[7px] !bg-fill2 !text-label !text-xs !font-medium",
          success: "[&_[data-icon]]:!text-ink-green",
          error: "[&_[data-icon]]:!text-ink-red",
          warning: "[&_[data-icon]]:!text-ink-orange",
          info: "[&_[data-icon]]:!text-ink-blue",
        },
      }}
      {...props}
    />
  );
}

export { toast };

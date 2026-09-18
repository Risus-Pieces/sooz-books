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
      offset={16}
      gap={8}
      visibleToasts={4}
      toastOptions={{
        classNames: {
          toast:
            "!rounded-md !border !border-border-strong !bg-surface-raised !text-foreground !shadow-overlay !font-sans !text-sm",
          title: "!text-sm !font-semibold",
          description: "!text-xs !text-muted-foreground",
          actionButton: "!rounded-sm !bg-primary !text-primary-foreground !text-xs !font-medium",
          cancelButton: "!rounded-sm !bg-muted !text-muted-foreground !text-xs !font-medium",
          success: "[&_[data-icon]]:!text-positive",
          error: "[&_[data-icon]]:!text-negative",
          warning: "[&_[data-icon]]:!text-warning",
          info: "[&_[data-icon]]:!text-info",
        },
      }}
      {...props}
    />
  );
}

export { toast };

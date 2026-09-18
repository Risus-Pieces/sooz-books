import * as React from "react";

import { cn } from "@/lib/cn";

export interface TextareaProps extends React.ComponentPropsWithRef<"textarea"> {
  invalid?: boolean;
}

export function Textarea({ className, invalid, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      aria-invalid={invalid || undefined}
      className={cn(
        "min-h-16 w-full rounded-sm border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm text-foreground transition-colors placeholder:text-muted-foreground/80 focus-visible:border-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground",
        invalid && "border-negative focus-visible:border-negative",
        className,
      )}
      {...props}
    />
  );
}

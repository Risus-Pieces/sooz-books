import * as React from "react";

import { cn } from "@/lib/cn";

import { fieldBase, fieldInvalid } from "./menu-styles";

export interface TextareaProps extends React.ComponentPropsWithRef<"textarea"> {
  invalid?: boolean;
}

export function Textarea({ className, invalid, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, "h-auto min-h-16 py-1.5 max-sm:h-auto", invalid && fieldInvalid, className)}
      {...props}
    />
  );
}

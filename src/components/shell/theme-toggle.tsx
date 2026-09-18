"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme, type ThemePreference } from "@/components/ui/theme";

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Match system", icon: Monitor },
];

export function ThemeToggle({ className }: { className?: string }) {
  const { preference, resolved, setPreference } = useTheme();
  const Icon = resolved === "dark" ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Change theme"
        className={cn(
          "grid size-8 place-items-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted",
          className,
        )}
      >
        <Icon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        {OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => setPreference(option.value)}
            className={preference === option.value ? "text-foreground" : undefined}
          >
            <option.icon />
            <span>{option.label}</span>
            {preference === option.value ? (
              <span aria-hidden className="ml-auto size-1.5 rounded-full bg-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

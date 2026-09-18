"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { PopUpButton, type PopUpGroup } from "@/components/ui/pop-up-button";
import type { Tint } from "@/lib/ui/tints";

import { useReportParams } from "./report-toolbar";

export interface LedgerAccountChoice {
  id: string;
  code: string;
  name: string;
  /** Statement section heading: "Assets", "Expenses". */
  group: string;
  tint: Tint;
}

const EVERY = "every";

/**
 * The register's own filters: one account, one source, or a range of codes. They write into the
 * URL like every other report control.
 */
export function GeneralLedgerControls({
  accounts,
  sources,
  account,
  source,
  codeFrom,
  codeTo,
}: {
  accounts: readonly LedgerAccountChoice[];
  sources: ReadonlyArray<{ value: string; label: string }>;
  account: string;
  source: string;
  codeFrom: string;
  codeTo: string;
}) {
  const { set } = useReportParams();

  const groups: PopUpGroup[] = [{ options: [{ value: EVERY, label: "Every account" }] }];
  for (const choice of accounts) {
    let group = groups.find((g) => g.label === choice.group);
    if (group === undefined) {
      group = { label: choice.group, options: [] };
      groups.push(group);
    }
    group.options.push({ value: choice.id, label: `${choice.code} ${choice.name}`, tint: choice.tint });
  }

  const commit = (key: "code_from" | "code_to", value: string, current: string) => {
    const trimmed = value.trim();
    if (trimmed !== current) set({ [key]: trimmed === "" ? null : trimmed });
  };

  return (
    <>
      <PopUpButton
        aria-label="Account"
        value={account === "" ? EVERY : account}
        onValueChange={(value) => set({ account: value === EVERY ? null : value })}
        options={groups}
        className="max-w-[16rem]"
      />
      <PopUpButton
        aria-label="Source"
        value={source === "" ? EVERY : source}
        onValueChange={(value) => set({ source: value === EVERY ? null : value })}
        options={[{ value: EVERY, label: "Every source" }, ...sources]}
      />
      <span className="inline-flex items-center gap-1.5">
        <Input
          aria-label="Codes from"
          inputMode="numeric"
          numeric
          defaultValue={codeFrom}
          placeholder="1000"
          className="h-[26px] w-[4.5rem] max-sm:h-11 max-sm:w-full"
          onBlur={(event) => commit("code_from", event.target.value, codeFrom)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit("code_from", event.currentTarget.value, codeFrom);
          }}
        />
        <span className="text-label2">–</span>
        <Input
          aria-label="Codes to"
          inputMode="numeric"
          numeric
          defaultValue={codeTo}
          placeholder="9999"
          className="h-[26px] w-[4.5rem] max-sm:h-11 max-sm:w-full"
          onBlur={(event) => commit("code_to", event.target.value, codeTo)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit("code_to", event.currentTarget.value, codeTo);
          }}
        />
      </span>
    </>
  );
}

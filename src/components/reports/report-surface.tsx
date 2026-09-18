import * as React from "react";

import { PageToolbar } from "@/components/shell/page-toolbar";
import { Pill } from "@/components/ui/pill";
import { today } from "@/lib/dates";
import {
  type ColumnMode,
  type Report,
  type ReportRequest,
  datePresets,
  reportRequestToParams,
} from "@/lib/reports/types";
import { mediumDate, shortDate } from "@/lib/ui/format";

import { ReportFileActions } from "./copy-report-button";
import { RegisterMatrix } from "./register-matrix";
import { ReportMatrix } from "./report-matrix";
import { type ChannelOption, ReportToolbar } from "./report-toolbar";

export const REPORT_EXPORT_PATH = "/reports/export";

export type ReportKind = "profit-loss" | "balance-sheet" | "trial-balance" | "general-ledger" | "cash-flow";

export interface ReportSurfaceProps {
  report: Report;
  request: ReportRequest;
  /** This page's own path. */
  path: string;
  kind: ReportKind;
  channels: readonly ChannelOption[];
  columnModes?: readonly ColumnMode[];
  showCompare?: boolean;
  showPercent?: boolean;
  dense?: boolean;
  /** The report's explanation: never on screen, behind the ⓘ. */
  description?: string;
  /** The one chart the report opens with. */
  summary?: React.ReactNode;
  /** Report-specific controls, drawn in the options bar. */
  toolbarExtras?: React.ReactNode;
  /**
   * Filters this report has beyond `ReportRequest` — the register's account and
   * source, for instance. They ride along on the export URL.
   */
  extraParams?: Readonly<Record<string, string>>;
}

/** "Jan 1 – Sep 18, 2026", or "Sep 18, 2026" for a single day. */
function windowLabel(from: string, to: string): string {
  if (from === to) return mediumDate(to);
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${mediumDate(from)} – ${mediumDate(to)}`;
  return `${shortDate(from)} – ${mediumDate(to)}`;
}

/**
 * The frame every statement is rendered in: the toolbar, the options bar, one summary chart and
 * the Numbers-style table. The report pages share it so that the date presets, the basis control
 * and the export URL cannot drift apart between them.
 */
export function ReportSurface({
  report,
  request,
  kind,
  channels,
  columnModes,
  showCompare,
  showPercent,
  dense,
  description,
  summary,
  toolbarExtras,
  extraParams,
}: ReportSurfaceProps) {
  const extras = Object.entries(extraParams ?? {});

  const presets = datePresets(today()).map((preset) => ({
    key: preset.key,
    label: preset.label,
    from: preset.from,
    to: preset.to,
    active: preset.from === request.from && preset.to === request.to,
  }));

  const exportQuery = reportRequestToParams(request);
  exportQuery.set("report", kind);
  for (const [key, value] of extras) exportQuery.set(key, value);

  const csvHref = `${REPORT_EXPORT_PATH}?${exportQuery.toString()}`;
  const tsvQuery = new URLSearchParams(exportQuery);
  tsvQuery.set("format", "tsv");

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={report.meta.title}
        phoneTitle={kind === "cash-flow" ? "Cash Flow" : undefined}
        back={{ href: "/reports", label: "Reports" }}
        phoneTitleRow
        subtitle={
          <>
            <span className="num">{windowLabel(report.meta.from, report.meta.to)}</span>
            {report.meta.basis === "cash" ? (
              <Pill tone="orange" className="h-5 px-2 text-2xs">
                Cash basis
              </Pill>
            ) : null}
          </>
        }
        info={description ? <p>{description}</p> : undefined}
        actions={<ReportFileActions csvHref={csvHref} copyHref={`${REPORT_EXPORT_PATH}?${tsvQuery.toString()}`} />}
      />

      <ReportToolbar
        request={request}
        presets={presets}
        channels={channels}
        columnModes={columnModes}
        showCompare={showCompare}
        showPercent={showPercent}
      >
        {toolbarExtras}
      </ReportToolbar>

      {summary}

      {kind === "general-ledger" ? (
        // On a phone the register is inset groups straight on the page, like the Journal.
        <section className="overflow-clip rounded-2xl bg-card shadow-card max-sm:overflow-visible max-sm:rounded-none max-sm:bg-transparent max-sm:shadow-none">
          <RegisterMatrix report={report} />
        </section>
      ) : (
        <section className="overflow-clip rounded-2xl bg-card shadow-card max-sm:rounded-[22px]">
          <ReportMatrix report={report} dense={dense} />
        </section>
      )}
    </div>
  );
}

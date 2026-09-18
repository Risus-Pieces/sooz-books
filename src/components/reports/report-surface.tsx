import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { today } from "@/lib/dates";
import {
  type ColumnMode,
  type Report,
  type ReportRequest,
  datePresets,
  reportRequestToParams,
} from "@/lib/reports/types";

import { ReportMatrix } from "./report-matrix";
import { type ChannelOption, ReportToolbar } from "./report-toolbar";

export const REPORT_EXPORT_PATH = "/reports/export";

export type ReportKind = "profit-loss" | "balance-sheet" | "trial-balance" | "general-ledger" | "cash-flow";

export interface ReportSurfaceProps {
  report: Report;
  request: ReportRequest;
  /** This page's own path, which the toolbar submits back to. */
  path: string;
  kind: ReportKind;
  channels: readonly ChannelOption[];
  columnModes?: readonly ColumnMode[];
  showCompare?: boolean;
  showPercent?: boolean;
  dense?: boolean;
  description?: string;
  /** Report-specific controls, rendered inside the toolbar form. */
  toolbarExtras?: React.ReactNode;
  /**
   * Filters this report has beyond `ReportRequest` — the register's account and
   * source, for instance. They ride along on the preset links and the export URL,
   * so changing the date range never silently drops them.
   */
  extraParams?: Readonly<Record<string, string>>;
}

/**
 * The frame every statement is rendered in: the header, the controls, the
 * matrix. Four report pages share it so that the date presets, the basis toggle
 * and the export URL cannot drift apart between them.
 */
export function ReportSurface({
  report,
  request,
  path,
  kind,
  channels,
  columnModes,
  showCompare,
  showPercent,
  dense,
  description,
  toolbarExtras,
  extraParams,
}: ReportSurfaceProps) {
  const extras = Object.entries(extraParams ?? {});

  const presets = datePresets(today()).map((preset) => {
    const query = reportRequestToParams({ ...request, from: preset.from, to: preset.to });
    for (const [key, value] of extras) query.set(key, value);
    return {
      key: preset.key,
      label: preset.label,
      href: `${path}?${query.toString()}`,
      active: preset.from === request.from && preset.to === request.to,
    };
  });

  const exportQuery = reportRequestToParams(request);
  exportQuery.set("report", kind);
  for (const [key, value] of extras) exportQuery.set(key, value);

  const csvHref = `${REPORT_EXPORT_PATH}?${exportQuery.toString()}`;
  const tsvQuery = new URLSearchParams(exportQuery);
  tsvQuery.set("format", "tsv");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Reports"
        title={report.meta.title}
        description={description}
        meta={
          <>
            <Badge tone="outline">{report.meta.subtitle}</Badge>
            <Badge tone={report.meta.basis === "cash" ? "warning" : "neutral"}>
              {report.meta.basis === "cash" ? "Cash basis" : "Accrual basis"}
            </Badge>
          </>
        }
      />

      <ReportToolbar
        action={path}
        request={request}
        presets={presets}
        channels={channels}
        columnModes={columnModes}
        showCompare={showCompare}
        showPercent={showPercent}
        exportHref={csvHref}
        copyHref={`${REPORT_EXPORT_PATH}?${tsvQuery.toString()}`}
      >
        {toolbarExtras}
      </ReportToolbar>

      <Card className="overflow-hidden">
        <ReportMatrix report={report} dense={dense} />
      </Card>
    </div>
  );
}

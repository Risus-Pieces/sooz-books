/**
 * Report download. The same query string that renders a statement on screen
 * renders it as a file here, so an exported CSV is by construction the report
 * the reader was looking at rather than a second implementation of it.
 */

import { requireCapability } from '@/lib/auth/session';
import { balanceSheetReport } from '@/lib/reports/balance-sheet';
import { cashFlowReport } from '@/lib/reports/cash-flow';
import { toCsv, toTsv, reportFilename } from '@/lib/reports/export';
import { generalLedgerReport, parseGeneralLedgerRequest } from '@/lib/reports/general-ledger';
import { profitAndLossReport } from '@/lib/reports/pnl';
import { trialBalanceReport } from '@/lib/reports/trial-balance';
import { type Report, type SearchParams, parseReportRequest } from '@/lib/reports/types';

const KINDS = ['profit-loss', 'balance-sheet', 'trial-balance', 'general-ledger', 'cash-flow'] as const;
type Kind = (typeof KINDS)[number];

function isKind(value: string | null): value is Kind {
  return value !== null && (KINDS as readonly string[]).includes(value);
}

/** `URLSearchParams` to the record shape the request parser reads. */
function toSearchParams(url: URL): SearchParams {
  const params: SearchParams = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    params[key] = values.length > 1 ? values : values[0];
  }
  return params;
}

async function build(kind: Kind, params: SearchParams): Promise<Report> {
  switch (kind) {
    case 'profit-loss':
      return profitAndLossReport(parseReportRequest(params));
    case 'balance-sheet':
      return balanceSheetReport(parseReportRequest(params));
    case 'trial-balance':
      return trialBalanceReport(parseReportRequest(params));
    case 'general-ledger':
      return generalLedgerReport(parseGeneralLedgerRequest(params));
    case 'cash-flow':
      return cashFlowReport(parseReportRequest(params));
  }
}

export async function GET(request: Request): Promise<Response> {
  await requireCapability('reports.view');

  const url = new URL(request.url);
  const kindParam = url.searchParams.get('report');
  if (!isKind(kindParam)) {
    return new Response(`Unknown report. Expected one of: ${KINDS.join(', ')}.`, {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const report = await build(kindParam, toSearchParams(url));

  if (url.searchParams.get('format') === 'tsv') {
    return new Response(toTsv(report), {
      headers: {
        'content-type': 'text/tab-separated-values; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  // Without the byte order mark Excel reads the file in the local code page, and
  // every en dash in an account name arrives as mojibake.
  return new Response(`﻿${toCsv(report)}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${reportFilename(report, 'csv')}"`,
      'cache-control': 'no-store',
    },
  });
}

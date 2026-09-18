import type { Metadata } from 'next';
import { asc, eq } from 'drizzle-orm';

import { GeneralLedgerControls } from '@/components/reports/general-ledger-controls';
import { GeneralLedgerSummary, ledgerSeries } from '@/components/reports/report-charts';
import { ReportSurface } from '@/components/reports/report-surface';
import { sourceLabel } from '@/components/ledger/types';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import { requireCapability } from '@/lib/auth/session';
import { listAccounts } from '@/lib/ledger/accounts';
import { SOURCE_TYPES } from '@/lib/ledger/post';
import { generalLedgerReport, parseGeneralLedgerRequest } from '@/lib/reports/general-ledger';
import type { SearchParams } from '@/lib/reports/types';
import { categoryFor } from '@/lib/ui/categories';

export const metadata: Metadata = {
  title: 'General Ledger',
};

export const dynamic = 'force-dynamic';

const PATH = '/reports/general-ledger';

const TYPE_GROUP: Record<string, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expenses',
};
export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [, params] = await Promise.all([requireCapability('reports.view'), searchParams]);

  const request = parseGeneralLedgerRequest(params);

  const [report, accounts, channelRows] = await Promise.all([
    generalLedgerReport(request),
    listAccounts({}),
    db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(eq(channels.active, true))
      .orderBy(asc(channels.sortOrder)),
  ]);

  const selectedAccount = request.accountIds?.[0] ?? '';
  const selectedSource = request.sourceTypes?.[0] ?? '';

  const byId = new Map(accounts.map((account) => [account.id, account]));
  const extras = (
    <GeneralLedgerControls
      accounts={accounts.map((account) => ({
        id: account.id,
        code: account.code,
        name: account.name,
        group: TYPE_GROUP[account.type] ?? 'Other',
        tint: categoryFor({
          code: account.code,
          subtype: account.subtype,
          type: account.type,
          parentCode: account.parentId === null ? null : (byId.get(account.parentId)?.code ?? null),
        }).tint,
      }))}
      sources={SOURCE_TYPES.map((source) => ({ value: source, label: sourceLabel(source) }))}
      account={selectedAccount}
      source={selectedSource}
      codeFrom={request.codeFrom ?? ''}
      codeTo={request.codeTo ?? ''}
    />
  );

  const extraParams: Record<string, string> = {};
  if (selectedAccount !== '') extraParams.account = selectedAccount;
  if (selectedSource !== '') extraParams.source = selectedSource;
  if (request.codeFrom !== undefined) extraParams.code_from = request.codeFrom;
  if (request.codeTo !== undefined) extraParams.code_to = request.codeTo;

  return (
    <ReportSurface
      report={report}
      request={request}
      path={PATH}
      kind="general-ledger"
      channels={channelRows}
      columnModes={['total']}
      showCompare={false}
      dense
      toolbarExtras={extras}
      summary={<GeneralLedgerSummary series={ledgerSeries(report)} />}
      extraParams={extraParams}
      description="Every posted line on an account, with the balance running through it. This is what every figure on a statement drills into."
    />
  );
}

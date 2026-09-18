import type { Metadata } from 'next';
import { asc, eq } from 'drizzle-orm';

import { ReportSurface } from '@/components/reports/report-surface';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import { requireCapability } from '@/lib/auth/session';
import { inputBase } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { listAccounts } from '@/lib/ledger/accounts';
import { SOURCE_TYPES } from '@/lib/ledger/post';
import { generalLedgerReport, parseGeneralLedgerRequest } from '@/lib/reports/general-ledger';
import type { SearchParams } from '@/lib/reports/types';

export const metadata: Metadata = {
  title: 'General Ledger',
};

export const dynamic = 'force-dynamic';

const PATH = '/reports/general-ledger';

const selectClass = cn(inputBase, 'w-auto min-w-[9rem] pr-8');

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

  const extras = (
    <>
      <label className="flex flex-col gap-1">
        <span className="eyebrow">Account</span>
        <select name="account" defaultValue={selectedAccount} className={cn(selectClass, 'max-w-[20rem]')}>
          <option value="">Every account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} {account.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="eyebrow">Source</span>
        <select name="source" defaultValue={selectedSource} className={selectClass}>
          <option value="">Every source</option>
          {SOURCE_TYPES.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="eyebrow">Codes from</span>
        <input
          type="text"
          name="code_from"
          inputMode="numeric"
          defaultValue={request.codeFrom ?? ''}
          placeholder="1000"
          className={cn(inputBase, 'num w-24')}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="eyebrow">to</span>
        <input
          type="text"
          name="code_to"
          inputMode="numeric"
          defaultValue={request.codeTo ?? ''}
          placeholder="1999"
          className={cn(inputBase, 'num w-24')}
        />
      </label>
    </>
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
      extraParams={extraParams}
      description="Every posted line on an account, with the balance running through it. This is what every figure on a statement drills into."
    />
  );
}

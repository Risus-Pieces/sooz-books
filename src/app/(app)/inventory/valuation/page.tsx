import type { Metadata } from 'next';
import { ClipboardList } from 'lucide-react';

import { SnapshotImport } from '@/components/inventory/snapshot-import';
import { Callout, Table, TableScroll, Td, Th } from '@/components/inventory/table';
import { RecordTieoutButton, TieoutHistory } from '@/components/inventory/tieout-panels';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';

import { currentTieout, snapshotImports, tieoutRows } from '../queries';

export const metadata: Metadata = {
  title: 'Valuation',
};

export const dynamic = 'force-dynamic';

const STAGE_NAMES: Record<string, string> = {
  finished: 'Finished goods',
  'raw+wip': 'Raw ingredients and work in process',
  raw: 'Raw ingredients',
  packaging: 'Packaging',
  in_transit: 'In transit',
};

/**
 * The inventory tie-out: Peasy's counted value against the ledger, account by
 * account, with a history of every comparison and what was done about it.
 */
export default async function ValuationPage() {
  const [user, current, history, imports] = await Promise.all([
    requireCapability('reports.view'),
    currentTieout(),
    tieoutRows(),
    snapshotImports(),
  ]);
  const canManage = can(user.role, 'inventory.manage');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Inventory"
        title="Valuation"
        description="Peasy is the record of how many; the ledger is the record of what they cost. Import Peasy’s count at month end and the tie-out compares the two for each inventory account."
        actions={canManage && current !== null ? <SnapshotImport variant="secondary" /> : null}
      />

      {current === null ? (
        <Card>
          <EmptyState
            icon={<ClipboardList />}
            title="No Peasy count imported"
            description="Export inventory as of a date from Peasy and import it here to tie the count to the ledger. Sooz’s Peasy workspace lists its items at zero on hand today, and ambiguous items (a pouch can be packaging or product) get their stage chosen in the preview before anything is saved."
            action={canManage ? <SnapshotImport /> : undefined}
          />
        </Card>
      ) : (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Tie-out · count of {current.snapshotDate}</CardTitle>
              {current.varianceCents === 0 ? (
                <Badge tone="positive">Ties</Badge>
              ) : (
                <Badge tone="warning">
                  Variance <Money cents={current.varianceCents} signed plain />
                </Badge>
              )}
            </div>
            {canManage ? (
              <RecordTieoutButton
                snapshotDate={current.snapshotDate}
                varianceCents={current.varianceCents}
                recorded={current.recorded}
              />
            ) : null}
          </CardHeader>
          <TableScroll>
            <Table caption={`Tie-out for ${current.snapshotDate}`} className="min-w-[38rem]">
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th>Peasy stages</Th>
                  <Th align="right">Peasy</Th>
                  <Th align="right">Ledger</Th>
                  <Th align="right">Variance</Th>
                </tr>
              </thead>
              <tbody>
                {current.byStage.map((d) => (
                  <tr key={d.accountCode ?? d.stage} className="rule-row">
                    <Td>
                      <span className="num mr-2 text-muted-foreground">{d.accountCode}</span>
                      {d.accountName}
                    </Td>
                    <Td className="text-xs text-muted-foreground">{STAGE_NAMES[d.stage] ?? d.stage}</Td>
                    <Td align="right">
                      <Money cents={d.snapshotValueCents} zeroDash plain />
                    </Td>
                    <Td align="right">
                      <Money cents={d.ledgerValueCents} zeroDash plain />
                    </Td>
                    <Td align="right">
                      <Money
                        cents={d.varianceCents}
                        signed
                        zeroDash
                        plain
                        className={d.varianceCents === 0 ? undefined : 'text-warning'}
                      />
                    </Td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <Td className="rule-subtotal" colSpan={2}>
                    Inventory
                  </Td>
                  <Td align="right" className="rule-subtotal rule-total">
                    <Money cents={current.snapshotValueCents} currency plain />
                  </Td>
                  <Td align="right" className="rule-subtotal rule-total">
                    <Money cents={current.ledgerValueCents} currency plain />
                  </Td>
                  <Td align="right" className="rule-subtotal rule-total">
                    <Money
                      cents={current.varianceCents}
                      currency
                      signed
                      zeroDash
                      plain
                      className={current.varianceCents === 0 ? undefined : 'text-warning'}
                    />
                  </Td>
                </tr>
              </tbody>
            </Table>
          </TableScroll>
          {current.reserveCents !== 0 ? (
            <p className="border-t border-border px-4 py-2 text-2xs text-muted-foreground">
              The inventory reserve (1390) holds <Money cents={current.reserveCents} plain /> — an estimate with no
              counterpart in a count, so it sits outside the comparison.
            </p>
          ) : null}
          {current.varianceCents !== 0 && !current.recorded ? (
            <div className="border-t border-border p-3">
              <Callout tone="warning" title="Record the tie-out to act on this difference">
                Recording saves the comparison and proposes the entry that would bring each account to the count. Nothing
                posts until someone reviews that entry and posts it.
              </Callout>
            </div>
          ) : null}
        </Card>
      )}

      {history.length > 0 ? (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle>Tie-out history</CardTitle>
          </CardHeader>
          <TieoutHistory rows={history} canManage={canManage} />
        </Card>
      ) : null}

      {imports.length > 0 ? (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle>Peasy counts imported</CardTitle>
          </CardHeader>
          <TableScroll>
            <Table caption="Peasy counts imported" className="min-w-[36rem]">
              <thead>
                <tr>
                  <Th>Count date</Th>
                  <Th>File</Th>
                  <Th align="right">Rows</Th>
                  <Th align="right">Value</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {imports.map((imp) => (
                  <tr key={imp.id} className="rule-row">
                    <Td className="num whitespace-nowrap">{imp.snapshotDate}</Td>
                    <Td className="max-w-64 truncate text-muted-foreground">{imp.filename ?? '—'}</Td>
                    <Td align="right" className="num">
                      {imp.rowCount}
                    </Td>
                    <Td align="right">
                      <Money cents={imp.totalValueCents} plain />
                    </Td>
                    <Td>
                      {imp.status === 'imported' ? (
                        <Badge tone="neutral">Current</Badge>
                      ) : (
                        <Badge tone="outline">Replaced</Badge>
                      )}
                      {imp.warnings > 0 ? (
                        <span className="ml-2 text-2xs text-warning">
                          {imp.warnings} {imp.warnings === 1 ? 'note' : 'notes'}
                        </span>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      ) : null}
    </div>
  );
}

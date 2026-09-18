import type { Metadata } from 'next';

import { SnapshotImport } from '@/components/inventory/snapshot-import';
import { StageComparison, type StageTableRow } from '@/components/inventory/stage-table';
import { Table, TableScroll, Td, Th } from '@/components/inventory/table';
import { RecordTieoutButton, TieoutHistory, UnrecordedNote } from '@/components/inventory/tieout-panels';
import { STAGE_KEYS, STAGE_STYLE, type StageKey } from '@/components/inventory/types';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Dot, IconBadge } from '@/components/ui/icon-badge';
import { InfoButton } from '@/components/ui/info-button';
import { InsetGroup, ListRow } from '@/components/ui/inset-group';
import { Money } from '@/components/ui/money';
import { Pill } from '@/components/ui/pill';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { mediumDate, shortDate } from '@/lib/ui/format';

import { currentTieout, snapshotImports, tieoutRows } from '../queries';

export const metadata: Metadata = {
  title: 'Valuation',
};

export const dynamic = 'force-dynamic';

const STAGE_NAMES: Record<string, string> = {
  finished: 'Finished goods',
  'raw+wip': 'Raw and WIP',
  raw: 'Raw ingredients',
  packaging: 'Packaging',
  in_transit: 'In transit',
};

/** A tie-out stage as the stage it is drawn in: raw ingredients and work in process share 1320. */
function stageKey(stage: string): StageKey {
  if (stage === 'raw+wip') return 'raw';
  return STAGE_KEYS.find((s) => s === stage) ?? 'raw';
}

/**
 * The inventory tie-out: Peasy's counted value against the ledger, account by account, drawn as
 * two bars on one scale, with a history of every comparison and what was done about it.
 */
export default async function ValuationPage() {
  const [user, current, history, imports] = await Promise.all([
    requireCapability('reports.view'),
    currentTieout(),
    tieoutRows(),
    snapshotImports(),
  ]);
  const canManage = can(user.role, 'inventory.manage');
  const info =
    'Peasy is the record of how many; the ledger is the record of what they cost. Import Peasy’s count at month end and the tie-out compares the two for each inventory account.';

  const rows: StageTableRow[] =
    current?.byStage.map((d) => ({
      stage: stageKey(d.stage),
      label: STAGE_NAMES[d.stage] ?? d.stage,
      accountCode: d.accountCode ?? '',
      accountName: d.accountName,
      ledgerCents: d.ledgerValueCents,
      snapshotCents: d.snapshotValueCents,
      varianceCents: d.varianceCents,
    })) ?? [];

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Valuation"
        back={{ href: '/inventory', label: 'Inventory' }}
        phoneTitleRow
        subtitle={current ? <>Count of {shortDate(current.snapshotDate)}</> : undefined}
        info={info}
        actions={
          canManage && current !== null ? (
            <>
              <ToolbarGroup>
                <SnapshotImport variant="toolbar" />
              </ToolbarGroup>
              <ToolbarGroup>
                <RecordTieoutButton
                  snapshotDate={current.snapshotDate}
                  varianceCents={current.varianceCents}
                  recorded={current.recorded}
                />
              </ToolbarGroup>
            </>
          ) : undefined
        }
      />

      {current === null ? (
        <Card>
          <EmptyState
            glyph="doc-text"
            title="No Peasy count imported"
            description="Export inventory as of a date from Peasy and import it here to tie the count to the ledger. Ambiguous items (a pouch can be packaging or product) get their stage chosen in the preview before anything is saved."
            action={canManage ? <SnapshotImport /> : undefined}
          />
        </Card>
      ) : (
        <Card className="min-w-0 overflow-hidden">
          <div className="px-5 pt-[18px] pb-4 max-md:p-4">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="flex items-center gap-1 text-sm font-semibold text-label2">
                  Variance
                  {current.reserveCents !== 0 ? (
                    <InfoButton label="About the reserve" align="start">
                      The inventory reserve (1390) holds <Money cents={current.reserveCents} currency plain /> — an estimate
                      with no counterpart in a count, so it sits outside the comparison.
                    </InfoButton>
                  ) : null}
                </h2>
                <Money
                  cents={current.varianceCents}
                  currency
                  signed
                  plain
                  className={`mt-0.5 block text-5xl leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.5rem] ${current.varianceCents === 0 ? '' : 'text-ink-orange'}`}
                />
              </div>
              <Pill tone={current.varianceCents === 0 ? 'green' : 'orange'} glyph={current.varianceCents === 0 ? 'check' : 'warning'}>
                {current.varianceCents === 0 ? 'Ties' : current.recorded ? 'Recorded' : 'Not recorded'}
              </Pill>
            </div>
            <StageComparison rows={rows} snapshotDate={current.snapshotDate} />
            {current.varianceCents !== 0 && !current.recorded ? (
              <div className="mt-4">
                <UnrecordedNote />
              </div>
            ) : null}
          </div>
          <div className="hairline-t pb-1">
            <TableScroll>
              <Table caption={`Tie-out for ${current.snapshotDate}`} className="min-w-[36rem]">
                <thead>
                  <tr>
                    <Th>Account</Th>
                    <Th align="right">Peasy</Th>
                    <Th align="right">Ledger</Th>
                    <Th align="right">Variance</Th>
                  </tr>
                </thead>
                <tbody>
                  {current.byStage.map((d) => (
                    <tr key={d.accountCode ?? d.stage} className="[&>td]:rule-row">
                      <Td>
                        <span className="flex items-center gap-2">
                          <Dot tint={STAGE_STYLE[stageKey(d.stage)].tint} />
                          <span className="font-medium">{d.accountName}</span>
                          <span className="num text-xs text-label2">{d.accountCode}</span>
                        </span>
                      </Td>
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
                          className={d.varianceCents === 0 ? undefined : 'font-semibold text-ink-orange'}
                        />
                      </Td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <Td>Total</Td>
                    <Td align="right" className="rule-total">
                      <Money cents={current.snapshotValueCents} currency plain />
                    </Td>
                    <Td align="right" className="rule-total">
                      <Money cents={current.ledgerValueCents} currency plain />
                    </Td>
                    <Td align="right" className="rule-total">
                      <Money
                        cents={current.varianceCents}
                        currency
                        signed
                        zeroDash
                        plain
                        className={current.varianceCents === 0 ? undefined : 'text-ink-orange'}
                      />
                    </Td>
                  </tr>
                </tbody>
              </Table>
            </TableScroll>
          </div>
        </Card>
      )}

      {history.length > 0 ? (
        <InsetGroup header="History">
          <TieoutHistory rows={history} canManage={canManage} />
        </InsetGroup>
      ) : null}

      {imports.length > 0 ? (
        <InsetGroup header="Counts imported" separatorInset={63}>
          {imports.map((imp) => (
            <ListRow
              key={imp.id}
              leading={<IconBadge glyph="doc-text" tint={imp.status === 'imported' ? 'blue' : 'gray'} size="xl" />}
              title={<span className="num">{mediumDate(imp.snapshotDate)}</span>}
              subtitle={
                <>
                  <span className="truncate">{imp.filename ?? 'Peasy export'}</span>
                  {imp.warnings > 0 ? (
                    <span className="shrink-0 font-medium text-ink-orange">
                      {imp.warnings} {imp.warnings === 1 ? 'note' : 'notes'}
                    </span>
                  ) : null}
                </>
              }
              trailing={<Money cents={imp.totalValueCents} currency plain />}
              detail={
                <span className="num">
                  {imp.rowCount} rows · {imp.status === 'imported' ? 'Current' : 'Replaced'}
                </span>
              }
            />
          ))}
        </InsetGroup>
      ) : null}
    </div>
  );
}

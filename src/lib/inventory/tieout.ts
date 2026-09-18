/**
 * The inventory tie-out: what Peasy says inventory is worth against what the
 * ledger carries, account by account.
 *
 * Peasy's snapshot is grouped by the balance-sheet account each stage lives in
 * (`STAGE_ACCOUNT`: finished → 1310, raw and wip → 1320, packaging → 1330, in
 * transit → 1340) and compared with that account's posted balance on the
 * snapshot date. The Inventory Reserve (1390) is a contra estimate with no
 * counterpart in a count, so it is reported beside the comparison and never
 * inside it.
 *
 * Recording a tie-out writes `inventory_tieouts` with the variance and its
 * per-account detail. It proposes the entry that would true the ledger up to the
 * count (inventory against 5060 Inventory Write-offs), and does not post it:
 * a person reviews the variance and posts the proposal, or explains it.
 */

import { and, desc, eq, lte, sql as sqlTag } from 'drizzle-orm';

import {
  inventoryImports,
  inventorySnapshots,
  inventoryTieouts,
  type InventoryTieout,
  type TieoutStageDetail,
} from '@/db/schema';
import { type CalendarDate, isCalendarDate } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type DraftEntry, type LedgerDb, postJournalEntry } from '@/lib/ledger/post';

import { STAGES, STAGE_ACCOUNT, type Stage } from './accounts';
import { inTx, reader, type InventoryCtx } from './context';
import { InventoryError } from './errors';
import { toDraftLines, type SignedLine } from './lines';

/** Ledger accounts compared, in presentation order. */
const COMPARED_ACCOUNTS: readonly string[] = [
  ACCOUNTS.INVENTORY_FINISHED,
  ACCOUNTS.INVENTORY_INGREDIENTS,
  ACCOUNTS.INVENTORY_PACKAGING,
  ACCOUNTS.INVENTORY_IN_TRANSIT,
];

export interface TieoutComputation {
  asOfDate: CalendarDate;
  snapshotDate: CalendarDate;
  snapshotImportId: string | null;
  byStage: TieoutStageDetail[];
  snapshotValueCents: number;
  ledgerValueCents: number;
  varianceCents: number;
  /** 1390's balance on the date, shown beside the comparison. Negative is a credit reserve. */
  reserveCents: number;
}

/** Groups per-stage snapshot values by account and compares them. Pure. */
export function compareByAccount(
  snapshotByStage: ReadonlyMap<Stage, number>,
  ledgerByCode: ReadonlyMap<string, number>,
): TieoutStageDetail[] {
  return COMPARED_ACCOUNTS.map((code) => {
    const stages = STAGES.filter((s) => STAGE_ACCOUNT[s] === code);
    const snapshotValueCents = stages.reduce((sum, s) => sum + (snapshotByStage.get(s) ?? 0), 0);
    const ledgerValueCents = ledgerByCode.get(code) ?? 0;
    return {
      stage: stages.join('+'),
      accountCode: code,
      snapshotValueCents,
      ledgerValueCents,
      varianceCents: snapshotValueCents - ledgerValueCents,
    };
  });
}

interface BalanceRow extends Record<string, unknown> {
  code: string;
  balance: string | number;
}

async function ledgerInventory(x: LedgerDb, asOf: CalendarDate): Promise<Map<string, number>> {
  const codes = [...COMPARED_ACCOUNTS, ACCOUNTS.INVENTORY_RESERVE];
  const rows = await x.execute<BalanceRow>(sqlTag`
    select a.code as code, coalesce(sum(l.debit_cents - l.credit_cents), 0) as balance
      from accounts a
      left join journal_lines l on l.account_id = a.id
      left join journal_entries e on e.id = l.entry_id
     where a.code in (${sqlTag.join(codes.map((c) => sqlTag`${c}`), sqlTag`, `)})
       and (l.id is null or (e.status = 'posted' and e.entry_date <= ${asOf}))
     group by a.code
  `);
  return new Map([...rows].map((r) => [String(r.code), Number(r.balance)]));
}

/**
 * Compares the latest Peasy snapshot on or before `asOf` with the ledger on the
 * snapshot's own date. Throws when no snapshot exists yet.
 */
export async function computeTieout(asOf: CalendarDate, exec?: LedgerDb): Promise<TieoutComputation> {
  if (!isCalendarDate(asOf)) throw new InventoryError('invalid_input', `${String(asOf)} is not YYYY-MM-DD.`);
  const x = reader(exec);
  const [latest] = await x
    .select({ date: inventorySnapshots.snapshotDate })
    .from(inventorySnapshots)
    .where(lte(inventorySnapshots.snapshotDate, asOf))
    .orderBy(desc(inventorySnapshots.snapshotDate))
    .limit(1);
  if (!latest) {
    throw new InventoryError('not_found', `No Peasy inventory snapshot on or before ${asOf}. Import one first.`);
  }
  const snapshotDate = latest.date;

  const stageRows = await x
    .select({
      stage: inventorySnapshots.stage,
      value: sqlTag<string>`sum(${inventorySnapshots.valueCents})`,
    })
    .from(inventorySnapshots)
    .where(eq(inventorySnapshots.snapshotDate, snapshotDate))
    .groupBy(inventorySnapshots.stage);
  const snapshotByStage = new Map<Stage, number>(stageRows.map((r) => [r.stage, Number(r.value)]));

  const [imp] = await x
    .select({ id: inventoryImports.id })
    .from(inventoryImports)
    .where(and(eq(inventoryImports.snapshotDate, snapshotDate), eq(inventoryImports.status, 'imported')))
    .orderBy(desc(inventoryImports.createdAt))
    .limit(1);

  const ledger = await ledgerInventory(x, snapshotDate);
  const byStage = compareByAccount(snapshotByStage, ledger);
  const snapshotValueCents = byStage.reduce((s, d) => s + d.snapshotValueCents, 0);
  const ledgerValueCents = byStage.reduce((s, d) => s + d.ledgerValueCents, 0);
  return {
    asOfDate: snapshotDate,
    snapshotDate,
    snapshotImportId: imp?.id ?? null,
    byStage,
    snapshotValueCents,
    ledgerValueCents,
    varianceCents: snapshotValueCents - ledgerValueCents,
    reserveCents: ledger.get(ACCOUNTS.INVENTORY_RESERVE) ?? 0,
  };
}

/**
 * The entry that would bring each inventory account to the count: the
 * variance against 5060 Inventory Write-offs & Spoilage. Returned for review,
 * never posted here. `lines` is empty when nothing differs.
 */
export function proposeTieoutAdjustment(t: Pick<TieoutComputation, 'asOfDate' | 'byStage'>): DraftEntry {
  const signed: SignedLine[] = [];
  for (const d of t.byStage) {
    if (d.varianceCents === 0 || d.accountCode === null) continue;
    const memo = `Peasy count ${d.stage}`;
    signed.push({ accountCode: d.accountCode, cents: d.varianceCents, memo });
    signed.push({ accountCode: ACCOUNTS.COGS_WRITE_OFF, cents: -d.varianceCents, memo });
  }
  return {
    date: t.asOfDate,
    memo: `Inventory tie-out to Peasy snapshot ${t.asOfDate}`,
    sourceType: 'inventory',
    lines: toDraftLines(signed),
  };
}

export interface RecordedTieout {
  tieout: InventoryTieout;
  computation: TieoutComputation;
  proposal: DraftEntry;
}

/** Computes and records (or refreshes) the tie-out for the snapshot date. */
export async function recordTieout(
  asOf: CalendarDate,
  ctx: InventoryCtx & { explanation?: string },
): Promise<RecordedTieout> {
  return inTx(ctx, async (tx) => {
    const computation = await computeTieout(asOf, tx);
    const [existing] = await tx
      .select()
      .from(inventoryTieouts)
      .where(eq(inventoryTieouts.asOfDate, computation.asOfDate))
      .for('update');
    if (existing?.adjustmentEntryId) {
      throw new InventoryError(
        'invalid_state',
        `The tie-out for ${computation.asOfDate} was already adjusted; its record is final.`,
      );
    }
    const values = {
      asOfDate: computation.asOfDate,
      snapshotDate: computation.snapshotDate,
      snapshotImportId: computation.snapshotImportId,
      snapshotValueCents: computation.snapshotValueCents,
      ledgerValueCents: computation.ledgerValueCents,
      varianceCents: computation.varianceCents,
      byStage: computation.byStage,
      explanation: ctx.explanation ?? existing?.explanation ?? null,
      resolved: computation.varianceCents === 0,
      createdBy: ctx.userId,
    };
    const [tieout] = existing
      ? await tx.update(inventoryTieouts).set(values).where(eq(inventoryTieouts.id, existing.id)).returning()
      : await tx.insert(inventoryTieouts).values(values).returning();
    return { tieout, computation, proposal: proposeTieoutAdjustment(computation) };
  });
}

/**
 * Posts the proposed adjustment for a recorded tie-out — the human approval
 * step. Refused if the ledger or the snapshot has moved since the tie-out was
 * recorded, because the proposal would then true up to a stale figure.
 */
export async function postTieoutAdjustment(
  tieoutId: string,
  ctx: InventoryCtx,
): Promise<{ tieoutId: string; entryId: string }> {
  return inTx(ctx, async (tx) => {
    const [row] = await tx.select().from(inventoryTieouts).where(eq(inventoryTieouts.id, tieoutId)).for('update');
    if (!row) throw new InventoryError('not_found', `Tie-out ${tieoutId} does not exist.`);
    if (row.adjustmentEntryId) throw new InventoryError('invalid_state', 'This tie-out has already been adjusted.');
    const fresh = await computeTieout(row.asOfDate, tx);
    if (
      fresh.asOfDate !== row.asOfDate ||
      fresh.snapshotValueCents !== row.snapshotValueCents ||
      fresh.ledgerValueCents !== row.ledgerValueCents
    ) {
      throw new InventoryError(
        'invalid_state',
        'The ledger or the snapshot changed since this tie-out was recorded. Record it again and review the new variance.',
      );
    }
    const proposal = proposeTieoutAdjustment(fresh);
    if (proposal.lines.length === 0) {
      throw new InventoryError('invalid_state', 'There is no variance to adjust.');
    }
    const posted = await postJournalEntry(proposal, { userId: ctx.userId, tx });
    await tx
      .update(inventoryTieouts)
      .set({ adjustmentEntryId: posted.entryId, resolved: true })
      .where(eq(inventoryTieouts.id, row.id));
    return { tieoutId: row.id, entryId: posted.entryId };
  });
}

export async function listTieouts(exec?: LedgerDb): Promise<InventoryTieout[]> {
  return reader(exec).select().from(inventoryTieouts).orderBy(desc(inventoryTieouts.asOfDate));
}

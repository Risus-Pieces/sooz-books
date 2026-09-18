/**
 * Peasy intake: preview and commit of the two Peasy exports.
 *
 * `@/lib/importers/peasy` parses; this module resolves each Peasy item to a
 * product, values uncosted inventory lines at the product's unit cost, decides
 * whether the file may be written, and writes it.
 *
 * What it guarantees:
 *
 *   - **Preview first, and the preview is the commit.** `commit*` re-runs the
 *     same preview and refuses on any blocker, so nothing can be written that
 *     was not shown.
 *   - **No row is silently dropped.** Any `error` or `fatal` issue blocks the
 *     commit; excluded rows are listed in the issues with their reason.
 *   - **Unknown items create products only on explicit confirmation.** Every
 *     unknown item must appear in `createProducts`, with the SKU and name to
 *     create it under; otherwise the commit is refused and nothing is written.
 *   - **Re-import is idempotent.** The same file (by sha256) is refused. A second
 *     file for a snapshot date or month that already has data is refused unless
 *     `replaceExisting` is set, and a month whose COGS is posted cannot be
 *     replaced at all until that batch is reversed.
 */

import { and, eq, inArray, isNull, or, sql as sqlTag } from 'drizzle-orm';

import {
  channels,
  cogsBatches,
  inventoryImports,
  inventorySnapshots,
  products,
  shipmentImports,
  shipmentUnits,
  type ImportIssue,
} from '@/db/schema';
import { fileHash } from '@/lib/banking/fingerprint';
import { readFile } from '@/lib/banking/read-file';
import type { CalendarDate } from '@/lib/dates';
import {
  blocksCommit,
  describeItem,
  formatPeriodKey,
  itemKey,
  parsePeasyInventory,
  parsePeasyShipments,
  type PeasyInventoryOptions,
  type PeasyItemRef,
  type PeasyShipmentOptions,
  type PeasyInventoryParse,
  type PeasyShipmentsParse,
} from '@/lib/importers/peasy';
import type { Issue } from '@/lib/importers/types';
import type { ChannelCode } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import type { Stage } from './accounts';
import { inTx, reader, type InventoryCtx } from './context';
import { InventoryError } from './errors';
import { extendCost, quantityToDb, unitCostOf } from './quantity';

// ---------------------------------------------------------------------------
// Items -> products
// ---------------------------------------------------------------------------

export interface ResolvedProduct {
  id: string;
  sku: string;
  name: string;
}

export interface UnknownItem {
  key: string;
  item: PeasyItemRef;
  /** What the commit will create unless told otherwise. */
  suggestedSku: string;
  suggestedName: string;
}

/** Confirmation to create a product for an unknown Peasy item. */
export interface ProductToCreate {
  key: string;
  sku: string;
  name: string;
}

function suggestSku(item: PeasyItemRef): string {
  if (item.sku) return item.sku;
  const slug = (item.name ?? item.peasyId ?? 'ITEM')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `PEASY-${slug || 'ITEM'}`;
}

/**
 * Matches items by SKU (case-insensitive), then by Peasy item id, then by exact
 * name — but only when exactly one product carries that name.
 */
async function resolveItems(
  x: LedgerDb,
  items: readonly PeasyItemRef[],
): Promise<{ resolved: Map<string, ResolvedProduct>; unknown: UnknownItem[]; issues: Issue[] }> {
  const all = await x
    .select({ id: products.id, sku: products.sku, name: products.name, peasyId: products.peasyId })
    .from(products);
  const bySku = new Map(all.map((p) => [p.sku.toLowerCase(), p]));
  const byPeasy = new Map(all.filter((p) => p.peasyId).map((p) => [String(p.peasyId).toLowerCase(), p]));
  const byName = new Map<string, typeof all>();
  for (const p of all) {
    const k = p.name.toLowerCase().trim();
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }

  const resolved = new Map<string, ResolvedProduct>();
  const unknown: UnknownItem[] = [];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const hit =
      (item.sku ? bySku.get(item.sku.toLowerCase()) : undefined) ??
      (item.peasyId ? byPeasy.get(item.peasyId.toLowerCase()) : undefined) ??
      (() => {
        const named = item.name ? byName.get(item.name.toLowerCase().trim()) : undefined;
        if (named && named.length > 1) {
          issues.push({
            severity: 'warn',
            code: 'item.ambiguous',
            message: `"${item.name}" matches ${named.length} products by name; it is treated as unknown.`,
          });
          return undefined;
        }
        return named?.[0];
      })();
    if (hit) resolved.set(key, { id: hit.id, sku: hit.sku, name: hit.name });
    else unknown.push({ key, item, suggestedSku: suggestSku(item), suggestedName: item.name ?? suggestSku(item) });
  }
  return { resolved, unknown, issues };
}

async function createConfirmedProducts(
  tx: LedgerDb,
  unknown: readonly UnknownItem[],
  confirmations: readonly ProductToCreate[],
): Promise<Map<string, ResolvedProduct>> {
  const byKey = new Map(confirmations.map((c) => [c.key, c]));
  const missing = unknown.filter((u) => !byKey.has(u.key));
  if (missing.length > 0) {
    throw new InventoryError(
      'import_refused',
      `${missing.length} Peasy item(s) are not products yet and were not confirmed for creation.`,
      missing.map((m) => describeItem(m.item)),
    );
  }
  const created = new Map<string, ResolvedProduct>();
  for (const u of unknown) {
    const c = byKey.get(u.key) as ProductToCreate;
    const sku = c.sku.trim();
    const name = c.name.trim();
    if (sku === '' || name === '') {
      throw new InventoryError('invalid_input', `A new product needs a SKU and a name (${describeItem(u.item)}).`);
    }
    const [clash] = await tx.select({ id: products.id }).from(products).where(sqlTag`lower(${products.sku}) = ${sku.toLowerCase()}`);
    if (clash) {
      throw new InventoryError('duplicate', `SKU ${sku} already belongs to another product.`);
    }
    const [row] = await tx
      .insert(products)
      .values({ sku, name, peasyId: u.item.peasyId })
      .returning({ id: products.id, sku: products.sku, name: products.name });
    created.set(u.key, row);
  }
  return created;
}

function toImportIssues(issues: readonly Issue[]): ImportIssue[] {
  return issues.map((i) => ({
    severity: i.severity,
    code: i.code,
    message: i.message,
    ...(i.rowIndex === undefined ? {} : { rowIndex: i.rowIndex }),
    ...(i.rawRow === undefined ? {} : { rawRow: [...i.rawRow] }),
    ...(i.field === undefined ? {} : { field: i.field }),
    ...(i.remedy === undefined ? {} : { remedy: i.remedy }),
  }));
}

// ---------------------------------------------------------------------------
// Inventory position
// ---------------------------------------------------------------------------

export interface PeasyFileInput {
  filename: string;
  bytes: Uint8Array | ArrayBuffer;
}

export interface InventoryPreviewLine {
  key: string;
  item: PeasyItemRef;
  product: ResolvedProduct | null;
  location: string;
  stage: Stage;
  quantity: number;
  valueCents: number;
  valueSource: 'file' | 'product_cost' | 'none';
  rowIndexes: number[];
}

export interface InventoryPreview {
  filename: string;
  fileHash: string;
  snapshotDate: CalendarDate | null;
  parse: PeasyInventoryParse;
  lines: InventoryPreviewLine[];
  unknownItems: UnknownItem[];
  totalsByStage: Partial<Record<Stage, number>>;
  totalValueCents: number;
  issues: Issue[];
  /** Why the file cannot be committed as it stands. Empty means it can (given confirmations). */
  blockers: string[];
  /** Earlier imports that already hold this snapshot date. */
  existingImportIds: string[];
}

export async function previewPeasyInventory(
  input: PeasyFileInput & PeasyInventoryOptions,
  exec?: LedgerDb,
): Promise<InventoryPreview> {
  const x = reader(exec);
  const file = await readFile(input.bytes, input.filename);
  const parse = parsePeasyInventory(file, input);
  const hash = fileHash(input.bytes);
  const issues: Issue[] = [...parse.issues];
  const blockers: string[] = [];
  if (blocksCommit(parse.issues)) {
    blockers.push('The file has rows that could not be read; fix or remove them in Peasy and export again.');
  }

  const { resolved, unknown, issues: resolveIssues } = await resolveItems(x, parse.lines.map((l) => l.item));
  issues.push(...resolveIssues);

  const lines: InventoryPreviewLine[] = [];
  for (const line of parse.lines) {
    const product = resolved.get(itemKey(line.item)) ?? null;
    let valueCents = line.valueCents ?? 0;
    let valueSource: InventoryPreviewLine['valueSource'] = line.valueCents === null ? 'none' : 'file';
    if (line.valueCents === null && product && parse.snapshotDate) {
      const rows = await x.execute<{ cost: string | number | null }>(
        sqlTag`select unit_cost_at(${product.id}::uuid, ${parse.snapshotDate}::date) as cost`,
      );
      const cost = [...rows][0]?.cost;
      if (cost !== null && cost !== undefined) {
        valueCents = extendCost(line.quantity, Number(cost));
        valueSource = 'product_cost';
      }
    }
    if (valueSource === 'none' && line.quantity !== 0) {
      issues.push({
        severity: 'warn',
        code: 'cost.none',
        message: `${describeItem(line.item)} at ${line.location} has no cost in the file and no unit cost in the books; it is counted at $0.`,
        rowIndex: line.rowIndexes[0],
      });
    }
    lines.push({
      key: line.key,
      item: line.item,
      product,
      location: line.location,
      stage: line.stage,
      quantity: line.quantity,
      valueCents,
      valueSource,
      rowIndexes: line.rowIndexes,
    });
  }

  const totalsByStage: Partial<Record<Stage, number>> = {};
  for (const l of lines) totalsByStage[l.stage] = (totalsByStage[l.stage] ?? 0) + l.valueCents;
  const totalValueCents = lines.reduce((s, l) => s + l.valueCents, 0);

  const [dup] = await x
    .select({ id: inventoryImports.id })
    .from(inventoryImports)
    .where(eq(inventoryImports.fileHash, hash));
  if (dup) blockers.push('This exact file has already been imported.');

  let existingImportIds: string[] = [];
  if (parse.snapshotDate) {
    const existing = await x
      .selectDistinct({ importId: inventorySnapshots.importId })
      .from(inventorySnapshots)
      .where(eq(inventorySnapshots.snapshotDate, parse.snapshotDate));
    existingImportIds = existing.map((e) => e.importId ?? 'manual');
  }
  if (lines.length === 0 && !blocksCommit(parse.issues)) blockers.push('The file has no inventory lines.');

  return {
    filename: input.filename,
    fileHash: hash,
    snapshotDate: parse.snapshotDate,
    parse,
    lines,
    unknownItems: unknown,
    totalsByStage,
    totalValueCents,
    issues,
    blockers,
    existingImportIds,
  };
}

export interface CommitOptions {
  /** One confirmation per unknown item; without it the commit is refused. */
  createProducts?: readonly ProductToCreate[];
  /** Replace what an earlier import wrote for the same date / month. */
  replaceExisting?: boolean;
}

export interface InventoryCommitResult {
  importId: string;
  snapshotDate: CalendarDate;
  lineCount: number;
  totalValueCents: number;
  createdProducts: ResolvedProduct[];
  replacedImportIds: string[];
}

export async function commitPeasyInventory(
  input: PeasyFileInput & PeasyInventoryOptions & CommitOptions,
  ctx: InventoryCtx,
): Promise<InventoryCommitResult> {
  return inTx(ctx, async (tx) => {
    const preview = await previewPeasyInventory(input, tx);
    if (preview.blockers.length > 0 || preview.snapshotDate === null) {
      throw new InventoryError('import_refused', 'The Peasy inventory file cannot be imported.', preview.blockers);
    }
    const snapshotDate = preview.snapshotDate;
    if (preview.existingImportIds.length > 0 && !input.replaceExisting) {
      throw new InventoryError(
        'import_refused',
        `A snapshot for ${snapshotDate} is already imported. Choose to replace it, or pick another date.`,
      );
    }

    const created = await createConfirmedProducts(tx, preview.unknownItems, input.createProducts ?? []);

    let replacedImportIds: string[] = [];
    if (preview.existingImportIds.length > 0) {
      const ids = preview.existingImportIds.filter((id) => id !== 'manual');
      replacedImportIds = ids;
      await tx
        .delete(inventorySnapshots)
        .where(
          and(
            eq(inventorySnapshots.snapshotDate, snapshotDate),
            or(isNull(inventorySnapshots.importId), ids.length > 0 ? inArray(inventorySnapshots.importId, ids) : undefined),
          ),
        );
      if (ids.length > 0) {
        await tx.update(inventoryImports).set({ status: 'cancelled' }).where(inArray(inventoryImports.id, ids));
      }
    }

    // Two Peasy lines can land on one product (one row by SKU, another by name).
    const byKey = new Map<string, { productId: string; location: string; stage: Stage; quantity: number; valueCents: number }>();
    for (const line of preview.lines) {
      const product = line.product ?? created.get(itemKey(line.item));
      if (!product) {
        throw new InventoryError('import_refused', `${describeItem(line.item)} has no product.`);
      }
      const k = [product.id, line.location, line.stage].join('|');
      const agg = byKey.get(k);
      if (agg) {
        agg.quantity += line.quantity;
        agg.valueCents += line.valueCents;
      } else {
        byKey.set(k, { productId: product.id, location: line.location, stage: line.stage, quantity: line.quantity, valueCents: line.valueCents });
      }
    }

    const [imp] = await tx
      .insert(inventoryImports)
      .values({
        source: 'peasy',
        snapshotDate,
        filename: input.filename,
        fileHash: preview.fileHash,
        rowCount: preview.parse.stats.dataRows,
        totalValueCents: preview.totalValueCents,
        status: 'imported',
        warnings: toImportIssues(preview.issues),
        importedBy: ctx.userId,
      })
      .returning({ id: inventoryImports.id });

    const values = [...byKey.values()].map((v) => ({
      importId: imp.id,
      snapshotDate,
      productId: v.productId,
      location: v.location,
      stage: v.stage,
      quantity: quantityToDb(v.quantity),
      unitCostCents: v.quantity === 0 ? 0 : Math.abs(unitCostOf(v.valueCents, v.quantity)),
      valueCents: v.valueCents,
    }));
    if (values.length > 0) await tx.insert(inventorySnapshots).values(values);

    return {
      importId: imp.id,
      snapshotDate,
      lineCount: values.length,
      totalValueCents: preview.totalValueCents,
      createdProducts: [...created.values()],
      replacedImportIds,
    };
  });
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

export interface ShipmentPreviewLine {
  key: string;
  year: number;
  month: number;
  item: PeasyItemRef;
  product: ResolvedProduct | null;
  channelCode: ChannelCode;
  units: number;
  returns: number;
  peasyCostCents: number | null;
  rowIndexes: number[];
}

export interface ShipmentPeriodState {
  year: number;
  month: number;
  label: string;
  units: number;
  /** An earlier import already holds units for this month. */
  hasExisting: boolean;
  /** COGS is posted for this month: it cannot be re-imported until reversed. */
  cogsPosted: boolean;
}

export interface ShipmentsPreview {
  filename: string;
  fileHash: string;
  parse: PeasyShipmentsParse;
  lines: ShipmentPreviewLine[];
  periods: ShipmentPeriodState[];
  unknownItems: UnknownItem[];
  issues: Issue[];
  blockers: string[];
}

export async function previewPeasyShipments(
  input: PeasyFileInput & PeasyShipmentOptions,
  exec?: LedgerDb,
): Promise<ShipmentsPreview> {
  const x = reader(exec);
  const file = await readFile(input.bytes, input.filename);
  const parse = parsePeasyShipments(file, input);
  const hash = fileHash(input.bytes);
  const issues: Issue[] = [...parse.issues];
  const blockers: string[] = [];
  if (blocksCommit(parse.issues)) {
    blockers.push('The file has rows that could not be read or attributed; fix them and upload again.');
  }

  const { resolved, unknown, issues: resolveIssues } = await resolveItems(x, parse.lines.map((l) => l.item));
  issues.push(...resolveIssues);

  const lines: ShipmentPreviewLine[] = parse.lines.map((l) => ({
    key: l.key,
    year: l.year,
    month: l.month,
    item: l.item,
    product: resolved.get(itemKey(l.item)) ?? null,
    channelCode: l.channelCode,
    units: l.units,
    returns: l.returns,
    peasyCostCents: l.peasyCostCents,
    rowIndexes: l.rowIndexes,
  }));

  const periods: ShipmentPeriodState[] = [];
  for (const p of parse.periods) {
    const [existing] = await x
      .select({ n: sqlTag<string>`count(*)` })
      .from(shipmentUnits)
      .where(and(eq(shipmentUnits.periodYear, p.year), eq(shipmentUnits.periodMonth, p.month)));
    const [posted] = await x
      .select({ id: cogsBatches.id })
      .from(cogsBatches)
      .where(and(eq(cogsBatches.periodYear, p.year), eq(cogsBatches.periodMonth, p.month), eq(cogsBatches.status, 'posted')));
    const state: ShipmentPeriodState = {
      year: p.year,
      month: p.month,
      label: formatPeriodKey(p.year, p.month),
      units: lines.filter((l) => l.year === p.year && l.month === p.month).reduce((s, l) => s + l.units - l.returns, 0),
      hasExisting: Number(existing.n) > 0,
      cogsPosted: posted !== undefined,
    };
    if (state.cogsPosted) {
      blockers.push(`COGS for ${state.label} is posted; reverse that batch before importing its shipments again.`);
    }
    periods.push(state);
  }

  const [dup] = await x
    .select({ id: shipmentImports.id })
    .from(shipmentImports)
    .where(and(eq(shipmentImports.fileHash, hash), eq(shipmentImports.status, 'imported')));
  if (dup) blockers.push('This exact file has already been imported.');
  if (lines.length === 0 && !blocksCommit(parse.issues)) blockers.push('The file has no shipments.');

  return { filename: input.filename, fileHash: hash, parse, lines, periods, unknownItems: unknown, issues, blockers };
}

export interface ShipmentsCommitResult {
  imports: Array<{ importId: string; year: number; month: number; lineCount: number }>;
  createdProducts: ResolvedProduct[];
}

export async function commitPeasyShipments(
  input: PeasyFileInput & PeasyShipmentOptions & CommitOptions,
  ctx: InventoryCtx,
): Promise<ShipmentsCommitResult> {
  return inTx(ctx, async (tx) => {
    const preview = await previewPeasyShipments(input, tx);
    if (preview.blockers.length > 0) {
      throw new InventoryError('import_refused', 'The Peasy shipments file cannot be imported.', preview.blockers);
    }
    const clashes = preview.periods.filter((p) => p.hasExisting);
    if (clashes.length > 0 && !input.replaceExisting) {
      throw new InventoryError(
        'import_refused',
        `Shipments for ${clashes.map((c) => c.label).join(', ')} are already imported. Choose to replace them.`,
      );
    }

    const created = await createConfirmedProducts(tx, preview.unknownItems, input.createProducts ?? []);
    const channelRows = await tx.select({ id: channels.id, code: channels.code }).from(channels);
    const channelId = new Map(channelRows.map((c) => [c.code, c.id]));

    const imports: ShipmentsCommitResult['imports'] = [];
    for (const period of preview.periods) {
      if (period.hasExisting) {
        await tx
          .delete(shipmentUnits)
          .where(and(eq(shipmentUnits.periodYear, period.year), eq(shipmentUnits.periodMonth, period.month)));
        await tx
          .update(shipmentImports)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(shipmentImports.periodYear, period.year),
              eq(shipmentImports.periodMonth, period.month),
              eq(shipmentImports.status, 'imported'),
            ),
          );
      }

      const agg = new Map<string, { productId: string; channelId: string; units: number; returns: number }>();
      const periodLines = preview.lines.filter((l) => l.year === period.year && l.month === period.month);
      for (const line of periodLines) {
        const product = line.product ?? created.get(itemKey(line.item));
        if (!product) throw new InventoryError('import_refused', `${describeItem(line.item)} has no product.`);
        const ch = channelId.get(line.channelCode);
        if (!ch) throw new InventoryError('not_found', `Channel ${line.channelCode} is not set up.`);
        const k = `${product.id}|${ch}`;
        const a = agg.get(k);
        if (a) {
          a.units += line.units;
          a.returns += line.returns;
        } else {
          agg.set(k, { productId: product.id, channelId: ch, units: line.units, returns: line.returns });
        }
      }

      const [imp] = await tx
        .insert(shipmentImports)
        .values({
          source: 'peasy',
          periodYear: period.year,
          periodMonth: period.month,
          filename: input.filename,
          fileHash: preview.fileHash,
          rowCount: periodLines.reduce((s, l) => s + l.rowIndexes.length, 0),
          status: 'imported',
          importedBy: ctx.userId,
        })
        .returning({ id: shipmentImports.id });

      const values = [...agg.values()].map((a) => ({
        importId: imp.id,
        periodYear: period.year,
        periodMonth: period.month,
        productId: a.productId,
        channelId: a.channelId,
        customerId: null,
        units: quantityToDb(a.units),
        returnsUnits: quantityToDb(a.returns),
      }));
      if (values.length > 0) await tx.insert(shipmentUnits).values(values);
      imports.push({ importId: imp.id, year: period.year, month: period.month, lineCount: values.length });
    }

    return { imports, createdProducts: [...created.values()] };
  });
}

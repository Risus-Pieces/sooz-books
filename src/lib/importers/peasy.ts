/**
 * Peasy — the inventory-position and shipments importers.
 *
 * Peasy is Sooz's operations system of record for QUANTITIES: what is on hand,
 * where, and what shipped. Sooz Books carries the VALUE. Two Peasy exports feed
 * it:
 *
 *   1. **Inventory position** (Inventory > Count > Import / Export > Export
 *      current inventory, or Inventory as of a date > Download CSV) becomes an
 *      `inventory_snapshots` set — the counted side of the tie-out.
 *   2. **Shipments by SKU × channel × month**, read either from a report with a
 *      channel column or from Peasy's Inventory History CSV (Reports > Current
 *      View), whose sale rows carry the item, the customer and the signed
 *      quantity — the driver of the monthly COGS batch.
 *
 * This module is pure: it turns a `ParsedFile` into typed rows, aggregated
 * lines, fingerprints and issues, and never touches the database. Product
 * resolution, the preview and the write live in `@/lib/inventory/peasy-intake`.
 *
 * **No real Peasy export has been seen.** `docs/formats/peasy.md` marks every
 * column as verified (named in Peasy's help centre) or inferred. Columns are
 * therefore chosen by name through alias tables, never by position, and the
 * columns Peasy documents as selling-price based ("Unit Value", "Total Value")
 * are refused as a source of cost and reported rather than silently used.
 *
 * Nothing is silently dropped. A row that cannot be read is an `error` issue
 * carrying its raw text, and an `error` refuses the commit. A row that is
 * deliberately not counted — a receipt or a work-order line in an Inventory
 * History file, a Pending movement — is reported with its reason and counted in
 * `stats.excluded`.
 */

import { createHash } from 'node:crypto';

import type { ParsedFile } from '@/lib/banking/types';
import { type CalendarDate, daysInMonth, isCalendarDate, parseDateInput } from '@/lib/dates';
import { STAGES, type Stage } from '@/lib/inventory/accounts';
import { QuantityError, extendCost, parseQuantity } from '@/lib/inventory/quantity';
import { type ChannelCode, CHANNEL_CODES } from '@/lib/ledger/coa';
import { parseMoney } from '@/lib/money';

import type { Issue } from './types';

export const PEASY_INVENTORY_IMPORTER_ID = 'peasy.inventory.v1';
export const PEASY_SHIPMENTS_IMPORTER_ID = 'peasy.shipments.v1';

/** Unit separator: a value containing it cannot forge a fingerprint collision. */
const SEP = '\u001f';

function sha(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join(SEP), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

type Field =
  | 'sku'
  | 'item'
  | 'itemId'
  | 'variantType'
  | 'category'
  | 'stage'
  | 'location'
  | 'lot'
  | 'unit'
  | 'quantity'
  | 'unitCost'
  | 'totalCost'
  | 'asOf'
  | 'month'
  | 'date'
  | 'channel'
  | 'customer'
  | 'units'
  | 'returns'
  | 'signedQuantity'
  | 'txnType'
  | 'status'
  | 'transactionId'
  | 'orderId'
  | 'sellingValue';

/** Normalised header -> field. Normalised = lower case, letters and digits only. */
const ALIASES: Readonly<Record<Field, readonly string[]>> = {
  sku: ['sku', 'itemsku', 'variantsku', 'productsku'],
  item: ['itemname', 'item', 'name', 'product', 'productname', 'variantname'],
  itemId: ['itemid', 'parentitemid', 'peasyid', 'peasyitemid', 'variantid'],
  variantType: ['varianttype', 'itemtype', 'unittype'],
  category: ['category', 'itemcategory'],
  stage: ['stage', 'inventorystage'],
  location: ['location', 'warehouse', 'site'],
  lot: ['lot', 'lotcode', 'lotnumber', 'batch'],
  unit: ['unit', 'uom', 'unitofmeasure'],
  quantity: ['quantity', 'qty', 'onhand', 'quantityonhand', 'inventory', 'closingquantity', 'count'],
  unitCost: ['unitcost', 'avgcost', 'averagecost', 'cost', 'costperunit'],
  totalCost: ['totalcost', 'inventoryvalue', 'valueatcost', 'extendedcost', 'costvalue'],
  asOf: ['asof', 'asofdate', 'snapshotdate', 'countdate'],
  month: ['month', 'period', 'shipmonth'],
  date: ['inventorydate', 'shipdate', 'shippeddate', 'date', 'fulfilleddate', 'orderdate'],
  channel: ['channel', 'saleschannel', 'source', 'store', 'marketplace'],
  customer: ['customer', 'vendorcustomer', 'customername', 'account'],
  units: ['unitsshipped', 'quantityshipped', 'shippedquantity', 'unitssold', 'quantitysold', 'units'],
  returns: ['unitsreturned', 'returns', 'returnedquantity', 'returnquantity', 'quantityreturned'],
  signedQuantity: ['signedquantity'],
  txnType: ['type', 'transactiontype', 'movementtype'],
  status: ['status'],
  transactionId: ['transactionid'],
  orderId: ['orderid', 'ordernumber', 'salesorder'],
  sellingValue: ['unitvalue', 'totalvalue'],
};

function norm(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

type ColumnMap = Partial<Record<Field, number>>;

function mapColumns(header: readonly string[]): ColumnMap {
  const map: ColumnMap = {};
  const normalised = header.map(norm);
  for (const field of Object.keys(ALIASES) as Field[]) {
    for (const alias of ALIASES[field]) {
      const index = normalised.indexOf(alias);
      if (index !== -1 && !Object.values(map).includes(index)) {
        map[field] = index;
        break;
      }
    }
  }
  return map;
}

/** The header row: the first of the first ten rows that names an item and a quantity. */
function findHeader(rows: readonly string[][], kind: PeasyExportKind): { index: number; map: ColumnMap } | null {
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    const map = mapColumns(rows[i]);
    const hasItem = map.sku !== undefined || map.item !== undefined || map.itemId !== undefined;
    const hasQty =
      kind === 'inventory'
        ? map.quantity !== undefined
        : map.units !== undefined || map.signedQuantity !== undefined || map.quantity !== undefined;
    if (hasItem && hasQty) return { index: i, map };
  }
  return null;
}

function cell(row: readonly string[], map: ColumnMap, field: Field): string {
  const i = map[field];
  return i === undefined ? '' : (row[i] ?? '').trim();
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export type PeasyExportKind = 'inventory' | 'shipments';

/** How a Peasy row names an item. Resolution to a product happens at intake. */
export interface PeasyItemRef {
  sku: string | null;
  name: string | null;
  peasyId: string | null;
}

/** The key rows are grouped by: SKU when present, else Peasy item id, else name. */
export function itemKey(ref: PeasyItemRef): string {
  if (ref.sku) return `sku:${ref.sku.toUpperCase()}`;
  if (ref.peasyId) return `id:${ref.peasyId.toLowerCase()}`;
  return `name:${(ref.name ?? '').toLowerCase().replace(/\s+/g, ' ')}`;
}

export function describeItem(ref: PeasyItemRef): string {
  return ref.sku ?? ref.name ?? ref.peasyId ?? '(unnamed item)';
}

export interface PeasyParseStats {
  physicalRows: number;
  dataRows: number;
  /** Rows that became part of a line. */
  used: number;
  /** Rows deliberately not counted, each reported in `issues`. */
  excluded: number;
  /** Rows that could not be read, each an `error` in `issues`. */
  unreadable: number;
}

function itemOf(row: readonly string[], map: ColumnMap): PeasyItemRef | null {
  const sku = cell(row, map, 'sku') || null;
  const name = cell(row, map, 'item') || null;
  const peasyId = cell(row, map, 'itemId') || null;
  if (!sku && !name && !peasyId) return null;
  return { sku, name, peasyId };
}

function rowError(rowIndex: number, raw: readonly string[], code: string, message: string, field?: string): Issue {
  return {
    severity: 'error',
    code,
    message,
    rowIndex,
    rawRow: [...raw],
    ...(field === undefined ? {} : { field }),
  };
}

// ---------------------------------------------------------------------------
// Inventory position
// ---------------------------------------------------------------------------

export interface PeasyInventoryOptions {
  /** The count date. Required unless the file has an as-of column or a date in its name. */
  snapshotDate?: CalendarDate;
  /** Stage for rows nothing else classifies. Without it such a row is an error. */
  defaultStage?: Stage;
  /** Stage by SKU, item name or Peasy id (case-insensitive); beats everything in the file. */
  stageOverrides?: Readonly<Record<string, Stage>>;
}

export interface PeasySnapshotRow {
  rowIndex: number;
  item: PeasyItemRef;
  location: string;
  stage: Stage;
  stageSource: 'override' | 'stage' | 'category' | 'variant_type' | 'default';
  lot: string | null;
  /** Hundredths of a unit. */
  quantity: number;
  /** From the file; null when it carries no cost for the row. */
  unitCostCents: number | null;
  /** From the file's total-cost column, else quantity × unit cost; null when neither exists. */
  valueCents: number | null;
  fingerprint: string;
}

/** Rows sharing item, location and stage (several lots, typically), summed. */
export interface PeasySnapshotLine {
  key: string;
  item: PeasyItemRef;
  location: string;
  stage: Stage;
  quantity: number;
  /** Null when no row of the line carried a cost; intake may value it at product cost. */
  valueCents: number | null;
  rowIndexes: number[];
  fingerprint: string;
}

export interface PeasyInventoryParse {
  importerId: typeof PEASY_INVENTORY_IMPORTER_ID;
  snapshotDate: CalendarDate | null;
  rows: PeasySnapshotRow[];
  lines: PeasySnapshotLine[];
  issues: Issue[];
  stats: PeasyParseStats;
  columns: ColumnMap;
}

const STAGE_WORDS: ReadonlyArray<[RegExp, Stage]> = [
  [/transit/i, 'in_transit'],
  [/\bwip\b|in[ -]?process|work in/i, 'wip'],
  [/pack|label|film|carton|pouch stock|shipper|bottle|can\b|cap\b|lid/i, 'packaging'],
  [/raw|ingredient|material|component/i, 'raw'],
  [/finish|\bfg\b|sellable|product/i, 'finished'],
];

function stageFromWords(text: string): Stage | null {
  if (text === '') return null;
  const exact = text.toLowerCase().replace(/[\s-]+/g, '_');
  if ((STAGES as readonly string[]).includes(exact)) return exact as Stage;
  for (const [pattern, stage] of STAGE_WORDS) if (pattern.test(text)) return stage;
  return null;
}

function stageFromVariantType(text: string): Stage | null {
  const t = text.toLowerCase();
  if (t === 'sell' || t === 'make') return 'finished';
  if (t === 'buy') return 'raw';
  return null;
}

const FILENAME_DATE = /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/;

function dateFromFilename(filename: string): CalendarDate | null {
  const m = FILENAME_DATE.exec(filename);
  if (!m) return null;
  const candidate = `${m[1]}-${m[2]}-${m[3]}`;
  return isCalendarDate(candidate) ? candidate : null;
}

function overrideFor(overrides: Readonly<Record<string, Stage>> | undefined, item: PeasyItemRef): Stage | null {
  if (!overrides) return null;
  const lower = new Map(Object.entries(overrides).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of [item.sku, item.name, item.peasyId]) {
    if (k && lower.has(k.toLowerCase())) return lower.get(k.toLowerCase()) ?? null;
  }
  return null;
}

function money(text: string): number {
  return parseMoney(text);
}

export function parsePeasyInventory(file: ParsedFile, options: PeasyInventoryOptions = {}): PeasyInventoryParse {
  const issues: Issue[] = [];
  const stats: PeasyParseStats = {
    physicalRows: file.rows.length,
    dataRows: 0,
    used: 0,
    excluded: 0,
    unreadable: 0,
  };
  const empty = (snapshotDate: CalendarDate | null): PeasyInventoryParse => ({
    importerId: PEASY_INVENTORY_IMPORTER_ID,
    snapshotDate,
    rows: [],
    lines: [],
    issues,
    stats,
    columns: {},
  });

  const header = findHeader(file.rows, 'inventory');
  if (header === null) {
    issues.push({
      severity: 'fatal',
      code: 'header.missing_required',
      message: 'No header row names both an item (SKU, Item Name or Item ID) and a quantity.',
      remedy: 'Export current inventory from Peasy (Inventory > Count > Import / Export) and upload the CSV unchanged.',
    });
    return empty(options.snapshotDate ?? null);
  }
  const { map } = header;
  if (map.sellingValue !== undefined) {
    issues.push({
      severity: 'info',
      code: 'column.selling_value_ignored',
      message:
        'The file\'s "Unit Value" / "Total Value" column is based on selling price in Peasy, not cost, and is not used to value inventory.',
    });
  }
  if (map.unitCost === undefined && map.totalCost === undefined) {
    issues.push({
      severity: 'warn',
      code: 'column.no_cost',
      message:
        'The file carries no cost column. Lines will be valued at each product\'s unit cost on the snapshot date where one exists, and flagged where none does.',
    });
  }

  const data = file.rows.slice(header.index + 1);
  stats.dataRows = data.length;

  // The count date: given > file column > filename.
  const fileDates = new Set<string>();
  if (map.asOf !== undefined) {
    for (const raw of data) {
      const text = cell(raw, map, 'asOf');
      if (text === '') continue;
      try {
        fileDates.add(parseDateInput(text));
      } catch {
        // Reported per row below.
      }
    }
  }
  let snapshotDate: CalendarDate | null = options.snapshotDate ?? null;
  if (snapshotDate === null && fileDates.size === 1) snapshotDate = [...fileDates][0];
  if (snapshotDate === null && fileDates.size > 1) {
    issues.push({
      severity: 'fatal',
      code: 'date.multiple',
      message: `The file covers several as-of dates (${[...fileDates].sort().join(', ')}); one snapshot is one date.`,
      remedy: 'Export one date at a time, or name the snapshot date.',
    });
    return empty(null);
  }
  if (snapshotDate === null) snapshotDate = dateFromFilename(file.filename);
  if (snapshotDate === null) {
    issues.push({
      severity: 'fatal',
      code: 'date.missing',
      message: 'The file does not say what date it counts, and none was given.',
      remedy: 'Enter the date the export was taken (Peasy\'s current-inventory export has no date column).',
    });
    return empty(null);
  }
  if (options.snapshotDate !== undefined && fileDates.size > 0 && !fileDates.has(options.snapshotDate)) {
    issues.push({
      severity: 'warn',
      code: 'date.mismatch',
      message: `The file says ${[...fileDates].join(', ')} but ${options.snapshotDate} was given; ${options.snapshotDate} is used.`,
    });
  }

  const rows: PeasySnapshotRow[] = [];
  const seen = new Map<string, number>();
  data.forEach((raw, rowIndex) => {
    const item = itemOf(raw, map);
    if (item === null) {
      stats.unreadable += 1;
      issues.push(rowError(rowIndex, raw, 'item.missing', 'The row names no item.'));
      return;
    }

    let quantity: number;
    try {
      const q = parseQuantity(cell(raw, map, 'quantity'));
      quantity = q.hundredths;
      if (q.rounded) {
        issues.push({
          severity: 'warn',
          code: 'quantity.rounded',
          message: `${describeItem(item)}: quantity ${cell(raw, map, 'quantity')} rounded to two decimals.`,
          rowIndex,
        });
      }
    } catch (error) {
      stats.unreadable += 1;
      issues.push(
        rowError(rowIndex, raw, 'quantity.unparsable', error instanceof QuantityError ? error.message : 'Unreadable quantity.', 'quantity'),
      );
      return;
    }

    let unitCostCents: number | null = null;
    let valueCents: number | null = null;
    try {
      const unitText = cell(raw, map, 'unitCost');
      const totalText = cell(raw, map, 'totalCost');
      if (unitText !== '') unitCostCents = money(unitText);
      if (totalText !== '') valueCents = money(totalText);
    } catch (error) {
      stats.unreadable += 1;
      issues.push(rowError(rowIndex, raw, 'cost.unparsable', error instanceof Error ? error.message : 'Unreadable cost.'));
      return;
    }
    if (valueCents === null && unitCostCents !== null) valueCents = extendCost(quantity, unitCostCents);
    if (valueCents !== null && unitCostCents !== null) {
      const expected = extendCost(quantity, unitCostCents);
      const tolerance = Math.max(1, Math.ceil(Math.abs(quantity) / 200));
      if (Math.abs(expected - valueCents) > tolerance) {
        issues.push({
          severity: 'warn',
          code: 'cost.inconsistent',
          message: `${describeItem(item)}: total cost ${valueCents}¢ is not quantity × unit cost (${expected}¢). The total is used.`,
          rowIndex,
        });
      }
    }
    if (quantity < 0) {
      issues.push({
        severity: 'warn',
        code: 'quantity.negative',
        message: `${describeItem(item)} is negative on hand in Peasy (${cell(raw, map, 'quantity')}). Kept as counted.`,
        rowIndex,
      });
    }

    let stage: Stage | null = overrideFor(options.stageOverrides, item);
    let stageSource: PeasySnapshotRow['stageSource'] = 'override';
    if (stage === null && map.stage !== undefined) {
      stage = stageFromWords(cell(raw, map, 'stage'));
      stageSource = 'stage';
    }
    if (stage === null && map.category !== undefined) {
      stage = stageFromWords(cell(raw, map, 'category'));
      stageSource = 'category';
    }
    if (stage === null && map.variantType !== undefined) {
      stage = stageFromVariantType(cell(raw, map, 'variantType'));
      stageSource = 'variant_type';
    }
    if (stage === null && options.defaultStage !== undefined) {
      stage = options.defaultStage;
      stageSource = 'default';
    }
    if (stage === null) {
      stats.unreadable += 1;
      issues.push(
        rowError(
          rowIndex,
          raw,
          'stage.unknown',
          `Cannot tell whether ${describeItem(item)} is finished goods, an ingredient or packaging.`,
          'stage',
        ),
      );
      return;
    }

    const location = cell(raw, map, 'location') || 'default';
    const lot = cell(raw, map, 'lot') || null;
    const fingerprint = sha([
      PEASY_INVENTORY_IMPORTER_ID,
      snapshotDate as string,
      itemKey(item),
      location.toLowerCase(),
      stage,
      lot ?? '',
      String(quantity),
      String(valueCents ?? ''),
    ]);
    const duplicateOf = seen.get(fingerprint);
    if (duplicateOf !== undefined) {
      issues.push({
        severity: 'warn',
        code: 'row.duplicate',
        message: `Row ${rowIndex + 1} repeats row ${duplicateOf + 1} exactly (${describeItem(item)}). Both are counted; check the export was not doubled.`,
        rowIndex,
      });
    } else {
      seen.set(fingerprint, rowIndex);
    }
    stats.used += 1;
    rows.push({ rowIndex, item, location, stage, stageSource, lot, quantity, unitCostCents, valueCents, fingerprint });
  });

  const byKey = new Map<string, PeasySnapshotLine>();
  for (const row of rows) {
    const key = [itemKey(row.item), row.location.toLowerCase(), row.stage].join('|');
    const line = byKey.get(key);
    if (line) {
      const mixed = (line.valueCents === null) !== (row.valueCents === null);
      line.quantity += row.quantity;
      line.valueCents = line.valueCents === null && row.valueCents === null ? null : (line.valueCents ?? 0) + (row.valueCents ?? 0);
      line.rowIndexes.push(row.rowIndex);
      if (mixed) {
        issues.push({
          severity: 'warn',
          code: 'cost.partial',
          message: `${describeItem(row.item)} at ${row.location}: some lots carry a cost and some do not; the uncosted lots add nothing to the value.`,
          rowIndex: row.rowIndex,
        });
      }
    } else {
      byKey.set(key, {
        key,
        item: row.item,
        location: row.location,
        stage: row.stage,
        quantity: row.quantity,
        valueCents: row.valueCents,
        rowIndexes: [row.rowIndex],
        fingerprint: sha([PEASY_INVENTORY_IMPORTER_ID, snapshotDate as string, key]),
      });
    }
  }
  const lines = [...byKey.values()];
  const merged = lines.filter((l) => l.rowIndexes.length > 1);
  if (merged.length > 0) {
    issues.push({
      severity: 'info',
      code: 'rows.merged',
      message: `${merged.length} item/location/stage line(s) were summed from several rows (lots): ${merged
        .slice(0, 5)
        .map((l) => `${describeItem(l.item)} (${l.rowIndexes.length})`)
        .join(', ')}${merged.length > 5 ? ', …' : ''}.`,
    });
  }

  return { importerId: PEASY_INVENTORY_IMPORTER_ID, snapshotDate, rows, lines, issues, stats, columns: map };
}

// ---------------------------------------------------------------------------
// Shipments by SKU x channel x month
// ---------------------------------------------------------------------------

export interface PeasyShipmentOptions {
  /** Channel or customer text (case-insensitive, exact) -> channel code. Beats the built-in patterns. */
  channelMap?: Readonly<Record<string, ChannelCode>>;
  /** Channel for rows nothing else attributes. Without it such a row is an error. */
  defaultChannelCode?: ChannelCode;
}

export interface PeasyShipmentRow {
  rowIndex: number;
  item: PeasyItemRef;
  year: number;
  month: number;
  channelCode: ChannelCode;
  channelSource: 'map' | 'channel' | 'customer' | 'default';
  customer: string | null;
  /** Hundredths; units shipped (positive) and returned (positive). */
  units: number;
  returns: number;
  /** Peasy's own cost on the sale row, when the export carries it. For cross-checks only. */
  peasyCostCents: number | null;
  fingerprint: string;
}

export interface PeasyShipmentLine {
  key: string;
  year: number;
  month: number;
  item: PeasyItemRef;
  channelCode: ChannelCode;
  units: number;
  returns: number;
  peasyCostCents: number | null;
  rowIndexes: number[];
  fingerprint: string;
}

export interface PeasyShipmentsParse {
  importerId: typeof PEASY_SHIPMENTS_IMPORTER_ID;
  /** True when read from an Inventory History export (Type / Signed Quantity columns). */
  fromInventoryHistory: boolean;
  rows: PeasyShipmentRow[];
  lines: PeasyShipmentLine[];
  periods: Array<{ year: number; month: number }>;
  issues: Issue[];
  stats: PeasyParseStats;
  columns: ColumnMap;
}

const CHANNEL_PATTERNS: ReadonlyArray<[RegExp, ChannelCode]> = [
  [/amazon|\bfba\b|seller central/i, 'AMAZON'],
  [/faire|wholesale/i, 'WHOLESALE'],
  [/unfi|kehe|distribut/i, 'DISTRIBUTOR'],
  [/restaurant|food ?service|cafe|café|catering/i, 'FOODSERVICE'],
  [/shopify|online store|\bdtc\b|website|web store|square|farmers? market|pop.?up|point of sale|\bpos\b/i, 'DTC'],
];

function channelFromText(text: string, map: ReadonlyMap<string, ChannelCode>): { code: ChannelCode; mapped: boolean } | null {
  if (text === '') return null;
  const exact = map.get(text.toLowerCase());
  if (exact) return { code: exact, mapped: true };
  const upper = text.toUpperCase();
  if ((CHANNEL_CODES as readonly string[]).includes(upper)) return { code: upper as ChannelCode, mapped: false };
  for (const [pattern, code] of CHANNEL_PATTERNS) if (pattern.test(text)) return { code, mapped: false };
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** `2026-08`, `2026-08-01`, `Aug 2026`, `August 2026`, `08/2026`, `8/1/2026`. */
export function parsePeriod(text: string): { year: number; month: number } | null {
  const t = text.trim();
  let m = /^(\d{4})[-/](\d{1,2})$/.exec(t);
  if (m) return valid(Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})[-/](\d{4})$/.exec(t);
  if (m) return valid(Number(m[2]), Number(m[1]));
  m = /^([A-Za-z]{3,9})\.?[\s,-]+(\d{4})$/.exec(t);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    return month === 0 ? null : valid(Number(m[2]), month);
  }
  try {
    const date = parseDateInput(t);
    return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) };
  } catch {
    return null;
  }
}

function valid(year: number, month: number): { year: number; month: number } | null {
  return year >= 2000 && year <= 2999 && month >= 1 && month <= 12 && daysInMonth(year, month) > 0
    ? { year, month }
    : null;
}

const SALE_TYPE = /sale|sold|ship|fulfil/i;
/** Movements that share words with a sale but are not one. */
const NOT_SALE_TYPE = /purchase|work order|receipt|transfer|return to vendor/i;
const COMPLETE_STATUS = /complete|shipped|fulfilled|closed|done/i;

export function parsePeasyShipments(file: ParsedFile, options: PeasyShipmentOptions = {}): PeasyShipmentsParse {
  const issues: Issue[] = [];
  const stats: PeasyParseStats = {
    physicalRows: file.rows.length,
    dataRows: 0,
    used: 0,
    excluded: 0,
    unreadable: 0,
  };
  const header = findHeader(file.rows, 'shipments');
  if (header === null) {
    issues.push({
      severity: 'fatal',
      code: 'header.missing_required',
      message: 'No header row names both an item and a shipped quantity.',
      remedy: 'Export the Inventory History (Reports > Current View) or a sales-by-item report from Peasy and upload it unchanged.',
    });
    return {
      importerId: PEASY_SHIPMENTS_IMPORTER_ID,
      fromInventoryHistory: false,
      rows: [],
      lines: [],
      periods: [],
      issues,
      stats,
      columns: {},
    };
  }
  const { map } = header;
  const fromInventoryHistory = map.signedQuantity !== undefined || (map.txnType !== undefined && map.units === undefined);
  const channelMap = new Map(
    Object.entries(options.channelMap ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]),
  );

  if (map.month === undefined && map.date === undefined) {
    issues.push({
      severity: 'fatal',
      code: 'header.no_period',
      message: 'The file has neither a month nor a date column, so shipments cannot be assigned to a month.',
    });
  }

  const data = file.rows.slice(header.index + 1);
  stats.dataRows = data.length;
  const excludedByReason = new Map<string, number[]>();
  const exclude = (reason: string, rowIndex: number): void => {
    stats.excluded += 1;
    const list = excludedByReason.get(reason) ?? [];
    list.push(rowIndex);
    excludedByReason.set(reason, list);
  };

  const rows: PeasyShipmentRow[] = [];
  const seenTxn = new Map<string, number>();
  if (!issues.some((i) => i.severity === 'fatal')) {
    data.forEach((raw, rowIndex) => {
      const item = itemOf(raw, map);
      if (item === null) {
        stats.unreadable += 1;
        issues.push(rowError(rowIndex, raw, 'item.missing', 'The row names no item.'));
        return;
      }

      if (map.txnType !== undefined) {
        const type = cell(raw, map, 'txnType');
        if (!SALE_TYPE.test(type) || NOT_SALE_TYPE.test(type)) {
          exclude(`type "${type || '(blank)'}" is not a sale or shipment`, rowIndex);
          return;
        }
      }
      if (map.status !== undefined) {
        const status = cell(raw, map, 'status');
        if (!COMPLETE_STATUS.test(status)) {
          exclude(`status "${status || '(blank)'}" is not complete`, rowIndex);
          return;
        }
      }

      const periodText = map.month !== undefined ? cell(raw, map, 'month') : cell(raw, map, 'date');
      const period = parsePeriod(periodText);
      if (period === null) {
        stats.unreadable += 1;
        issues.push(rowError(rowIndex, raw, 'date.unparsable', `Cannot read "${periodText}" as a month or date.`, 'date'));
        return;
      }

      let units = 0;
      let returns = 0;
      try {
        if (map.units !== undefined) {
          units = parseQuantity(cell(raw, map, 'units')).hundredths;
        } else if (map.signedQuantity !== undefined) {
          // Inventory History: a sale removes stock, so its signed quantity is negative.
          units = -parseQuantity(cell(raw, map, 'signedQuantity')).hundredths;
        } else {
          units = Math.abs(parseQuantity(cell(raw, map, 'quantity')).hundredths);
        }
        const returnsText = cell(raw, map, 'returns');
        if (returnsText !== '') returns = Math.abs(parseQuantity(returnsText).hundredths);
      } catch (error) {
        stats.unreadable += 1;
        issues.push(
          rowError(rowIndex, raw, 'quantity.unparsable', error instanceof Error ? error.message : 'Unreadable quantity.', 'units'),
        );
        return;
      }
      if (units < 0) {
        issues.push({
          severity: 'warn',
          code: 'units.negative',
          message: `${describeItem(item)}: a negative shipment (${cell(raw, map, map.units !== undefined ? 'units' : 'signedQuantity')}) is read as a return.`,
          rowIndex,
        });
        returns += -units;
        units = 0;
      }

      const customer = cell(raw, map, 'customer') || null;
      const channelText = cell(raw, map, 'channel');
      let channelCode: ChannelCode | null = null;
      let channelSource: PeasyShipmentRow['channelSource'] = 'channel';
      const fromChannel = channelFromText(channelText, channelMap);
      if (fromChannel) {
        channelCode = fromChannel.code;
        channelSource = fromChannel.mapped ? 'map' : 'channel';
      } else if (customer) {
        const fromCustomer = channelFromText(customer, channelMap);
        if (fromCustomer) {
          channelCode = fromCustomer.code;
          channelSource = fromCustomer.mapped ? 'map' : 'customer';
        }
      }
      if (channelCode === null && options.defaultChannelCode !== undefined) {
        channelCode = options.defaultChannelCode;
        channelSource = 'default';
      }
      if (channelCode === null) {
        stats.unreadable += 1;
        issues.push(
          rowError(
            rowIndex,
            raw,
            'channel.unknown',
            `Cannot tell which channel "${channelText || customer || '(blank)'}" is. Map it to a channel or choose a default.`,
            'channel',
          ),
        );
        return;
      }

      let peasyCostCents: number | null = null;
      const costText = cell(raw, map, 'totalCost');
      if (costText !== '') {
        try {
          peasyCostCents = Math.abs(parseMoney(costText));
        } catch {
          issues.push({
            severity: 'info',
            code: 'cost.unparsable',
            message: `Peasy's cost "${costText}" on row ${rowIndex + 1} is unreadable; it is only used as a cross-check.`,
            rowIndex,
          });
        }
      }

      const txn = cell(raw, map, 'transactionId') || cell(raw, map, 'orderId');
      const fingerprint = sha([
        PEASY_SHIPMENTS_IMPORTER_ID,
        txn,
        itemKey(item),
        periodText,
        String(units),
        String(returns),
        customer ?? '',
        txn === '' ? String(rowIndex) : '',
      ]);
      if (txn !== '') {
        const prior = seenTxn.get(fingerprint);
        if (prior !== undefined) {
          issues.push({
            severity: 'warn',
            code: 'row.duplicate',
            message: `Row ${rowIndex + 1} repeats transaction ${txn} from row ${prior + 1}. Both are counted; check the export.`,
            rowIndex,
          });
        } else {
          seenTxn.set(fingerprint, rowIndex);
        }
      }

      stats.used += 1;
      rows.push({
        rowIndex,
        item,
        year: period.year,
        month: period.month,
        channelCode,
        channelSource,
        customer,
        units,
        returns,
        peasyCostCents,
        fingerprint,
      });
    });
  }

  for (const [reason, indexes] of excludedByReason) {
    issues.push({
      severity: 'info',
      code: 'row.excluded',
      message: `${indexes.length} row(s) not counted as shipments: ${reason} (rows ${indexes
        .slice(0, 10)
        .map((i) => i + 1)
        .join(', ')}${indexes.length > 10 ? ', …' : ''}).`,
    });
  }

  const byKey = new Map<string, PeasyShipmentLine>();
  for (const row of rows) {
    const key = [row.year, row.month, itemKey(row.item), row.channelCode].join('|');
    const line = byKey.get(key);
    if (line) {
      line.units += row.units;
      line.returns += row.returns;
      line.peasyCostCents =
        line.peasyCostCents === null && row.peasyCostCents === null ? null : (line.peasyCostCents ?? 0) + (row.peasyCostCents ?? 0);
      line.rowIndexes.push(row.rowIndex);
    } else {
      byKey.set(key, {
        key,
        year: row.year,
        month: row.month,
        item: row.item,
        channelCode: row.channelCode,
        units: row.units,
        returns: row.returns,
        peasyCostCents: row.peasyCostCents,
        rowIndexes: [row.rowIndex],
        fingerprint: sha([PEASY_SHIPMENTS_IMPORTER_ID, key]),
      });
    }
  }
  const lines = [...byKey.values()];
  const periods = [...new Set(lines.map((l) => `${l.year}-${l.month}`))]
    .map((p) => {
      const [year, month] = p.split('-').map(Number);
      return { year, month };
    })
    .sort((a, b) => a.year - b.year || a.month - b.month);

  return {
    importerId: PEASY_SHIPMENTS_IMPORTER_ID,
    fromInventoryHistory,
    rows,
    lines,
    periods,
    issues,
    stats,
    columns: map,
  };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface PeasyDetection {
  kind: PeasyExportKind | null;
  confidence: number;
  reasons: string[];
}

/** Which Peasy export this looks like. Cheap, pure, never throws. */
export function detectPeasyExport(file: ParsedFile): PeasyDetection {
  const shipments = findHeader(file.rows, 'shipments');
  const inventory = findHeader(file.rows, 'inventory');
  const reasons: string[] = [];
  if (shipments) {
    const m = shipments.map;
    if (m.signedQuantity !== undefined && m.txnType !== undefined) {
      reasons.push('Has Peasy Inventory History columns (Type, Signed Quantity).');
      return { kind: 'shipments', confidence: 0.9, reasons };
    }
    if (m.units !== undefined && (m.month !== undefined || m.date !== undefined)) {
      reasons.push('Has shipped-units and period columns.');
      if (m.channel !== undefined) reasons.push('Has a channel column.');
      return { kind: 'shipments', confidence: m.channel !== undefined ? 0.8 : 0.65, reasons };
    }
  }
  if (inventory) {
    const m = inventory.map;
    reasons.push('Has item and on-hand quantity columns.');
    let confidence = 0.6;
    if (m.location !== undefined) {
      reasons.push('Has a location column.');
      confidence += 0.1;
    }
    if (m.unitCost !== undefined || m.totalCost !== undefined) {
      reasons.push('Has a cost column.');
      confidence += 0.1;
    }
    return { kind: 'inventory', confidence, reasons };
  }
  return { kind: null, confidence: 0, reasons: ['No item and quantity columns found.'] };
}

/** True when any issue stops the file from being written. */
export function blocksCommit(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.severity === 'fatal' || i.severity === 'error');
}

export function formatPeriodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

import { describe, expect, it } from 'vitest';

import { readFile } from '@/lib/banking/read-file';

import {
  blocksCommit,
  detectPeasyExport,
  itemKey,
  parsePeasyInventory,
  parsePeasyShipments,
  parsePeriod,
} from './peasy';

async function grid(text: string, filename = 'peasy.csv') {
  return readFile(new TextEncoder().encode(text), filename);
}

describe('Peasy inventory position', () => {
  it('reads items, stages, lots and cost, merging lots and ignoring selling-price value', async () => {
    const file = await grid(
      [
        'Item Name,SKU,Category,Variant Type,Location,Lot,Quantity,Unit Cost,Total Value',
        'Mango Breeze Pouch,MB-POUCH-12,Finished Goods,Sell,Co-man,L1,500,1.25,2000.00',
        'Mango Breeze Pouch,MB-POUCH-12,Finished Goods,Sell,Co-man,L2,332.5,1.25,1330.00',
        'Allulose,,Ingredients,Buy,Co-man,,12.345,4.00,',
        'Printed film,FILM-01,Packaging,Buy,Houston,,1000,0.12,',
        'Mystery item,,,,Houston,,3,,',
      ].join('\n'),
      'peasy-inventory-2026-08-31.csv',
    );
    const parsed = parsePeasyInventory(file);
    expect(parsed.snapshotDate).toBe('2026-08-31'); // from the filename
    expect(parsed.issues.some((i) => i.code === 'column.selling_value_ignored')).toBe(true);

    const pouch = parsed.lines.find((l) => l.item.sku === 'MB-POUCH-12');
    expect(pouch?.stage).toBe('finished');
    expect(pouch?.quantity).toBe(832_50);
    expect(pouch?.valueCents).toBe(500 * 125 + 41563); // 332.5 × 1.25 = 415.625 -> 415.63
    expect(pouch?.rowIndexes).toEqual([0, 1]);

    const allulose = parsed.lines.find((l) => l.item.name === 'Allulose');
    expect(allulose?.stage).toBe('raw');
    expect(allulose?.quantity).toBe(1235);
    expect(parsed.issues.some((i) => i.code === 'quantity.rounded')).toBe(true);
    expect(parsed.lines.find((l) => l.item.sku === 'FILM-01')?.stage).toBe('packaging');

    // An unclassifiable row is never dropped silently: it is an error that blocks the commit.
    const unknown = parsed.issues.find((i) => i.code === 'stage.unknown');
    expect(unknown?.severity).toBe('error');
    expect(unknown?.rawRow?.[0]).toBe('Mystery item');
    expect(blocksCommit(parsed.issues)).toBe(true);
    expect(parsed.stats.used + parsed.stats.unreadable + parsed.stats.excluded).toBe(parsed.stats.dataRows);
  });

  it('accepts a default stage and per-item overrides, and refuses a file with no date', async () => {
    const file = await grid('Item,Quantity\nMango Breeze Stick,10\nWS-23,2\n');
    expect(parsePeasyInventory(file).issues.some((i) => i.code === 'date.missing' && i.severity === 'fatal')).toBe(true);
    const parsed = parsePeasyInventory(file, {
      snapshotDate: '2026-09-01',
      defaultStage: 'finished',
      stageOverrides: { 'ws-23': 'raw' },
    });
    expect(blocksCommit(parsed.issues)).toBe(false);
    expect(parsed.lines.map((l) => l.stage)).toEqual(['finished', 'raw']);
    expect(parsed.lines.every((l) => l.valueCents === null)).toBe(true);
    expect(parsed.issues.some((i) => i.code === 'column.no_cost')).toBe(true);
  });

  it('fingerprints lines stably by date, item, location and stage', async () => {
    const text = 'SKU,Location,Stage,Quantity,Unit Cost\nA-1,WH,finished,5,1.00\n';
    const a = parsePeasyInventory(await grid(text), { snapshotDate: '2026-08-31' });
    const b = parsePeasyInventory(await grid(text), { snapshotDate: '2026-08-31' });
    const c = parsePeasyInventory(await grid(text), { snapshotDate: '2026-09-30' });
    expect(a.lines[0].fingerprint).toBe(b.lines[0].fingerprint);
    expect(a.lines[0].fingerprint).not.toBe(c.lines[0].fingerprint);
    expect(itemKey({ sku: 'a-1', name: null, peasyId: null })).toBe('sku:A-1');
  });

  it('flags a total cost that disagrees with quantity × unit cost and keeps the total', async () => {
    const parsed = parsePeasyInventory(
      await grid('SKU,Stage,Quantity,Unit Cost,Total Cost\nA-1,finished,10,1.00,12.00\n'),
      { snapshotDate: '2026-08-31' },
    );
    expect(parsed.lines[0].valueCents).toBe(1200);
    expect(parsed.issues.some((i) => i.code === 'cost.inconsistent')).toBe(true);
  });
});

describe('Peasy shipments', () => {
  it('aggregates a shipments report by month, SKU and channel', async () => {
    const file = await grid(
      [
        'Month,SKU,Channel,Customer,Units Shipped,Units Returned',
        '2026-08,MB-POUCH-12,Square,,100,0',
        'Aug 2026,MB-POUCH-12,Square,,23,1',
        '2026-08,MB-POUCH-12,Amazon FBA,,40,0',
        '2026-09,MB-POUCH-12,,Whole Foods Cafe,6,0',
      ].join('\n'),
    );
    const parsed = parsePeasyShipments(file);
    expect(blocksCommit(parsed.issues)).toBe(false);
    expect(parsed.periods).toEqual([
      { year: 2026, month: 8 },
      { year: 2026, month: 9 },
    ]);
    const dtc = parsed.lines.find((l) => l.month === 8 && l.channelCode === 'DTC');
    expect(dtc?.units).toBe(123_00);
    expect(dtc?.returns).toBe(1_00);
    expect(parsed.lines.find((l) => l.channelCode === 'AMAZON')?.units).toBe(40_00);
    expect(parsed.lines.find((l) => l.month === 9)?.channelCode).toBe('FOODSERVICE');
  });

  it('reads Peasy Inventory History: sale rows only, sign flipped, others reported not dropped', async () => {
    const file = await grid(
      [
        'Item Name,Type,Order ID,Transaction ID,Status,Quantity,Signed Quantity,Inventory Date,Location,Vendor/Customer,Unit Cost,Total Cost',
        'Mango Breeze Pouch,Sale Order,SO-1,T1,Complete,12,-12,2026-08-03,Houston,Shopify,1.25,15.00',
        'Mango Breeze Pouch,Sale Order,SO-2,T2,Pending,5,-5,2026-08-04,Houston,Shopify,1.25,6.25',
        'Mango Breeze Pouch,Work Order Output,WO-1,T3,Complete,500,500,2026-08-01,Co-man,,1.25,625.00',
        'Allulose,Receipt,PO-1,T4,Complete,25,25,2026-08-01,Co-man,Supplier,4.00,100.00',
        'Mango Breeze Pouch,Sale Order,SO-3,T5,Complete,3,-3,2026-08-09,Houston,Acme Wholesale,1.25,3.75',
      ].join('\n'),
    );
    const detection = detectPeasyExport(file);
    expect(detection.kind).toBe('shipments');
    expect(detection.confidence).toBeGreaterThanOrEqual(0.9);

    const parsed = parsePeasyShipments(file);
    expect(parsed.fromInventoryHistory).toBe(true);
    expect(parsed.stats.excluded).toBe(3);
    expect(parsed.stats.used).toBe(2);
    expect(parsed.stats.used + parsed.stats.excluded + parsed.stats.unreadable).toBe(parsed.stats.dataRows);
    const excluded = parsed.issues.filter((i) => i.code === 'row.excluded');
    expect(excluded.map((i) => i.message).join(' ')).toMatch(/Pending/);
    expect(excluded.map((i) => i.message).join(' ')).toMatch(/Work Order Output/);

    const dtc = parsed.lines.find((l) => l.channelCode === 'DTC');
    expect(dtc?.units).toBe(12_00);
    expect(dtc?.peasyCostCents).toBe(1500);
    expect(parsed.lines.find((l) => l.channelCode === 'WHOLESALE')?.units).toBe(3_00);
  });

  it('refuses an unattributable channel unless mapped or defaulted', async () => {
    const text = 'Month,SKU,Customer,Units Shipped\n2026-08,A-1,Bob,4\n';
    const plain = parsePeasyShipments(await grid(text));
    expect(plain.issues.find((i) => i.code === 'channel.unknown')?.severity).toBe('error');
    expect(parsePeasyShipments(await grid(text), { channelMap: { bob: 'FOODSERVICE' } }).lines[0].channelCode).toBe(
      'FOODSERVICE',
    );
    expect(parsePeasyShipments(await grid(text), { defaultChannelCode: 'DTC' }).lines[0].channelCode).toBe('DTC');
  });

  it('reads the month forms a report uses', () => {
    expect(parsePeriod('2026-08')).toEqual({ year: 2026, month: 8 });
    expect(parsePeriod('08/2026')).toEqual({ year: 2026, month: 8 });
    expect(parsePeriod('August 2026')).toEqual({ year: 2026, month: 8 });
    expect(parsePeriod('8/15/2026')).toEqual({ year: 2026, month: 8 });
    expect(parsePeriod('2026-13')).toBeNull();
    expect(parsePeriod('soon')).toBeNull();
  });
});

describe('detection', () => {
  it('tells an inventory position from a shipments report', async () => {
    const inv = await grid('SKU,Location,Quantity,Unit Cost\nA,WH,1,1\n');
    expect(detectPeasyExport(inv).kind).toBe('inventory');
    const none = await grid('Date,Description,Amount\n2026-01-01,x,1\n');
    expect(detectPeasyExport(none).kind).toBeNull();
  });
});

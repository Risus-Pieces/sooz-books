# Peasy — inventory position and shipments exports

**Peasy is Sooz Beverage LLC's operations system of record for quantities**: items, on-hand stock by
location and lot, purchase orders, work orders (production), sales orders and transfers. Sooz Books is
the system of record for **value**: what a unit costs landed, what inventory is worth on the balance
sheet, and what COGS to recognise against units shipped. Two Peasy exports connect the two.

| Export | Becomes | Used by |
|---|---|---|
| Inventory position (current, or as of a date) | `inventory_imports` + `inventory_snapshots` | the inventory tie-out (`src/lib/inventory/tieout.ts`) |
| Shipments by SKU × channel × month (a sales report, or the Inventory History CSV) | `shipment_imports` + `shipment_units` | the monthly COGS batch (`src/lib/inventory/cogs.ts`) |

Parser: `src/lib/importers/peasy.ts` (pure). Intake, preview and write: `src/lib/inventory/peasy-intake.ts`.

> ⚠️ **Read this first. No real Peasy export file has been seen.** This document is assembled from
> Peasy's public help centre and from a read-only look at the live Sooz workspace through the Peasy
> connector (item names and quantities only, no file). Every claim carries a mark:
>
> | Mark | Meaning |
> |---|---|
> | ✅ | **Verified** — stated in Peasy's help centre (page named), or observed in the live Sooz workspace. |
> | ❓ | **Inferred** — a reasonable construction the first real export will confirm or kill. |
>
> Because the column contract is inferred, the parser selects columns **by name through alias tables,
> never by position**, refuses what it cannot classify rather than guessing, and reports every row it
> does not count. Validate against a real export (§8) before trusting the tie-out or a COGS batch built
> from it.

---

## 1. What Peasy is and what it can export

- Peasy is free inventory, production and lot-tracking software for small CPG brands, with multi-location
  stock, purchase orders, work orders and a QuickBooks sync. ✅ ([peasyos.com](https://peasyos.com/))
- Items are organised as **item families** with **variants**; each variant has a type: **Buy** (purchased
  from a vendor), **Sell** (sold to a customer), **Make** (produced in-house) or **Conversion** (counting
  only). Categories are **user-defined** tags such as "Dry Goods" or "Packaging". Fields named: Item Name,
  Unit, Conversion ratio, Variant Name, Unit Price / Unit Cost, SKU, Category. ✅
  ([Understanding Items and Units](https://peasyos.com/help/understanding-items-and-units))
- Peasy does **not** have a built-in "raw / packaging / finished" stage field. ✅ (same page) Stage must
  therefore be derived — see §4.
- Stock is tracked **separately per location**; totals are available across locations. ✅
  ([Inventory Overview](https://peasyos.com/help/inventory-overview))
- **Export current inventory** (Inventory > Count > Import / Export menu) downloads "a CSV snapshot of
  on-hand quantities". It "reflects what you see on screen" — a search term, category filter or the Count
  quick filter narrows the CSV. ✅ ([Counting Inventory](https://peasyos.com/help/counting-inventory))
- **Inventory as of a date** — pick a date, then **Download CSV** (or Export to Google Sheets). **Compare
  inventory dates** shows opening, closing and net quantities, percentage change, and expense and sale
  values. Both "cover the whole business and do not inherit the Count page's search, filters, or selected
  location." ✅ (same page)
- **Inventory History** (every movement) downloads through Reports > Current View. Its columns include
  **Item Name, Type, Order ID, Transaction ID, Status, Quantity, Inventory Date, Created At, Performed By,
  Location, Vendor/Customer, Notes**, value and cost fields, and a **Signed Quantity** column (positive
  adds stock, negative removes it). The CSV includes **both Pending and Complete** rows. ✅
  ([Inventory History](https://peasyos.com/help/inventory-history))
- In Inventory History, **Unit / Total Value are based on selling price** (sale orders use the line price,
  others the list price) — they are **not cost**. **Unit / Total Cost** is the vendor price on receipts,
  consumption cost on work-order inputs, production cost on work-order outputs, and **COGS on sales**. ✅
  (same page)
- Work orders run Draft → Planned → In Progress → Complete (or Cancelled) and record ingredient
  consumption and finished output, including runs that produced nothing usable. ✅
  ([Work Order](https://peasyos.com/help/work-order))

What the live Sooz workspace shows (read-only, 2026-09-18): ✅ 12 items, all at quantity 0 at "All
Locations", named e.g. *Allulose*, *Instant Micellar Casein*, *Whole Milk Powder*, *Mango Breeze Pouch*,
*Mango Breeze Stick*. Items are identified by **name and a Peasy item UUID**; no SKU was surfaced by the
connector. **No sales are recorded** in the past year. So today both exports would be (nearly) empty:
Sooz has no production and no Peasy-recorded shipments yet, and its ingredients and packaging sit in
1320 / 1330 at the value the bank and bill modules post.

## 2. Export A — inventory position

**How to produce it** ✅: Inventory > Count > Import / Export > *Export current inventory* (clear any
search or filter first, or the file is partial), **or** Reports > *Inventory as of a date* > Download CSV
(preferred for month end: it is dated and whole-business).

**Columns** — ❓ inferred; Peasy does not publish the header. Recognised by normalised name (lower case,
letters and digits only):

| Field | Accepted headers | Required |
|---|---|---|
| SKU | `SKU`, `Item SKU`, `Variant SKU`, `Product SKU` | one of SKU / name / id |
| Item name | `Item Name`, `Item`, `Name`, `Product`, `Variant Name` | ″ |
| Peasy item id | `Item ID`, `Parent Item ID`, `Peasy ID`, `Variant ID` | ″ |
| Variant type | `Variant Type`, `Item Type` (Buy / Sell / Make) | no |
| Category | `Category` | no |
| Stage | `Stage`, `Inventory Stage` (a Sooz-added column, if any) | no |
| Location | `Location`, `Warehouse`, `Site` | no (→ `default`) |
| Lot | `Lot`, `Lot Code`, `Lot Number`, `Batch` | no |
| Quantity | `Quantity`, `Qty`, `On Hand`, `Quantity On Hand`, `Inventory`, `Closing Quantity` | **yes** |
| Unit cost | `Unit Cost`, `Avg Cost`, `Average Cost`, `Cost` | no |
| Total cost | `Total Cost`, `Inventory Value`, `Value at Cost`, `Extended Cost` | no |
| As-of date | `As Of`, `As Of Date`, `Snapshot Date`, `Count Date` | no |

`Unit Value` / `Total Value` are **recognised and deliberately ignored** (selling-price based, ✅ above);
the preview says so.

**Snapshot date**: the date entered at upload wins; else the file's as-of column (every row must agree,
or the file is refused); else a `YYYY-MM-DD` in the filename; else the file is refused (`date.missing`).
The current-inventory export is not believed to carry a date column (❓), so enter it.

**Value**: total cost if present; else quantity × unit cost (rounded once, half away from zero). A row
whose total disagrees with quantity × unit cost by more than half a cent per unit is flagged
(`cost.inconsistent`) and the total is used. A line with no cost at all is valued at the product's own
unit cost on the snapshot date (`unit_cost_at`) and marked `product_cost`; with no unit cost either, it
is counted at $0 and flagged `cost.none` — so the tie-out shows it rather than hiding it.

**Lots**: rows sharing item × location × stage (typically several lots) are summed into one snapshot
line; the preview lists which were merged. Exact duplicate rows are counted and flagged (`row.duplicate`).

## 3. Export B — shipments by SKU × channel × month

Two sources are accepted.

**B1 — a sales / shipments report** ❓ with a month or date, the item, a channel and units:

| Field | Accepted headers |
|---|---|
| Period | `Month`, `Period` (`2026-08`, `08/2026`, `Aug 2026`, `August 2026`) or a date column |
| Item | as in §2 |
| Channel | `Channel`, `Sales Channel`, `Source`, `Store`, `Marketplace` |
| Customer | `Customer`, `Vendor/Customer`, `Customer Name` |
| Units shipped | `Units Shipped`, `Quantity Shipped`, `Units Sold`, `Quantity Sold`, `Units` |
| Units returned | `Units Returned`, `Returns`, `Returned Quantity` |

**B2 — the Inventory History CSV** ✅ columns (§1). Only **sale** rows count (Type matching
sale / sold / ship / fulfil, and not purchase / work order / receipt / transfer ❓ — the exact Type labels
are not published), and only **Complete** rows (Pending is excluded ✅ because the CSV carries both).
Units = −Signed Quantity (a sale removes stock ✅). Peasy's own Total Cost on those rows is kept as a
cross-check only (`peasyCostCents`); Sooz Books values COGS at its own landed cost.

Every excluded row is reported, grouped by reason with its row numbers (`row.excluded`), and counted in
`stats.excluded`; `used + excluded + unreadable = dataRows` always holds.

**Channel attribution** (Inventory History has no channel column ✅, so the customer carries it), in
order: the uploader's explicit map (text → channel) → a channel-code match → built-in patterns → the
same on the customer → the chosen default channel → otherwise the row is an **error** and the file is
refused. Built-in patterns:

| Pattern | Channel |
|---|---|
| Amazon, FBA, Seller Central | AMAZON |
| Faire, wholesale | WHOLESALE |
| UNFI, KeHE, distributor | DISTRIBUTOR |
| restaurant, foodservice, cafe, catering | FOODSERVICE |
| Shopify, online store, DTC, website, **Square**, farmers market, pop-up, POS | DTC |

Square maps to DTC because Square is Sooz's direct and market channel and `square-intake.ts` files it
under DTC.

Rows aggregate to one line per month × item × channel; a negative shipment is read as a return and
flagged.

## 4. Stage — where a line sits on the balance sheet

Peasy has no stage field ✅, so each line's stage is decided, first match wins: an explicit per-item
override given at upload → a `Stage` column → the **Category** text (packag/label/film/carton → packaging;
raw/ingredient/material/component → raw; finish/sellable/product → finished; WIP/in process → wip;
transit → in_transit) → the **Variant Type** (Sell / Make → finished, Buy → raw) → the default stage
chosen at upload → otherwise an **error** (`stage.unknown`) that blocks the file.

| Stage | Ledger account |
|---|---|
| finished | 1310 Finished Goods |
| raw | 1320 Raw Ingredients |
| wip | 1320 Raw Ingredients (materials at the co-man stay in 1320 until the run is costed) |
| packaging | 1330 Packaging Materials |
| in_transit | 1340 Goods in Transit |

⚠️ Sooz's "Mango Breeze Pouch" and "Mango Breeze Stick" are ambiguous by name (a pouch can be packaging
or a finished pack format). Categorise them in Peasy, or pass a stage override, before the first import.

## 5. Items → products

Each Peasy item is matched to `products` by SKU (case-insensitive), then `products.peasy_id`, then exact
name when exactly one product has it. **An unknown item never creates a product silently**: the preview
lists it with a suggested SKU (`PEASY-<NAME>` when Peasy gives none), and the commit is refused unless
every unknown item is confirmed with the SKU and name to create. Created products carry the Peasy id.

## 6. Deduplication and replacement

- **File**: sha256 of the bytes. The same file is refused a second time (`inventory_imports.file_hash`
  is unique; shipments check `shipment_imports.file_hash` among imported files).
- **Lines**: inventory lines are keyed and fingerprinted by snapshot date × item × location × stage;
  shipment lines by month × item × channel. Fingerprints are sha256 over the key with a unit-separator
  join, so re-parsing the same content yields the same key.
- **Replacing**: a second file for a snapshot date or month that already has data is refused unless the
  uploader chooses *replace*; the earlier import is marked `cancelled` and its rows removed. A month
  whose **COGS batch is posted** cannot be replaced until that batch is reversed.

## 7. What each export drives

- **Tie-out** (`recordTieout`) compares the latest snapshot on or before a date with the posted balance of
  1310 / 1320 / 1330 / 1340 on the snapshot date, per account, and records `inventory_tieouts` with the
  variance and per-account detail. It **proposes** a true-up (inventory against 5060) and never posts it;
  `postTieoutAdjustment` is the human approval step, and refuses if the ledger moved since recording.
- **COGS** (`draftCogsBatch` → `postCogsBatch`) values each month × SKU × channel's net units (shipped −
  returned) at the unit cost effective at month end (`product_cost_at`), split by landed-cost component
  (5010 tolling, 5015 ingredients, 5020 packaging, 5030 freight in, 5040 duty) against 1310, every line
  tagged with product and channel.

## 8. Checklist for the first real export

1. Export *Inventory as of a date* for a month end, and the Inventory History for the same month.
2. Upload through the preview. Confirm every header was recognised (the preview shows the column map)
   and that no column you expected to be cost was actually `Total Value`.
3. Confirm the stage of every line; add Peasy categories where it had to fall back to the default.
4. Compare the preview's unit counts with Peasy's screen for three SKUs.
5. Confirm the Inventory History Type labels for sales; if they differ from sale / ship / fulfil, extend
   `SALE_TYPE` in `src/lib/importers/peasy.ts` and add the real file as a test fixture.
6. Update the ❓ marks in this document to ✅ with what the file showed.

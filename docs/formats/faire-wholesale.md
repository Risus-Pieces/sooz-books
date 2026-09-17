# Faire + Direct Wholesale / Foodservice Receivables

**Format spec for Sooz Books importers.**
Covers two distinct file families that both land in the "wholesale" bucket:

- **Part A — Faire** (brand-side marketplace). Faire pays Sooz; the retailer never owes Sooz money.
  Receivable is from *Faire*, cleared through a **Faire Clearing** account.
- **Part B — Direct wholesale & foodservice** (distributors, restaurant groups, independent grocers
  invoiced directly). Sooz carries real **AR** against the customer, and collects via ACH/check with a
  **remittance advice**.

The two parts are separate parsers. They share section 7's chart of accounts and section 5's dedup
discipline, and they meet in the reconciliation algorithm in §7.C.

> **Sourcing note.** Faire's Help Center and blog return HTTP 403 to automated fetchers, so exact header
> strings below are reconstructed from Faire's own field enumeration in "Can I export order data?"
> (reproduced in search indexes) plus community/bookkeeping descriptions of real exports. Treat the header
> strings as *expected*, not *guaranteed*: §6.A.1 specifies a header-normalization layer that must be built
> regardless, and §3.A.3 specifies an arithmetic identity that self-verifies the column semantics on import.
> Where sources disagree (notably commission rate), both readings are given.

---

## 1. How you get the file

### 1.A — Faire

There are **three** distinct brand-side exports. They are not interchangeable.

**A1. Payout Summary export (the primary file for accounting).**

1. Log in to the Faire **brand** portal at `faire.com` (brand account, not retailer).
2. Left nav → **Orders**.
3. Top-right → **Export**.
4. Choose **Payout summary** (the other choice is **Product info**).
5. Pick a date range. Options are **All time**, **Last 30 days**, **Last 60 days**, **Custom**.
6. **Export CSV**.

**A2. Payouts page export (same data, payout-centric entry point).**

1. Left nav → **Payouts**.
2. **Export** → **All time / Last 30 days / Last 60 days / Custom**.
3. **Export CSV**.

**A3. Product info export (line-item detail — needed to value damages and to post COGS).**

1. **Orders** → **Export** → **Product info (.csv)**.
2. Contains SKU, product name, quantity, wholesale unit price, retail price, image URLs, and the order
   number that joins back to A1.

**Options that matter:**

- **Small files download in-browser; large files are emailed to the account owner instead.** The importer
  must accept a file that arrived by email attachment, not just a browser download. There is no documented
  row cap, but assume anything over roughly a year of orders takes the email path.
- Faire has no "include cancelled orders" toggle — cancelled orders simply do not appear in a payout
  summary, because they generated no payout.
- **Choose the date range by *payout* date, not order date.** The Payouts-page export ranges on payout
  date; the Orders-page export ranges on order date and will therefore hand you orders whose payout has
  not happened yet (blank payout date). Prefer the Payouts-page export (A2) for period close.
- If the brand operates in more than one Faire region (US + EU), each region is a separate brand account
  and a separate export with a different currency. Do not merge them in one import run.

**A4. Faire API (optional, for automation).** `developers.faire.com` documents Faire External API v2,
brand-side endpoints for products, orders, inventory and shipments. Faire's v1 is deprecated. The API is
a reasonable future replacement for A1/A3 but is **not** a substitute for the payout file today: the API
exposes order economics, not the bank-deposit batching, so you would still have to re-derive payout
grouping yourself.

### 1.B — Direct wholesale / foodservice remittance advice

There is no single source system. In practice Sooz receives, per paying customer:

- **Emailed PDF remittance advice** (most independent grocers, most restaurant groups) — must be OCR'd or
  hand-keyed into the canonical CSV shape in §8.B before import.
- **Emailed or SFTP CSV/XLSX remittance** (larger distributors: UNFI, KeHE, Sysco/US Foods-style vendor
  portals, DOT Foods). Column names are per-trading-partner and will never match across customers.
- **EDI 820 Payment Order/Remittance Advice** if the customer is EDI-enabled. The 820 carries payer/payee
  IDs, bank/account IDs, invoice numbers, billed vs paid amounts, and adjustment reason codes. If an EDI
  provider is in the loop, have it emit the canonical CSV in §8.B rather than teaching the importer X12.
- **Nothing at all** — a bare ACH credit in the bank feed with a memo like
  `GOLDEN GATE PROV  PAYABLES  0921`. This is the case the matching algorithm in §7.C exists for.

**Design decision:** the importer targets **one canonical remittance CSV** (§8.B). Every customer-specific
format gets a small per-customer column-mapping profile that rewrites into the canonical shape. Do not
build 14 parsers.

---

## 2. Columns

### 2.A.1 — Faire Payout Summary CSV

Header text as Faire enumerates the fields. Header casing and the exact wording of the Insider columns
have varied between export versions; §6.A.1 normalization is mandatory.

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Payout Date` | date | `2026-08-04` | Date Faire initiated the transfer. Blank/empty when the order has shipped but is inside its 30-/60-day payout window. | Yes (blank = unpaid) |
| `Payout Amount` | decimal | `1431.52` | Net cash for this order in this payout. **The authoritative number.** Can be negative (post-payout clawback). | Yes |
| `Order Number` | string | `FQ7K2M9X` | Faire's order token. Opaque uppercase alphanumeric — **parse as string**, never as a number, never strip leading zeros, do not assume a fixed prefix or length. | Yes |
| `Retailer Shop Name` | string | `Bodega Verde` | Buying store. Free text; contains commas, `&`, accented characters, emoji. | Yes |
| `Order Date` | date | `2026-06-03` | When the retailer placed the order. | Yes |
| `Order Total` | decimal | `1800.00` | Wholesale value of goods. **Ambiguous pre-/post-promotion — resolve with §3.A.3.** | Yes |
| `Currency` | string | `USD` | ISO 4217. `USD`/`CAD` for NA accounts, `GBP`/`EUR` for the non-NA entity. | Yes |
| `Quantity Damaged or Missing` | integer | `2` | **A UNIT COUNT, NOT DOLLARS.** See §6.A.4. | Yes (`0` when none) |
| `Promotions Applied` | decimal | `180.00` | Brand-funded discount on this order (first-order %, brand promo code, volume deal). Faire-funded promos do not appear here. | Yes (`0.00`) |
| `Commission Rate` | decimal or percent | `0.15` or `15%` | Rate applied. `0` on Faire Direct. Format varies — see §3.A.4. | Yes |
| `New Customer Fee` | decimal | `10.00` | Flat one-time fee when a Faire-sourced retailer places its first order with the brand. `0.00` otherwise. Header also seen as `New Customer Fee (if applicable)`. | Yes |
| `Total Commission` | decimal | `243.00` | Dollar commission charged. Header also seen as `Total Commission Charged`. | Yes |
| `Taxes Charged` | decimal | `0.00` | Sales tax Faire collected from the retailer. Pass-through — see §7.A.4. | Yes |
| `Shipping Costs Applied` | decimal | `96.00` | Shipping money moving on this order. **Sign/direction ambiguous — resolve with §3.A.3.** | Yes |
| `Payment Processing Fees` | decimal | `41.48` | Faire's processing fee, set by the brand's chosen payout speed. | Yes |
| `Insider Free Shipping` | boolean | `TRUE` / `Yes` | Whether the order shipped free under Faire Insider. | Yes |
| `Insider Fees Charged to Brand` | decimal | `122.20` | Insider shipping cost borne by Sooz. Header also seen as `Insider Fees Charged to the Brand`. | Conditional |
| `Insider Fees Charged to Faire` | decimal | `22.80` | Insider shipping cost Faire absorbed. **Informational only — never post it.** | Conditional |
| `Ship with Faire` | boolean | `FALSE` / `No` | Whether the brand bought the label through Faire. If `TRUE`, the label cost is inside `Shipping Costs Applied`. | Yes |

**Columns that are NOT in this file and that people expect to be:**
`Payout ID` / `Transfer ID` — there is none. `Invoice Number` — Faire only issues a brand invoice number
for EU brands, and it is on the order invoice PDF, not this export. `Order Status`. `Ship Date`.
`SKU` / line items — those are the Product info export (§2.A.2).

### 2.A.2 — Faire Product Info CSV (join file, for COGS and damage valuation)

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Order Number` | string | `FQ7K2M9X` | Join key to §2.A.1. | Yes |
| `Order Date` | date | `2026-06-03` | Order placement date. | Yes |
| `Retailer Shop Name` | string | `Bodega Verde` | Buying store. | Yes |
| `SKU` | string | `SOOZ-GRN-CH-12` | Brand SKU. May be blank if the brand never set one. | No |
| `Product Name` | string | `Cherry Almond Granola — 12ct case` | Free text, contains em dashes and commas. | Yes |
| `Variant Name` | string | `12 oz` | Option value; blank for single-variant products. | No |
| `Quantity` | integer | `6` | Units ordered. | Yes |
| `Wholesale Price` | decimal | `28.80` | Per-unit wholesale price. | Yes |
| `Retail Price` | decimal | `64.00` | MSRP; informational. | No |
| `Image URL` | string | `https://cdn.faire.com/...` | Product image. Ignore. | No |

### 2.B — Canonical remittance advice CSV

This is the shape every customer-specific remittance gets mapped into.

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `payer_name` | string | `Golden Gate Provisions` | Paying customer as they call themselves. Map to a customer id via an alias table — it will not match the AR customer name. | Yes |
| `payer_id` | string | `GGP-0142` | Customer's own vendor number for Sooz, or Sooz's customer code. Best join key when present. | No |
| `payment_reference` | string | `ACH-20260921-77431` | Check number or ACH trace. **The dedup anchor.** | Yes |
| `payment_date` | date | `2026-09-21` | Value date of the payment. | Yes |
| `payment_method` | string | `ACH` | `ACH` \| `CHECK` \| `WIRE` \| `CARD`. | No |
| `payment_total` | decimal | `19451.25` | Total of the check/deposit **as the payer states it**. May disagree with the sum of `amount_paid` — see §6.B.3. | No |
| `invoice_number` | string | `SZ-10447` | Sooz invoice being paid. Payers mangle this — see §6.B.2. | Yes |
| `invoice_date` | date | `2026-08-14` | Invoice date per the payer. Often wrong or blank. | No |
| `invoice_amount` | decimal | `3200.00` | Face amount of the invoice per the payer. | No |
| `discount_taken` | decimal | `17.80` | Early-payment (terms) discount. | No (`0.00`) |
| `deduction_amount` | decimal | `184.00` | Short-pay / chargeback on this invoice. | No (`0.00`) |
| `deduction_code` | string | `DMG` | Reason code. Per-customer vocabulary — see below. | No |
| `deduction_description` | string | `2 cs damaged in transit, PO 88431` | Free text; frequently multi-line. | No |
| `amount_paid` | decimal | `3016.00` | Cash applied to this invoice. Should equal `invoice_amount - discount_taken - deduction_amount`. | Yes |
| `currency` | string | `USD` | ISO 4217. | No (default `USD`) |

**Header variations actually seen in the wild, per trading-partner profile:**

| Canonical | Seen as |
|---|---|
| `invoice_number` | `Invoice #`, `Invoice No`, `Inv Num`, `Document Number`, `Reference`, `Your Invoice` |
| `invoice_amount` | `Gross Amount`, `Invoice Total`, `Billed Amount`, `Original Amount` |
| `amount_paid` | `Net Amount`, `Paid Amount`, `Amount`, `Payment Amount`, `Net Paid` |
| `deduction_amount` | `Adjustment`, `Deduction`, `Chargeback`, `Short Pay`, `Allowance` |
| `discount_taken` | `Discount`, `Terms Discount`, `Cash Discount`, `Disc Taken` |
| `payment_reference` | `Check Number`, `Check #`, `Payment ID`, `Trace Number`, `EFT Reference` |

**Deduction reason codes are per-customer, not standard.** Maintain a per-customer code map. Common
buckets: `DMG` damaged, `SHT` shortage/short ship, `OSD` over-short-damaged, `PROMO`/`MCB` promotional
allowance or manufacturer chargeback, `SPOIL` spoilage/swell allowance, `SLOT` slotting, `FRT` freight,
`UNSAL` unsaleables, `PRC` price discrepancy, `RTV` return to vendor. Each code maps to one of three
treatments in §7.B.4.

---

## 3. Sign and amount conventions

### 3.A — Faire

**3.A.1 — Faire uses positive-magnitude fee columns, not signed amounts.** There is no debit/credit pair.
Every fee column (`Total Commission`, `New Customer Fee`, `Payment Processing Fees`,
`Insider Fees Charged to Brand`, `Promotions Applied`) is a **positive number representing money taken
away**. The importer subtracts them. Do not sum the row.

**3.A.2 — `Payout Amount` can be negative.** A post-payout damage claim, a retailer refund, or a reversed
order produces a row with a negative payout and often `Order Total = 0.00`. Negative rows net against
positive rows inside the same payout batch. A payout *batch* total is normally positive but can be
negative in a bad week, in which case Faire debits the brand's bank account rather than crediting it.

**3.A.3 — MANDATORY: run the payout identity on import to resolve column semantics.** Two things are
genuinely ambiguous in the file: whether `Order Total` is before or after `Promotions Applied`, and whether
`Shipping Costs Applied` is a reimbursement *to* the brand (add) or a cost *charged to* the brand
(subtract). Rather than guessing, the parser probes them. Faire's own stated formula is
`payout = order subtotal + shipping reimbursement − commission − payment processing fee`.

Evaluate, over the first 50 rows with `Quantity Damaged or Missing = 0`:

```
candidate_1 (Order Total is GROSS, shipping is a REIMBURSEMENT):
  Order Total
  + Shipping Costs Applied
  - Promotions Applied
  - Total Commission
  - New Customer Fee
  - Payment Processing Fees
  - Insider Fees Charged to Brand
  ?= Payout Amount

candidate_2 (Order Total already NET of promotions):
  same, but drop the "- Promotions Applied" term

candidate_3 (shipping is a COST to the brand):
  candidate_1 with "- Shipping Costs Applied"
```

Pick whichever candidate holds within $0.01 on ≥95% of probe rows; persist that choice per brand account
and per export version. **If no candidate clears 95%, fail the import loudly rather than posting.** Once a
candidate is locked, the residual on any row is the damages/adjustment amount (§6.A.4).

The samples in §8.A are generated under **candidate_1**, which is the expected convention.

**3.A.4 — `Commission Rate` format varies.** Seen as `0.15`, `15`, and `15%`. Normalize:
strip `%`, then if the value is `> 1`, divide by 100. `0` and `0.00` both mean Faire Direct.
Never compute commission from the rate — always use `Total Commission`; the rate is a cross-check only,
and it is a *blended* rate on mixed orders.

**3.A.5 — Formatting.** Plain decimals with a `.` separator, two places, **no currency symbol, no thousands
separator, no parentheses** in the standard US export. Defensive parsing anyway: strip `$`, `£`, `€`, `,`,
and treat `(123.45)` as `-123.45`, because XLSX round-trips through Excel reintroduce all of these. Empty
string and `-` both mean zero for amount columns; **empty string in `Payout Date` means not-yet-paid and
must not be coerced to a date.**

**3.A.6 — Rounding.** Faire's processing fee is `rate × (goods + shipping) + $0.30`, rounded half-up to
cents *before* the $0.30 is added, so recomputation can disagree by a cent. Always trust the file's
`Payment Processing Fees`. Tolerance for all cross-checks: `$0.01` per row, `$0.05` per payout batch.

### 3.B — Remittance advice

**3.B.1 — Everything is positive.** `invoice_amount`, `discount_taken`, `deduction_amount` and
`amount_paid` are all positive magnitudes. The row's meaning is
`amount_paid = invoice_amount - discount_taken - deduction_amount`. Assert this per row; a failure means
the mapping profile is wrong.

**3.B.2 — Except credit memos, which arrive as negative rows.** A customer applying an existing credit
memo emits a row with a negative `invoice_amount` and negative `amount_paid`, e.g.
`CM-2211,-420.00,...,-420.00`. These reduce the deposit. Some payers instead put the credit memo in
`deduction_amount` on an unrelated invoice — catch it by matching `deduction_description` against open
credit memo numbers.

**3.B.3 — Some payers signal short-pays with parentheses or a trailing `CR`.** `(184.00)` and `184.00CR`
both appear. Normalize both to `-184.00` before the sign convention in 3.B.1 is applied.

**3.B.4 — Currency symbols and thousands separators are common** in PDF-derived remittances:
`$19,451.25`. Strip aggressively.

---

## 4. Date formats and timezone

### 4.A — Faire

- Primary observed format: **`YYYY-MM-DD`** (e.g. `2026-08-04`). Accept `MM/DD/YYYY` as a fallback — Excel
  round-trips convert it, and the non-NA export has been seen with `DD/MM/YYYY`.
- **Ambiguity trap:** `03/04/2026` is unresolvable in isolation. Resolution rule: scan the whole column;
  if any value has a first component `> 12`, the file is `DD/MM/YYYY`; if any has a second component
  `> 12`, it is `MM/DD/YYYY`; if neither, use the brand account's region (NA → `MM/DD/YYYY`,
  UK/EU → `DD/MM/YYYY`) and **flag the import for review**.
- `Payout Date` and `Order Date` are **dates only, no time component**, and Faire renders them in the
  brand account's locale timezone. Treat both as *local calendar dates with no timezone* and never
  convert. Converting a bare date to UTC is how a payout lands in the wrong month.
- **Period-boundary caveat:** a payout initiated on `2026-08-04` typically lands in the bank **1–3 business
  days later**, so a payout with an August 31 `Payout Date` frequently hits the bank statement in
  September. This is exactly why Faire Clearing exists (§7.A.1) — the clearing account carries the
  in-transit balance across the close. Do not force the bank deposit date to equal `Payout Date`.
- Blank `Payout Date` = shipped but inside the 30-/60-day payout window. Import the row (it is real revenue
  and a real receivable from Faire) but do not create a bank-side expectation.

### 4.B — Remittance advice

- No standard. `MM/DD/YYYY` dominates US distributor exports; `YYYYMMDD` (`20260921`) is common in EDI-820
  derived files; `DD-MMM-YY` (`21-SEP-26`) appears from Oracle/JDE-based payers.
- Store the date format per customer profile rather than sniffing every file.
- `payment_date` is the payer's **value date**, which is typically 1–2 banking days *before* the ACH lands
  in Sooz's account. Match on amount and invoice set, not on date equality. Allow a window of
  `payment_date` to `payment_date + 5 calendar days` when matching to the bank feed.
- No time component and no timezone anywhere. Do not manufacture one.

---

## 5. Identity and deduplication

### 5.A — Faire

**There is no payout id in the file.** This is the central problem.

- `Order Number` is stable and globally unique per order, but **it is not unique per row**: an order can
  appear on multiple payout dates (original payout, then a later clawback, then a replacement).
- `Payout Date` is not unique either — one payout date covers many orders.

**Row identity key:**

```
faire_row_key = sha256(
    normalize(order_number)        # uppercase, strip whitespace
  + '|' + iso(payout_date or 'UNPAID')
  + '|' + cents(payout_amount)
  + '|' + cents(order_total)
  + '|' + cents(total_commission)
)
```

Include `payout_amount` *and* the fee columns: order+date alone collides when Faire splits a single order
across two payout rows for the same date (partial shipment). Including the amounts makes a genuine
re-import of an overlapping date range idempotent while still admitting a legitimate second row.

**Payout batch identity** (the thing that matches a bank deposit):

```
faire_payout_batch_key = (brand_account_id, payout_date, currency)
batch_amount = SUM(payout_amount) over all rows with that key
```

Persist the batch with its amount and its member `faire_row_key`s. If a re-import produces a different
`batch_amount` for an already-reconciled batch, **do not silently update** — raise a discrepancy, because
the deposit already posted against the old amount.

**Overlap detection on re-import:** compute the set of `faire_row_key`s in the incoming file; rows already
present are skipped; rows present in the DB for a `payout_date` inside the file's range but *absent* from
the file are flagged as "possibly reversed by Faire" for human review, never auto-deleted.

### 5.B — Remittance advice

- **`payment_reference` is the stable id when present** — a check number or ACH trace is unique per payer.
  Deposit identity: `(customer_id, payment_reference)`.
- When `payment_reference` is absent (a bare PDF with no check number, common from small restaurant
  groups), fall back to:
  `(customer_id, payment_date, round(sum(amount_paid), 2), count(rows))`.
- **Line identity:** `(customer_id, payment_reference, invoice_number, sequence_within_reference)`. The
  sequence matters: a payer can emit two lines for one invoice (a partial payment plus a deduction line),
  and dropping one as a duplicate silently corrupts cash application.
- **Re-import safety:** a remittance is idempotent on `(customer_id, payment_reference)`. If the same
  reference arrives with a different line set, treat it as a *corrected* remittance: reverse the prior cash
  application in full and re-apply, rather than diffing lines.
- **The bank deposit is a separate object** with its own id from the bank feed. Never dedup a remittance
  against a bank transaction; they are two records that get *linked*, not merged.

---

## 6. Gotchas

### 6.A — Faire

1. **Header drift is constant.** Faire has renamed columns between export versions
   (`Total Commission` ↔ `Total Commission Charged`, `Insider Fees Charged to Brand` ↔
   `Insider Fees Charged to the Brand`). Normalize every header: lowercase, strip non-alphanumerics,
   collapse whitespace, drop leading `the`, drop trailing `(if applicable)` / `charged` / `applied`.
   Match against a synonym table. **Fail the import on an unmapped header**, do not ignore it — an ignored
   new fee column silently unbalances every entry.
2. **`Order Number` is not a number.** Values like `0012XKQ9` exist. Parsing as int and re-serializing
   destroys the join to the Product info export. Force the column to string at the CSV-reader level.
3. **`Retailer Shop Name` contains commas and quotes.** Use a real RFC-4180 CSV reader; `line.split(',')`
   will destroy roughly one row in thirty. Names also contain non-ASCII (`Café Lumière`, `Tienda Ñam`) and
   occasionally emoji.
4. **`Quantity Damaged or Missing` is a unit count, and the dollar value of the damage is NOT in the file.**
   You must derive it as the residual of the payout identity (§3.A.3):
   `damages_value = (identity RHS) - payout_amount`. Cross-check that residual against
   `Quantity Damaged or Missing × unit wholesale price` from the Product info export. If the residual is
   non-zero but the quantity is zero, you have an unexplained adjustment — route to a suspense account and
   flag, never force-balance.
5. **Preamble and footer rows.** Some Faire exports carry a brand-name/date-range preamble above the
   header row, and an emailed large export can include a trailing blank line plus a totals row. Detection:
   the header row is the first row containing ≥3 known header tokens; stop parsing at the first row where
   `Order Number` is empty *and* `Payout Amount` is populated (that is a totals row).
6. **Encoding.** Exports are UTF-8, and **frequently UTF-8 with a BOM** (`EF BB BF`), which turns the first
   header into `﻿Payout Date`. Strip the BOM. If the user re-saved from Excel on Windows, the file may
   be `cp1252`/latin-1 — sniff, and on decode failure retry as `cp1252` before giving up.
7. **XLSX disguised as CSV.** Users re-save the export in Excel and send a `.csv` that is actually an
   `.xlsx` (leading bytes `PK\x03\x04`) or, worse, an HTML table (leading `<`). Sniff the magic bytes
   before parsing.
8. **Excel mangles the data even when the extension is honest:** `Order Number` `1.2E+08`, `Payout Date`
   converted to a serial number `46237`, amounts gaining `$` and `,`. If any `Order Number` matches
   `^\d+(\.\d+)?E\+\d+$`, reject the file and tell the user to re-export rather than trying to recover it.
9. **`Insider Fees Charged to Faire` must never be posted.** It is Faire's own cost, shown for
   transparency. Posting it double-counts shipping expense. This column being present at all is the single
   most common source of an unbalanced Faire entry.
10. **Faire is the merchant of record for sales tax in facilitator states.** `Taxes Charged` is money Faire
    collected from the retailer and remits itself. Default treatment: **do not post it** (§7.A.4).
11. **Wholesale is usually sale-for-resale and therefore exempt anyway.** `Taxes Charged` is `0.00` on the
    overwhelming majority of rows. A non-zero value is worth a flag.
12. **A single order can produce several rows across several payout dates.** Do not assume one row per
    order; do not use `Order Number` as a primary key.
13. **Unpaid rows.** Blank `Payout Date` with a populated `Order Total` = shipped, not yet paid (30-/60-day
    payout speed). These are real revenue with a receivable from Faire. Import them; they will be paid in a
    later file and must not create a duplicate revenue entry when they are (the `faire_row_key` changes
    when `payout_date` fills in — handle this explicitly: match on `order_number` + amounts, and *update*
    the existing row's payout date rather than inserting).
14. **Replacement orders carry zero commission and zero processing fee** but appear as normal rows with a
    positive payout. Do not flag them as parse errors.
15. **Region split.** A brand operating in NA and the UK has two accounts, two currencies, two commission
    schedules. Never merge.
16. **Commission rate disagreement in the sources.** Faire's North America pricing update (effective
    **July 5, 2023**) moved NA brands to a **flat 15%** marketplace commission plus a **one-time $10 new
    customer fee**, and **0%** on Faire Direct. Multiple current third-party sources still describe the
    **legacy 25% on a new customer's first order / 15% on reorders** structure, which remains the
    documented structure for brands **outside** North America. **Do not hardcode either.** Read
    `Total Commission` from the file; use `Commission Rate` only to classify the order
    (`0` → Faire Direct, otherwise → marketplace).

### 6.B — Remittance advice

1. **The remittance often arrives on a different day than the money**, sometimes days before, sometimes a
   week after, sometimes never. Build the deposit-first path (§7.C) as the default, with the remittance as
   an enrichment that can arrive later and retroactively explain an already-posted deposit.
2. **Invoice numbers are mangled by the payer's AP system.** `SZ-10447` comes back as `SZ10447`,
   `10447`, `SZ-10447-A`, `SZ 10447`, `0000010447`. Match on a normalized form: uppercase, strip all
   non-alphanumerics, strip a known prefix, strip leading zeros — and keep a secondary index on the bare
   numeric tail.
3. **`payment_total` frequently does not equal `sum(amount_paid)`.** Causes: the payer omitted credit-memo
   lines; the remittance covers several Sooz entities; the payer netted a deduction at the check level
   rather than the invoice level. **Trust the bank, not the remittance.** The deposit amount from the bank
   feed is the authority; the remittance is a proposed allocation.
4. **Invoices that are not Sooz's.** Distributors send one consolidated remittance per check run that can
   include another vendor's invoices if the AP clerk misfiled. Any `invoice_number` that does not resolve
   to an open Sooz AR invoice goes to an exception queue, never to suspense silently.
5. **Multi-line `deduction_description`** with embedded newlines inside a quoted CSV field. RFC-4180 readers
   handle it; naive line-splitting does not. PDF-derived remittances wrap the description across visual
   rows with the other columns blank — the mapping profile must forward-fill.
6. **Footer totals and page headers in PDF-derived CSVs.** Repeated header rows every 40 lines (page
   breaks) and a `TOTAL` row at the end. Drop rows where `invoice_number` is empty, equals `TOTAL`, or
   repeats the header text.
7. **A deduction taken today can reference an invoice paid three months ago.** Do not restrict deduction
   matching to the invoices in the current remittance.
8. **Discount taken outside the terms window.** Customers routinely take the 2% after day 10. This is an
   unauthorized deduction, not a discount. Rule: if `payment_date > invoice_date + discount_days`, classify
   `discount_taken` as a **deduction** (`code = UNAUTH_DISC`) and post it to Deductions Receivable, not
   contra-revenue (§7.B.4). Make the grace period configurable (3 days is typical).
9. **Foodservice customers pay by statement, not by invoice**, and some send no invoice detail at all —
   just "payment on account, $12,400". These bypass §7.C entirely and go to oldest-first auto-application
   with a review flag.
10. **Encoding and delimiters.** SFTP drops from distributor portals are often `latin-1` and occasionally
    pipe- or tab-delimited despite a `.csv` extension. Sniff the delimiter across the first 5 lines.
11. **Duplicate remittance emails.** The same PDF is forwarded by two people at the customer. §5.B's
    `(customer_id, payment_reference)` key handles it; without a reference, the fallback key will
    false-negative on two genuinely identical same-day payments — rare, but flag equal-amount same-day
    pairs rather than auto-deduping.

---

## 7. Accounting treatment

### Chart of accounts used below

| Account | Type | Notes |
|---|---|---|
| `1010 Bank – Operating` | Asset | |
| `1200 AR – Wholesale` | Asset | Direct customers only. **Never used for Faire.** |
| `1250 Faire Clearing` | Asset | Receivable from Faire between shipment and deposit. |
| `1280 Deductions Receivable` | Asset | Disputed customer short-pays pending research. |
| `1400 Inventory – Finished Goods` | Asset | |
| `2000 AP` | Liability | |
| `2200 Sales Tax Payable` | Liability | |
| `4100 Gross Sales – Faire Marketplace` | Revenue | |
| `4110 Gross Sales – Faire Direct` | Revenue | |
| `4120 Gross Sales – Faire : Shipping` | Revenue | Shipping reimbursement. |
| `4200 Gross Sales – Wholesale Direct` | Revenue | |
| `4210 Gross Sales – Foodservice` | Revenue | |
| `4900 Contra-Revenue : Promotions & Trade` | Contra-revenue | Brand-funded promos, trade allowances. |
| `4910 Contra-Revenue : Early Payment Discounts` | Contra-revenue | Terms discounts. |
| `4920 Contra-Revenue : Returns & Allowances` | Contra-revenue | Damages, shortages, credit memos. |
| `5000 COGS` | Expense | |
| `6100 Processing Fees` | Expense | |
| `6110 Processing Fees : Faire Commission` | Expense | See note below. |
| `6200 Fulfillment Fees` | Expense | Outbound freight, labels, Insider shipping borne by brand. |
| `6300 Advertising Expense` | Expense | Faire Ads / promoted placement, billed separately. |

> **Note on Faire commission.** Sooz is the **principal** in a Faire sale (it owns the inventory, sets
> wholesale price, ships the goods), so revenue is recognized **gross** and the commission is a **selling
> expense**, not contra-revenue. Sooz Books' account list has no dedicated "Channel Commission" account, so
> commission maps to `6110 Processing Fees : Faire Commission`. **If a `Channel Commission Expense` account
> is later added, move it — the mapping is a chart-of-accounts limitation, not an accounting judgment.**
> Brand-funded **promotions** are different: they are a price concession to the customer and are genuine
> contra-revenue (`4900`).

### 7.A — Faire

**7.A.1 — The model.** Faire, not the retailer, owes Sooz. Faire pays the brand on the brand's chosen
payout speed regardless of the retailer's net-60 terms, so **Sooz carries no retailer credit risk and
books no AR for a Faire order.** Three events:

1. **Ship** → revenue recognized, `Faire Clearing` debited for the expected net payout, fees expensed.
2. **COGS** → inventory relieved.
3. **Deposit** → `Bank` debited, `Faire Clearing` credited by the payout batch total.

`Faire Clearing` should trend to zero and its balance at any date = sum of payouts earned but not yet
deposited (i.e. unpaid rows + in-transit batches). **Reconcile it monthly; a permanent residue means the
payout identity is mis-resolved.**

**7.A.2 — Per-row entry (marketplace order).**

```
Dr 1250 Faire Clearing                        payout_amount
Dr 4900 Contra-Revenue : Promotions & Trade   promotions_applied
Dr 6110 Processing Fees : Faire Commission    total_commission + new_customer_fee
Dr 6100 Processing Fees                       payment_processing_fees
Dr 6200 Fulfillment Fees                      insider_fees_charged_to_brand
Dr 4920 Contra-Revenue : Returns & Allowances damages_value          (derived residual)
    Cr 4100 Gross Sales – Faire Marketplace       order_total
    Cr 4120 Gross Sales – Faire : Shipping        shipping_costs_applied
```

Faire Direct rows are identical except `total_commission = 0` and the credit goes to
`4110 Gross Sales – Faire Direct`.

**7.A.3 — COGS entry**, from the Product info export:
`Dr 5000 COGS / Cr 1400 Inventory` at standard cost × quantity shipped.

**7.A.4 — Sales tax.** Default: **do not post `Taxes Charged`.** Faire is the marketplace facilitator and
the merchant of record; the tax never touches Sooz's cash and is not Sooz's liability. Provide a config
flag `faire_brand_is_tax_remitter` (false by default); when true, add
`Cr 2200 Sales Tax Payable  taxes_charged` and increase the Faire Clearing debit by the same amount.

**7.A.5 — Faire Ads** are billed separately (card charge or payout deduction on a separate statement), not
in this file. Post to `6300 Advertising Expense` from the ads invoice.

**7.A.6 — Fully worked example: one Faire payout batch, three orders, one deposit.**

Payout date `2026-08-04`. Brand is on the **30-day payout speed** → processing fee `2.4% + $0.30`.
Commission `15%` marketplace, `0%` Faire Direct.

*Order `FQ7K2M9X` — Bodega Verde, marketplace reorder, 10% brand-funded first-order promo, retailer paid
shipping.*

| Component | Amount |
|---|---|
| `Order Total` (gross wholesale) | 1,800.00 |
| `Promotions Applied` | 180.00 |
| net goods | 1,620.00 |
| `Shipping Costs Applied` (retailer-paid, reimbursed) | 96.00 |
| `Total Commission` = 15% × 1,620.00 | 243.00 |
| `New Customer Fee` | 0.00 |
| `Payment Processing Fees` = 2.4% × (1,620.00 + 96.00) + 0.30 = 41.18 + 0.30 | 41.48 |
| **`Payout Amount`** = 1,800 + 96 − 180 − 243 − 41.48 | **1,431.52** |

```
Dr 1250 Faire Clearing                          1,431.52
Dr 4900 Contra-Revenue : Promotions & Trade       180.00
Dr 6110 Processing Fees : Faire Commission        243.00
Dr 6100 Processing Fees                            41.48
    Cr 4100 Gross Sales – Faire Marketplace                 1,800.00
    Cr 4120 Gross Sales – Faire : Shipping                     96.00
                                    Dr 1,896.00 = Cr 1,896.00 ✓
```

*Order `H3PQ8L4T` — Marin Pantry Co, new Faire-sourced retailer, Insider free shipping, 2 units damaged.*

| Component | Amount |
|---|---|
| `Order Total` | 940.00 |
| `Promotions Applied` | 0.00 |
| `Shipping Costs Applied` (Insider — retailer paid nothing) | 0.00 |
| `Total Commission` = 15% × 940.00 | 141.00 |
| `New Customer Fee` | 10.00 |
| `Payment Processing Fees` = 2.4% × 940.00 + 0.30 = 22.56 + 0.30 | 22.86 |
| `Insider Fees Charged to Brand` = 13% × 940.00 = 122.20 (actual label 145.00) | 122.20 |
| `Insider Fees Charged to Faire` (Faire absorbs the excess — **do not post**) | 22.80 |
| damages: `Quantity Damaged or Missing` = 2 @ 16.00 wholesale, derived as residual | 32.00 |
| **`Payout Amount`** = 940 − 141 − 10 − 22.86 − 122.20 − 32.00 | **611.94** |

```
Dr 1250 Faire Clearing                            611.94
Dr 6110 Processing Fees : Faire Commission        151.00   (141.00 commission + 10.00 new customer fee)
Dr 6100 Processing Fees                            22.86
Dr 6200 Fulfillment Fees                          122.20
Dr 4920 Contra-Revenue : Returns & Allowances      32.00
    Cr 4100 Gross Sales – Faire Marketplace                   940.00
                                      Dr 940.00 = Cr 940.00 ✓
```

*Order `R9VX2C6B` — Heirloom Grocer via Faire Direct, 0% commission.*

| Component | Amount |
|---|---|
| `Order Total` | 2,400.00 |
| `Total Commission` (Faire Direct) | 0.00 |
| `Payment Processing Fees` = 2.4% × 2,400.00 + 0.30 = 57.60 + 0.30 | 57.90 |
| **`Payout Amount`** | **2,342.10** |

```
Dr 1250 Faire Clearing                          2,342.10
Dr 6100 Processing Fees                            57.90
    Cr 4110 Gross Sales – Faire Direct                      2,400.00
                                  Dr 2,400.00 = Cr 2,400.00 ✓
```

*COGS for the batch* (standard cost 38% of gross wholesale, from the Product info export):

```
Dr 5000 COGS                                    1,953.20
    Cr 1400 Inventory – Finished Goods                      1,953.20
```
(0.38 × (1,800.00 + 940.00 + 2,400.00) = 0.38 × 5,140.00 = 1,953.20)

*The deposit.* Batch total = 1,431.52 + 611.94 + 2,342.10 = **4,385.56**, landing in the bank
`2026-08-06` (payout date + 2 business days):

```
Dr 1010 Bank – Operating                        4,385.56
    Cr 1250 Faire Clearing                                  4,385.56
```

`Faire Clearing` nets to zero for this batch. ✓

### 7.B — Direct wholesale and foodservice

**7.B.1 — Invoice issued.** Terms are stated on the invoice: `Net 15`, `Net 30`, `Net 60`, or
`2/10 Net 30` (2% off if paid within 10 days, otherwise full at 30). Foodservice distributors commonly
demand `Net 45`/`Net 60`; restaurant groups are usually `Net 15`/`Net 30`.

```
Dr 1200 AR – Wholesale                          invoice_total
    Cr 4200 Gross Sales – Wholesale Direct                  taxable_and_exempt_goods
    Cr 2200 Sales Tax Payable                               tax   (usually 0 — sale for resale)
Dr 5000 COGS / Cr 1400 Inventory                at standard cost
```

Sales to distributors and restaurants are **sales for resale** and are exempt with a valid resale
certificate on file. If no certificate is on file, tax is charged and `2200` is credited. Flag any invoice
to a customer with an expired certificate.

**7.B.2 — Payment in full, no discount.**

```
Dr 1010 Bank                                    amount_paid
    Cr 1200 AR – Wholesale                                  amount_paid
```

**7.B.3 — Early payment discount taken (2/10 Net 30). The discount is CONTRA-REVENUE, not an expense.**
Under ASC 606 an early-payment discount is **variable consideration** that reduces the transaction price.
It is a price concession to the customer, so it reduces revenue; it is never "interest expense" and never
a marketing cost. (Consideration paid to a *customer* reduces the transaction price; consideration paid to
a *third party* is an expense — that is the dividing line.)

Invoice `SZ-10501` for 890.00, terms 2/10 Net 30, paid on day 8 for 872.20:

```
Dr 1010 Bank                                      872.20
Dr 4910 Contra-Revenue : Early Payment Discounts   17.80
    Cr 1200 AR – Wholesale                                    890.00
```

*Gross method* is used above (book AR at face, recognize the discount when taken). If materiality later
demands the *net method* (estimate the discount at invoice time and accrue it), the importer should not
change — the estimate is a period-end journal, not an import-time decision.

**7.B.4 — Short pays and deductions. Three-way classification, driven by `deduction_code`:**

| Class | When | Treatment |
|---|---|---|
| **Valid contracted trade** — promotional allowance, slotting, agreed MCB, agreed freight | code maps to a signed trade agreement or an accrued promo | `Dr 4900 Contra-Revenue : Promotions & Trade` — relieves the accrued trade liability if one exists |
| **Valid returns/allowance** — damage, shortage, spoilage where Sooz accepts fault | code maps to a documented incident | `Dr 4920 Contra-Revenue : Returns & Allowances` |
| **Disputed / undocumented** — everything else, plus unauthorized discounts | default when a code is unrecognized, over a threshold, or lacks backup | `Dr 1280 Deductions Receivable` and open a dispute case |

**Default when uncertain: `1280 Deductions Receivable`.** This keeps disputed money visible as an asset
under active collection instead of quietly eroding revenue. A configurable auto-write-off threshold (e.g.
deductions under $25) sends trivial amounts straight to `4920` to avoid a dispute queue full of noise.

Dispute resolution, later:

```
Deduction conceded:    Dr 4920 Contra-Revenue : Returns & Allowances / Cr 1280 Deductions Receivable
Deduction recovered:   Dr 1010 Bank                                  / Cr 1280 Deductions Receivable
Written off as bad:    Dr 6xxx Bad Debt Expense                      / Cr 1280 Deductions Receivable
```

**7.B.5 — Credit memo issued** (proactive, before the customer deducts):

```
Dr 4920 Contra-Revenue : Returns & Allowances   credit_amount
    Cr 1200 AR – Wholesale                                  credit_amount
```
The open credit then sits in AR as a negative balance and will be applied against a future remittance.
**A credit memo applied on a remittance is not a new expense** — it only moves AR; the P&L hit already
happened when the memo was issued. Double-hitting `4920` here is the most common error in this flow.

**7.B.6 — Partial payment (no deduction, customer simply paying in installments):**
`Dr Bank / Cr AR` for the partial amount, invoice stays open for the balance. Do **not** create a deduction
record — distinguishable because the customer did not send a `deduction_code` and the balance shows up on
the next remittance.

### 7.C — The reconciliation problem: one ACH deposit, 14 invoices, 3 short-paid

**The problem.** The bank feed shows a single credit: `2026-09-21  ACH CREDIT  GOLDEN GATE PROV PAYABLES
$19,451.25`. Sooz has 19 open invoices for that customer. The deposit does not equal any invoice, any
obvious run of invoices, or the sum of all of them (face total of the 14 actually paid is 19,812.15). Three
are short-paid and one took a terms discount.

**7.C.1 — Matching algorithm.** Run stages in order; stop at the first stage that produces a *unique*
result above its confidence bar. All arithmetic in **integer cents** — float subset-sum produces
irreproducible matches.

```
INPUT:  deposit D (cents), value date d, counterparty string s
OUTPUT: (allocation, confidence) or MANUAL

STAGE 0 — IDENTIFY CUSTOMER
  Resolve s against the customer alias table (ACH originator names are truncated and
  uppercased: "GOLDEN GATE PROV PAYABLES"). If ambiguous -> MANUAL.
  Candidate set C = open invoices for that customer with
      balance > 0  AND  invoice_date in [d - 180 days, d]
  Sort C oldest-first. If |C| > 60 -> require a remittance; otherwise -> MANUAL.
      (Subset-sum over 60+ items yields too many spurious exact hits to trust.)

STAGE 1 — REMITTANCE-DRIVEN (confidence: HIGH)
  If a remittance exists for this customer with |payment_total - D| <= $0.01,
  or with |sum(amount_paid) - D| <= $0.01:
      allocate exactly as the remittance states. DONE.
  If a remittance exists but sum(amount_paid) != D:
      allocate per the remittance lines; post the residual (D - sum(amount_paid))
      to a customer suspense account and flag. DONE-WITH-FLAG.
  This stage always wins. Everything below exists only because the remittance is missing.

STAGE 2 — EXACT SINGLE INVOICE (confidence: HIGH)
  If exactly one i in C has balance == D -> allocate. DONE.
  If several do -> prefer the oldest; flag as ambiguous-but-immaterial.

STAGE 3 — EXACT SUBSET-SUM, FACE VALUE (confidence: HIGH)
  Find all subsets S of C with sum(balance) == D.
  Implementation:
    |C| <= 28  -> meet-in-the-middle: split C in halves, hash all 2^14 partial sums
                  of one half, probe with D - (sums of the other half). O(2^(n/2)).
    |C| >  28  -> DP over a dict {reachable_sum -> list of subsets}, pruned to
                  sums <= D, capped at 200k distinct sums and at most 8 stored
                  witnesses per sum; abort to STAGE 5 if the cap is hit.
  If exactly one subset -> allocate. DONE.
  If several subsets -> tie-break, in order:
      (a) the subset that is a contiguous oldest-first run of C
      (b) the subset with the oldest maximum invoice_date (customers pay old first)
      (c) the subset with the fewest invoices
    If (a) is unique -> allocate with MEDIUM confidence.
    Otherwise -> MANUAL. Never coin-flip a cash application.

STAGE 4 — EXACT SUBSET-SUM, DISCOUNT-AWARE (confidence: MEDIUM-HIGH)
  Expand each i in C into up to two candidate values:
      v_face = balance
      v_disc = round(balance * (1 - terms.discount_pct))   -- only if
               d <= invoice_date + terms.discount_days + grace_days (grace default 3)
  Re-run STAGE 3 over the expanded set, constrained so at most one value per invoice
  is chosen. Discount-taken selections post to 4910 per 7.B.3.
  Unique solution -> allocate. Several -> prefer the solution with the fewest
  discounts taken, then STAGE 3's tie-breaks. Still ambiguous -> STAGE 5.

STAGE 5 — TOLERANCE SUBSET-SUM (confidence: LOW -> always queued for review)
  Now allow short pays. Per-invoice allowed shortfall:
      cap_i = max($25.00, 2% * balance_i)
  Total allowed shortfall across the deposit:
      CAP = min( max($250.00, 5% * D), $2,000.00 )
  Search for the subset S and per-invoice shortfalls f_i in [0, cap_i] with
      sum(balance_i) - sum(f_i) == D   and   sum(f_i) <= CAP
  Implementation: DP over cents on (subset sum) allowing a total-shortfall dimension
  discretized to whole cents is too wide -- instead:
      for each candidate subset S from STAGE 3's DP whose face sum lies in
      (D, D + CAP], compute shortfall = sum(S) - D and test whether shortfall can
      be distributed within the per-invoice caps (greedy largest-cap-first; feasible
      iff shortfall <= sum(cap_i for i in S)).
  SCORE each feasible S (lower is better):
      score = 100 * (number of invoices needing a nonzero shortfall)
            + (total shortfall in dollars)
            + 10 * (number of invoices in S)
  Accept the best S only if score(best) + 50 < score(runner_up); otherwise MANUAL.
  Even when accepted, the allocation is queued for human confirmation, because the
  per-invoice split of the shortfall is a guess without a remittance.

STAGE 6 — MANUAL
  Post the deposit as:
      Dr 1010 Bank  D  /  Cr 1290 Unapplied Customer Cash  D
  and open a cash-application task. NEVER leave a bank line unposted, and NEVER
  auto-apply oldest-first without a flag.
```

**Guard rails:**

- **Exact subset-sum over many small invoices is dangerous.** With 40 invoices averaging $1,000, thousands
  of subsets hit any given target. That is why `|C|` is capped at 60, why uniqueness is required, and why
  stage 3's tie-break (a) prefers a contiguous oldest-first run — customers pay their aging report top-down,
  not a random combination.
- **Cross-customer matching is forbidden.** A deposit only ever matches invoices for one identified
  customer. If the ACH memo is unresolvable, go to stage 6.
- **Never let stage 5 close an invoice as fully paid.** A short-paid invoice's residual becomes a deduction
  record (§7.B.4), which stays visible.

**7.C.2 — The journal entry when the deposit is short.** Deposit `$19,451.25` against 14 invoices with a
face total of `$19,812.15`. Difference `$360.90` = `$343.10` of deductions on three invoices + `$17.80` of
terms discount on one.

| Invoice | Face | Discount | Deduction | Code | Paid |
|---|---:|---:|---:|---|---:|
| SZ-10412 | 1,284.00 | — | — | | 1,284.00 |
| SZ-10428 | 2,150.00 | — | — | | 2,150.00 |
| SZ-10433 | 978.50 | — | — | | 978.50 |
| SZ-10440 | 1,640.00 | — | — | | 1,640.00 |
| **SZ-10447** | 3,200.00 | — | **184.00** | `DMG` | 3,016.00 |
| SZ-10455 | 742.25 | — | — | | 742.25 |
| SZ-10461 | 1,115.00 | — | — | | 1,115.00 |
| **SZ-10470** | 2,480.00 | — | **62.50** | `SHT` | 2,417.50 |
| SZ-10478 | 655.40 | — | — | | 655.40 |
| **SZ-10486** | 1,932.00 | — | **96.60** | `PROMO` | 1,835.40 |
| SZ-10490 | 410.00 | — | — | | 410.00 |
| SZ-10495 | 1,275.00 | — | — | | 1,275.00 |
| **SZ-10501** | 890.00 | **17.80** | — | 2/10 taken, day 8 | 872.20 |
| SZ-10509 | 1,060.00 | — | — | | 1,060.00 |
| **Total** | **19,812.15** | **17.80** | **343.10** | | **19,451.25** |

Classification per §7.B.4: `PROMO` on SZ-10486 matches a signed Q3 trade agreement → contra-revenue.
`DMG` and `SHT` have no backup attached → **disputed**, to Deductions Receivable.

```
Dr 1010 Bank – Operating                                19,451.25
Dr 4910 Contra-Revenue : Early Payment Discounts            17.80    (SZ-10501, terms taken in window)
Dr 4900 Contra-Revenue : Promotions & Trade                 96.60    (SZ-10486, contracted allowance)
Dr 1280 Deductions Receivable                              184.00    (SZ-10447, DMG — disputed)
Dr 1280 Deductions Receivable                               62.50    (SZ-10470, SHT — disputed)
    Cr 1200 AR – Wholesale : Golden Gate Provisions                 19,812.15

    Debits  19,451.25 + 17.80 + 96.60 + 184.00 + 62.50 = 19,812.15
    Credits                                               19,812.15   ✓
```

All 14 invoices close to zero AR balance. The $246.50 of disputed money is now an asset on the aging of
`1280`, not a silent revenue leak. If Sooz later concedes the damage claim:

```
Dr 4920 Contra-Revenue : Returns & Allowances              184.00
    Cr 1280 Deductions Receivable                                      184.00
```

If Golden Gate repays the shortage after research:

```
Dr 1010 Bank – Operating                                    62.50
    Cr 1280 Deductions Receivable                                       62.50
```

---

## 8. Realistic sample files

### 8.A — Faire Payout Summary CSV (SYNTHETIC — for parser fixtures only)

**This file is invented. No real Faire data.** Retailer names, order numbers and amounts are fabricated.
Generated under **candidate_1** of the §3.A.3 identity:

```
Payout Amount = Order Total + Shipping Costs Applied - Promotions Applied
              - Total Commission - New Customer Fee - Payment Processing Fees
              - Insider Fees Charged to Brand - (derived damages)
```

Brand is on the **30-day payout speed** (`2.4% + $0.30`), marketplace commission `15%`, Faire Direct `0%`.
Test assertions the fixture should support:

- Payout batch `2026-08-04` sums to **4,385.56** (3 rows)
- Payout batch `2026-08-11` sums to **8,796.58** (4 rows)
- Payout batch `2026-08-18` sums to **6,559.37** (7 rows, including one negative clawback)
- `FQ7K2M9X` appears **twice** (row 1 and the `2026-08-18` clawback) — dedup must not collapse them
- Rows with non-zero derived damages: row 2 → **32.00** (qty 2), row 9 → **18.00** (qty 1),
  row 13 → **86.40** (qty 3). Every other row's residual must be exactly **0.00**
- `Insider Fees Charged to Faire` is non-zero on 4 rows and must never appear in any journal entry
- The file has a **UTF-8 BOM** in production; `Café Lumière` and an embedded comma exercise the CSV reader

```csv
Payout Date,Payout Amount,Order Number,Retailer Shop Name,Order Date,Order Total,Currency,Quantity Damaged or Missing,Promotions Applied,Commission Rate,New Customer Fee,Total Commission,Taxes Charged,Shipping Costs Applied,Payment Processing Fees,Insider Free Shipping,Insider Fees Charged to Brand,Insider Fees Charged to Faire,Ship with Faire
2026-08-04,1431.52,FQ7K2M9X,Bodega Verde,2026-06-03,1800.00,USD,0,180.00,0.15,0.00,243.00,0.00,96.00,41.48,FALSE,0.00,0.00,TRUE
2026-08-04,611.94,H3PQ8L4T,Marin Pantry Co,2026-06-05,940.00,USD,2,0.00,0.15,10.00,141.00,0.00,0.00,22.86,TRUE,122.20,22.80,TRUE
2026-08-04,2342.10,R9VX2C6B,Heirloom Grocer,2026-06-06,2400.00,USD,0,0.00,0.00,0.00,0.00,0.00,0.00,57.90,FALSE,0.00,0.00,FALSE
2026-08-11,1088.57,K2WD7N5J,"The Larder SF, Hayes Valley",2026-06-11,1250.00,USD,0,0.00,0.15,10.00,187.50,0.00,68.00,31.93,FALSE,0.00,0.00,TRUE
2026-08-11,2254.74,M8TY4Q1Z,Golden Gate Provisions,2026-06-12,3600.00,USD,0,360.00,0.15,0.00,486.00,0.00,0.00,78.06,TRUE,421.20,38.00,TRUE
2026-08-11,427.17,P5LB9F3R,Cypress Corner Market,2026-06-14,480.00,USD,0,0.00,0.15,10.00,72.00,0.00,42.00,12.83,FALSE,0.00,0.00,FALSE
2026-08-11,5026.10,T6HN1K8W,Nob Hill Fine Foods,2026-06-15,5150.00,USD,0,0.00,0.00,0.00,0.00,0.00,0.00,123.90,FALSE,0.00,0.00,FALSE
2026-08-18,1283.82,C4JR6V2D,Presidio Provisions,2026-06-18,2050.00,USD,0,205.00,0.15,0.00,276.75,0.00,0.00,44.58,TRUE,239.85,15.40,TRUE
2026-08-18,663.14,W7ZG3S9Y,Ferry Plaza Pantry,2026-06-19,760.00,USD,1,0.00,0.15,0.00,114.00,0.00,55.00,19.86,FALSE,0.00,0.00,TRUE
2026-08-18,922.34,D2QF5X7M,Oakland Co-op Grocery,2026-06-20,1340.00,USD,0,0.00,0.15,10.00,201.00,0.00,0.00,32.46,TRUE,174.20,9.10,TRUE
2026-08-18,3196.10,B8KV4T6P,Bernal Bodega,2026-06-22,3275.00,USD,0,0.00,0.00,0.00,0.00,0.00,0.00,78.90,FALSE,0.00,0.00,FALSE
2026-08-18,493.97,N1RM9H5C,Café Lumière,2026-06-23,615.00,USD,0,61.50,0.15,0.00,83.03,0.00,38.00,14.50,FALSE,0.00,0.00,TRUE
2026-08-18,-86.40,FQ7K2M9X,Bodega Verde,2026-06-03,0.00,USD,3,0.00,0.15,0.00,0.00,0.00,0.00,0.00,FALSE,0.00,0.00,FALSE
2026-08-18,86.40,Y3DC8B1N,Bodega Verde,2026-07-02,86.40,USD,0,0.00,0.00,0.00,0.00,0.00,0.00,0.00,FALSE,0.00,0.00,TRUE
```

Row-by-row notes for the test suite:

- **Row 1** — plain marketplace reorder with a brand-funded promo. Fully worked in §7.A.6.
- **Row 2** — new Faire-sourced customer ($10 fee), Insider free shipping (brand pays 13% cap = 122.20,
  Faire absorbs 22.80), 2 units damaged worth 32.00 recovered as the identity residual.
- **Row 3, 7, 11** — Faire Direct: `Commission Rate = 0.00`, `Total Commission = 0.00`, processing only.
- **Row 4** — retailer shop name contains a comma inside quotes.
- **Row 5** — large order, 10% promo, Insider shipping at the 13% cap on the post-promo base
  (13% × 3,240.00 = 421.20).
- **Row 12** — non-ASCII shop name; commission 83.03 is `553.50 × 0.15 = 83.025` rounded half-up.
- **Row 13** — negative clawback on an already-paid order. `Order Total = 0.00`, damages residual 86.40
  (3 units @ 28.80). Same `Order Number` as row 1 — this is the duplicate-order-number case.
- **Row 14** — the replacement shipment for row 13: zero commission, zero processing, full payout.

### 8.B — Canonical remittance advice CSV (SYNTHETIC — for parser fixtures only)

**This file is invented. No real customer data.** This is the §7.C worked example: Golden Gate Provisions
paying 14 invoices with one ACH credit of $19,451.25, three short-paid and one taking terms.

Test assertions:

- `sum(amount_paid)` = **19,451.25** and equals `payment_total`
- `sum(invoice_amount)` = **19,812.15**
- Every row satisfies `amount_paid == invoice_amount - discount_taken - deduction_amount`
- Exactly 3 rows carry a `deduction_code`; exactly 1 carries a `discount_taken`
- `SZ-10501` discount is authorized: `payment_date 2026-09-21` ≤ `invoice_date 2026-09-14` + 10 days
- `SZ-10447` has a multi-line `deduction_description` (embedded newline inside quotes)

```csv
payer_name,payer_id,payment_reference,payment_date,payment_method,payment_total,invoice_number,invoice_date,invoice_amount,discount_taken,deduction_amount,deduction_code,deduction_description,amount_paid,currency
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10412,2026-07-29,1284.00,0.00,0.00,,,1284.00,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10428,2026-08-03,2150.00,0.00,0.00,,,2150.00,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10433,2026-08-06,978.50,0.00,0.00,,,978.50,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10440,2026-08-11,1640.00,0.00,0.00,,,1640.00,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10447,2026-08-14,3200.00,0.00,184.00,DMG,"2 cs Cherry Almond crushed in transit
PRO 884310221 / claim filed 08/22",3016.00,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10455,2026-08-18,742.25,0.00,0.00,,,742.25,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10461,2026-08-20,1115.00,0.00,0.00,,,1115.00,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10470,2026-08-25,2480.00,0.00,62.50,SHT,"Short 5 units SOOZ-GRN-MP-12 vs BOL",2417.50,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10478,2026-08-28,655.40,0.00,0.00,,,655.40,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10486,2026-09-02,1932.00,0.00,96.60,PROMO,"Q3 off-shelf feature allowance 5% per signed MCB",1835.40,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10490,2026-09-04,410.00,0.00,0.00,,,410.00,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10495,2026-09-09,1275.00,0.00,0.00,,,1275.00,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10501,2026-09-14,890.00,17.80,0.00,,"2/10 net 30 discount taken",872.20,USD
Golden Gate Provisions,GGP-0142,ACH-20260921-77431,2026-09-21,ACH,19451.25,SZ-10509,2026-09-17,1060.00,0.00,0.00,,,1060.00,USD
```

**Second fixture — the hard case (SYNTHETIC).** Same deposit, **no remittance received**. The importer sees
only this bank row and must run §7.C.1 stages 2→5 against the open invoice list:

```csv
date,description,amount,currency,balance
2026-09-22,"ACH CREDIT  GOLDEN GATE PROV PAYABLES  CCD 0921  TRN*1*0779431",19451.25,USD,84210.66
```

Expected behavior: stages 2–4 all fail (no exact face-value subset sums to 19,451.25). Stage 5 finds the
14-invoice subset with a face total of 19,812.15, a shortfall of 360.90 (within `CAP = max($250, 5% × D) =
$972.56`), distributable within per-invoice caps. It should be **accepted with LOW confidence and queued
for human confirmation**, and its guessed shortfall split will likely differ from the true 184.00 / 62.50 /
96.60 / 17.80 split — which is exactly why stage 5 never auto-posts without review.

---

## Sources

- [Can I export order data? — Faire Help Center](https://www.faire.com/support/articles/36132089162267)
- [Where can I access payout information as a North American brand? — Faire Help Center](https://www.faire.com/support/articles/360022169831)
- [Where can I access payout information as a brand outside of North America? — Faire Help Center](https://www.faire.com/support/articles/16888380282651)
- [How do I export product information from my Faire orders? — Faire Help Center](https://www.faire.com/support/articles/48223799465883)
- [How much does it cost to sell on Faire if I'm based in North America? — Faire Help Center](https://www.faire.com/support/articles/360015893392)
- [How much does it cost to sell on Faire if I'm based outside of North America? — Faire Help Center](https://www.faire.com/support/articles/360040446591)
- [North America pricing update — Faire blog](https://www.faire.com/blog/for-brands/north-america-pricing-update)
- [Faire Direct commission policy — Faire Help Center](https://www.faire.com/support/articles/360031800672)
- [What if a retailer reports my products missing or damaged? — Faire Help Center](https://www.faire.com/support/articles/360033568051)
- [Faire Insider Partnership Program Terms & Conditions — Faire Help Center](https://www.faire.com/support/articles/25343614989851)
- [How do 60-day payment terms work? — Faire Help Center](https://www.faire.com/support/articles/360016658851)
- [Faire for Developers (External API v2)](https://developers.faire.com/docs)
- [Faire Fee Calculator — Stocksmith](https://stocksmith.io/faire-fee-calculator)
- [Faire Payment Terms Explained — Multisellr](https://multisellr.com/blog/faire-payment-terms-explained)
- [How to Reconcile Faire Payouts in QuickBooks Online — MSM Taxes](https://www.msmtaxes.com/how-to-reconcile-faire-payouts-in-quickbooks-online)
- [EDI 820 Payment Order/Remittance Advice — SPS Commerce](https://www.spscommerce.com/edi-document/edi-820-payment-remittance-advice/)
- [EDI 820 Specifications — 1 EDI Source](https://www.1edisource.com/resources/edi-transactions-sets/edi-820/)
- [Changes to revenue recognition in the consumer products industry — RSM](https://rsmus.com/content/dam/rsm/insights/financial-reporting/1pdf/Changes-to-revenue-recognition-in-the-consumer-products-industry-202309.pdf)
- [4.3 Variable consideration — PwC Viewpoint](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/revenue_from_contrac/revenue_from_contrac_US/chapter_4_determinin_US/43variable_considera_US.html)
- [Accounting for Trade Discounts, Volume Rebates, and Early Payment Incentives — Data Studios](https://www.datastudios.org/post/accounting-for-trade-discounts-volume-rebates-and-early-payment-incentives)

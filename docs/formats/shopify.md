# Shopify — Financial Export Formats (Sooz Books)

**Scope:** Shopify online store + Shop channel, DTC, US merchant, Shopify Payments as the primary
gateway, USD payout currency, some CAD/international presentment currencies.

**Three files matter, and they are not interchangeable:**

| File | What it is | What it is good for | What it is *not* good for |
|---|---|---|---|
| **Balance transactions export** (`Finance > Payouts > … > Export > Balance transactions`) | Every money movement in the Shopify Payments balance: charges, refunds, disputes, fees, adjustments, the payout itself | Proving the payout deposit; the fee side; the dispute side | Revenue detail — a `charge` row is one gross number that mixes product, shipping, tax and tip |
| **Payouts list export** (same dialog, `Payouts`) | One row per payout, with its total | Matching bank deposits; an index of payout IDs | Anything else |
| **Orders export** (`Orders > Export`) | One row per **line item** | Decomposing gross sales, discounts, shipping charged, tax collected | Cash. It says nothing about fees, payouts, or when money arrived |

The system must import **both** the balance transactions export and the orders export and join them on the
order name. Neither alone can produce a correct journal entry.

> ⚠️ **Non-negotiable rule for this integration:** revenue is never booked net. A Shopify payout that
> lands in the bank as one number (e.g. `$560.28`) is decomposed into gross sales, discounts, refunds,
> shipping income, tips, tax collected and fees, routed through a **Channel Clearing – Shopify Payments**
> account, which the bank deposit then clears to exactly zero. See §7.

---

## 1. How you get the file

### 1a. Balance transactions export (the primary file)

Shopify has moved this page twice; both paths exist in the wild depending on admin version, so document
both for whoever operates the import:

- **Current (2025+ admin):** Shopify admin → **Finance** → **Payouts** section → **View payouts** →
  open a payout (or stay on the list) → **Export** → choose **Balance transactions** → pick the range →
  **Export balance transactions**.
- **Legacy path (still linked from older help articles):** **Settings** → **Payments** →
  Shopify Payments → **View payouts** → **View transactions** → **Export**.

Options that matter:

| Option | Choose | Why |
|---|---|---|
| Range | **A specific payout**, or a custom date range | Importing one payout at a time makes the tie-out check trivial (§5). A date range is fine but you must then group by `Payout Date` yourself. |
| CSV type | **Plain CSV** | The "CSV for Excel" variant is written for Excel's importer: it carries a UTF-8 **BOM** and may localize separators/decimals. Plain CSV is what the parser should expect. Accept the BOM anyway (§6). |
| Delivery | ≤ 50 rows downloads in-browser; larger exports are **emailed** to the store owner as a download link | The emailed link expires and can return an HTML error page (§6). |

### 1b. Payouts list export

Same **Export** dialog, radio option **Payouts** instead of **Balance transactions**. One row per payout.

### 1c. Orders export

Shopify admin → **Orders** → (apply a date filter; Shopify filters on `Created at` in **store timezone**)
→ **Export** → scope **Current page** / **All orders matching your search** / **Selected orders**, plus
"Orders by date" → format **Plain CSV file**. ≤ 50 orders downloads directly; more is emailed.

There is a separate radio option **Orders transactions** ("transaction histories only") — it is a
different, smaller file (order id, kind, gateway, amount). Sooz Books does not need it; the balance
transactions export supersedes it.

### 1d. Supporting documents (not parsed, but needed for review)

- **Shopify Payments activity report** — `Finance > Documents > Shopify Payments activity report`.
  PDF only. Gives starting balance → gross activity → fees → payouts → ending balance for a range.
  Ranges: Last month / 3 / 6 / 12 months / Custom (custom only back to **2025-01-01**). **3-day data
  delay.** Use it as the month-end control total.
  Its own activity categories are a useful sanity list of what can appear in the balance:
  *Charges and Refunds, Disputes, Managed Markets, Adjustments, Shopify Capital, Duties & Taxes,
  Installments Recovery, Internal Transfers, Fees, Promotions & Credits, Reserves & Holds, Shipping,
  Shop Cash, Shopify Collective, Payouts, Other.*
- **Shopify bills export** — `Finance > Bills > Export`. Needed to explain any `billing_debit` row (§4d).

---

## 2. Columns

### 2a. Balance transactions export — 16 columns

Header row is row 1. Order below is the observed native order; **the parser must select by header name,
case-insensitively, not by position**, because Shopify's own help article documents only 11 of these and
merchants report both shapes.

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Transaction Date` | timestamp w/ offset | `2026-09-11 13:47:03 -0400` | When the balance event occurred, in **store timezone** | Yes |
| `Type` | enum (lowercase, `snake_case`) | `charge`, `refund`, `dispute`, `chargeback_fee`, `dispute_reversal`, `adjustment`, `billing_debit`, `shipping_label`, `payout` | Taxonomy — see §2b | Yes |
| `Order` | string | `#1005` | Order **name** (not id), with the store's order prefix. Blank for `payout`, `billing_debit`, most `shipping_label`, and some `adjustment` rows | No |
| `Card Brand` | string | `visa`, `mastercard`, `amex`, `discover` | Blank on non-card rows | No |
| `Card Source` | string | `online`, `pos` | Blank on non-card rows | No |
| `Payout Status` | enum | `paid`, `in_transit`, `scheduled`, `pending`, `failed`, `canceled` | `pending` = captured but not yet assigned to a payout | Yes |
| `Payout Date` | date | `2026-09-14` | Payout this row belongs to. **Blank when `Payout Status` = `pending`** | No |
| `Available On` | date (sometimes timestamp) | `2026-09-14` | Date the funds become payable. For `pending` rows this is an *estimate* and can move | No |
| `Checkout` | string/int | `c_884411021` or `26618049921` | Checkout id. Stable per checkout; repeats across the charge and its refunds | No |
| `Payment Method Name` | string | `shopify_payments`, `shop_pay`, `shop_pay_installments`, `shop_app`, `apple_pay`, `google_pay` | How the buyer paid, within Shopify Payments | No |
| `Presentment Amount` | decimal | `412.80` | Amount in the **buyer's** currency | No |
| `Presentment Currency` | ISO-4217 | `CAD` | Buyer's currency | No |
| `Amount` | decimal | `305.12` | Gross amount in **payout currency**. The number that moves the balance before the fee | Yes |
| `Fee` | decimal | `13.43` | Shopify Payments fee on this row, **as a positive number** (§3) | Yes |
| `Net` | decimal | `291.69` | `Amount − Fee` | Yes |
| `Currency` | ISO-4217 | `USD` | Payout currency | Yes |

**Header variation to tolerate:** Shopify's help article lists only
`Transaction Date, Type, Order, Card Brand, Card Source, Payout Status, Payout Date, Available On,
Amount, Fee, Net`. Third-party reconciliation guides consistently report 16 columns including
`Checkout, Payment Method Name, Presentment Amount, Presentment Currency, Currency`.
**Both are real** — older exports and non-multi-currency stores can be missing the presentment columns.
Treat the 5 extra columns as optional; hard-fail only if `Transaction Date`, `Type`, `Amount`, `Fee`,
`Net` are absent.

### 2b. `Type` — the full taxonomy

The CSV emits lowercase snake_case versions of the API enum `ShopifyPaymentsTransactionType`. The full
enum is very large (100+ values, mostly for Shopify Capital, Shop Cash, Collective, Markets Pro, lending).
A US DTC brand will realistically see the following. **The parser must have an explicit allow-list and
must hard-fail on an unknown type rather than silently dropping the row** — a dropped row breaks the
payout tie-out, which is the whole point of the control.

| `Type` value | Sign of `Amount` | What it means financially | Treatment (§7) |
|---|---|---|---|
| `charge` | **+** | A customer's card was captured for the full order total: product − discounts + shipping + tax + tip. Gross, not revenue | Decompose against the orders export |
| `charge_adjustment` | ± | Correction to a prior charge (rare) | Same as `charge`, on the delta |
| `refund` | **−** | Money returned to the customer. `Fee` is `0.00` — **Shopify does not return the processing fee on a refund** | Contra-Revenue, tax reversal, shipping reversal |
| `refund_failure` | **+** | A refund could not be delivered; money comes back | Reverse the refund entry |
| `refund_adjustment` | ± | Correction to a prior refund | Delta on the refund entry |
| `dispute` | **−** | A chargeback was filed; Shopify debits the full disputed amount immediately, before the outcome | Contra-Revenue – Chargebacks (or Deductions Receivable if contesting — see §7c) |
| `chargeback_fee` | **−** | Card-network dispute fee, typically `$15.00` US. **Charged whether you win or lose** | Processing Fees |
| `chargeback_fee_refund` | **+** | Dispute fee returned (some networks return it on a win) | Credit Processing Fees |
| `dispute_reversal` | **+** | **Chargeback won.** The disputed amount is returned | Reverse the `dispute` entry line for line |
| `dispute_withdrawal` | **+** | Buyer withdrew the dispute | Same as `dispute_reversal` |
| `chargeback_hold` / `chargeback_hold_release` | −/+ | Funds held pending a dispute, then released | Deductions Receivable ⇄ Clearing; no P&L |
| `chargeback_protection_credit` / `_debit` | +/− | Shopify Protect reimbursed (or clawed back) a fraudulent-chargeback loss | Credit/debit Contra-Revenue – Chargebacks |
| `adjustment` | ± | Catch-all. **The single most dangerous value** — it carries marketplace sales tax withholding, goodwill credits, tax adjustments, anomaly corrections. Must be sub-classified by the payout detail screen or the activity report, never auto-posted | Route to a review queue with a default of Suspense |
| `reserved_funds` / `reserved_funds_reversal` / `reserved_funds_withdrawal` | −/+ | Shopify is holding a rolling reserve | Clearing ⇄ **Reserve Receivable**; never P&L |
| `payout` | **−** | The money leaving the Shopify balance for the bank. Not revenue, not an expense | Nets the clearing account to the deposit amount |
| `payout_failure` / `payout_cancellation` | **+** | A payout bounced and came back into the balance | Reverse the payout row; the bank deposit will not appear |
| `billing_debit` | **−** | **Shopify's own invoice** (plan, apps, Shopify Tax fees, Shopify ads) deducted from the balance. **This is not a processing fee** (§4d) | Operating expense, split per the Shopify bill |
| `billing_debit_reversal` | **+** | Refund of the above | Reverse |
| `shipping_label` | **−** | Shopify Shipping label purchase | Fulfillment Fees |
| `shipping_label_adjustment`, `_base`, `_surcharge`, `shipping_return_to_origin_adjustment` | ± | Carrier reweigh/redimension corrections, arriving weeks later | Fulfillment Fees |
| `customs_duty`, `import_tax`, `import_tax_refund`, `_adjustment` | ± | International duties/import tax collected or remitted (Markets / Managed Markets) | Duties Payable, not revenue |
| `tax_adjustment_credit` / `_debit` | +/− | Correction to tax previously collected | Sales Tax Payable |
| `transfer`, `balance_transfer_inbound`/`_outbound` | ± | Movement between Shopify Balance and the Payments balance | Bank ⇄ Clearing; no P&L |
| `shop_cash_credit`, `shop_cash_billing_debit`, `shop_cash_campaign_billing_debit` | ± | Shop Cash promotion funding/reimbursement | Advertising Expense / Contra-Revenue, per campaign terms |
| `advance`, `advance_funding`, `lending_*` | ± | Shopify Capital draw and remittance | Loan Payable / Interest — **out of scope, must route to review** |
| `marketplace_fee_credit`, `channel_*`, `markets_pro_credit`, `shopify_collective_*` | ± | Multi-channel and Collective settlement | Out of scope for Sooz today; route to review |

**Things people call transaction types that are not `Type` values:**

- **"Shop Pay Installments"** is not a `Type`. It is a `Payment Method Name` (`shop_pay_installments`)
  on an ordinary `charge`. Affirm underwrites; Shopify/Affirm pays the **full order amount up front**
  (1–3 business days, same as any card) and withholds the Installments fee, which appears in the ordinary
  `Fee` column of that charge — **not** as a separate line. There is no receivable to track; the customer's
  instalment schedule is invisible to Sooz. Note: **on a refund, the Installments fee is not returned.**
  (A `payout` for Installments may land in the bank as its own deposit on some stores — match on amount.)
- **"Gift card"** is not a `Type` either, and this is a real revenue trap. Selling a gift card produces a
  normal `charge` (a liability, not revenue). **Redeeming** a gift card produces *no* Shopify Payments
  charge at all — the order total is partly or wholly settled off-gateway. So the payout is smaller than
  the order total, and any revenue figure derived only from the payout **understates sales**. This is the
  single strongest argument for joining to the orders export. See §6.
- **"Tip"** is not a `Type`. A tip is included in the `charge` `Amount` and must be split out from the
  orders export (§4a), where it is only recoverable as a residual.

### 2c. Payouts list export

| Header | Type | Example | Meaning | Required? |
|---|---|---|---|---|
| `Payout Date` (some exports: `Date`) | date | `2026-09-14` | Date Shopify initiated the transfer | Yes |
| `Status` | enum | `paid` | `scheduled`, `in_transit`, `paid`, `failed`, `canceled` | Yes |
| `Charges` | decimal | `993.62` | Sum of `charge` `Amount` | Yes |
| `Refunds` | decimal | `-118.50` | Sum of `refund` `Amount` | Yes |
| `Adjustments` | decimal | `-193.52` | Everything that is not a charge, refund, or fee | Yes |
| `Reserved Funds` | decimal | `0.00` | Held back this cycle | No |
| `Fees` | decimal | `-50.18` | Processing + dispute fees | Yes |
| `Total` | decimal | `560.28` | The bank deposit amount | Yes |
| `Currency` | ISO-4217 | `USD` | Payout currency | Yes |

The payout **id** is not in this CSV; it is visible in the admin URL and in the API
(`ShopifyPaymentsPayout.id`) as e.g. `gid://shopify/ShopifyPaymentsPayout/31245678901`.
`ShopifyPaymentsPayoutTransactionType` has exactly two values — `DEPOSIT` and `WITHDRAWAL` — so a negative
`Total` means Shopify is pulling money *from* the bank (a withdrawal), which happens after a month of
heavy refunds. Handle the negative case.

### 2d. Orders export — native column list

Native header, in order (Shopify help centre wording, verbatim):

```
Name, Phone, Email, Financial Status, Paid at, Fulfillment Status, Fulfilled at, Accepts Marketing,
Currency, Subtotal, Shipping, Taxes, Total, Discount Code, Discount Amount, Shipping Method, Created at,
Lineitem quantity, Lineitem name, Lineitem price, Lineitem compare-at price, Lineitem SKU,
Lineitem requires shipping, Lineitem taxable, Lineitem fulfillment status, Billing Name, Billing Street,
Billing Address1, Billing Address2, Billing Company, Billing City, Billing Zip, Billing Province,
Billing Province Name, Billing Country, Billing Phone, Shipping Name, Shipping Street, Shipping Address1,
Shipping Address2, Shipping Company, Shipping City, Shipping Zip, Shipping Province,
Shipping Province Name, Shipping Country, Shipping Phone, Notes, Note Attributes, Canceled at,
Payment Method, Payment Reference, Payment References, Refunded Amount, Vendor, Outstanding Balance,
Employee, Location, Device ID, Id, Tags, Risk Level, Source, Lineitem discount, Tax 1 Name, Tax 1 Value,
Payment ID, Payment terms, Next payment due at
```

**Casing conflict — sources disagree.** Shopify's help centre prints `Lineitem SKU`; real downloaded files
are widely reported as `Lineitem sku`. Likewise `Tax 1 Name` / `Tax 1 Value` are documented generically as
`Tax # Name` / `Tax # Value`. **Match all headers case-insensitively and by regex for the tax pair.**

The columns Sooz Books actually needs:

| Exact header text | Type | Example | Meaning | Required? |
|---|---|---|---|---|
| `Name` | string | `#1003` | Order name. **The grouping key.** Present on every line-item row | Yes |
| `Id` | int | `6118240321793` | Numeric order id — globally unique, immutable. **The dedup key.** Order-level (first row only) | Yes |
| `Email` | string | `jo@example.com` | Customer | No |
| `Financial Status` | enum | `paid`, `pending`, `authorized`, `partially_refunded`, `refunded`, `voided` | Order-level | Yes |
| `Paid at` | timestamp w/ offset | `2026-09-10 16:38:11 -0400` | When payment was captured. **Use this, not `Created at`, for period assignment** | Yes |
| `Created at` | timestamp w/ offset | `2026-09-10 16:38:10 -0400` | Order placed | Yes |
| `Fulfillment Status` | enum | `fulfilled`, `unfulfilled`, `partial`, `restocked` | Drives the COGS entry timing | Yes |
| `Currency` | ISO-4217 | `USD` / `CAD` | **Presentment currency** of the order, not necessarily the payout currency | Yes |
| `Subtotal` | decimal | `193.50` | Line items **after** discounts, **before** shipping and tax. Order-level | Yes |
| `Shipping` | decimal | `4.95` | Shipping **charged to the customer** (income). Not the label cost | Yes |
| `Taxes` | decimal | `19.40` | Total tax collected on the order | Yes |
| `Total` | decimal | `212.90` | What the customer paid | Yes |
| `Discount Code` | string | `FALL10` | Blank when the discount was automatic | No |
| `Discount Amount` | decimal | `21.50` | Order-level total discount | Yes |
| `Lineitem quantity` | int | `5` | Per row | Yes |
| `Lineitem name` | string | `Sooz Chili Crisp — 7 oz` | Per row; may contain commas | Yes |
| `Lineitem price` | decimal | `29.00` | **Unit price before discount** | Yes |
| `Lineitem sku` | string | `SOOZ-CC-7OZ` | Per row. Join key to Inventory/COGS | Yes |
| `Lineitem discount` | decimal | `14.50` | Discount allocated to this line, **total for the line, not per unit** | Yes |
| `Refunded Amount` | decimal | `64.20` | Total refunded on the order **as of export time**. Mutable — see §6 | Yes |
| `Outstanding Balance` | decimal | `0.00` | Unpaid remainder (wholesale/Net terms) | No |
| `Tax 1 Name` … `Tax 5 Name` | string | `NY State Tax` | Jurisdiction. Column count varies per export | No |
| `Tax 1 Value` … `Tax 5 Value` | decimal | `9.45` | Tax amount for that jurisdiction | No |
| `Payment Method` | string | `Shopify Payments`, `shop_pay_installments`, `gift_card, Shopify Payments` | **Comma-separated when split-tendered** — must be parsed, not compared | Yes |
| `Payment Reference` / `Payment References` | string | `c_884411009` | Ties to the balance transactions `Checkout` column | No |
| `Source` | string | `web`, `shop_app`, `pos`, `android` | **Decides marketplace-facilitator treatment** (§4e) | Yes |
| `Vendor` | string | `Sooz` | Per line | No |
| `Location` | string | `ShipBob — Cicero IL` | Fulfillment location | No |

**There is no `Tip` column and no `Duties` column in the native orders export.** See §6 for the residual
method and its limits.

---

## 3. Sign and amount conventions

**Balance transactions export**

- **There is no separate debit/credit column.** There is one signed `Amount` column plus a `Fee` column.
- `Amount` is signed from the perspective of *the Shopify Payments balance*: money in is positive, money
  out is negative. `charge` → `+`; `refund`, `dispute`, `chargeback_fee`, `billing_debit`, `shipping_label`,
  `payout` → `−`.
- **`Fee` is always a positive number, even though it is a deduction.** This is the opposite of what
  people expect and the most common parser bug. `Net = Amount − Fee`, *not* `Amount + Fee`.
  - Charge: `Amount 118.45`, `Fee 3.73`, `Net 114.72`.
  - Refund: `Amount −54.30`, `Fee 0.00`, `Net −54.30`. Refunds carry **no** fee — the original processing
    fee is not returned. A refund row with a non-zero `Fee` is an anomaly worth flagging.
  - **Never take `abs(Fee)` and never negate it conditionally.** Assert `Net == Amount − Fee` on every row
    and hard-fail the import on a mismatch; that single assertion catches a locale/decimal misparse.
- **`Fee` on a `charge` is a blend.** For a domestic USD card it is pure processing. For a foreign-currency
  order it is processing **plus** the currency conversion fee, summed into one number. The components are
  not separable from the CSV — see §4c for the split method.
- **Currency symbols:** none. Values are bare decimals: `118.45`, `-54.30`, `0.00`.
- **Thousands separators:** none in Plain CSV. The "CSV for Excel" variant may localize
  (`1.234,56` in DE locales). Reject any amount field that does not match
  `^-?\d+(\.\d{1,2})?$` after trimming, rather than coercing.
- **Parentheses:** never used for negatives. A `(54.30)` in the data means the file was round-tripped
  through Excel and is not trustworthy.
- **Zero is written `0.00`, not blank.** A genuinely blank amount means a malformed row.
- **Two decimal places always**, for USD/CAD/EUR/GBP. Do not assume 2 for JPY-denominated presentment.

**Orders export**

- All money columns are **positive magnitudes**, including `Discount Amount` and `Refunded Amount`.
  A `$21.50` discount is written `21.50`, not `-21.50`. Your contra-revenue debit must supply the sign.
- `Total = Subtotal + Shipping + Taxes + tips + duties`. Since `Subtotal` is already net of discounts,
  `Discount Amount` is *not* subtracted again — double-subtracting it is the second most common bug.
- `Lineitem price` × `Lineitem quantity` sums to gross-before-discount;
  `Σ(Lineitem price × Lineitem quantity) − Σ(Lineitem discount) == Subtotal` should hold and is worth
  asserting per order. **Never sum `Lineitem discount` and `Discount Amount` together** — they are the
  line-level and order-level views of the same reduction.
- `Refunded Amount` is positive and is a *cumulative* figure, not this-period.

---

## 4. Date formats and timezone

| Field | Format | Example |
|---|---|---|
| `Transaction Date` (balance txns) | `YYYY-MM-DD HH:MM:SS ±HHMM` | `2026-09-11 13:47:03 -0400` |
| `Payout Date`, `Available On` | `YYYY-MM-DD` (occasionally the full timestamp form) | `2026-09-14` |
| `Created at`, `Paid at`, `Fulfilled at`, `Canceled at` (orders) | `YYYY-MM-DD HH:MM:SS ±HHMM` | `2026-09-10 16:38:10 -0400` |

**Timezone caveats — all three are real and all three bite:**

1. **Everything is in the store's timezone** (`Settings > General > Store defaults > Timezone`), **not UTC**,
   and **not the user's browser timezone**. The offset is printed on the row, so parse it; do not assume
   `-05:00`.
2. **The offset shifts with DST.** A September export shows `-0400`; a December export of the same store
   shows `-0500`. Any parser that strips the offset and assumes a fixed one will mis-bucket the first and
   last day of a month around DST changes. Store the parsed instant *and* the store-local date; use the
   **store-local date** for period assignment, because that is what Shopify's own Finance reports use and
   what the auditor will compare against.
3. **`Payout Date` is a banking date in the payout currency's region, not a store-local timestamp.** The
   payout dated `2026-09-14` typically arrives in the bank 1–2 business days later. The clearing account
   is what absorbs this lag (§7).

The **Shopify Payments activity report has a 3-day data delay**; do not generate a month-end control total
before the 4th of the following month.

---

## 5. Identity and deduplication

### 5a. Balance transactions: there is no id column

This is the hard part. The API object `ShopifyPaymentsBalanceTransaction` has an `id`, and the
Matrixify-style export exposes `Transaction: ID` — **but the native CSV does not include it.** So:

**Primary idempotency key — the payout, not the row.**

```
payout_key = (source='shopify_payments', currency, payout_date, payout_total)
```

Import at payout granularity. A payout with `Payout Status = paid` is **immutable** once issued: its set of
rows never changes. On re-import of an overlapping date range, if `payout_key` already exists, skip the
whole payout. If `payout_date` matches but `payout_total` differs, that is a genuine error (an
`in_transit` payout that later changed) — quarantine, do not merge.

**Secondary row key — for the rows inside a payout, and for `pending` rows.**

```
row_key = sha256(payout_date | transaction_date_utc | type | order | amount | fee | checkout | ordinal)
```

`ordinal` is the 0-based index of this row among rows in the same file that are otherwise identical. It is
required: a store can legitimately issue two identical `$29.00` charges to the same order name in the same
second (two partial captures), and without an ordinal the second one is silently dropped.

`Checkout` is the strongest natural identifier available and should be used when present: it is stable and
links a charge to its later refunds and disputes.

**`pending` rows are inherently unstable** — their `Available On` moves and they later reappear inside a
payout. Store them in a separate staging table keyed by `row_key`, mark them provisional, and **delete and
replace the whole provisional set on each import**. Never let a `pending` row and its later `paid` twin
both post.

### 5b. Orders: `Id` is a real key

`Id` is Shopify's numeric order id — unique, immutable, never reused. Line rows are identified by
`(Id, line_ordinal)` where `line_ordinal` is the row's position within the order's block, because
`Lineitem sku` can legitimately repeat within an order (same SKU at two different prices/discounts).

**But `Id` is only populated on the first row of a multi-row order.** Forward-fill it down the block
(§6), and forward-fill within a `Name` group — never across the file blindly.

**Mutable columns defeat naive dedup.** `Refunded Amount`, `Financial Status`, `Fulfillment Status` and
`Outstanding Balance` change *after* the export. Re-exporting August in October yields different values
for the same `Id`. Therefore:

- Persist orders with a `snapshot_exported_at` and treat a later snapshot as an **update**, not a duplicate.
- **Never derive refunds from the orders export.** Refunds come from the balance transactions export,
  where they are point-in-time and immutable. `Refunded Amount` is for review/variance only.

---

## 6. Gotchas

**File mechanics**

1. **No preamble rows, no footer totals, no merged cells** — Shopify CSVs are clean. Treat any file with a
   title row or a "Total" row as not-a-Shopify-export and reject it.
2. **BOM.** The "CSV for Excel" variant starts with `EF BB BF`. Strip it before reading the header, or
   your first column becomes `﻿Transaction Date` and never matches.
3. **Encoding is UTF-8.** Product names and customer names carry accents and emoji. Do not fall back to
   latin-1 — decode strictly and fail loudly.
4. **Large exports arrive as a ZIP containing several CSVs, each with its own header row.** Concatenating
   them naively injects header rows into the data. Read each member separately.
5. **The emailed download link expires and then serves an HTML page.** Before parsing, check the first
   non-whitespace byte: if it is `<`, this is HTML, not CSV — fail with "download link expired".
   (Shopify does not serve XLS-disguised-as-CSV; the HTML case is the real one.)
6. **Quoted multi-line fields.** `Notes`, `Note Attributes` and `Lineitem name` can contain commas,
   double quotes and embedded newlines. Use a real RFC-4180 parser; a `split(',')` will silently shred the
   file. Test fixtures must include one.
7. **Row limits / pagination.** The orders admin export is capped per request and Shopify splits by date;
   the balance transactions export is practically limited to one payout or a modest range. Community
   reports are consistent that multi-payout exports are unreliable. **Import one payout per file.**

**Semantic traps**

8. **`pending` rows must be excluded from the payout tie-out** but *included* in the month-end clearing
   accrual. Filter on `Payout Date == <this payout>` **and** `Payout Status != pending`.
9. **The `payout` row itself must be excluded from the sum of its own payout**, otherwise the total is
   always zero. The correct assertion is:
   `Σ Net (rows where Payout Date = D and Type ≠ 'payout') == −(Amount of the 'payout' row for D)`.
10. **A `charge` `Amount` is not revenue.** It is product − discounts + shipping + tax + tip, and for a
    split-tender order it is only the card portion.
11. **Gift cards.** Redeeming a gift card settles part of the order off-gateway, so the `charge` is smaller
    than `Total`. `Payment Method` on the order will read `gift_card, Shopify Payments`. Build the revenue
    side from the **orders export**, use the balance transactions only for cash and fees, and let the
    gift-card liability absorb the difference. Selling a gift card is a liability, not revenue.
12. **Other gateways.** PayPal, Amazon Pay, Faire, Amazon and manual/COD orders appear in the orders export
    but **never** in a Shopify Payments payout. Filter the orders export by `Payment Method` before trying
    to tie it to a payout, or the difference will look like missing money.
13. **Test-mode transactions.** Bogus-gateway test orders can appear if test mode was left on. They have no
    balance transaction. Exclude `Payment Method` containing `bogus` / `Payment Reference` starting `test_`.
14. **One order spans many rows.** Order-level columns (`Subtotal`, `Shipping`, `Taxes`, `Total`,
    `Discount Amount`, `Refunded Amount`, `Financial Status`, `Paid at`, `Id`, …) are populated only on the
    **first** row of the order's block; continuation rows carry only the `Lineitem *` columns.
    `Name` is repeated on every row and is the grouping key. *(Sources disagree on exactly which non-money
    columns repeat — Shopify says "many of the fields are left blank", third-party guides claim `Email` and
    the address fields repeat. Do not depend on it.)* **Safe rule:** group by `Name`; for each order-level
    column take the **first non-empty value in the group**, and assert that the group contains at most one
    distinct non-empty value. **Summing `Total` across rows inflates revenue 2–3×.**
15. **`Tax N Name`/`Tax N Value` column count varies between exports** of the same store, depending on the
    maximum number of tax lines in the range. Discover them by regex; never hard-code five pairs.
16. **Tips and duties have no column.** `tips + duties = Total − Subtotal − Shipping − Taxes`. Post the
    residual to a single **Tips Payable / Duties Payable — Unsplit** account, and if a store starts taking
    both, stop using the residual and switch to the GraphQL Admin API (`Order.totalTipReceived`,
    `Order.currentTotalDuties`). Log the residual per order so a sudden non-zero value is visible.
17. **Multi-currency.** The orders export is in the order's **presentment** currency; the payout is in USD.
    You cannot join them on amount. **Use the implied rate from the balance transactions row:**
    `rate = Presentment Amount / Amount`. Convert the order's components with that single rate so the
    decomposition ties to the payout exactly to the cent (see §7b, order `#1005`). Do not use a
    market rate — it will not tie.
18. **Refunds and disputes lag.** A refund settles against a *later* payout than the original charge, and a
    dispute can land months later. Both are keyed to an old `Order`. The system must be able to post a
    contra-revenue entry to an open period against an order from a closed one.
19. **Negative payouts.** A month with heavy refunds or a Capital remittance can produce a payout with a
    negative `Total`, which Shopify collects by **debiting the bank account**. Support `WITHDRAWAL`.
20. **`adjustment` is not self-describing.** The CSV gives no sub-reason. Never auto-post an `adjustment`;
    route it to a review queue with the payout detail screen / activity report as the resolution source.
21. **The shipping label charged to the customer and the label Sooz buys are different numbers on different
    files.** `Shipping` (orders export) is income; `shipping_label` (balance transactions) is expense.
    Never net them.

---

## 7. Accounting treatment

### 7a. Chart of accounts used

| Category (from the spec) | Account used here |
|---|---|
| Bank | `Bank – Operating` |
| Channel Clearing | `Channel Clearing – Shopify Payments` (a.k.a. "Shopify Clearing") |
| Gross Sales by channel | `Gross Sales – Shopify DTC` |
| Contra-Revenue | `Contra-Revenue – Discounts`, `Contra-Revenue – Returns & Refunds`, `Contra-Revenue – Chargebacks` |
| Sales Tax Payable | `Sales Tax Payable – Self-Remitted`, `Sales Tax Payable – Marketplace Facilitator` |
| Processing Fees | `Processing Fees – Shopify Payments` |
| Fulfillment Fees | `Fulfillment Fees – Shipping Labels` |
| Advertising Expense | `Advertising Expense – Shopify` (Shop Cash campaigns, Shopify Audiences billed via `billing_debit`) |
| Inventory / COGS | `Inventory – Finished Goods`, `COGS` |
| Deductions Receivable | `Deductions Receivable – Disputes` (open chargebacks being contested) |
| AR | not used for prepaid DTC; used only for `Outstanding Balance > 0` (Net-terms orders placed through the store) |
| AP | used only to accrue a Shopify bill before it is deducted |

**Three accounts outside the given list are required and should be added:**
`Shipping Income`, `Tips Payable`, `Software & Platform Expense`.
(`Sales Tax Compliance Expense` may be folded into `Software & Platform Expense`.)

### 7b. Rule per row type

| Balance-transaction row | Debit | Credit |
|---|---|---|
| `charge` | Channel Clearing (net of nothing — the gross `Amount`) + Contra-Revenue – Discounts | Gross Sales, Shipping Income, Sales Tax Payable, Tips Payable |
| `charge` fee (`Fee` column) | Processing Fees | Channel Clearing |
| `refund` | Contra-Revenue – Returns & Refunds, Shipping Income (reversal), Sales Tax Payable (reversal) | Channel Clearing |
| `dispute` (accepting the loss) | Contra-Revenue – Chargebacks, Sales Tax Payable (reversal) | Channel Clearing |
| `dispute` (contesting — see §7c) | Deductions Receivable – Disputes | Channel Clearing |
| `chargeback_fee` | Processing Fees | Channel Clearing |
| `dispute_reversal` | Channel Clearing | Contra-Revenue – Chargebacks (or Deductions Receivable), Sales Tax Payable |
| `billing_debit` | Software & Platform Expense / Advertising Expense / Sales Tax Compliance Expense, per the Shopify bill | Channel Clearing |
| `shipping_label`, `shipping_label_adjustment` | Fulfillment Fees – Shipping Labels | Channel Clearing |
| `adjustment` = marketplace sales tax withheld | Sales Tax Payable – Marketplace Facilitator | Channel Clearing |
| `adjustment` = anything else | **Suspense – Shopify Review** | Channel Clearing |
| `reserved_funds` / reversal | Reserve Receivable ⇄ Channel Clearing | — |
| `payout` | *(no entry at payout time — see below)* | — |
| Bank deposit (from the bank feed) | Bank – Operating | Channel Clearing |

The `payout` row is **not** posted as its own journal line. It is the *control*: its amount must equal the
balance left in Channel Clearing after all the other rows of that payout have posted. Then the bank
deposit, imported separately from the bank statement, debits Bank and credits Channel Clearing, taking it
to zero. That zero is the proof that nothing was dropped.

Fulfillment posts separately, off the orders export:

```
DR  COGS                        (Σ unit cost × Lineitem quantity, rows where Fulfillment Status = fulfilled)
    CR  Inventory – Finished Goods
```
and on a restocked refund, the reverse.

### 7c. Contesting a dispute

If Sooz intends to fight the chargeback, book the `dispute` debit to `Deductions Receivable – Disputes`
rather than Contra-Revenue, so the P&L is not hit for something expected to come back. A later
`dispute_reversal` credits Deductions Receivable to zero. If the dispute is lost (no reversal arrives
within the network window, typically 75–120 days), reclassify:
`DR Contra-Revenue – Chargebacks / CR Deductions Receivable – Disputes`.
The `chargeback_fee` always goes to Processing Fees immediately — it is never returned on a loss and only
sometimes on a win.

### 7d. Month-end cutoff

At `2026-09-30 23:59:59` store-local, charges exist that are captured but not yet paid out
(`Payout Status = pending`). Book them from the same decomposition, with the debit to **Channel Clearing**
instead of the bank. The clearing account's closing balance then equals
`Σ Net of all pending rows` and should reconcile to the Shopify admin's "Payout balance" figure. When the
October payout lands, the clearing entry is already there and only the deposit posts.

### 7e. Fully worked example — payout `2026-09-14`, `$560.28`

Source: the fixture in §8a (balance transactions) joined to §8b (orders), payout date `2026-09-14`.

**Step 1 — what the payout is made of** (all rows with `Payout Date = 2026-09-14`, `Payout Status = paid`,
excluding the `payout` row itself):

| Component | Amount |
|---|---|
| Charges (`charge` `Amount`, 7 orders) | `+993.62` |
| Processing + conversion fees (`Fee` on those charges) | `−35.18` |
| Refunds (`#0987`, `#1002`) | `−118.50` |
| Dispute (`#0954`) | `−72.40` |
| Chargeback fee | `−15.00` |
| Dispute reversal — chargeback won (`#0931`) | `+48.75` |
| Shopify bill deducted (`billing_debit`) | `−139.90` |
| Shipping labels (`86.24 + 3.15`) | `−89.39` |
| Marketplace sales tax withheld (`adjustment`, `#1007`) | `−11.72` |
| **Payout total** | **`560.28`** |

Check against the `payout` row: `Amount = −560.28`. ✓

**Step 2 — decompose the $993.62 of charges** using the orders export. `#1005` is a CAD order; its implied
rate is `412.80 / 305.12 = 1.352910`, and its CAD figures are converted at exactly that rate so the result
ties to the cent.

| Order | Gross product | Discount | Shipping | Tax | Tip | = Charge |
|---|---|---|---|---|---|---|
| `#1001` | 129.00 | (20.00) | 0.00 | 9.45 | — | 118.45 |
| `#1002` | 58.00 | — | 4.95 | 1.25 | — | 64.20 |
| `#1003` | 215.00 | (21.50) | 0.00 | 19.40 | — | 212.90 |
| `#1004` | 42.00 | — | 2.00 | 3.65 | — | 47.65 |
| `#1005` (CAD→USD) | 289.00 | (14.45) | 0.00 | 20.57 | 10.00 | 305.12 |
| `#1006` | 85.00 | (5.00) | 0.00 | 9.00 | — | 89.00 |
| `#1007` (Shop app) | 150.00 | (5.42) | 0.00 | 11.72 | — | 156.30 |
| **Total** | **968.00** | **(66.37)** | **6.95** | **75.04** | **10.00** | **993.62** |

Of the `75.04` tax, `11.72` is `#1007` — a **Shop app** order, where Shopify (SC Commerce Services Inc.)
is the marketplace facilitator and remits. The remaining `63.32` is Sooz's own liability.

Refund detail: `#0987` = product 49.00 + tax 5.30 = 54.30; `#1002` = product 58.00 + shipping 4.95 +
tax 1.25 = 64.20. Totals: product 107.00, shipping 4.95, tax 6.55.
Dispute `#0954` = product 66.00 + tax 6.40 = 72.40. Reversal `#0931` = product 44.75 + tax 4.00 = 48.75.
`billing_debit` 139.90 = Shopify plan 79.00 + apps 49.00 + Shopify Tax transaction fees 11.90.
Fee 35.18 = processing 30.60 + currency conversion 4.58 (all on `#1005`).

**Step 3 — the journal entry.** Date `2026-09-14`, memo `Shopify payout 2026-09-14 (USD 560.28)`.

| Account | Debit | Credit |
|---|---|---|
| Channel Clearing – Shopify Payments | 560.28 | |
| Contra-Revenue – Discounts | 66.37 | |
| Contra-Revenue – Returns & Refunds | 107.00 | |
| Contra-Revenue – Chargebacks | 66.00 | |
| Shipping Income *(refund of shipping charged)* | 4.95 | |
| Sales Tax Payable – Self-Remitted *(refunds)* | 6.55 | |
| Sales Tax Payable – Self-Remitted *(chargeback)* | 6.40 | |
| Sales Tax Payable – Marketplace Facilitator *(withheld by Shopify)* | 11.72 | |
| Processing Fees – Shopify Payments | 30.60 | |
| Processing Fees – Shopify Payments *(currency conversion)* | 4.58 | |
| Processing Fees – Shopify Payments *(chargeback fee)* | 15.00 | |
| Fulfillment Fees – Shipping Labels | 89.39 | |
| Software & Platform Expense | 128.00 | |
| Sales Tax Compliance Expense *(Shopify Tax fees)* | 11.90 | |
| Gross Sales – Shopify DTC | | 968.00 |
| Shipping Income | | 6.95 |
| Tips Payable | | 10.00 |
| Sales Tax Payable – Self-Remitted | | 63.32 |
| Sales Tax Payable – Marketplace Facilitator | | 11.72 |
| Contra-Revenue – Chargebacks *(dispute won, `#0931`)* | | 44.75 |
| Sales Tax Payable – Self-Remitted *(dispute won)* | | 4.00 |
| **Totals** | **1,108.74** | **1,108.74** |

Note that `Sales Tax Payable – Marketplace Facilitator` is credited `11.72` on the sale and debited `11.72`
on the withholding **in the same entry** — net zero, by design. It is grossed up so the tax report shows
the full taxable sale with the correct facilitator-collected amount, and it never leaves a phantom
liability at period end.

**Step 4 — the bank deposit.** On `2026-09-16` the bank feed shows `SHOPIFY PAYOUTS  560.28`:

| Account | Debit | Credit |
|---|---|---|
| Bank – Operating | 560.28 | |
| Channel Clearing – Shopify Payments | | 560.28 |

`Channel Clearing – Shopify Payments` now stands at **0.00** for this payout. Any non-zero residual after
matching a deposit means a row was dropped, mis-signed, or an `adjustment` is still sitting in Suspense.

**Step 5 — COGS** (separate, from `Lineitem sku` × `Lineitem quantity` × standard cost):

| Account | Debit | Credit |
|---|---|---|
| COGS | 312.40 | |
| Inventory – Finished Goods | | 312.40 |

and for the restocked portion of `#1002`:

| Account | Debit | Credit |
|---|---|---|
| Inventory – Finished Goods | 18.60 | |
| COGS | | 18.60 |

### 7f. Fees: three different things that must not be merged

| | Where it appears | Account | Notes |
|---|---|---|---|
| **Processing fee** | `Fee` column on a `charge`; `chargeback_fee` rows | `Processing Fees – Shopify Payments` | US online card rate is plan-dependent (`2.9% + $0.30` on Basic, lower on higher plans). Never refunded on a refund. |
| **Currency conversion fee** | Folded into the same `Fee` column, only on orders where `Presentment Currency ≠ Currency` | `Processing Fees – Shopify Payments` (sub-account) | **1.5% (US) / 2% (non-US)**. As of **2026-04-06** it is calculated on the **gross order amount**; before that it was calculated on the amount net of other fees, via `(Gross − Shopify Payments fees) × rate ÷ (1 + rate)`. Any back-period recomputation must use the right formula for the date. To split it out of `Fee`: `conversion = Amount × rate`; `processing = Fee − conversion`. Flag if `processing` comes out negative. |
| **Shopify's own billing** | `billing_debit` rows, and/or a card charge outside the payout entirely | `Software & Platform Expense`, `Advertising Expense`, `Sales Tax Compliance Expense` | **This is not a processing fee and must never land in Processing Fees.** It is the subscription plan, app subscriptions, Shopify Tax transaction fees, Shopify Audiences/ad spend, themes, domains. Reconcile every `billing_debit` to a line on the Shopify bill (`Finance > Bills > Export`). |

**Sources disagree on whether Shopify bills are deducted from payouts.** Shopify's help centre says bills
are charged to the primary payment method on file (a card), which would mean they never touch the payout.
But `BILLING_DEBIT` / `BILLING_DEBIT_REVERSAL` are real enum values and merchants do see them. Both are
true in different configurations (billing payment method, region, and whether the card declined).
**Handle both:** a `billing_debit` row posts as above; a card charge for the Shopify bill arrives through
the bank/credit-card feed and is coded from the bill export. Guard against double-counting by matching
both against the same monthly bill.

### 7g. Marketplace facilitator / Shopify Tax — who owes the tax

Three distinct regimes, and `Source` on the orders export is what distinguishes them:

1. **`Source = web` / `pos` (Sooz's own storefront).** Shopify is **not** a marketplace facilitator.
   Sooz is the seller of record. Shopify Tax *calculates* the tax and Shopify collects it inside the
   charge — it does **not** file or remit. Tax collected is Sooz's liability:
   `CR Sales Tax Payable – Self-Remitted` at the sale, `DR` when Sooz files and pays each state.
   **Shopify Tax's transaction fee** — `0.35%` per order where tax is calculated, capped at `$0.99` per
   order and `$5,000` per year per state, free below `$100,000` of US sales per calendar year — is billed
   on the Shopify invoice, not taken from the customer. It is an **operating expense**, not tax and not a
   processing fee.
2. **`Source = shop_app` (Shop app / Shop Website).** Since **2025-01-01**, the Shop channel is a
   marketplace facilitator, operating as **SC Commerce Services Inc.**, and collects, remits and files
   sales tax for all US orders — every state with a statewide sales tax, plus DC, plus Alaska local tax.
   Shopify **deducts the tax from the payout**, labelled *"Marketplace sales tax"* in the payout detail
   (it arrives as an `adjustment` row in the CSV). Accounting: gross the tax up on the sale into
   `Sales Tax Payable – Marketplace Facilitator` and debit the same account when withheld, so it nets to
   zero and never mingles with Sooz's self-remitted liability. **On the state return these are still
   reportable gross sales with facilitator-collected tax deducted** — Shopify's tax report marks these
   rows `Filed` in the *Filed by channel* column. This is a reporting difference, not an exemption.
3. **International / Managed Markets (Markets Pro).** Global-e is the merchant of record; duties and
   import tax flow through `customs_duty` / `import_tax` rows and the *Managed Markets* category of the
   activity report. Neither revenue nor Sooz's tax liability — post to `Duties Payable`/clearing and route
   to review. Out of scope for the first release.

**Parser requirement:** every tax amount must be tagged `self_remitted` or `marketplace_facilitator` at
import time, from `Source`. Getting this wrong either double-pays a state or understates a liability.

---

## 8. Realistic sample files (synthetic)

> **SYNTHETIC — every value below is invented for test-fixture use.** It is not Sooz data and does not
> correspond to any real store, order, card or bank account. The two files are consistent with each other
> and with the worked example in §7e; a parser test suite should assert the payout ties to `560.28` and
> the journal entry balances at `1,108.74`.

### 8a. `shopify_balance_transactions_2026-09-14.csv`

Payout `2026-09-14` (rows 1–17), plus four `pending` rows (18–21) that belong to the next payout and must
be excluded from this payout's tie-out.

```csv
Transaction Date,Type,Order,Card Brand,Card Source,Payout Status,Payout Date,Available On,Checkout,Payment Method Name,Presentment Amount,Presentment Currency,Amount,Fee,Net,Currency
2026-09-10 09:14:22 -0400,charge,#1001,visa,online,paid,2026-09-14,2026-09-14,c_884411003,shopify_payments,118.45,USD,118.45,3.73,114.72,USD
2026-09-10 11:02:47 -0400,charge,#1002,mastercard,online,paid,2026-09-14,2026-09-14,c_884411004,shopify_payments,64.20,USD,64.20,2.16,62.04,USD
2026-09-10 16:38:11 -0400,charge,#1003,amex,online,paid,2026-09-14,2026-09-14,c_884411009,shopify_payments,212.90,USD,212.90,6.47,206.43,USD
2026-09-11 08:21:55 -0400,charge,#1004,visa,online,paid,2026-09-14,2026-09-14,c_884411015,shop_pay,47.65,USD,47.65,1.68,45.97,USD
2026-09-11 13:47:03 -0400,charge,#1005,visa,online,paid,2026-09-14,2026-09-14,c_884411021,shopify_payments,412.80,CAD,305.12,13.43,291.69,USD
2026-09-11 19:05:41 -0400,charge,#1006,mastercard,online,paid,2026-09-14,2026-09-14,c_884411030,shop_pay_installments,89.00,USD,89.00,2.88,86.12,USD
2026-09-12 07:33:19 -0400,charge,#1007,visa,online,paid,2026-09-14,2026-09-14,c_884411038,shop_app,156.30,USD,156.30,4.83,151.47,USD
2026-09-11 10:12:00 -0400,refund,#0987,visa,online,paid,2026-09-14,2026-09-14,c_884402277,shopify_payments,-54.30,USD,-54.30,0.00,-54.30,USD
2026-09-12 15:26:34 -0400,refund,#1002,mastercard,online,paid,2026-09-14,2026-09-14,c_884411004,shopify_payments,-64.20,USD,-64.20,0.00,-64.20,USD
2026-09-11 04:00:00 -0400,dispute,#0954,visa,online,paid,2026-09-14,2026-09-14,c_884399812,shopify_payments,-72.40,USD,-72.40,0.00,-72.40,USD
2026-09-11 04:00:00 -0400,chargeback_fee,#0954,visa,online,paid,2026-09-14,2026-09-14,,shopify_payments,-15.00,USD,-15.00,0.00,-15.00,USD
2026-09-12 04:00:00 -0400,dispute_reversal,#0931,mastercard,online,paid,2026-09-14,2026-09-14,c_884388120,shopify_payments,48.75,USD,48.75,0.00,48.75,USD
2026-09-12 02:00:00 -0400,billing_debit,,,,paid,2026-09-14,2026-09-14,,,-139.90,USD,-139.90,0.00,-139.90,USD
2026-09-10 18:44:02 -0400,shipping_label,,,,paid,2026-09-14,2026-09-14,,,-86.24,USD,-86.24,0.00,-86.24,USD
2026-09-12 06:15:00 -0400,shipping_label_adjustment,,,,paid,2026-09-14,2026-09-14,,,-3.15,USD,-3.15,0.00,-3.15,USD
2026-09-12 07:33:19 -0400,adjustment,#1007,,,paid,2026-09-14,2026-09-14,,,-11.72,USD,-11.72,0.00,-11.72,USD
2026-09-14 00:00:00 -0400,payout,,,,paid,2026-09-14,2026-09-14,,,-560.28,USD,-560.28,0.00,-560.28,USD
2026-09-13 09:02:11 -0400,charge,#1008,visa,online,pending,,2026-09-17,c_884411044,shopify_payments,74.10,USD,74.10,2.45,71.65,USD
2026-09-13 12:40:58 -0400,charge,#1009,mastercard,online,pending,,2026-09-17,c_884411051,shopify_payments,129.99,USD,129.99,4.07,125.92,USD
2026-09-13 20:17:36 -0400,charge,#1010,visa,online,pending,,2026-09-17,c_884411060,shop_pay,41.50,USD,41.50,1.50,40.00,USD
2026-09-13 21:05:12 -0400,refund,#1005,visa,online,pending,,2026-09-17,c_884411021,shopify_payments,-25.00,USD,-25.00,0.00,-25.00,USD
```

**Assertions a test suite should make against this file**

| # | Assertion | Expected |
|---|---|---|
| 1 | `Net == Amount − Fee` on every row | true |
| 2 | `Σ Net where Payout Date = 2026-09-14 and Type != 'payout'` | `560.28` |
| 3 | `Amount` of the `payout` row | `-560.28` |
| 4 | `Σ Amount where Type = 'charge' and Payout Date = 2026-09-14` | `993.62` |
| 5 | `Σ Fee where Payout Date = 2026-09-14` | `35.18` |
| 6 | rows with `Payout Status = 'pending'` have empty `Payout Date` | true (4 rows) |
| 7 | `pending` rows are excluded from #2 | `74.10 + 129.99 + 41.50 − 25.00` is **not** in the total |
| 8 | `#1005` implied FX rate `412.80 / 305.12` | `1.352910…` |
| 9 | every `refund` row has `Fee == 0.00` | true |
| 10 | `Order` is empty on `payout`, `billing_debit`, `shipping_label*` | true |

### 8b. `shopify_orders_2026-09-10_2026-09-12.csv`

A **column subset** of the native orders export (money-relevant columns only — the real file has ~70
columns; select by header name, not position). 13 line-item rows across 8 orders. Note `#1001`, `#1003`,
`#1005` and `#1007` span multiple rows with order-level columns blank on continuation rows; `#1003`
contains a quoted `Lineitem name` with a comma; `#1005` is in CAD.

```csv
Name,Id,Email,Financial Status,Paid at,Fulfillment Status,Currency,Subtotal,Shipping,Taxes,Total,Discount Code,Discount Amount,Created at,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku,Lineitem discount,Refunded Amount,Tax 1 Name,Tax 1 Value,Payment Method,Source
#1001,6118240321793,jo.reyes@example.com,paid,2026-09-10 09:14:22 -0400,fulfilled,USD,109.00,0.00,9.45,118.45,FALL15,20.00,2026-09-10 09:13:58 -0400,2,Sooz Chili Crisp — 7 oz,39.00,SOOZ-CC-7OZ,12.40,0.00,NY State Tax,9.45,Shopify Payments,web
#1001,,,,,,,,,,,,,,1,Sooz Garlic Crunch — 6 oz,51.00,SOOZ-GC-6OZ,7.60,,,,,
#1002,6118240354561,m.okafor@example.com,refunded,2026-09-10 11:02:47 -0400,restocked,USD,58.00,4.95,1.25,64.20,,0.00,2026-09-10 11:02:20 -0400,1,Sooz Sampler Box,58.00,SOOZ-BOX-SMP,0.00,64.20,TX State Tax,1.25,Shopify Payments,web
#1003,6118240399617,dana.li@example.com,paid,2026-09-10 16:38:11 -0400,fulfilled,USD,193.50,0.00,19.40,212.90,FALL10,21.50,2026-09-10 16:37:44 -0400,5,"Sooz Chili Crisp, 7 oz (5-pack)",29.00,SOOZ-CC-7OZ,14.50,0.00,CA State Tax,19.40,Shopify Payments,web
#1003,,,,,,,,,,,,,,1,Sooz Tote Bag,45.00,SOOZ-MERCH-TOTE,4.50,,,,,
#1003,,,,,,,,,,,,,,1,Sooz Sticker Pack,25.00,SOOZ-MERCH-STK,2.50,,,,,
#1004,6118240441345,p.novak@example.com,paid,2026-09-11 08:21:55 -0400,fulfilled,USD,42.00,2.00,3.65,47.65,,0.00,2026-09-11 08:21:30 -0400,1,Sooz Garlic Crunch — 6 oz,42.00,SOOZ-GC-6OZ,0.00,0.00,IL State Tax,3.65,Shopify Payments,web
#1005,6118240487425,r.tremblay@example.ca,paid,2026-09-11 13:47:03 -0400,fulfilled,CAD,371.45,0.00,27.83,412.80,VIP5,19.55,2026-09-11 13:46:31 -0400,4,Sooz Chili Crisp — 7 oz,52.77,SOOZ-CC-7OZ,10.55,0.00,GST/HST,27.83,Shopify Payments,web
#1005,,,,,,,,,,,,,,1,Sooz Gift Set,179.92,SOOZ-GIFT-SET,9.00,,,,,
#1006,6118240523265,a.haddad@example.com,paid,2026-09-11 19:05:41 -0400,fulfilled,USD,80.00,0.00,9.00,89.00,WELCOME5,5.00,2026-09-11 19:05:12 -0400,1,Sooz Sampler Box,85.00,SOOZ-BOX-SMP,5.00,0.00,WA State Tax,9.00,shop_pay_installments,web
#1007,6118240566273,k.mensah@example.com,paid,2026-09-12 07:33:19 -0400,fulfilled,USD,144.58,0.00,11.72,156.30,AUTO-SHOPAPP,5.42,2026-09-12 07:32:50 -0400,3,Sooz Chili Crisp — 7 oz,34.00,SOOZ-CC-7OZ,3.68,0.00,CA State Tax,11.72,Shopify Payments,shop_app
#1007,,,,,,,,,,,,,,1,Sooz Garlic Crunch — 6 oz,48.00,SOOZ-GC-6OZ,1.74,,,,,
#0987,6118237114881,t.delgado@example.com,refunded,2026-09-02 10:55:08 -0400,restocked,USD,49.00,0.00,5.30,54.30,,0.00,2026-09-02 10:54:40 -0400,1,Sooz Garlic Crunch — 6 oz,49.00,SOOZ-GC-6OZ,0.00,54.30,AZ State Tax,5.30,Shopify Payments,web
```

**Assertions a test suite should make against this file**

| # | Assertion | Expected |
|---|---|---|
| 1 | Distinct orders after grouping by `Name` | 8 |
| 2 | Rows for `#1003` | 3, with order-level columns blank on rows 2–3 |
| 3 | `Σ Total` after forward-filling order-level columns down each block, then summing every row | `2,268.95` — **wrong by 2×**, proves the grouping bug. Forward-fill is required to recover `Id`, so the parser must fill *and then* deduplicate by `Name` before aggregating |
| 4 | `Σ Total` after grouping by `Name` (one value per order) | `1,155.60` (mixed currency — USD + `#1005` in CAD; the real aggregate must convert first) |
| 5 | `Σ(Lineitem price × Lineitem quantity) − Σ Lineitem discount == Subtotal` per order | true for all 8 |
| 6 | `#1005` residual `Total − Subtotal − Shipping − Taxes` | `13.52` CAD — the tip. Converting at the implied rate would give `13.53`; the `0.01` difference is Shopify's own rounding, which is why the **USD** tip (`10.00`) must come from the payout decomposition, not from converting this residual |
| 7 | All other orders' residual | `0.00` |
| 8 | `#1003` `Lineitem name` parsed intact | `Sooz Chili Crisp, 7 oz (5-pack)` |
| 9 | Orders with `Source = shop_app` | `#1007` only → its `11.72` tax is marketplace-facilitator |
| 10 | Join `#1001`–`#1007` to §8a on `Name` | 7 matches; `#0987` matches a `refund` row only |
| 11 | `#1005` converted at implied rate ties to the §7e table | `289.00 / 14.45 / 20.57 / 10.00` USD |

---

## Sources

- [Shopify Help Center — Viewing and exporting your Shopify Payments payout details](https://help.shopify.com/en/manual/payments/shopify-payments/payouts/view-details)
- [Shopify Help Center — Navigating your Shopify Payments payouts to resolve lower or missing payouts](https://help.shopify.com/en/manual/payments/shopify-payments/payouts/lower-or-missing-payouts)
- [Shopify Help Center — Shopify Payments activity report](https://help.shopify.com/en/manual/payments/shopify-payments/payouts/payouts-activity-report)
- [Shopify Help Center — Exporting orders](https://help.shopify.com/en/manual/fulfillment/managing-orders/exporting-orders)
- [Shopify Help Center — Sales tax in Shop](https://help.shopify.com/en/manual/online-sales-channels/shop/sales-tax)
- [Shopify Help Center — Shopify Tax pricing](https://help.shopify.com/en/manual/taxes/shopify-tax/pricing)
- [Shopify Help Center — Understanding Shopify Tax transaction fees](https://help.shopify.com/en/manual/your-account/manage-billing/billing-charges/types-of-charges/shopify-tax-transaction-fees)
- [Shopify Help Center — Currency conversion fee calculation for Shopify Payments orders](https://help.shopify.com/en/manual/payments/shopify-payments/store-currency/currency-conversion-calculation)
- [Shopify Help Center — Getting paid for orders placed using Shop Pay Installments](https://help.shopify.com/en/manual/payments/shop-pay-installments/getting-paid)
- [Shopify Help Center — Making payments for your Shopify bills](https://help.shopify.com/en/manual/your-account/manage-billing/paying-your-bills/making-payments)
- [Shopify.dev — ShopifyPaymentsTransactionType enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/ShopifyPaymentsTransactionType)
- [Shopify.dev — ShopifyPaymentsPayoutTransactionType enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/shopifypaymentspayouttransactiontype)
- [Shopify.dev — ShopifyPaymentsBalanceTransaction object](https://shopify.dev/docs/api/admin-graphql/unstable/objects/ShopifyPaymentsBalanceTransaction)
- [Matrixify — Payouts documentation (column list, transaction type values)](https://matrixify.app/documentation/payouts/)
- [TrestleFinance — Shopify Payments CSV to QuickBooks Online (16-column list, sign conventions, date format)](https://trestlefinance.com/guides/shopify-payments-csv-quickbooks)
- [TaxConnex — Shop app: how does it handle sales tax and is it a marketplace facilitator?](https://www.taxconnex.com/blog-/shop-app-how-does-it-handle-sales-tax-and-is-it-a-marketplace-facilitator)
- [Numeral — Is Shopify a marketplace facilitator?](https://www.numeral.com/blog/is-shopify-a-marketplace-facilitator)
- [Shopify Community — Help interpreting Orders-CSV export fields](https://community.shopify.com/t/help-interpreting-orders-csv-export-fields/580682)

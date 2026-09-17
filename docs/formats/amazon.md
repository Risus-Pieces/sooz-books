# Amazon Seller Central — Settlement Report (Flat File V2)

**Importer spec for Sooz Books. Scope: 3P seller, FBA (AFN), Amazon.com primary, with notes for
Amazon.co.uk / .de / .fr because a CPG brand that expands will hit the EU locale traps.**

Report type ID: `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`
Output: **tab-delimited flat file**, `.txt` extension, 24 columns.

> **Evidence base for this document.** The column list is confirmed against Amazon's own SP-API
> documentation. Everything about row shapes, blank columns, locale formats, ragged rows, the
> tie-out identity, and the reserve chain was verified by me against **seven real settlement files**
> (4 EU/UK in EUR and GBP, 3 US in USD) published in a public GitHub repo
> (`guysolan/thetis`, `services/amazon/supabase/functions/_shared/amazon/reports/*/v2.txt`).
> Where I only have a secondary source, or where sources disagree, I say so inline.
> **Marked `[UNVERIFIED]` = plausible per vendor docs, not seen in a real file by me.**

---

## 1. How you get the file

### 1a. Seller Central UI (the manual path Sooz will use)

1. Sign in to Seller Central for the **correct marketplace** (each marketplace region has its own
   settlement stream — North America, Europe, Far East are separate report sets).
2. **Payments → Payments** (older UI: `Reports → Payments`).
3. The Payments dashboard has four tabs. Which one matters:
   - **Statement View** — the *current, still-open* settlement. Amazon shows a running view. There
     is a `Download Flat File V2` control here, but the period is not closed and **the file will not
     have a final `total-amount` or `deposit-date`**. *Do not import from Statement View.*
   - **Transaction View** — a per-transaction browser with filters (Order, Refund, Service Fee,
     Adjustment…). This is a *UI view only*; its CSV export is the Date Range Report shape, **not**
     the settlement flat file. Use it for human investigation, never as an import source.
   - **All Statements** — the list of **closed** settlement periods. This is the one. Each row has
     an Actions column with `Download XML`, `Download Flat File`, `Download Flat File V2`.
     **Click `Download Flat File V2`.** For some settlements you must click `Request Report` first
     and wait for it to generate.
   - **Date Range Reports** — a *different report* (`GET_DATE_RANGE_FINANCIAL_TRANSACTION_DATA`,
     wide-format, one row per transaction with ~30 named money columns like `product sales`,
     `selling fees`, `fba fees`). Useful for month-end cutoff, **but it does not tie to a deposit**
     and it is not what this spec covers. Do not mix the two importers.
4. **Reports Repository** (`Payments → Reports Repository`, present in newer UI rollouts) is the
   asynchronous drop zone for generated reports. Some accounts see settlement downloads here
   instead of inline on All Statements. Both produce the same bytes.

**Options that matter**
- Format must be **Flat File V2**, not "Flat File" (V1, 36 columns, different layout — see §2c) and
  not XML.
- **Retention: only the last ~90 days of settlements are downloadable.** Sooz must archive every
  file on download. Build the importer to store the raw bytes permanently.
- The file downloads with a name like `<settlement-id>.txt`. Keep that name.

### 1b. SP-API (the path to automate)

Settlement reports **cannot be requested or scheduled** — Amazon generates them automatically.
You poll `getReports` with `reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`, then
`getReportDocument` to fetch. Role required: **Finance and Accounting**. Availability: Seller
Central sellers only (not Vendor Central / 1P — 1P is invoices and remittance advice, an entirely
different importer).

**Deprecation note:** Amazon has already deprecated `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE` (V1)
and `GET_V2_SETTLEMENT_REPORT_DATA_XML`, with a removal date announced as **November 11, 2026**.
V2 is the survivor. Build only V2; detect V1 by header and reject with a clear message.

---

## 2. Columns

### 2a. The 24 columns, exact spelling, exact order

Confirmed byte-for-byte against (a) Amazon SP-API "Settlement Reports" docs, (b) seven real files,
(c) an independent PHP integrator header map. All lowercase, hyphen-separated.

| # | Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|---|
| 1 | `settlement-id` | string (numeric-looking, treat as string) | `21871512981` | Settlement period key. **Present on every row including the summary row.** | Always |
| 2 | `settlement-start-date` | datetime | `2024-10-23 14:28:39 UTC` | Period start. | **Summary row only** — blank on every detail row |
| 3 | `settlement-end-date` | datetime | `2024-11-06 14:28:39 UTC` | Period end. | Summary row only |
| 4 | `deposit-date` | datetime | `2024-11-08 14:28:39 UTC` | Date Amazon initiates the disbursement. | Summary row only |
| 5 | `total-amount` | decimal | `1668.68` | Net settled amount = the deposit. | Summary row only |
| 6 | `currency` | ISO-4217 | `USD` | Settlement currency. | Summary row only |
| 7 | `transaction-type` | enum (open) | `Order`, `Refund`, `ServiceFee`, `Liquidations`, `other-transaction` | Top-level classification. | Every detail row |
| 8 | `order-id` | string | `114-4918736-2898654` | Amazon order id. Also carries **removal order ids** (`26031149TQ`) and **liquidation ids** (`17204518893551`). Blank on reserve/subscription/ad rows. | Conditional |
| 9 | `merchant-order-id` | string | `111-2233445-6677889` or `#SZ-10482` | Seller's own reference. For Amazon.com orders it echoes `order-id`. **For MCF it carries your Shopify order name.** | Conditional |
| 10 | `adjustment-id` | string | `amzn1:crow:7LpQ2mSvTGyBd4RhK9xJaA` | Present on **Refund** rows and reimbursement rows. Modern format is an `amzn1:crow:` ARN-ish token, not a number. | Conditional |
| 11 | `shipment-id` | string | `DkR8v2Lqe` | FBA shipment / fulfillment-shipment id. Blank on refunds. | Conditional |
| 12 | `marketplace-name` | string | `Amazon.com`, `Amazon.co.uk`, `Amazon.de`, `Amazon.fr`, `Non-Amazon US` | Which storefront. **`Non-Amazon US` = Multi-Channel Fulfillment.** Blank on Liquidations, ServiceFee, reserve rows. | Conditional |
| 13 | `amount-type` | enum (open) | `ItemPrice`, `ItemFees`, `ItemWithheldTax`, `Promotion`, `other-transaction`, `Cost of Advertising`, `FBA Inventory Reimbursement` | Bucket. **Not always a camelCase token — some values contain spaces.** | Every detail row |
| 14 | `amount-description` | enum (open) | `Principal`, `Commission`, `FBAPerUnitFulfillmentFee`, `MarketplaceFacilitatorTax-Principal`, `Current Reserve Amount` | The specific line kind. | Every detail row |
| 15 | `amount` | signed decimal | `-16.19` | The money. **Locale-formatted** — see §3. | Every detail row |
| 16 | `fulfillment-id` | enum | `AFN` or `MFN` | `AFN` = Fulfilled by Amazon, `MFN` = merchant-fulfilled. **Blank on ServiceFee, Liquidations, reserve and reimbursement rows.** | Conditional |
| 17 | `posted-date` | date | `2024-10-26` or `26.10.2024` | Date the row posted. Locale-formatted. | Every detail row |
| 18 | `posted-date-time` | datetime | `2024-10-26 18:32:18 UTC` | Same instant with time. **This column exists — the task brief's 23-column list omits it.** | Every detail row |
| 19 | `order-item-code` | string | `112789501075401` | Amazon's line-item id. **This is the join key for order lines.** | Conditional |
| 20 | `merchant-order-item-id` | string | `SOOZ-GRAN-12PK` | Your line reference. Usually blank on Amazon.com orders; populated on MCF. | Rare |
| 21 | `merchant-adjustment-item-id` | string | `1772449283610094551` | Populated on Refund rows. | Conditional |
| 22 | `sku` | string | `SOOZ-GRAN-12PK` | Seller SKU (occasionally an ASIN, e.g. `B09N58H79F`, on Liquidations rows). | Conditional |
| 23 | `quantity-purchased` | integer | `4` | Units. **Frequently blank on Refund rows even when units came back.** | Conditional |
| 24 | `promotion-id` | string | `PAWS-V2-22886240117-91` | Populated on some `Promotion` rows; blank on many. | Rare |

**Header row is literally:**
```
settlement-id	settlement-start-date	settlement-end-date	deposit-date	total-amount	currency	transaction-type	order-id	merchant-order-id	adjustment-id	shipment-id	marketplace-name	amount-type	amount-description	amount	fulfillment-id	posted-date	posted-date-time	order-item-code	merchant-order-item-id	merchant-adjustment-item-id	sku	quantity-purchased	promotion-id
```

### 2b. Header variations

- **No regional header variation observed.** US, UK, DE, FR files all carry identical headers.
  Only the *values* localize.
- **Some vendor docs omit `posted-date-time`** and describe a 23-column file. That is wrong for the
  current file; every real file I checked has 24 columns with `posted-date-time` at position 18.
  Treat 23-column headers as a hard parse error, not a supported variant.
- One seller reported a 2022-era Amazon-side glitch that briefly widened the file beyond column X
  (24). Validate header exactly and fail loudly rather than positionally indexing.

### 2c. V1 ("Flat File", deprecated) — detect and reject

V1 is 36 columns with per-purpose money columns. Its header starts identically for the first 12
columns, then diverges at column 13:

```
… marketplace-name	shipment-fee-type	shipment-fee-amount	order-fee-type	order-fee-amount	fulfillment-id	posted-date	order-item-code	merchant-order-item-id	merchant-adjustment-item-id	sku	quantity-purchased	price-type	price-amount	item-related-fee-type	item-related-fee-amount	misc-fee-amount	other-fee-amount	other-fee-reason-description	promotion-id	promotion-type	promotion-amount	direct-payment-type	direct-payment-amount	other-amount
```

**Detection rule:** if field 13 is `shipment-fee-type`, it is V1 → reject with
"This is a V1 Flat File. Re-download using *Download Flat File V2*."

---

## 3. Sign and amount conventions

### The rule
**There is a single signed `amount` column. No separate debit/credit columns. No parentheses.
No currency symbols. No thousands separators.**

**Sign convention (from Sooz's point of view, i.e. the seller):**
- **Positive = Amazon owes Sooz more** (revenue, tax collected on Sooz's behalf, reimbursements,
  fee reversals, reserve released back).
- **Negative = Amazon keeps it** (fees, taxes remitted by Amazon, refunds paid to customers,
  ad spend, reserve withheld).

**Yes, credits appear as positives in what look like "fee" rows and vice versa.** Do not infer sign
from `amount-description`. Verified counter-examples from real files:

| Row | Sign | Why |
|---|---|---|
| `Refund / ItemFees / Commission` = **+12.42** | positive | the original referral fee is *returned* to you on a refund |
| `Refund / ItemFees / RefundCommission` = **−2.48** | negative | Amazon keeps 20% of the returned commission as a refund-admin fee |
| `Refund / ItemPrice / RestockingFee` = **+13.80** | positive | you kept a restocking fee out of the customer's refund |
| `Refund / ItemWithheldTax / MarketplaceFacilitatorTax-Principal` = **+5.95** | positive | the tax Amazon withheld is un-withheld on a refund |
| `other-transaction / other-transaction / Previous Reserve Amount Balance` = **+1412.23** | positive | last period's reserve released into this settlement |

### Decimal separator and thousands separator — **locale dependent, per marketplace**

Amazon's own docs state amounts print in **local currency format** ("95,00 for EU instead of
95.00"). Verified in real files:

| Marketplace | `amount` sample | Decimal sep |
|---|---|---|
| Amazon.com (USD) | `-16.19` | `.` |
| Amazon.co.uk (GBP) | `-1.73` | `.` |
| Amazon.de / Amazon.fr (EUR) | `-11,33` | `,` |

**No thousands separator was present in any real file**, even at values over 1000
(`1412.23`, not `1,412.23`). Do **not** assume it will never appear: normalize by stripping
anything that is not a digit, `-`, `,` or `.`, then decide the decimal separator from the last
occurring separator.

**Recommended parse:**
1. Strip whitespace. Empty string → `0` **only** for `total-amount`/`amount` on rows where the
   column is structurally blank; otherwise a blank `amount` is a parse error.
2. If the string contains both `,` and `.`, the rightmost one is the decimal separator.
3. If it contains only `,`, and exactly 2 digits follow it → decimal comma. Otherwise → thousands.
4. Parse into `Decimal`, never `float`. Every assertion in §5 is exact-to-the-cent.

**Currency:** column 6 is populated **only on the summary row**. Every detail row has a blank
`currency`. The parser must hoist the summary-row currency onto all detail rows.
(A widely circulated AI-authored integration note claims `currency` and the date columns repeat on
every row — that is **false** for every real file examined. Do not build on it.)

---

## 4. Date formats and timezone

Five date-bearing columns: `settlement-start-date`, `settlement-end-date`, `deposit-date`,
`posted-date`, `posted-date-time`.

**Two format families observed in real files. Date format and decimal separator vary
independently — a UK file uses dotted dates with a dot decimal.**

| Marketplace | start/end/deposit & posted-date-time | posted-date |
|---|---|---|
| Amazon.com (USD) | `2024-10-23 14:28:39 UTC` | `2024-10-23` |
| Amazon.co.uk (GBP) | `15.11.2024 08:59:45 UTC` | `15.11.2024` |
| Amazon.de / .fr (EUR) | `11.10.2024 08:59:52 UTC` | `11.10.2024` |

A real-world open-source parser (`SomeUserMtl/amazon-data-grab`) tries, in order:
`%d.%m.%Y %H:%M:%S %Z`, `%Y-%m-%d %H:%M:%S %Z`, `%Y-%m-%d`, `%d.%m.%Y`. **Adopt that list, in that
order, and quarantine any row whose date matches none of them** (keep the literal string in the
error). Do **not** hard-code `MM/DD/YYYY`; one secondary source claims `posted-date` is `MM/DD/YY`
and I could not confirm it in any real file — if you ever see it, the `%d.%m.%Y` vs `%m/%d/%Y`
ambiguity is genuinely dangerous, so require the separator to disambiguate (`.` ⇒ day-first,
`/` ⇒ month-first for US marketplaces).

**Timezone caveats**
- The literal suffix is always `UTC`. The XML sibling report uses ISO-8601 with a numeric offset
  (`2022-03-22T21:21:31+00:00`) — do not assume flat-file V2 matches it.
- **`posted-date` is the UTC calendar date, not local.** A US sale placed 2026-03-04 19:00 PT posts
  as `2026-03-05`. For a US-GAAP book this shifts revenue across a period boundary at month-end.
  **Decision for Sooz Books: use `posted-date-time` converted to `America/Los_Angeles` to assign
  the accounting period, and store the raw UTC value alongside.** Record which convention was used
  on the import run so a later restatement is possible.
- `settlement-start-date`, `settlement-end-date` and `deposit-date` all carry a time-of-day equal to
  the account's settlement cutoff (e.g. `14:28:39 UTC`). Settlement windows are **half-open on the
  clock**: settlement N's `settlement-end-date` is bit-identical to settlement N+1's
  `settlement-start-date`. Use `[start, end)` and never double-count.
- Settlement cycle length: **14 days** standard; some accounts get 7. Never hard-code.

---

## 5. Identity and deduplication

### 5a. Settlement-level identity — **the assertion the parser must make**

**For every file: `SUM(amount)` over all detail rows == `total-amount` on the summary row ==
the bank deposit.**

Verified exactly (diff = 0.00) on all seven real files:

| settlement-id | currency | total-amount | Σ amount |
|---|---|---|---|
| 21574497411 | USD | 1977.17 | 1977.17 |
| 21871512981 | USD | 1668.68 | 1668.68 |
| 23167452842 | EUR | 196,65 | 196,65 |
| 22988491762 | EUR | 128,84 | 128,84 |
| 23347038192 | EUR | 0,00 | 0,00 |
| 23395380562 | GBP | 253.43 | 253.43 |
| 23208776292 | GBP | 346.60 | 346.60 |

**Implementation:** hard-fail the import if `abs(Σ amount − total-amount) > 0.00`. A mismatch means a
**truncated or partially-downloaded file**, not an accounting problem. Do not "plug the difference."

### 5b. Why a settlement still may not equal one bank line — reserves

The reserve rows are **inside** the file, which is exactly why the identity still holds:

- `other-transaction / other-transaction / Current Reserve Amount` — **negative**, the amount Amazon
  is withholding out of *this* settlement into reserve.
- `other-transaction / other-transaction / Previous Reserve Amount Balance` — **positive**, last
  settlement's reserve released into *this* one.

**Verified chaining invariant:** settlement `21574497411` has `Current Reserve Amount = −1412.23`;
the next US settlement `21871512981` has `Previous Reserve Amount Balance = +1412.23`. Exact match.

**Assert it:** `|Current Reserve Amount(N)| == Previous Reserve Amount Balance(N+1)` for consecutive
settlements of the same marketplace/account. A break means you missed a settlement file. This is the
single best completeness check Sooz Books can run.

Caveats: a settlement may have **no** `Previous Reserve Amount Balance` row at all (observed: FR
settlement `23347038192`) — treat missing as 0, not as an error. Reserve rows carry **no**
`order-id`, `marketplace-name`, `fulfillment-id` or `sku`.

Also note: the deposit **initiates** on `deposit-date` but lands in Sooz's bank 1–5 business days
later, and the bank memo will show a *different* reference (`AMAZON.COM ... PAYMENTS`) than the
settlement-id. Match bank→settlement on **amount + date window**, then pin the settlement-id once
matched. Amazon can also batch two settlements into one ACH; design the bank match to allow
many-settlements-to-one-deposit.

### 5c. `total-amount = 0`

Observed for real (`23347038192`, EUR). All order/refund/fee activity netted to +22,80 and the whole
+22,80 was pushed into `Current Reserve Amount = −22,80`, leaving 0,00.

**Handling:** this is a **valid, complete settlement**. `deposit-date` is still populated even though
no money moves. The parser must:
- still post the full journal entry (revenue, fees, reserve) — the P&L is real;
- post **no bank line** and create **no** expected deposit;
- not treat 0 as "empty file" or skip it.
A **negative** `total-amount` is also legal (fees exceeded revenue). Amazon then charges the card on
file or carries the balance forward; there is still no bank deposit for that settlement.

### 5d. Row-level identity — there is no row id

**There is no unique transaction id column.** `adjustment-id` is unique for refunds/reimbursements
but blank on ~85% of rows.

**Dedup key for a row (use this):**

```
(settlement-id, transaction-type, amount-type, amount-description,
 order-id, order-item-code, adjustment-id, sku, posted-date-time, amount, row_ordinal)
```

`row_ordinal` = the 0-based index of the row within the file, **required** because Amazon genuinely
emits byte-identical rows (two units of the same SKU on two shipments of the same order, each with
the same fee and timestamp). Without an ordinal you will silently collapse real money.

**Dedup at the file level, not the row level.** `settlement-id` is the natural key and it is
immutable once a settlement closes:

1. Hash the raw bytes (SHA-256). If the hash matches a prior import → no-op, report "already
   imported".
2. If the `settlement-id` matches a prior import but the hash differs → **reject** and alert. A
   closed settlement should never change; a changed one means either Amazon re-issued it (rare) or
   someone edited the file in Excel (common, and destructive — see §6).
3. Never import "a date range." Settlement files do not overlap: a given `posted-date-time` appears
   in exactly one settlement. **Overlapping re-import of a date range is structurally impossible if
   you key on settlement-id**, which is the main reason to prefer this report over Date Range Reports.

**Line-level join to orders:** `(order-id, order-item-code)` identifies an order line.
`order-item-code` is stable across the Order rows and the later Refund rows for the same line
(verified: order `112-9710701-2605005` refund rows carry `order-item-code 108736777938361`), so it is
the key for matching a refund back to its original sale — possibly in an earlier settlement.

---

## 6. Gotchas

Every item below is something I verified in a real file unless marked `[UNVERIFIED]`.

1. **Row 2 is a summary row, not a transaction.** It has `settlement-id`, the three dates,
   `total-amount`, `currency` — and **21 empty trailing fields**. Its `transaction-type` is blank.
   *Skip it for posting, use it for the header facts.* Detect it by `transaction-type == ""`.
   There is **no preamble** before the header and **no footer total**.

2. **Ragged rows — real files contain rows with only 23 fields.** Verified: both US files have rows
   (Liquidations rows in particular) where the trailing empty `promotion-id` tab is stripped.
   Field counts observed per file: `{23: 8, 24: 267}`. **A parser that requires exactly 24 fields
   will crash on real Amazon data.** Rule: accept 23 or 24, pad to 24 with `""`; reject <23 or >24.

3. **Detail rows have blank `currency` and blank date columns 2–4.** Hoist from the summary row.
   (An AI-authored integration doc circulating publicly says the opposite. It is wrong.)

4. **Rows are grouped by transaction but are NOT sorted by date.** Verified: consecutive order
   groups run 10-26, 10-27, 10-25, 10-24, 10-29… Never rely on ordering; never use "last row" logic.
   Reserve and ServiceFee rows appear interleaved in the middle of the file, not at the end.

5. **Encoding.** All seven real files were plain **ASCII, LF line endings, no BOM**. But food-brand
   SKUs and promotion names contain accented characters and `™`/`®`, and EU marketplaces emit
   `Amazon.fr`-side product text. **Read as UTF-8; on decode failure retry as `cp1252`/latin-1 and
   flag the file.** Strip a UTF-8 BOM if present. Handle CRLF defensively (Windows browsers
   occasionally rewrite it).

6. **Never let a human open it in Excel.** Excel will: strip leading zeros, reformat `2026-03-04` as
   `3/4/2026`, turn `order-item-code 118420071559301` into `1.1842E+14`, and re-save comma-delimited.
   The importer should refuse a file whose header is comma-delimited with the same 24 names and say
   "this file was re-saved by a spreadsheet; re-download the original."

7. **`amount-type` values can contain spaces.** `Cost of Advertising`, `FBA Inventory Reimbursement`,
   `other-transaction`. Do not validate against `^[A-Za-z]+$`.

8. **Casing is inconsistent across the vocabulary and across sources.**
   `other-transaction` (lowercase, hyphenated) is a real value in *both* `transaction-type` and
   `amount-type`; Intentwise's docs render it `Other-Transaction` (title case). Sources also disagree
   on `FBAperOrderFulfillmentFee` vs `FBAPerOrderFulfillmentFee`. **Case-fold every vocabulary
   comparison**, and keep the raw string on the journal line for audit.

9. **The vocabulary is open-ended by design.** Amazon's docs explicitly say new fee types appear as
   new rows without a schema change. A seller reported the literal `transaction-type` value
   `Order_Retrocharge` (retroactive marketplace-facilitator tax adjustment) — underscore-separated,
   unlike every other value. **Rule: an unknown `(transaction-type, amount-type, amount-description)`
   triple must route to a `Suspense — Amazon Unmapped` account and raise a review task. Never drop
   it: dropping breaks the §5a identity.**

10. **`quantity-purchased` is blank on most Refund rows.** You cannot compute returned units from the
    settlement alone. Get units from the FBA Returns report, or infer from
    `Principal_refunded / unit_price`. **Do not post a COGS reversal off a missing quantity.**

11. **Shipping income is usually a wash for FBA.** `ItemPrice/Shipping +5.99` is almost always
    matched by `ItemFees/ShippingChargeback −5.99` on AFN orders — Amazon collects the shipping
    credit and keeps it. If you book the credit as revenue you must book the chargeback as expense;
    booking only one inflates or deflates gross margin.

12. **`Non-Amazon US` marketplace = Multi-Channel Fulfillment.** Order-id starts `S01-`,
    `ItemPrice/Principal` is **`0.00`**, and only an FBA fulfillment fee is charged. **These are not
    Amazon sales** — the revenue lives in Shopify. `merchant-order-id` carries the Shopify order name
    (`#SZ-10482`). Posting the fee to Amazon COGS/fulfillment while the revenue sits in Shopify is
    correct; posting a $0 Amazon sale is not. Route MCF fulfillment fees to
    `Fulfillment Fees — MCF (Shopify)`.

13. **`Liquidations` rows have a blank `marketplace-name` and blank `fulfillment-id`**, `order-id` and
    `shipment-id` both hold the same liquidation id, `merchant-order-id` sometimes holds an unrelated
    original order id, and `sku` may hold an **ASIN** (`B09N58H79F`) rather than your SKU. Do not
    assume `sku` joins to your item master on Liquidations rows.

14. **Advertising only lands here if you are billed "on account."** If Sooz's Amazon Ads account is
    charged to a credit card, ad spend **never appears** in the settlement and must be imported from
    the Ads billing invoices. If it is deducted from disbursements, it appears as
    `ServiceFee / Cost of Advertising / TransactionTotalAmount` (verified, US file, two rows in one
    settlement). **Double-counting ads is the single most common error here** — pick one source and
    assert the other is empty.

15. **`DigitalServicesFee`** appears on UK/EU rows (UK DST, etc.) and — observed — also on some
    `Amazon.com` rows for a non-US-established seller. Don't assume it is EU-only.

16. **There are no merged cells, no multi-line descriptions, no embedded tabs or quotes** in any real
    file. **Do not run this through a CSV/quote-aware reader.** Split on `\t` literally. A quote-aware
    reader will mangle SKUs containing `"` and will mis-handle the ragged rows in gotcha #2.

17. **No `Transfer` row exists** in any real file, and the payout is **not** represented as a row.
    Several vendor docs claim a `transaction-type = Transfer` row with a negative amount equal to
    `total-amount`. **If that were true the §5a sum would be zero.** It is not. `Transfer`,
    `Adjustment` and `Chargeback` are reported by secondary sources as real `transaction-type`
    values `[UNVERIFIED]` — handle them via the unknown-value rule (#9), and if a `Transfer` row
    ever does appear, verify the identity before trusting it.

18. **Pagination / size.** No pagination — one file per settlement, complete. A busy CPG settlement is
    5,000–50,000 rows and tens of MB. Stream it; do not `read()` the whole file into a DataFrame in
    a web request.

19. **There is no pending-vs-posted distinction.** Every row in a *closed* settlement is posted and
    final. Pending activity lives in the still-open settlement (Statement View), which is why §1
    says not to import from there.

20. **Rows that must be ignored for P&L** (but never dropped from the sum):
    the summary row; `Current Reserve Amount`; `Previous Reserve Amount Balance`. These three are
    balance-sheet or metadata only.

---

## 7. Accounting treatment

### 7a. Chart mapping used here

| Sooz Books category | Amazon-specific account |
|---|---|
| Bank | `Bank — Operating` |
| Channel Clearing | **`Amazon Clearing`** (asset) — every non-reserve row hits this |
| Channel Clearing | **`Amazon Reserve`** (asset) — reserve rows only |
| Gross Sales by channel | `Gross Sales — Amazon`, `Gross Sales — Amazon Liquidations` |
| Contra-Revenue | `Contra-Revenue — Amazon Promotions`, `Sales Returns & Allowances — Amazon` |
| Sales Tax Payable | `Sales Tax Payable` (see 7c — normally nets to zero for Amazon) |
| Processing Fees | `Selling Fees — Amazon` (referral commission, subscription) |
| Fulfillment Fees | `Fulfillment Fees — Amazon FBA` |
| Advertising Expense | `Advertising Expense — Amazon` |
| Inventory / COGS | `Inventory — FBA`, `COGS — Amazon`, `COGS — Inventory Shrink` |
| Deductions Receivable | `Deductions Receivable — Amazon` (open reimbursement claims) |
| AR / AP | **Not used for 3P Amazon.** `Amazon Clearing` replaces AR. AP is unused. |

### 7b. The full taxonomy — row → treatment

`AC` = Amazon Clearing. A positive `amount` debits AC; a negative `amount` credits AC. The
"other leg" column below is what the row's own amount posts against.

#### Revenue and contra-revenue

| transaction-type | amount-type | amount-description | Sign | Other leg | Classification |
|---|---|---|---|---|---|
| `Order` | `ItemPrice` | `Principal` | + | CR `Gross Sales — Amazon` | **Gross revenue** |
| `Order` | `ItemPrice` | `Shipping` | + | CR `Gross Sales — Amazon` | Gross revenue (see 7d) |
| `Order` | `ItemPrice` | `GiftWrap` | + | CR `Gross Sales — Amazon` | Gross revenue `[UNVERIFIED for food]` |
| `Order` | `Promotion` | `Principal` | − | DR `Contra-Revenue — Amazon Promotions` | **Contra-revenue** (seller-funded coupon / Subscribe & Save discount) |
| `Order` | `Promotion` | `Shipping` | − | DR `Contra-Revenue — Amazon Promotions` | **Contra-revenue** (seller-funded free shipping) |
| `Order` | `Promotion` | `TaxDiscount` | − | DR `Sales Tax Payable` (pass-through) | Tax side of the promo, **not** contra-revenue |
| `Refund` | `ItemPrice` | `Principal` | − | DR `Sales Returns & Allowances — Amazon` | **Contra-revenue** |
| `Refund` | `ItemPrice` | `Shipping` | − | DR `Sales Returns & Allowances — Amazon` | Contra-revenue |
| `Refund` | `ItemPrice` | `RestockingFee` | **+** | CR `Sales Returns & Allowances — Amazon` | Contra-revenue **reduction** — you kept part of the refund |
| `Refund` | `ItemPrice` | `Goodwill` | − | DR `Sales Returns & Allowances — Amazon` | Contra-revenue `[UNVERIFIED]` |
| `Liquidations` | `ItemPrice` | `Principal` | + | CR `Gross Sales — Amazon Liquidations` | Revenue, **separate line** — never mix into channel gross sales, the margin is catastrophic and will distort unit economics |

#### Tax (pass-through — see 7c)

| transaction-type | amount-type | amount-description | Sign | Other leg |
|---|---|---|---|---|
| `Order` / `Refund` | `ItemPrice` | `Tax` | ± | `Sales Tax Payable` |
| `Order` / `Refund` | `ItemPrice` | `ShippingTax` | ± | `Sales Tax Payable` |
| `Order` / `Refund` | `ItemWithheldTax` | `MarketplaceFacilitatorTax-Principal` | ∓ | `Sales Tax Payable` |
| `Order` / `Refund` | `ItemWithheldTax` | `MarketplaceFacilitatorTax-Shipping` | ∓ | `Sales Tax Payable` |
| `Order` / `Refund` | `ItemWithheldTax` | `MarketplaceFacilitatorVAT-Principal` / `-Shipping` | ∓ | `VAT Payable` (EU/UK only) |

#### Selling expense (referral / platform) — **below gross margin, operating expense**

| transaction-type | amount-type | amount-description | Sign | Other leg |
|---|---|---|---|---|
| `Order` | `ItemFees` | `Commission` | − | DR `Selling Fees — Amazon` (referral fee, ~8–15%; food is typically 8% under $15, 15% over) |
| `Refund` | `ItemFees` | `Commission` | **+** | CR `Selling Fees — Amazon` (referral fee returned) |
| `Refund` | `ItemFees` | `RefundCommission` | − | DR `Selling Fees — Amazon` (refund admin fee, **20% of the returned commission**) |
| `Order` | `ItemFees` | `VariableClosingFee` | − | DR `Selling Fees — Amazon` `[UNVERIFIED for food]` |
| `Order` | `ItemFees` | `DigitalServicesFee` | − | DR `Selling Fees — Amazon` |
| `ServiceFee` | `other-transaction` | `Subscription` | − | DR `Selling Fees — Amazon` (Professional plan, $39.99/mo) `[UNVERIFIED exact string — also seen as `Subscription Fee`]` |
| `ServiceFee` | `other-transaction` | `Coupon redemption fee` / `LightningDealFee` | − | DR `Selling Fees — Amazon` `[UNVERIFIED exact strings]`. **Judgement call:** these are *merchandising* costs; if Sooz wants them in trade spend, route to `Contra-Revenue — Amazon Promotions` instead — but be consistent and document the choice. Recommended: **Selling Fees**, because they are charged per redemption regardless of who funded the discount. |

#### Fulfillment expense — **below gross margin, operating expense**

| transaction-type | amount-type | amount-description | Sign | Other leg |
|---|---|---|---|---|
| `Order` | `ItemFees` | `FBAPerUnitFulfillmentFee` | − | DR `Fulfillment Fees — Amazon FBA` |
| `Order` | `ItemFees` | `FBAWeightBasedFee` / `FBAPerOrderFulfillmentFee` | − | DR `Fulfillment Fees — Amazon FBA` |
| `Order` | `ItemFees` | `ShippingChargeback` | − | DR `Fulfillment Fees — Amazon FBA` (Amazon keeping the shipping credit) |
| `Order` | `ItemFees` | `GiftwrapChargeback` | − | DR `Fulfillment Fees — Amazon FBA` `[UNVERIFIED]` |
| `Refund` | `ItemFees` | `ReturnShipping` | − | DR `Fulfillment Fees — Amazon FBA` `[UNVERIFIED]` |
| `Order` | `ItemFees` | `ShippingHB` | ± | DR `Fulfillment Fees — Amazon FBA` `[UNVERIFIED]` |
| `ServiceFee` | `other-transaction` | `StorageRenewalBilling` / `StorageFee` / `FBAStorageFee` | − | DR `Fulfillment Fees — Amazon FBA` (monthly storage). **Food/CPG note: storage spikes hard in Oct–Dec; treat as period expense, do not capitalize.** |
| `ServiceFee` | `other-transaction` | `FBALongTermStorageFee` | − | DR `Fulfillment Fees — Amazon FBA`. **Leading indicator of dead stock — flag any SKU with LTSF for a write-down review.** |
| `ServiceFee` | `other-transaction` | `FBAInboundTransportationFee` | − | **DR `Inventory — FBA`** if Sooz capitalizes freight-in (recommended for a CPG book, it is a cost of getting inventory to its selling location); else `Fulfillment Fees`. **Pick one and document it.** |
| `other-transaction` | `other-transaction` | `RemovalComplete` | − | DR `Fulfillment Fees — Amazon FBA`. Units come back to a 3PL/warehouse → also **transfer inventory** FBA → Warehouse at cost (no P&L). |
| `other-transaction` | `other-transaction` | `DisposalComplete` | − | DR `Fulfillment Fees — Amazon FBA` **plus** write off the disposed units: DR `COGS — Inventory Shrink`, CR `Inventory — FBA`. |
| `Liquidations` | `ItemFees` | `LiquidationsBrokerageFee` | − | DR `Fulfillment Fees — Amazon FBA` |

#### Advertising expense

| transaction-type | amount-type | amount-description | Sign | Other leg |
|---|---|---|---|---|
| `ServiceFee` | **`Cost of Advertising`** | `TransactionTotalAmount` | − | DR `Advertising Expense — Amazon` |

**Note the shape:** for advertising the semantics live in **`amount-type`**, not
`amount-description` — the description is the meaningless `TransactionTotalAmount`. A parser keyed
only on `amount-description` will mis-bucket every ad row. (Verified: US settlement `21871512981`,
two rows, `−427.08` and `−111.80`.)

#### Reimbursements — **other income, NOT sales**

| transaction-type | amount-type | amount-description | Sign | Other leg |
|---|---|---|---|---|
| `other-transaction` | `FBA Inventory Reimbursement` | `WAREHOUSE_LOST`, `WAREHOUSE_DAMAGE`, `MISSING_FROM_INBOUND`, `REMOVAL_ORDER_DAMAGED`, `MULTICHANNEL_ORDER_LOST/DAMAGED/LATE`, `CS_ERROR_ITEMS`, `INCORRECT_FEES_ITEMS` | + | CR `Other Income — FBA Reimbursements`, **or** CR `Deductions Receivable — Amazon` if Sooz already accrued the claim |
| `other-transaction` | `FBA Inventory Reimbursement` | `REVERSAL_REIMBURSEMENT`, `COMPENSATED_CLAWBACK` | ± | reverse of the above — Amazon found the unit; **also reverse the inventory write-off** |
| `other-transaction` | *various* | `SAFE-T Reimbursement` | + | CR `Other Income — FBA Reimbursements` `[UNVERIFIED exact string]` |

**This is the single most-often-miscoded row class.** A reimbursement is Amazon compensating Sooz for
*lost or damaged inventory*. It is **not a sale**: there is no customer, no sales tax, and no referral
fee. Booking it to `Gross Sales — Amazon` inflates channel revenue, corrupts every per-unit metric,
and — for a food brand — makes the gross margin bridge unreconcilable. Also pair it with the
inventory side: `DR COGS — Inventory Shrink / CR Inventory — FBA` for the units Amazon lost.

#### Reserve — balance sheet only, no P&L

| transaction-type | amount-type | amount-description | Sign | Entry |
|---|---|---|---|---|
| `other-transaction` | `other-transaction` | `Current Reserve Amount` | − | **DR `Amazon Reserve`, CR `Amazon Clearing`** |
| `other-transaction` | `other-transaction` | `Previous Reserve Amount Balance` | + | **DR `Amazon Clearing`, CR `Amazon Reserve`** |

After posting settlement N, `Amazon Reserve` should carry exactly `|Current Reserve Amount(N)|`.
That is an independently checkable balance — reconcile it to the next settlement's
`Previous Reserve Amount Balance` (§5b).

### 7c. Marketplace facilitator tax — why it must NOT sit in Sales Tax Payable

In every US marketplace-facilitator state (effectively all of them now), **Amazon is the legal
collector and remitter.** The settlement shows this as an exactly-offsetting pair on the *same*
order line, verified in a real US file (order `114-4918736-2898654`):

```
Order  ItemPrice        Tax                                   +6.30
Order  ItemWithheldTax  MarketplaceFacilitatorTax-Principal   -6.30
```

The first row is the tax the customer paid; the second is Amazon taking it away to remit it. **Net
effect on Sooz: zero.** Sooz never holds this money and owes no return on it.

**Rule for the parser:**
1. Post both rows to `Sales Tax Payable` (so the §5a sum still ties).
2. After posting a settlement, **assert that the Amazon-attributable movement in `Sales Tax Payable`
   is 0.00.** If it is not, the residual is genuinely Sooz-collected tax (a state without facilitator
   collection, or a `TaxDiscount` mismatch) and **that residual — and only that residual — is a real
   liability.** Raise it for review; do not silently leave it.
3. **Never accrue a sales-tax liability from the `ItemPrice/Tax` row alone.** That is the classic
   error: it makes Sooz look like it owes thousands of dollars of tax Amazon already paid.

Equivalent EU/UK pair: `MarketplaceFacilitatorVAT-Principal` / `-Shipping` against `VAT Payable`.

Two wrinkles worth knowing:
- `Promotion / TaxDiscount` (negative) is the tax adjustment on a seller-funded discount. It is a
  tax-side row, **not** contra-revenue. Verified in UK files.
- `Order_Retrocharge` rows `[UNVERIFIED in flat file]` are retroactive facilitator-tax corrections
  after a nexus change. They post `BaseTax` / `MarketplaceFacilitatorTax-*` pairs and should net to
  zero the same way.

### 7d. Explicitly: what is contra-revenue vs expense

Gross margin for Sooz is `Net Revenue − COGS`. The classification below decides whether a cost sits
above or below that line, and it is the thing most Amazon bookkeeping gets wrong.

**Above the gross-margin line — CONTRA-REVENUE (reduce Net Revenue):**
- `Promotion / Principal` and `Promotion / Shipping` — seller-funded discounts, Subscribe & Save,
  coupons. This is **trade spend** and belongs against revenue, exactly like a retail off-invoice
  allowance.
- `Refund / ItemPrice / Principal` and `Refund / ItemPrice / Shipping` — returns.
- `Refund / ItemPrice / RestockingFee` — a *credit* to contra-revenue.

**Below the gross-margin line — SELLING / PLATFORM EXPENSE:**
- `Commission`, `RefundCommission`, `VariableClosingFee`, `DigitalServicesFee`, `Subscription`.
  These are the cost of *access to the channel*, not a price concession to a customer.

**Below the gross-margin line — FULFILLMENT EXPENSE:**
- `FBAPerUnitFulfillmentFee`, `FBAWeightBasedFee`, `ShippingChargeback`, `StorageRenewalBilling`,
  `FBALongTermStorageFee`, `RemovalComplete`, `DisposalComplete`, `LiquidationsBrokerageFee`.

**Below the gross-margin line — ADVERTISING EXPENSE:**
- `ServiceFee / Cost of Advertising / TransactionTotalAmount` — and **only** this. Coupon redemption
  fees and Lightning Deal fees are *not* advertising (see the taxonomy note above).

**Not revenue or expense at all:**
- Both tax row families (pass-through), both reserve rows (balance sheet).

**Why `Shipping` income is a trap:** for AFN orders `ItemPrice/Shipping` is nearly always offset by
`ItemFees/ShippingChargeback` of the same magnitude. Book **both** (revenue and fulfillment expense)
or **neither**. Booking only the credit inflates net revenue and gross margin by the shipping amount.

---

### 7e. Fully worked example — one complete settlement

Using the synthetic fixture in §8 (settlement `22558491237`, USD, 31 detail rows).
Σ `amount` = **368.02** = `total-amount` = the deposit. ✔

**Step 1 — bucket every row** (each bucket is the sum of that class's signed `amount`):

| Bucket | Σ amount | Rows |
|---|---:|---|
| Gross Sales — Amazon (Principal + Shipping) | +230.92 | 119.96 + 104.97 + 0.00 + 5.99 |
| Gross Sales — Amazon Liquidations | +7.42 | 7.42 |
| Contra-Revenue — Amazon Promotions | −12.00 | Promotion/Principal |
| Sales Returns & Allowances — Amazon | −29.99 | Refund/ItemPrice/Principal |
| Sales Tax Payable — collected | +17.08 | 9.90 + 9.16 + 0.49 − 2.47 |
| Sales Tax Payable — withheld by Amazon | −17.08 | −9.90 − 9.16 − 0.49 + 2.47 |
| Selling Fees — Amazon (referral) | −29.23 | −16.19 − 16.64 + 4.50 − 0.90 |
| Selling Fees — Amazon (subscription) | −39.99 | Subscription |
| Fulfillment Fees — Amazon FBA | −125.12 | −23.36 − 19.05 − 5.99 − 9.45 − 62.40 − 3.24 − 1.63 |
| Advertising Expense — Amazon | −84.25 | Cost of Advertising |
| Other Income — FBA Reimbursements | +26.94 | WAREHOUSE_DAMAGE |
| Reserve released (Previous) | +612.87 | |
| Reserve withheld (Current) | −189.55 | |
| **Total** | **+368.02** | |

**Step 2 — Journal Entry 1: settlement activity, dated `settlement-end-date` 2026-03-16**

| Account | Debit | Credit |
|---|---:|---:|
| Sales Returns & Allowances — Amazon *(contra-revenue)* | 29.99 | |
| Contra-Revenue — Amazon Promotions *(contra-revenue)* | 12.00 | |
| Selling Fees — Amazon *(selling expense)* | 69.22 | |
| Fulfillment Fees — Amazon FBA *(fulfillment expense)* | 125.12 | |
| Advertising Expense — Amazon *(advertising)* | 84.25 | |
| Sales Tax Payable *(tax withheld & remitted by Amazon)* | 17.08 | |
| Amazon Reserve *(current reserve withheld)* | 189.55 | |
| **Amazon Clearing** *(= total-amount)* | **368.02** | |
| Gross Sales — Amazon | | 230.92 |
| Gross Sales — Amazon Liquidations | | 7.42 |
| Other Income — FBA Reimbursements | | 26.94 |
| Sales Tax Payable *(tax collected from customers)* | | 17.08 |
| Amazon Reserve *(prior reserve released)* | | 612.87 |
| **Totals** | **895.23** | **895.23** |

Debits 29.99 + 12.00 + 69.22 + 125.12 + 84.25 + 17.08 + 189.55 + 368.02 = **895.23**
Credits 230.92 + 7.42 + 26.94 + 17.08 + 612.87 = **895.23** ✔

Note `Sales Tax Payable` nets to **0.00** (17.08 DR vs 17.08 CR) — the §7c assertion passes.
Note `Amazon Reserve` nets to **−423.32** credit this period, leaving a **189.55 debit balance**,
which must equal the next settlement's `Previous Reserve Amount Balance`.

**Step 3 — Journal Entry 2: the deposit, dated when it clears the bank (2026-03-18 + 1–5 days)**

| Account | Debit | Credit |
|---|---:|---:|
| Bank — Operating | 368.02 | |
| Amazon Clearing | | 368.02 |
| **Totals** | **368.02** | **368.02** |

`Amazon Clearing` now returns to zero for this settlement. **That is the reconciliation:** a non-zero
per-settlement Amazon Clearing balance means either the deposit has not landed or a row was mis-posted.

**Step 4 — Journal Entry 3: inventory and COGS, dated 2026-03-16**

Driven by `sku` × `quantity-purchased`, at standard cost (`SOOZ-GRAN-12PK` $12.40/unit,
`SOOZ-BAR-24PK` $9.85/unit). Note the settlement report does **not** contain cost.

- Units shipped: 4 × 12.40 (Order A) + 3 × 9.85 (Order B) + 1 × 12.40 (MCF) + 1 × 9.85 (liquidated)
  = 49.60 + 29.55 + 12.40 + 9.85 = **101.40**
- Return restocked as sellable (1 × 9.85) = **−9.85**
- Units Amazon damaged (2 × 12.40) = **24.80** to shrink

| Account | Debit | Credit |
|---|---:|---:|
| COGS — Amazon | 91.55 | |
| COGS — Inventory Shrink (FBA lost/damaged) | 24.80 | |
| Inventory — FBA | | 116.35 |
| **Totals** | **116.35** | **116.35** |

(91.55 = 101.40 − 9.85 restocked; 116.35 = 91.55 + 24.80.)

**Resulting P&L for this settlement**

```
Gross Sales — Amazon                        230.92
Gross Sales — Amazon Liquidations             7.42
  less Contra-Revenue — Promotions          (12.00)
  less Sales Returns & Allowances           (29.99)
= Net Revenue                               196.35
  less COGS — Amazon                        (91.55)
= Gross Profit                              104.80   (53.4%)
  less Selling Fees — Amazon                (69.22)
  less Fulfillment Fees — Amazon FBA       (125.12)
  less Advertising Expense — Amazon         (84.25)
  less COGS — Inventory Shrink              (24.80)
  plus Other Income — FBA Reimbursements      26.94
= Channel Contribution                     (171.65)
```

(The fixture is deliberately small — three orders cannot absorb a month of storage, subscription and
ad spend. In a real settlement the order volume is 100× this. The point is that every number ties.)

**Assertions the importer must run before committing:**
1. `Σ amount == total-amount` — exact, to the cent.
2. `Σ debits == Σ credits` on every entry — exact.
3. Amazon-attributable net movement in `Sales Tax Payable == 0.00`; any residual raises a review task.
4. `Amazon Reserve` closing balance `== |Current Reserve Amount|`.
5. Zero rows routed to `Suspense — Amazon Unmapped`; if any, block auto-post and require review.
6. `Amazon Clearing` per-settlement balance returns to 0 once the deposit is matched.

---

## 8. Realistic sample file

**SYNTHETIC — every value invented for testing. Not real Sooz or Amazon data.**
Structure, column order, blank-column pattern, sign conventions and vocabulary are modelled directly
on the seven real settlement files cited at the top.

**Field separator is a literal TAB (U+0009), not a comma.** Save as `.txt`, UTF-8, LF line endings.
(Fenced as `csv` per the spec template; the content is TSV.) It contains 1 header row + 1 summary row
+ 31 detail rows, and it **ties exactly**: Σ `amount` = 368.02 = `total-amount`.

Deliberate test coverage: the summary row's 21 trailing empty fields; blank `currency` on detail
rows; a promoted order; an order with shipping + shipping chargeback; an MCF (`Non-Amazon US`,
`Principal = 0.00`) row; a refund with `adjustment-id`, no `quantity-purchased`, positive
`Commission` and negative `RefundCommission`; both `MarketplaceFacilitatorTax-Principal` and
`-Shipping`; `Cost of Advertising`; `Subscription`; `StorageRenewalBilling`; an
`FBA Inventory Reimbursement`; a `RemovalComplete`; a `Liquidations` pair with blank
`marketplace-name`; and both reserve rows.

```csv
settlement-id	settlement-start-date	settlement-end-date	deposit-date	total-amount	currency	transaction-type	order-id	merchant-order-id	adjustment-id	shipment-id	marketplace-name	amount-type	amount-description	amount	fulfillment-id	posted-date	posted-date-time	order-item-code	merchant-order-item-id	merchant-adjustment-item-id	sku	quantity-purchased	promotion-id
22558491237	2026-03-02 09:14:27 UTC	2026-03-16 09:14:27 UTC	2026-03-18 09:14:27 UTC	368.02	USD																		
22558491237						Order	111-2233445-6677889	111-2233445-6677889		DkR8v2Lqe	Amazon.com	ItemPrice	Principal	119.96	AFN	2026-03-04	2026-03-04 15:42:11 UTC	118420071559301			SOOZ-GRAN-12PK	4	
22558491237						Order	111-2233445-6677889	111-2233445-6677889		DkR8v2Lqe	Amazon.com	ItemPrice	Tax	9.90	AFN	2026-03-04	2026-03-04 15:42:11 UTC	118420071559301			SOOZ-GRAN-12PK	4	
22558491237						Order	111-2233445-6677889	111-2233445-6677889		DkR8v2Lqe	Amazon.com	ItemWithheldTax	MarketplaceFacilitatorTax-Principal	-9.90	AFN	2026-03-04	2026-03-04 15:42:11 UTC	118420071559301			SOOZ-GRAN-12PK	4	
22558491237						Order	111-2233445-6677889	111-2233445-6677889		DkR8v2Lqe	Amazon.com	Promotion	Principal	-12.00	AFN	2026-03-04	2026-03-04 15:42:11 UTC	118420071559301			SOOZ-GRAN-12PK	4	SOOZ-10OFF-2026Q1
22558491237						Order	111-2233445-6677889	111-2233445-6677889		DkR8v2Lqe	Amazon.com	ItemFees	Commission	-16.19	AFN	2026-03-04	2026-03-04 15:42:11 UTC	118420071559301			SOOZ-GRAN-12PK	4	
22558491237						Order	111-2233445-6677889	111-2233445-6677889		DkR8v2Lqe	Amazon.com	ItemFees	FBAPerUnitFulfillmentFee	-23.36	AFN	2026-03-04	2026-03-04 15:42:11 UTC	118420071559301			SOOZ-GRAN-12PK	4	
22558491237						Order	112-3344556-7788990	112-3344556-7788990		DkR8v9Xtb	Amazon.com	ItemPrice	Principal	104.97	AFN	2026-03-07	2026-03-07 21:03:58 UTC	118501223874411			SOOZ-BAR-24PK	3	
22558491237						Order	112-3344556-7788990	112-3344556-7788990		DkR8v9Xtb	Amazon.com	ItemPrice	Shipping	5.99	AFN	2026-03-07	2026-03-07 21:03:58 UTC	118501223874411			SOOZ-BAR-24PK	3	
22558491237						Order	112-3344556-7788990	112-3344556-7788990		DkR8v9Xtb	Amazon.com	ItemPrice	Tax	9.16	AFN	2026-03-07	2026-03-07 21:03:58 UTC	118501223874411			SOOZ-BAR-24PK	3	
22558491237						Order	112-3344556-7788990	112-3344556-7788990		DkR8v9Xtb	Amazon.com	ItemPrice	ShippingTax	0.49	AFN	2026-03-07	2026-03-07 21:03:58 UTC	118501223874411			SOOZ-BAR-24PK	3	
22558491237						Order	112-3344556-7788990	112-3344556-7788990		DkR8v9Xtb	Amazon.com	ItemWithheldTax	MarketplaceFacilitatorTax-Principal	-9.16	AFN	2026-03-07	2026-03-07 21:03:58 UTC	118501223874411			SOOZ-BAR-24PK	3	
22558491237						Order	112-3344556-7788990	112-3344556-7788990		DkR8v9Xtb	Amazon.com	ItemWithheldTax	MarketplaceFacilitatorTax-Shipping	-0.49	AFN	2026-03-07	2026-03-07 21:03:58 UTC	118501223874411			SOOZ-BAR-24PK	3	
22558491237						Order	112-3344556-7788990	112-3344556-7788990		DkR8v9Xtb	Amazon.com	ItemFees	Commission	-16.64	AFN	2026-03-07	2026-03-07 21:03:58 UTC	118501223874411			SOOZ-BAR-24PK	3	
22558491237						Order	112-3344556-7788990	112-3344556-7788990		DkR8v9Xtb	Amazon.com	ItemFees	FBAPerUnitFulfillmentFee	-19.05	AFN	2026-03-07	2026-03-07 21:03:58 UTC	118501223874411			SOOZ-BAR-24PK	3	
22558491237						Order	112-3344556-7788990	112-3344556-7788990		DkR8v9Xtb	Amazon.com	ItemFees	ShippingChargeback	-5.99	AFN	2026-03-07	2026-03-07 21:03:58 UTC	118501223874411			SOOZ-BAR-24PK	3	
22558491237						Order	S01-9988776-5544332	#SZ-10482		DkR8w1Qpm	Non-Amazon US	ItemPrice	Principal	0.00	AFN	2026-03-09	2026-03-09 18:27:40 UTC	55901733204871	SOOZ-GRAN-12PK		SOOZ-GRAN-12PK	1	
22558491237						Order	S01-9988776-5544332	#SZ-10482		DkR8w1Qpm	Non-Amazon US	ItemFees	FBAPerUnitFulfillmentFee	-9.45	AFN	2026-03-09	2026-03-09 18:27:40 UTC	55901733204871	SOOZ-GRAN-12PK		SOOZ-GRAN-12PK	1	
22558491237						Refund	111-8877665-4433221	111-8877665-4433221	amzn1:crow:7LpQ2mSvTGyBd4RhK9xJaA		Amazon.com	ItemPrice	Principal	-29.99	AFN	2026-03-11	2026-03-11 06:55:02 UTC	117904455231107		1772449283610094551	SOOZ-BAR-24PK		
22558491237						Refund	111-8877665-4433221	111-8877665-4433221	amzn1:crow:7LpQ2mSvTGyBd4RhK9xJaA		Amazon.com	ItemPrice	Tax	-2.47	AFN	2026-03-11	2026-03-11 06:55:02 UTC	117904455231107		1772449283610094551	SOOZ-BAR-24PK		
22558491237						Refund	111-8877665-4433221	111-8877665-4433221	amzn1:crow:7LpQ2mSvTGyBd4RhK9xJaA		Amazon.com	ItemWithheldTax	MarketplaceFacilitatorTax-Principal	2.47	AFN	2026-03-11	2026-03-11 06:55:02 UTC	117904455231107		1772449283610094551	SOOZ-BAR-24PK		
22558491237						Refund	111-8877665-4433221	111-8877665-4433221	amzn1:crow:7LpQ2mSvTGyBd4RhK9xJaA		Amazon.com	ItemFees	Commission	4.50	AFN	2026-03-11	2026-03-11 06:55:02 UTC	117904455231107		1772449283610094551	SOOZ-BAR-24PK		
22558491237						Refund	111-8877665-4433221	111-8877665-4433221	amzn1:crow:7LpQ2mSvTGyBd4RhK9xJaA		Amazon.com	ItemFees	RefundCommission	-0.90	AFN	2026-03-11	2026-03-11 06:55:02 UTC	117904455231107		1772449283610094551	SOOZ-BAR-24PK		
22558491237						ServiceFee						Cost of Advertising	TransactionTotalAmount	-84.25		2026-03-10	2026-03-10 13:19:46 UTC						
22558491237						ServiceFee						other-transaction	Subscription	-39.99		2026-03-02	2026-03-02 09:15:00 UTC						
22558491237						ServiceFee						other-transaction	StorageRenewalBilling	-62.40		2026-03-14	2026-03-14 02:40:11 UTC						
22558491237						other-transaction	114-7766554-3322110		amzn1:crow:R4tYu8NmQeSaZx2Cv6Bh1w			FBA Inventory Reimbursement	WAREHOUSE_DAMAGE	26.94		2026-03-12	2026-03-12 04:11:33 UTC				SOOZ-GRAN-12PK	2	
22558491237						other-transaction	26031149TQ					other-transaction	RemovalComplete	-3.24		2026-03-13	2026-03-13 17:22:05 UTC						
22558491237						Liquidations	17204518893551	111-5544332-1100998		17204518893551		ItemPrice	Principal	7.42		2026-03-15	2026-03-15 11:08:24 UTC				SOOZ-BAR-24PK	1	
22558491237						Liquidations	17204518893551	111-5544332-1100998		17204518893551		ItemFees	LiquidationsBrokerageFee	-1.63		2026-03-15	2026-03-15 11:08:24 UTC				SOOZ-BAR-24PK	1	
22558491237						other-transaction						other-transaction	Previous Reserve Amount Balance	612.87		2026-03-02	2026-03-02 09:14:31 UTC						
22558491237						other-transaction						other-transaction	Current Reserve Amount	-189.55		2026-03-16	2026-03-16 09:14:31 UTC					
```

**Note the last row deliberately has only 23 fields** (trailing tab stripped) to exercise gotcha #2.

### 8b. Second fixture — the zero-total settlement

Minimal file exercising §5c. Σ `amount` = 0.00 = `total-amount`. No bank line should be produced.

```csv
settlement-id	settlement-start-date	settlement-end-date	deposit-date	total-amount	currency	transaction-type	order-id	merchant-order-id	adjustment-id	shipment-id	marketplace-name	amount-type	amount-description	amount	fulfillment-id	posted-date	posted-date-time	order-item-code	merchant-order-item-id	merchant-adjustment-item-id	sku	quantity-purchased	promotion-id
22558491999	2026-03-16 09:14:27 UTC	2026-03-30 09:14:27 UTC	2026-04-01 09:14:27 UTC	0.00	USD																		
22558491999						Order	113-1122334-4556677	113-1122334-4556677		DkR8x4Yrn	Amazon.com	ItemPrice	Principal	59.98	AFN	2026-03-20	2026-03-20 12:02:44 UTC	119330028417751			SOOZ-GRAN-12PK	2	
22558491999						Order	113-1122334-4556677	113-1122334-4556677		DkR8x4Yrn	Amazon.com	ItemPrice	Tax	4.95	AFN	2026-03-20	2026-03-20 12:02:44 UTC	119330028417751			SOOZ-GRAN-12PK	2	
22558491999						Order	113-1122334-4556677	113-1122334-4556677		DkR8x4Yrn	Amazon.com	ItemWithheldTax	MarketplaceFacilitatorTax-Principal	-4.95	AFN	2026-03-20	2026-03-20 12:02:44 UTC	119330028417751			SOOZ-GRAN-12PK	2	
22558491999						Order	113-1122334-4556677	113-1122334-4556677		DkR8x4Yrn	Amazon.com	ItemFees	Commission	-9.00	AFN	2026-03-20	2026-03-20 12:02:44 UTC	119330028417751			SOOZ-GRAN-12PK	2	
22558491999						Order	113-1122334-4556677	113-1122334-4556677		DkR8x4Yrn	Amazon.com	ItemFees	FBAPerUnitFulfillmentFee	-11.68	AFN	2026-03-20	2026-03-20 12:02:44 UTC	119330028417751			SOOZ-GRAN-12PK	2	
22558491999						ServiceFee						other-transaction	Subscription	-39.99		2026-03-16	2026-03-16 09:15:00 UTC						
22558491999						other-transaction						other-transaction	Previous Reserve Amount Balance	189.55		2026-03-16	2026-03-16 09:14:31 UTC						
22558491999						other-transaction						other-transaction	Current Reserve Amount	-188.86		2026-03-30	2026-03-30 09:14:31 UTC					
```

Check: 59.98 + 4.95 − 4.95 − 9.00 − 11.68 − 39.99 + 189.55 − 188.86 = **0.00** ✔
Also note `Previous Reserve Amount Balance = 189.55` chains exactly from settlement `22558491237`'s
`Current Reserve Amount = −189.55` (§5b invariant).

---

## 9. Source disagreements, recorded

| Question | Source A | Source B | Resolution |
|---|---|---|---|
| Column count | Amazon SP-API docs, 7 real files, Intentwise: **24 incl. `posted-date-time`** | Some vendor summaries and the project brief: 23 | **24.** `posted-date-time` is column 18. |
| Do date/currency columns repeat on detail rows? | 7 real files: **blank on detail rows** | An AI-authored public "Amazon seller integration" skill doc: repeated on every row | **Blank.** Hoist from the summary row. |
| Is there a `Transfer` row equal to the payout? | 7 real files: **no such row**, and the sum identity forbids it | Several vendor/AI docs claim yes | **No.** If seen, verify the identity before trusting. |
| Does the deposit equal `total-amount`? | 7 real files + Celigo/DigitalAdBlog: **yes, exactly**; reserves are rows *inside* the file | Nova Analytics: "the difference between total-amount and the deposit is reserve" | **Yes, they are equal.** Nova's phrasing is loose — the reserve rows are what *bring* total-amount to the deposit. |
| `posted-date` format | 7 real files: `YYYY-MM-DD` (US) or `DD.MM.YYYY` (UK/EU) | One secondary source: `MM/DD/YY` | Try all; **never hard-code**. |
| `other-transaction` casing | Real files: lowercase hyphenated, in both `transaction-type` and `amount-type` | Intentwise: `Other-Transaction` title case | **Case-fold all comparisons.** |
| Subscription string | Webgility: `Subscription Fee` | openaccountants / skusum: `Subscription` | Accept both; match case-insensitively on `subscription`. |
| `FBAPerOrderFulfillmentFee` casing | Nova: `FBAPerOrderFulfillmentFee` | Intentwise: `FBAperOrderFulfillmentFee` | Case-fold. |

---

## Sources

- [Amazon SP-API — Settlement Reports (official; column list, tab-delimited, local currency format, deprecations)](https://developer-docs.amazon.com/sp-api/docs/report-type-values-settlement)
- [SP-API changelog — Removal of XML and Flat File Settlement Reports, Nov 11 2026](https://developer-docs.amazon.com/sp-api/changelog/update-removal-of-xml-settlement-report-and-flat-file-settlement-report-date-changed-to-november-11-2026)
- Real settlement files (7, USD/GBP/EUR): [`guysolan/thetis` — `services/amazon/supabase/functions/_shared/amazon/reports/*/v2.txt`](https://github.com/guysolan/thetis)
- V1 header (36 columns): [`caponica/AmazonMwsComplete` — `ReportSettlementFlatFile.php`](https://github.com/caponica/AmazonMwsComplete/blob/master/src/CaponicaAmazonMwsComplete/Domain/Report/ReportSettlementFlatFile.php)
- Independent V2 header map: [`xiaoguo0426/hyperf-admin-amazon` — `config/autoload/amazon_report_headers.php`](https://github.com/xiaoguo0426/hyperf-admin-amazon)
- Real-world multi-format date parsing: [`SomeUserMtl/amazon-data-grab` — `reports_util.py`](https://github.com/SomeUserMtl/amazon-data-grab)
- [`Order_Retrocharge` first-hand report + XML `MarketplaceFacilitatorTax-*` example — amzn/selling-partner-api-models issue #2345](https://github.com/amzn/selling-partner-api-models/issues/2345)
- [Webgility — Amazon Settlement Report Fee Groups and Fee Names (largest observed amount-description vocabulary)](https://helpcenter.webgility.com/en/articles/6257546-amazon-settlement-report-fee-groups-and-fee-names)
- [SkuSum — Amazon settlement fee types mapped to accounts](https://www.skusum.com/fees.html)
- [Intentwise — Amazon Settlement Report V1 to V2 Mapping Guide](https://help.intentwise.com/amazon-settlement-report-v1-to-v2-mapping-guide)
- [DigitalAdBlog — Understanding Amazon Settlement Reports Line by Line (tie-out assertion, MFT pairing)](https://digitaladblog.com/2026/08/08/understanding-amazon-settlement-reports-line-by-line/)
- [Nova Analytics — Amazon Settlement Report guide](https://novadata.io/resources/blog/amazon-settlement-report-guide)
- [A2X — Amazon settlement formats: V1 and V2 flat file](https://support.a2xaccounting.com/en/articles/1828440-amazon-settlement-formats-v1-and-v2-flat-file)
- [Openbridge — Understanding Amazon Settlement Reports](https://docs.openbridge.com/en/articles/5150091-understanding-amazon-settlement-reports)
- [Seller Forums — Help understanding 'amount-description' in All Statements Payment Report Flat File V2](https://sellercentral-europe.amazon.com/seller-forums/discussions/t/328bfeed-9007-478e-bea8-20b370db2cde)
- [Seller Forums — How to download payment reports (All Statements, Download Flat File V2)](https://sellercentral.amazon.com/seller-forums/discussions/t/6b82228c-034f-45d4-a4b1-859a6dd6f43d)

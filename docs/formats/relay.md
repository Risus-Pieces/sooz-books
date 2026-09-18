# Relay — bank statement CSV

**This is Sooz's primary intake format.** Derived from 36 real statement exports covering four Relay
accounts, January–September 2026 (110 transactions). Unlike the other documents in this folder, this one
is written from the actual files, not from vendor documentation — treat it as authoritative.

## How you get the file

Relay dashboard → the account → Statements → download CSV. Relay exports **one file per account per
month**, named `Relay YYYY-MM-01 #NNNN.csv`, where `NNNN` is the last four of the account. A
not-yet-closed month exports as `Relay (Partial) YYYY-MM-01 #NNNN.csv`.

Consequences for the importer:

- The **filename carries the account and the period**. Use it to preselect the bank account and to warn
  when the file's transactions fall outside the month in its name.
- `(Partial)` files will be re-downloaded later as a complete month. The same transactions arrive twice,
  so **row-level deduplication is not optional** — it is the normal case, every month.
- An account with no activity still exports: **a header row and nothing else**. 25 of the 36 real files
  are empty. An importer that treats zero data rows as an error will fail two thirds of the time.

## Columns

Exactly one header row, no preamble, no footer, no totals row. All 36 files share this header:

```
Date,Payee,Account #,Transaction Type,Description,Reference,Status,Amount,Currency,Balance
```

| Header | Type | Example | Meaning | Required |
|---|---|---|---|---|
| `Date` | `M/D/YYYY` | `1/5/2026`, `1/30/2026` | Transaction date. Month and day are **not zero-padded**. | yes |
| `Payee` | text | `Blue Pacific Flavors` | Counterparty. **The only reliable description field.** Occasionally empty (one internal transfer). | usually |
| `Account #` | text | `` , `1672`, `9973` | Last four of the *counterparty's* account. Empty on 104 of 110 rows; populated on transfers and some ACH. | no |
| `Transaction Type` | enum | `Spend` | One of `Spend`, `Receive`, `Spend-transfer`, `Receive-transfer`. See below. | yes |
| `Description` | text | `Unknown`, `` | **Junk.** Literally the string `Unknown` on 75 rows, empty on 35. Never use it. | no |
| `Reference` | text | `Corporate Card - 1892 (Business Card)` | The richest signal in the file. See below. | no |
| `Status` | enum | `SETTLED` | `SETTLED` or `RETURNED`. | yes |
| `Amount` | signed decimal | `-97.43`, `+13.99` | **Always carries an explicit leading `+` or `-`.** | yes |
| `Currency` | text | `USD` | USD throughout. | yes |
| `Balance` | decimal | `758.33` | Running account balance after this transaction. | yes |

### `Transaction Type`

| Value | Count | Meaning |
|---|---|---|
| `Spend` | 82 | Money out — card purchase, ACH push, wire, fee |
| `Receive` | 25 | Money in — deposit, ACH pull, refund |
| `Spend-transfer` | 1 | Money out **to another Relay account of the same company** |
| `Receive-transfer` | 2 | Money in **from another Relay account of the same company** |

The `-transfer` suffix is a gift: internal transfers are labelled at the source and must never hit the
P&L. Pair them by equal absolute amount, same date, opposite direction, different account. Relay's named
sub-accounts (`Owner's Comp`, `Operating Expenses`) appear in `Payee` on these rows.

### `Reference`

| Pattern | Meaning |
|---|---|
| `Corporate Card - 1892 (Business Card)` | Physical card purchase. Card last-four is embedded. |
| `Corporate Card - 8796 (Business Virtual Card)` | Virtual card purchase. |
| `ACH Pull` | Funds pulled **into** Relay from an external account. |
| `Transfer` / `TRANSFER` | Internal transfer between Relay accounts. |
| `Banking Fees` | Relay's own fee. |
| `SQ260126` | **Square payout.** `SQ` + `YYMMDD` of the batch. |
| `PO SOOZ-2026-001 / CO10191 - Sent By Boxuan Zhao` | ACH push with a purchase-order reference. |
| `... - Initiated By Unknown Payee` | A pull initiated by the counterparty (card network, Google). |
| `Returned received ACH transaction #NNN due to: ...` | The reason on a `RETURNED` row. |

The `Sent By <name>` and `Initiated By <name>` suffixes are metadata, not part of the memo. Strip them for
display; keep them for the audit trail.

## Signs and amounts

`Amount` is signed **from the company's point of view** and always prefixed: `-97.43` is money out,
`+13.99` is money in. This matches Sooz Books' internal convention exactly, so `amount_cents` is a direct
parse — `invert_sign` stays false and no `statement_sign` gymnastics are needed.

No thousands separators appear in the observed data, but the largest transaction is $2,000.00 and appeared
as `+2000.00`; do not assume commas never appear at higher balances. Parse with `parseMoney`, which handles
both. No parentheses-negative, no trailing-minus, no currency symbol.

## Dates

`M/D/YYYY`, not zero-padded (`1/5/2026` and `1/30/2026` both occur). No timestamps, no timezone. Parse as
a calendar date string; never route through a local-time `Date`.

**Rows are in descending date order** (newest first), and within a date, newest first. The `Balance`
column confirms it: reading bottom to top, each `Balance` equals the previous `Balance` plus `Amount`.

## Identity and deduplication

Relay provides **no stable transaction id**. There is no external id column. Dedup therefore relies on:

1. **File hash** — catches re-uploading the identical file.
2. **Row fingerprint** — `sha256(bank_account_id | date | amount_cents | normalized(payee + reference) | occurrence_index)`.
   The occurrence index disambiguates genuine same-day duplicates, which really occur here: on 1/28/2026
   there are two Target charges (`-8.19`, `-13.38`) and on 2/2/2026 three separate Amazon charges.
3. **Balance-chain validation** — the strongest check available and unique to this format. Sort ascending
   and assert `balance[n] == balance[n-1] + amount[n]` across the file. If the chain holds, the file is
   complete and internally consistent; if it breaks, rows are missing or the file was edited. Use the
   running balance to derive a deterministic occurrence index rather than relying on row order alone.

Because `(Partial)` files are supersets-in-progress of the eventual full month, the importer must expect a
high duplicate count on the second import of a month and report it as normal, not as an error.

## Gotchas

- **Empty files are normal** (25 of 36). Header only, zero data rows.
- **`Description` is the string `Unknown`.** Any importer that maps `Description` → memo produces a ledger
  where three quarters of the entries say "Unknown". Map `Payee` → memo, `Reference` → detail.
- **`RETURNED` status.** One observed: `5/15/2026 GOOGLE +10.00 RETURNED` — a received ACH that bounced
  for insufficient funds, paired with a `-10.00 SETTLED` spend the same day. Returned rows must not post
  as cash received. Either skip them and their paired original, or post both and let them net; skipping is
  cleaner, but the pair must be handled together or the balance chain will not tie.
- **Card refunds arrive as `Receive` with a card `Reference`** (`2/8/2026 Amazon +38.31`,
  `7/20/2026 Amazon +14.99`). These are expense reversals, not income. A rule keyed on
  `Transaction Type = Receive` alone will misclassify them; key on the `Corporate Card` reference.
- **Payee names are dirty.** `SP+AFF * META STORE -`, `SP NATURES FLAVORS`, `FEDEX533300619`,
  `eBay O*22-14335-69339`, `DAVESHOTCHICKEN`. Normalization must strip the `SP `/`SP+AFF * ` processor
  prefixes and trailing digit runs before matching a rule or a vendor.
- **The same merchant appears under several spellings**: `GOOGLE` / `Google`, `Meta Store` /
  `SP+AFF * META STORE -`, `FedEx` / `FEDEX533300619`. Vendor matching must be fuzzy on the normalized form.
- **Account `#9727` and `#9972` have no transactions at all** across the full nine months.

## Accounting treatment

The consequential decisions, in order of how badly getting them wrong would distort the books:

### 1. `ACH Pull` from a personal bank account is **not revenue**

`CHASE COLLEGE` and `Adv SafeBalance Banking` are consumer checking products (Chase College Checking,
Bank of America Advantage SafeBalance). Twelve pulls from them total **$5,673.46** across the period.
Add the $1,000.00 opening balance the first statement implies and the founder has put **$6,673.46**
into the business, against **$292.00** of Square revenue — a ratio of about 23 to 1. Booking these
pulls as income would overstate revenue twentyfold and turn a funded pre-launch company into a
fictitious one.

```
Dr  1010 Relay Operating            500.00
    Cr  3010 Member Contributions           500.00
```

Whether these are **contributions (equity)** or a **loan from the owner (liability)** is a decision with
tax consequences; the importer defaults to equity and flags the first one of each period for confirmation.

### 2. Square deposits are revenue, and they arrive net

`SQ260126` rows are Square payouts. Square deducts ~2.6% + $0.10 per transaction before depositing, so the
deposit is **net of processing fees**. Booking the deposit as revenue understates both revenue and expense.

```
Dr  1010 Relay Operating            161.67
Dr  5540 Payment Processing Fees      4.40
    Cr  4010 Sales — DTC/Retail             166.07
```

Until a Square settlement report is imported, the exact fee is unknown. The importer posts the deposit to
**Square Clearing** and leaves it there; the Square importer (to be built) then clears it with full gross
detail. A non-zero Square Clearing balance at month end is an exception the close checklist surfaces.

### 3. Ingredient and packaging purchases capitalize into inventory

Blue Pacific Flavors, Jedwards International, Lab Alley, AMCO, Ingredi, Puriva Nutrition, Bulk Supplements,
Kalustyan's, Nature's Flavors, Flavor Jungle, Box Nutra → **Raw Ingredients**. Brandmydispo, Online Labels,
Pak-Man Packaging, Sticker Swan → **Packaging**.

```
Dr  1300 Raw Ingredients Inventory   843.00
    Cr  1010 Relay Operating                843.00
```

**But** while Sooz is pre-launch, much of this is consumed in bench work rather than held for sale. Product
that is consumed in formulation belongs in **6310 Formulation & Bench Work**, not on the balance sheet.
The rule engine cannot decide this from the transaction alone — it routes ingredient purchases to the
review queue with both options presented, and the answer is driven by whether a production run exists.

### 4. Formulation consultants are R&D, not COGS

Andrew Firestone ($450, "Sooz Beverage Formulation Work Upfront Payment") and FIRESTONE CONSUL ($535.44)
→ **6310 Formulation & Bench Work**. Fiverr ($308.35) → design, **6210 Creative & Design** unless it is
packaging artwork tied to a SKU, in which case it capitalizes.

### 5. Everything else

| Payee pattern | Account |
|---|---|
| `SP+AFF * META STORE`, `Meta Store` | 6220 Advertising — Meta |
| `GOOGLE`, `Google` | 6221 Advertising — Google *(verify: could be Workspace, a software expense)* |
| `FedEx`, `FEDEX\d+` | 5520 Outbound Freight, or 5030 Freight-In when inbound on a PO |
| `Relay` + `Banking Fees` | 6710 Bank Service Charges |
| `Grok`, `OpenAI`, `Anthropic` | 6620 Software & Subscriptions |
| `Rice Parking`, `RICE UNIVERSITY` | 6810 Travel & Parking / review |
| `Amazon` (spend) | **ambiguous** — supplies, ingredients, or personal. Always review. |
| `Target`, `Walmart`, `Dollar Tree`, `Michaels`, `DAVESHOTCHICKEN` | **ambiguous** — always review. |

`Amazon` is the single most common payee (37 rows) and is **never** auto-categorizable: the same merchant
covers lab supplies, packaging, office goods and personal purchases. A rule that assigns Amazon to one
account is worse than no rule. These go to the review queue with an AI suggestion and no default.

## Worked example — one day, fully posted

`1/26/2026`, account #9726, five rows:

| Payee | Type | Amount | Reference |
|---|---|---|---|
| Square Inc | Receive | +161.67 | SQ260126 |
| Square Inc | Receive | +3.25 | SQ260126 |
| Square Inc | Receive | +0.82 | SQ260126 |
| CHASE COLLEGE | Receive | +9.00 | ACH Pull |
| Amazon | Spend | −8.99 | Corporate Card - 1892 |
| Amazon | Spend | −29.69 | Corporate Card - 1892 |

```
Dr  1010 Relay Operating              165.74     (three Square deposits)
    Cr  1250 Square Clearing                 165.74

Dr  1010 Relay Operating                9.00
    Cr  3010 Member Contributions              9.00

Dr  6910 Uncategorized — Review        38.68     (two Amazon charges, pending review)
    Cr  1010 Relay Operating                  38.68
```

Net change to `1010`: +165.74 + 9.00 − 38.68 = **+136.06**. The file's `Balance` column moves from
`763.76` (after the 1/23 transaction) to `899.82` — a change of `+136.06`. The balance chain ties, which
is the importer's own proof that it parsed the day correctly.

## Sample fixture

Synthetic, shape-identical to the real export, for parser tests:

```csv
Date,Payee,Account #,Transaction Type,Description,Reference,Status,Amount,Currency,Balance
3/2/2026,Relay,,Spend,Unknown,"Banking Fees",SETTLED,-8.00,USD,1204.55
3/1/2026,Square Inc,,Receive,,"SQ260301",SETTLED,+212.40,USD,1212.55
2/28/2026,Blue Pacific Flavors,,Spend,,"PO SOOZ-2026-004 / CO10192 - Sent By Boxuan Zhao",SETTLED,-1043.00,USD,1000.15
2/27/2026,GOOGLE,,Receive,,"Returned received ACH transaction #417940999 due to: Account has insufficient funds - Initiated By Unknown Payee",RETURNED,+10.00,USD,2043.15
2/27/2026,GOOGLE,,Spend,Unknown,"GOOGLE  |  PURCHASE |  GG4DR9NAQMW4 - Initiated By Unknown Payee",SETTLED,-10.00,USD,2043.15
2/26/2026,Amazon,,Receive,,"Corporate Card - 1892 (Business Card)",SETTLED,+14.99,USD,2053.15
2/25/2026,Amazon,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-14.99,USD,2038.16
2/24/2026,Target,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-8.19,USD,2053.15
2/24/2026,Target,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-13.38,USD,2061.34
2/20/2026,Operating Expenses,9973,Receive-transfer,,"Transfer",SETTLED,+50.00,USD,2074.72
2/18/2026,Adv SafeBalance Banking,,Receive,,"ACH Pull",SETTLED,+1000.00,USD,2024.72
2/15/2026,SP+AFF * META STORE -,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-53.31,USD,1024.72
2/12/2026,FEDEX533300619,,Spend,Unknown,"Corporate Card - 8796 (Business Virtual Card)",SETTLED,-4.50,USD,1078.03
2/10/2026,Jedwards International Inc.,,Spend,,"SO 0480099 / PO SOOZ-2026-005 / Sooz Beverage LLC - Sent By Boxuan Zhao",SETTLED,-254.35,USD,1082.53
2/5/2026,Andrew Firestone,,Spend,,"Sooz Beverage Formulation Work - Sent By Boxuan Zhao",SETTLED,-450.00,USD,1336.88
```

The balance chain in this fixture ties from the bottom row upward, so it doubles as a test of the
balance-chain validator. The `RETURNED` row is deliberately paired with its `SETTLED` original on the
same date to exercise that path.

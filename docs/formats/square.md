# Square — settlement, transaction and item exports

**Square is Sooz Beverage LLC's only revenue channel today.** Every dollar of recognised sales in the
first nine months of 2026 arrived as a Square payout into Relay #9726. There are five of them, worth
**$272.00** in total, and they are the entire top line of the company.

> ⚠️ **Read this first.** Unlike [`relay.md`](./relay.md), which was written from 36 real exports, **no
> real Square file has been seen yet.** This document is assembled from Square's own published
> documentation, from the Square Dashboard's own report vocabulary, and from what the Relay statements
> prove about the bank side. Every factual claim below carries a verification mark:
>
> | Mark | Meaning |
> |---|---|
> | ✅ | **Verified** against Square's own documentation or against the real Relay files. The source is named. |
> | ⚠️ | **Corroborated** by two or more independent third-party sources (accounting-integration vendors, reconciliation guides). Consistent, but not Square's word. |
> | ❓ | **Inferred.** A reasonable construction from the verified facts. Treat as a hypothesis the first real export will confirm or kill. |
>
> `src/lib/importers/square.ts` is written against this document. **It must not be trusted with the
> books until a real Square settlement export has been run through it** and the checklist in §11 passes.

---

## 1. What the bank already proves

These are the only hard facts about Square at Sooz, and they come from the real Relay statements, not
from Square. ✅ (`data/statements/relay/`, account #9726)

| Relay date | Payee | Reference | Amount |
|---|---|---|---|
| 1/26/2026 | Square Inc | `SQ260126` | `+161.67` |
| 1/26/2026 | Square Inc | `SQ260126` | `+3.25` |
| 1/26/2026 | Square Inc | `SQ260126` | `+0.82` |
| 2/2/2026 | Square Inc | `SQ260202` | `+67.70` |
| 2/11/2026 | Square Inc | `SQ260211` | `+10.41` |
| 2/17/2026 | Square Inc | `SQ260217` | `+14.34` |
| 8/31/2026 | Square Inc | `SQ260831` | `+13.81` |

Seven bank rows, **five** payouts, `$272.00`.

Two further `Square Inc` rows exist and are **not payouts**: ✅

| Relay date | Payee | Reference | Amount |
|---|---|---|---|
| 1/20/2026 | Square Inc | `ACCTVERIFY - Initiated By Unknown Payee` | `−0.01` |
| 1/20/2026 | Square Inc | `ACCTVERIFY` | `+0.01` |

That is Square's **micro-deposit bank-account verification** when the Relay account was first linked, six
days before the first real payout. The pair nets to zero and is neither revenue nor an expense. It is the
reason the reference code — not the payee — is what identifies a Square payout: a rule keyed on
`Payee = Square Inc` would book a penny of phantom revenue and a penny of phantom expense on the day the
account was opened. See §9.

Five things follow, and the importer is built on them:

1. **The reference is `SQ` + `YYMMDD`.** ✅ Seven of seven rows. This is the join key between a Square
   settlement and the Relay deposit that clears it.
2. **The code equals the Relay row's own date in all seven rows.** ✅ So the code is the *deposit* date
   — the day the ACH credit posts — not necessarily the day Square closed the batch. Square's default
   close of day is **5 PM PT / 8 PM ET**, funds arrive **the next business day**, and **no transfers are
   sent on Saturdays**. ✅ ([Square, *Set up and edit transfer
   options*](https://squareup.com/help/us/en/article/3807-deposit-options-with-square);
   [Square, *Customize your close of day*](https://squareup.com/help/us/en/article/5439-customize-your-close-of-day))
   So a settlement's own date is typically **one business day before** the code on its deposit. The
   observed dates corroborate it: 1/26, 2/2 and 8/31 are Mondays, 2/11 is a Wednesday, and 2/17 is the
   Tuesday after Presidents' Day (Monday 2/16/2026) — exactly the pattern of weekend and holiday batches
   landing on the next business day.
3. **One payout can arrive as several deposits.** ✅ On 1/26/2026 three separate Relay rows all carry
   `SQ260126`: `+161.67`, `+3.25`, `+0.82`, totalling `165.74`. Matching a payout to *one* bank row would
   have found `161.67` and left `4.07` stranded in clearing forever. §8 is entirely about this.
4. **The deposit is net.** ✅ Square deducts its processing fee before transferring. `$161.67` in the bank
   is not `$161.67` of revenue; it is gross sales less fees, and the gross number exists only inside
   Square.
5. **Sooz's Square volume is tiny and lumpy.** ✅ `$0.82` is a real payout. Any tolerance, rounding or
   "close enough" rule in this importer is proportionally enormous. Everything ties to the cent.

---

## 2. How you get the file

Square's report vocabulary has been renamed twice (*Deposits* → *Transfers* → *Balance/Payouts*), and
help articles, the Dashboard and the API each use a different word for the same object. The three files
below are the ones that matter, under whatever name the Dashboard is currently using.

### 2a. The settlement file — *Transfers report* / *Reconciliation report* (the primary file)

This is the file this importer is built against. It is the only Square export whose totals reconcile to
the bank.

- **Transfers report** ✅ — Square Dashboard → **Banking** → **View all transfers** → select a date range
  → **Export** → "download transaction details as a CSV file". The transfer view shows the transfer
  mechanism, the **last three digits of the receiving bank account**, the individual card payments
  included in the transfer, and trace details.
  ([Square, *Match transfers to sales*](https://squareup.com/help/us/en/article/3813-match-deposits-to-sales))
- **Reconciliation report** ✅ — `app.squareup.com/dashboard/sales/reports/reconciliation`. Square
  describes it as helping you "understand money movement from payments to transfers", covering "sales,
  payments, and payouts data", explicitly for "sharing with bookkeepers and accountants". A CSV download
  icon sits in the upper right.
  ([Square Product Updates, *Reconciliation Report CSV export now available*](https://community.squareup.com/t5/Product-Updates/Reconciliation-Report-CSV-export-now-available/ba-p/824643))
- **Generic report export path** ✅ — Dashboard → **Reports** → pick the report → set filters → the
  **export icon**. The **gear icon** offers *Export only selected columns* or *Export all columns in your
  view*. **Always choose "all columns in your view"** — a column-subset export silently drops the fee or
  tax column and the identity in §6 then cannot be checked. Cash-drawer reports and the Transaction
  status pages cannot be exported at all.
  ([Square, *Print, export, or email your reports*](https://squareup.com/help/us/en/article/8362-print-export-or-email-your-reports))

**Export one date range that fully contains whole payouts.** ❓ A range that bisects a payout produces a
settlement that cannot tie, and §6 will (correctly) reject it.

### 2b. The Transactions CSV (per-payment detail — *not* what this importer reads)

Dashboard → **Sales** → **Transactions** → **Export** → **Transaction CSV**. ⚠️ Three variants are
offered: **Transactions**, **Transaction Details** and **Transactions Items**.

This file is one row per payment and is the right source for *sales analysis*. It is the **wrong** source
for the ledger, because it is organised by sale, not by settlement: it cannot tell you which payments
went into which bank deposit without the `Deposit ID` column, and it carries no payout total to assert
against. `detectSquareSettlements()` **recognises it and rejects it with a remedy** rather than parsing
it into a wrong answer.

### 2c. Items / Sales summary (never parsed for the ledger)

- **Item Sales / Items CSV** ⚠️ — `Item Name, Category, Quantity Sold, Gross Sales, Discounts, Net Sales,
  Cost of Goods Sold`. Useful for unit economics and for a future COGS-by-SKU posting; it contains no
  cash and no fees.
- **Sales Summary** ⚠️ — `Report Date, Total Gross Sales, Total Discounts, Total Net Sales, Total Tax,
  Total Tips, Total Fees`. A control total for a period, nothing more. Square's own summary page is the
  right place to sanity-check a month, and third-party bookkeeping guides route clients to it for exactly
  that. ([Heard, *How to download Square Sales Summary Report*](https://support.joinheard.com/hc/en-us/articles/28465856207639-How-to-download-Square-Sales-Summary-Report))

### 2d. The API, when the CSV stops being enough

The **Payouts API** is the authoritative, versioned form of the settlement file and should replace the
CSV as soon as the OAuth work is done. ✅
([Square, *PayoutEntry*](https://developer.squareup.com/reference/square/objects/PayoutEntry))

| Field | Type | Meaning |
|---|---|---|
| `id` | string, required | Unique id for the payout **entry** |
| `payout_id` | string, required | The payout this entry belongs to — **the settlement container key** |
| `effective_at` | RFC 3339 timestamp | When the entry hit the balance |
| `type` | `ActivityType` | What kind of money movement it is (§3) |
| `gross_amount_money` | Money | Total transaction amount |
| `fee_amount_money` | Money | "The amount of Square fees associated with this payout entry" |
| `net_amount_money` | Money | "The net proceeds from this transaction after any fees" |

plus ~20 type-specific detail objects. **The API gives a stable per-entry id and a stable payout id; the
CSV does not reliably give either** (§5). That alone is reason to migrate.

---

## 3. `ActivityType` — the complete settlement taxonomy

✅ Verbatim from Square's `ActivityType` enum
([Square, *ActivityType*](https://developer.squareup.com/reference/square/enums/ActivityType)). This is
the authoritative list of everything that can move the Square balance, and therefore everything that can
appear in a settlement. **58 values.** A CSV export renders these as human labels rather than enum
tokens ❓, but the taxonomy is the same and this table is what an unknown label must be mapped against.

| `ActivityType` | Square's description | Treatment (§7) |
|---|---|---|
| `CHARGE` | A credit card payment capture | Gross sales, tax, tip |
| `REFUND` | A refund for an existing card payment | Returns & Allowances |
| `FEE` | The cost plus adjustment fee | Payment Processing Fees |
| `PROCESSING_FEE` | The processing fee for a payment (separate entry in Gross Settlement) | Payment Processing Fees |
| `PROCESSING_FEE_REFUND` | The processing fee for a payment refund in Gross Settlement | Credit Payment Processing Fees |
| `UNDO_PROCESSING_FEE_REFUND` | Undoing a processing fee refund in Gross Settlement | Reverse the above |
| `TAX_ON_FEE` | The tax paid on fee amounts | Payment Processing Fees |
| `ADJUSTMENT` | A manual adjustment applied to the seller's account by Square | **Ask My Accountant — never auto-post** |
| `OTHER_ADJUSTMENT` | Any other type of adjustment that doesn't fall under existing types | **Ask My Accountant** |
| `OTHER` | Any other type that doesn't belong in the rest of the types | **Ask My Accountant** |
| `DISPUTE` | The balance change due to a dispute event | Returns & Allowances, or Deductions Receivable if contesting |
| `OPEN_DISPUTE` | The balance change for a chargeback that's been filed | Deductions Receivable |
| `HOLD_ADJUSTMENT` | An adjustment made by Square related to holding a payment | Clearing ⇄ Ask My Accountant; no P&L |
| `RELEASE_ADJUSTMENT` | An adjustment made by Square related to releasing a payment | Reverses the hold |
| `RESERVE_HOLD` | Fees paid for a funding risk reserve | Other Receivables; **never** an expense |
| `RESERVE_RELEASE` | Fees released from a risk reserve | Clears Other Receivables |
| `RETURNED_PAYOUT` | Entry created when Square receives a response indicating settlement failure | **The bank deposit will never arrive.** Reverse the payout expectation |
| `DEPOSIT_FEE` | A fee assessed because of a deposit, such as an instant deposit | Bank & Merchant Fees (1.95% on instant transfers ✅) |
| `DEPOSIT_FEE_REVERSED` | Square returned a fee previously assessed due to a deposit | Credit the above |
| `SUBSCRIPTION_FEE` | A fee charged for subscription to a Square product | **Software & SaaS — not a processing fee** |
| `SUBSCRIPTION_FEE_REFUND` / `SUBSCRIPTION_FEE_PAID_REFUND` | Refund of a Square product subscription fee | Credit Software & SaaS |
| `THIRD_PARTY_FEE` / `THIRD_PARTY_FEE_REFUND` | Fees collected by / refunded from a third-party platform | Review; usually Software & SaaS |
| `APP_FEE_REVENUE` / `APP_FEE_REFUND` | Revenue from / refund of an application fee on a payment | Out of scope; review |
| `PAID_SERVICE_FEE` / `PAID_SERVICE_FEE_REFUND` | A fee paid to / refunded to a third-party seller | Review |
| `GIFT_CARD_LOAD_FEE` / `_REFUND` / `UNDO_GIFT_CARD_LOAD_FEE_REFUND` | Fee on gift card sale or reload | Payment Processing Fees |
| `GIFT_CARD_POOL_TRANSFER` / `_REVERSED` | Gift card funds to/from a central pool account (franchises) | Not applicable to Sooz; review |
| `ESCHEATMENT` | An escheatment entry for remittance | **Ask My Accountant** — unclaimed-property law |
| `FREE_PROCESSING` | A credit for free payments processing in various business scenarios | Credit Payment Processing Fees |
| `REDEMPTION_CODE` | Repayment for a redemption code | Review |
| `MONEY_TRANSFER` / `MONEY_TRANSFER_REVERSAL` | The balance change from a money transfer / its reversal | Clearing ⇄ bank; no P&L |
| `PAYOUT` | The balance change due to a money transfer (never returned by Payouts API) | **The control row — never posted (§7)** |
| `INITIAL_BALANCE_CHANGE` | An external change to a seller's balance that causes creation of other activity types | Review |
| `AUTOMATIC_SAVINGS` / `_REVERSED` | Transfer between the processing balance and the Square Savings account | Bank ⇄ Bank; no P&L |
| `BALANCE_FOLDERS_TRANSFER` / `_REVERSED` | Transfer of funds to/from a banking folder | Bank ⇄ Bank; no P&L |
| `AUTOMATIC_BITCOIN_CONVERSIONS` / `_REVERSED` | Withheld amounts converted into bitcoin via Cash App | **Ask My Accountant** — an asset purchase, not an expense |
| `SQUARE_CAPITAL_PAYMENT` / `SQUARE_CAPITAL_REVERSED_PAYMENT` | A capital merchant cash advance assessment / refund | **Loan repayment, not an expense.** Ask My Accountant |
| `CREDIT_CARD_REPAYMENT` / `_REVERSED` | Repayment toward the Square credit card balance | Liability repayment; never an expense |
| `PERCENTAGE_PROCESSING_ENROLLMENT` / `_DEACTIVATION` / `_REPAYMENT` / `_REPAYMENT_REVERSED` | Negative-balance instalment machinery after a dispute | **Ask My Accountant** |
| `LOCAL_OFFERS_CASHBACK` / `LOCAL_OFFERS_FEE` | Square Local Offers cashback to a customer / commission fee to Square | Coupons & Promotional Discounts / Marketing |
| `SQUARE_PAYROLL_TRANSFER` / `_REVERSED` | Payroll payment to a team member's bank account | Payroll; not applicable to Sooz today |

**The rule this table exists to enforce: an unrecognised activity type is never dropped and never
guessed.** It posts to **7900 Ask My Accountant** with its label preserved, and the settlement still
ties. A dropped row breaks the payout total, which is the only proof the parse was complete.

---

## 4. Columns

### 4a. The settlement file — the canonical column set

❓ **This is the inferred contract.** Square's money-column vocabulary is stable and consistent across
its Transactions CSV, its settlement detail screen and its summary reports ⚠️, and the parser selects by
**header name, case- and punctuation-insensitively, through an alias table** — never by position. It
therefore survives the column-order and spelling variation that is guaranteed to exist between Dashboard
versions and locales.

| Canonical header | Aliases accepted | Type | Role |
|---|---|---|---|
| `Settlement Date` | `Date`, `Payout Date`, `Transfer Date`, `Deposit Date` | `YYYY-MM-DD` | **Required.** Groups rows into settlements |
| `Settlement ID` | `Payout ID`, `Transfer ID`, `Deposit ID` | string | Optional. When present it is the container key and the dedup key (§5) |
| `Settlement Type` | `Type`, `Activity Type`, `Transfer Type` | string | Optional. `ActivityType` label (§3) |
| `Settlement Description` | `Description`, `Details` | string | Optional. Memo |
| `Gross Sales` | `Gross Amount`, `Gross` | money | Revenue before anything is taken off |
| `Returns` | `Refunds`, `Refunds Issued` | money, **negative** | Full refunds |
| `Partial Refunds` | `Partial Refund` | money, **negative** | Partial refunds |
| `Discounts & Comps` | `Discounts`, `Discounts And Comps`, `Comps` | money, **negative** | Discounts and comps given at the register |
| `Service Charges` | `Service Charge`, `Surcharges`, `Auto Gratuity` | money | Delivery/service fees charged to the customer |
| `Gift Card Sales` | `Gift Card Sale`, `Gift Cards Sold` | money | Cash in, **not revenue** — a liability |
| `Net Sales` | `Net Sale` | money | **Derived. Read for the identity check, never posted** (§6) |
| `Tax` | `Taxes`, `Sales Tax`, `Tax Collected` | money | Sales tax collected from the customer |
| `Tip` | `Tips`, `Tips Collected` | money | Tips collected |
| `Total Collected` | `Total`, `Total Money Collected` | money | **Derived. Read for the identity check, never posted** |
| `Fees` | `Fee`, `Square Fees`, `Processing Fees` | money, **negative** | Square's processing fee |
| `Net Total` | `Net`, `Net Amount`, `Total Transferred`, `Transfer Total`, `Payout Amount` | money | **Required.** What lands in the bank |
| `Currency` | `Currency Code` | ISO-4217 | Optional; defaults to `USD` |

**Hard-fail if `Settlement Date` (or an alias) and `Net Total` (or an alias) are absent.** Everything
else is optional; an absent component column contributes zero and is reported in the preview as absent,
not as zero-by-accident.

**Unknown money columns are kept, not dropped.** A header the alias table does not know, whose cells
parse as money, becomes an `other` component routed to **7900 Ask My Accountant**. That is what keeps the
identity in §6 true when Square adds a column, which it does.

### 4b. The Transactions CSV — for reference and for rejection

⚠️ Corroborated: the export carries **52 columns**. The leading eleven are
`Date, Time, Time Zone, Gross Sales, Discounts, Net Sales, Tax, Tip, Partial Refunds, Total Collected,
Fees`, followed by `Net Total`, and the file also carries `Transaction ID`, `Payment ID`, `Event Type`,
`Transaction Status`, `Card Brand`, `PAN Suffix` (the card's last four), `Card Entry Methods`,
`Device Name`, `Staff Name`, `Location`, `Customer ID`, `Source`, and the deposit-linking columns
`Deposit ID` / `Deposit Date`.
([TrestleFinance, *Square Transactions CSV to QuickBooks Online*](https://trestlefinance.com/guides/square-transactions-csv-quickbooks);
[TrestleFinance, *Fix "Wrong Square CSV Export Format"*](https://trestlefinance.com/guides/square-csv-export-wrong-format-quickbooks-fix))

**Per-payment rows are not by themselves the problem — ungrouped ones are.** The parser sums a
settlement's rows, so a transactions export that carries `Deposit ID` is perfectly usable: it groups on
that id and the payout identity is checkable again. A transactions export *without* any settlement,
payout, transfer or deposit id has no payout total to assert against, and no assertion means no trust.
So the detector rejects on `Transaction ID` + `Payment ID` **and the absence of a grouping id**, with:

> *This is the Square **Transactions** CSV — one row per payment, with no column saying which payout
> each payment belongs to, so no payout total can be checked against the bank. Export the Transfers
> report (Banking → View all transfers → Export) or the Reconciliation report. A transactions export
> that does carry `Deposit ID` is accepted and grouped on it.*

### 4c. Formats

| | Value | Mark |
|---|---|---|
| Date | `YYYY-MM-DD` (`2026-01-26`) | ⚠️ |
| Time | `HH:MM:SS` (`14:05:48`), in a separate column | ⚠️ |
| Time zone | Named IANA zone in its own column (`America/Chicago`) | ⚠️ |
| Money | `$` prefixed, thousands-separated, negatives as `-$0.33` | ⚠️ |
| Encoding | UTF-8; a BOM is likely on any file that has been opened in Excel | ❓ |
| Delimiter | comma | ⚠️ |

`parseMoney` already absorbs `$`, thousands separators, `(123.45)`, `123.45-` and a leading `+`, so the
money format costs the importer nothing. Dates go through `parseDateInput`, which reads `YYYY-MM-DD`
natively, and **a timestamp column is truncated to its calendar date** — Square timestamps are in the
location's time zone and a date is all the ledger ever wants.

---

## 5. Identity and deduplication

| Layer | Key |
|---|---|
| **0. File** | `sha256(raw bytes)` — `fileHash()` in `@/lib/banking/fingerprint` |
| **1. Container (settlement)** | `x:<Settlement ID>` when the file carries one ✅ for the API, ❓ for the CSV; otherwise `sha256('square' ␟ currency ␟ settlementDate ␟ netTotalCents)` |
| **2. Row (component line)** | `sha256(settlementKey ␟ component ␟ amountCents ␟ ordinal)` |

`␟` is `\x1f`, so a value containing the delimiter cannot forge a collision — the same rule the other
five importers use (`docs/formats/README.md` §3.3).

**The idempotency container is the payout**, exactly as it is for Shopify and Amazon
(`README.md` §3.4). A settled payout is immutable: its component set never changes once the money has
moved. That collapses re-import handling to *import the whole settlement or skip it* and removes the
occurrence-index machinery the bank importer needs. Re-importing an overlapping date range is therefore
free and silent, which is the normal way a bookkeeper catches up.

**Never in a fingerprint:** the filename, the row index, the import timestamp, a running balance, or a
`Settlement Type` label (Square renames these between Dashboard versions).

**The container-changed rule applies here too** (`README.md` §3.1): if a settlement id matches a prior
import but the component amounts differ, **reject and alert**. A closed payout should never change;
a changed one means Square reissued it (rare) or someone opened the CSV in Excel (common, and
destructive).

---

## 6. The identity — `assertSettlementBalances`

**Nothing posts until a settlement ties.** This is the assertion that makes the Square importer honest,
and it is the direct analogue of Shopify's payout tie-out and Amazon's `Σ amount == total-amount`.

The convention: **money-out components are stated negative.** ⚠️ Corroborated — Square's Transactions
CSV stores fees as negative (`-$0.33`) and refunds as negative gross sales, so that
`Net = Gross + Fees`. Everything below is a plain sum; nothing is subtracted.

```
(A)  Net Sales        =  Gross Sales + Returns + Discounts & Comps + Service Charges
(B)  Total Collected  =  Net Sales + Gift Card Sales + Tax + Tip + Partial Refunds
(C)  Net Total        =  Total Collected + Fees
(D)  Σ Net Total over the settlement's rows  ==  the amount that reaches the bank
```

`assertSettlementBalances(settlement)` runs (A), (B) and (C) and returns an assertion per identity with
`expected`, `actual` and `difference` in **integer cents, tolerance zero**. `(A)` and `(B)` are `warn`
severity, because a file that omits `Net Sales` or `Total Collected` simply cannot run them. **`(C)` is
`fatal`** — it is the one identity that decides how much money the payout delivers, and it is checkable
whenever the component columns exist at all.

Identity `(D)` is not an assertion inside the file; it is §8, the bank match.

### The diagnosis, not just the failure

A failing settlement is rejected **with a diagnosis**, because the single most likely reason a real
Square export fails to tie is that this document guessed the sign convention wrong:

| `diagnosis` | Meaning | What to do |
|---|---|---|
| `ties` | Every checkable identity holds | Proceed |
| `ties_if_outflows_negated` | The identity fails as stated but holds exactly when `Returns`, `Discounts & Comps`, `Partial Refunds` and `Fees` are treated as outflows | **The file states outflows positive.** Re-parse with `outflowsArePositive: true`. Then fix §4a in this document. |
| `ties_without_unmapped` | The identity holds exactly when the unrecognised money columns (§4a) are left out | Those columns are derived or duplicated, not components. Add them to the alias table as derived columns. |
| `off_by` | Neither reading ties | A dropped column, a bisected payout, or a genuinely broken file. Quarantine it. |

**Never plug the difference.** A tolerated two cents today is an unexplained two thousand dollars once
the same bug has run across a co-packer-scale year — and on a `$0.82` payout, two cents is 2.4% of the
transaction.

### A dropped row is a failure, not a loss

Because this importer asserts a control total, a row lost to an unreadable date or an unreadable amount
is proof the parse is wrong, and the preview refuses the whole file
(`README.md` §1.3 rule 2). A row carrying nothing but zeroes is different: nothing was lost, so it is
reported and skipped without blocking. The two are separated by `SQUARE_BLOCKING_SKIP_CODES`.

---

## 7. Accounting treatment

### 7a. The rule

> **A Square settlement posts full gross detail against 1150 Square Clearing. The Relay deposit clears
> it to zero. The bank file never creates revenue.**

This is `README.md` §4.1 applied to Square, and it is the reason `relay.md` §2 sends `SQ`-referenced
deposits to clearing and stops. Booking `+161.67` as revenue understates both the top line and the
expense line, records no sales-tax liability, and double-counts the moment this importer runs.

### 7b. Component → account

| Component | Account | Side |
|---|---|---|
| `Net Total` (what reaches the bank) | **1150 Square Clearing** | Dr |
| `Gross Sales` | **4015 Direct & Market Sales (Square)** | Cr |
| `Service Charges` | **4090 Other Sales Income** | Cr |
| `Tip` | **4090 Other Sales Income** — see 7c | Cr |
| `Gift Card Sales` | **2220 Gift Card & Store Credit Liability** | Cr |
| `Tax` | **2200 Sales Tax Payable** | Cr |
| `Returns`, `Partial Refunds` | **4585 Returns & Allowances** | Dr |
| `Discounts & Comps` | **4575 Coupons & Promotional Discounts** | Dr |
| `Fees` | **5540 Payment Processing Fees** | Dr |
| `Net Sales`, `Total Collected` | *(derived — never posted)* | — |
| anything unrecognised | **7900 Ask My Accountant** | either |
| the Relay deposit, from the bank side | **1011 Relay Operating** Dr / **1150 Square Clearing** Cr | |

Because outflow components are stated negative, the entry balances by construction:
`Σ Dr = Net Total + |Fees| + |Returns| + |Partial Refunds| + |Discounts|` and
`Σ Cr = Gross Sales + Service Charges + Gift Card Sales + Tax + Tip`, and substituting (C) into (B) makes
the two equal. The importer asserts it anyway, per entry, before returning a draft.

### 7c. Three decisions worth stating out loud

1. **Tips go to 4090 Other Sales Income, not to a liability.** Sooz has no employees and no tipped staff;
   a tip taken at a market stall is the founder's own receipt and is income to the LLC. **The moment Sooz
   has a tipped team member this must become a `Tips Payable` liability** — the chart does not carry one
   today, and adding it is the trigger, not an afterthought.
2. **Gift card sales are a liability, not revenue** (2220), recognised only on redemption. Sooz has not
   sold one yet; the column is mapped because the day it appears is the day someone would otherwise book
   it as sales.
3. **Square's *subscription* fees are not *processing* fees.** `SUBSCRIPTION_FEE` is Square's own
   software billing and belongs in **6610 Software & SaaS Subscriptions**. Merging it into 5540 corrupts
   the contribution margin, which is the one number a pre-launch CPG brand is actually managing. The same
   distinction Shopify's `billing_debit` forces (`shopify.md` §7f).

### 7d. Worked example — the real `SQ260126` payout

The three Relay deposits on 1/26/2026 total `165.74`. A settlement that produced them, at Square's
published US card-present rate, decomposes like this (component numbers ❓ — the bank total is ✅):

| Component | Amount |
|---|---|
| Gross Sales | `+162.00` |
| Discounts & Comps | `−4.00` |
| *Net Sales (derived)* | *`158.00`* |
| Tax | `+12.68` |
| *Total Collected (derived)* | *`170.68`* |
| Fees | `−4.94` |
| **Net Total** | **`165.74`** |

The fee is Square's published US card-present rate on five transactions —
`2.6% × 170.68 = 4.44`, plus `5 × $0.10` — which is why `$170.68` collected becomes `$165.74`
deposited. These are the numbers in `square-settlements.csv`.

```
Dr  1150 Square Clearing                   165.74
Dr  4575 Coupons & Promotional Discounts     4.00
Dr  5540 Payment Processing Fees             4.94
    Cr  4015 Direct & Market Sales (Square)        162.00
    Cr  2200 Sales Tax Payable                      12.68
                                           ─────────────────
                                            174.68   174.68
```

Then the bank side, from the Relay import — **three rows, one credit each, same clearing account**:

```
Dr  1011 Relay Operating   161.67  |  3.25  |  0.82
    Cr  1150 Square Clearing       161.67  |  3.25  |  0.82
```

`1150 Square Clearing` now stands at **0.00** for this payout. That zero is the proof nothing was
dropped. A non-zero residual after both halves are in is a bug, not an accounting event, and it blocks
the close (`README.md` §4.4).

---

## 8. The bank link — `SQ` + `YYMMDD`, and the one-to-many trap

`matchSquarePayoutToBankTransaction(payout, candidates, options)` joins a settlement to the Relay rows
that clear it.

**Step 1 — the reference code.** `squareBankReference('2026-01-26')` → `'SQ260126'`.
`parseSquareBankReference('SQ260126')` → `'2026-01-26'`. The two-digit year expands to `20YY`: Relay
did not exist in 1926 and this ledger will not outlive 2099. A code whose six digits are not a real
calendar date (`SQ261332`) parses to `null` rather than to a plausible wrong date.

**Step 2 — the acceptance window.** The code on the deposit is the deposit date (§1.2), which can trail
the settlement date by a business day or more. The matcher therefore accepts the codes for
`depositDate … depositDate + lagDays`, default **5**. Widening the window only ever adds candidates; it
never relaxes the amount, which stays exact.

**Step 3 — the amount, and the trap.** On 1/26/2026 **three** Relay rows carry `SQ260126`. A matcher
that stops at the first row finds `161.67` and leaves `4.07` in clearing forever, which then shows up as
an unexplained clearing balance six months later and takes an afternoon to find. So:

1. Take every candidate whose reference carries an accepted code, on the right side of zero.
2. If they sum exactly to the payout's net, **match all of them** (`matchedBy: 'reference'`). This is the
   1/26 case: `161.67 + 3.25 + 0.82 = 165.74`. ✅
3. Otherwise search subsets exhaustively (up to 14 candidates — `2^14` is nothing) for one summing
   exactly. Exactly one → matched. More than one → **`ambiguous`**, and a human decides; the importer
   does not pick.
4. None, and the candidates sum to *less* than the payout → **`partial`**: a deposit is still in transit.
   That is normal for 0–5 days and an exception after that (`README.md` §4.4).
5. None, and they sum to more → **`unmatched`**, with the difference reported. Two payouts have probably
   collided in one window.

**The amount is never approximate.** Codes are how candidates are found; cents are how they are
confirmed.

**`RETURNED_PAYOUT`** (§3) is the case where no deposit will ever arrive. A settlement carrying one must
not sit in clearing waiting for money that was sent back.

---

## 9. Gotchas

1. **The deposit is net.** The single largest error available here is booking `+161.67` as revenue. It
   understates revenue by the fee and records no tax liability. Everything in §7 exists to prevent it.
2. **One payout, several deposits.** ✅ Proven on 1/26/2026. Any matcher that assumes one-to-one is
   wrong on the very first payout this company ever took.
3. **`Net Sales` and `Total Collected` are derived.** Posting them alongside their components
   double-counts the entire settlement. They are read for the §6 identity and discarded.
4. **The sign convention is the likeliest thing this document has wrong.** ⚠️ not ✅. §6's
   `ties_if_outflows_negated` diagnosis exists precisely so that the first real export tells us the
   answer instead of silently posting a mirror-image entry.
5. **A column-subset export.** Square's gear icon lets a user export "only selected columns" ✅. The
   resulting file parses fine and cannot be checked. The importer reports which canonical columns were
   absent, every time, in the preview.
6. **Excel.** A CSV opened and re-saved in Excel acquires a BOM, may lose leading zeros in ids, and may
   render `$1,234.56` as text with a non-breaking space. `readFile` handles the BOM and `parseMoney`
   handles the rest, but a re-saved file that no longer matches its stored hash must be treated as a
   different file, and a settlement whose amounts changed must be rejected (§5).
7. **A bisected date range.** Exporting `Jan 1 – Jan 25` splits the `SQ260126` payout and no subset of it
   will tie. §6 catches it; the remedy is to re-export whole payouts.
8. **Instant transfers cost 1.95%** ✅. If the owner ever taps "instant", a `DEPOSIT_FEE` appears and the
   deposit is smaller than the payout's net. That is a real fee, not a break in the identity.
9. **Square renames its reports.** *Deposits* → *Transfers* → *Balance*. Never hard-code a Dashboard path
   into an error message without also naming the report by what it contains.
10. **Tiny amounts.** `$0.82` is a real Sooz payout. Any code path that treats small amounts as noise, or
    any tolerance expressed in dollars rather than cents, is wrong here by construction.
11. **`ACCTVERIFY` is not a payout.** ✅ Two real `Square Inc` rows on 1/20/2026, `−0.01` and `+0.01`,
    are the micro-deposit pair Square sends to verify a newly linked bank account. They carry no `SQ`
    code, they net to zero, and they belong to no settlement. Match on the reference code, never on the
    payee — the payee is `Square Inc` on all nine rows, and only seven of them are money.
12. **No sandbox data is a real file.** ❓ Square's sandbox emits well-formed exports that do *not*
    exercise adjustments, disputes or holds. A clean sandbox run is not the §11 validation.

---

## 10. Fixtures

`src/lib/importers/__fixtures__/square-*.csv` are **synthetic**. They are built from the column set in
§4a and the identities in §6, and they are shaped to match what a real export should look like — they
are not a real export and must not be mistaken for one.

| Fixture | What it exercises |
|---|---|
| `square-settlements.csv` | The happy path: five settlements matching the five real `SQ` codes, every identity ties |
| `square-settlements-unbalanced.csv` | A settlement whose `Net Total` is off by `$0.13` — the `off_by` rejection |
| `square-settlements-positive-outflows.csv` | Fees and refunds stated positive — the `ties_if_outflows_negated` diagnosis |
| `square-settlements-messy.csv` | BOM, `$` and comma formatting, `(1.23)` negatives, a timestamped date cell, alias headers (`Payout Date`, `Gross`, `Fee`, `Payout Amount`), a `Payout ID` container key, an unknown money column, and an all-zero row |
| `square-transactions.csv` | The Transactions CSV **without** a grouping id, which detection must reject |

The amounts in `square-settlements.csv` are chosen so that every settlement's `Net Total` equals a real
Relay deposit total: `165.74`, `67.70`, `10.41`, `14.34`, `13.81`. That makes the fixture and the real
bank rows testable against each other end to end, which is the closest thing to a real Square file that
exists today.

---

## 11. Before this importer is trusted with the books

A checklist, not a wish. Every line needs a real Square export.

- [ ] Export the Transfers/Reconciliation report for **2026-01-01 → 2026-09-30** with **all columns in
      your view** and archive the raw bytes.
- [ ] Compare its actual header row against §4a. Correct the canonical names and aliases. Record which
      claims were ❓ and are now ✅.
- [ ] Confirm the sign of `Fees`, `Returns`, `Discounts & Comps` and `Partial Refunds` against a payout
      you can compute by hand. If `assertSettlementBalances` returns `ties_if_outflows_negated`, §4a and
      §6 are wrong and must be corrected — not worked around in code.
- [ ] Confirm the settlement grouping column and whether a stable `Settlement ID` / `Payout ID` is
      present. If it is, §5 layer 1 becomes exact and the fallback hash stops being load-bearing.
- [ ] Run the five real payouts through `matchSquarePayoutToBankTransaction` against the real Relay rows.
      All five must come back `matched`, and the 1/26 payout must match **all three** deposits.
- [ ] Confirm the five settlements' `Net Total` values sum to **$272.00**, the total of the seven real
      Relay Square deposits.
- [ ] Post one settlement and its deposits into a scratch period and confirm **1150 Square Clearing nets
      to exactly 0.00**.
- [ ] Only then remove this section.

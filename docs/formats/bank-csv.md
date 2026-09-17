# Bank & Credit Card Transaction Exports — Parser Specification

**Scope:** the primary intake path for Sooz Books. Everything the importer needs to turn a raw bank or
card file into balanced journal entries.

**Status of the facts below.** Column names, row order, sign conventions and date formats were verified
against (a) official issuer documentation where it exists, (b) real exported files committed to public
repositories, and (c) the detection tables of several independent open-source importers, which agree with
each other. Where sources disagree, both variants are given and labelled. Where something is observed but
not officially documented (e.g. the Chase `Type` token vocabulary), it is marked as such and the parser is
told not to depend on it.

**All sample files in §8 are SYNTHETIC.** Names, account numbers, merchants and amounts are invented. They
are shaped to match real exports byte-for-byte in structure so a test suite can use them as fixtures.

---

## 1. How you get the file

### 1.1 Chase business checking

1. Sign in at chase.com → **Accounts** → select the business checking account.
2. On the account activity list, click the **download icon** at the top right of the transactions table
   (labelled "Download account activity").
3. Choose either:
   - **Activity / date range** — a rolling window, typically limited to the last 90 days of activity, or
   - **Statement period** — a specific posted statement; these go back roughly 7 years.
4. **File type:** choose `CSV` (older UI wording: "Spreadsheet (Excel, CSV)"). `QBO`, `QFX`, `OFX` and
   `PDF` are also offered.
5. Click **Download**.

**Options that matter**

- The *date range* option and the *statement period* option produce the **same columns** but different row
  sets. Statement-period downloads are cleanly bounded; date-range downloads silently clamp to 90 days and
  a user asking for a year gets a short file with no warning. Always read the actual min/max date in the
  file rather than trusting what the user says they exported.
- **Pending transactions are never in the CSV.** Chase shows them in the UI only. Everything in the file
  is posted.
- Chase Connect / Chase Commercial Online (larger business accounts) exports the same layout from
  **Accounts → Account Activity → Download**, file type "Comma delimited (CSV)".

### 1.2 Chase business credit card (Ink)

1. Sign in at chase.com → select the card account.
2. Click the **download icon** above the transactions list.
3. Choose **statement period** (a closed statement) or **date range** (rolling ~90 days).
4. **File type:** `CSV`. Download.

The card export is a **different file format from checking** — different headers, different sign
convention, no balance column. Do not share a parser profile between them.

### 1.3 Bank of America business checking

1. Sign in at bankofamerica.com → **Accounts** → select the account → **See all transactions**.
2. Scroll to the **Activity** header; the **Download** link is on the right.
3. In the popup, set **Transaction Period** (current statement, a previous statement, or a custom date
   range).
4. Set **File Type**. Two wordings exist depending on UI version — **"Microsoft Excel Format"** (older;
   despite the name it produces a `.csv`) or **"Comma-separated values (.csv)"**. Both give the same bytes.
   `Quicken`, `QuickBooks` and `Money` are the other options.
5. Click **Download Transactions**.

**Options that matter**

- Statement-period downloads include the summary preamble and a synthetic *Beginning balance* row.
  Custom-date-range downloads usually include the preamble too but the beginning-balance row may be absent.
  The parser must tolerate both.
- BofA retired its OFX/Direct Connect service on 2025-09-30, so CSV is the only machine-readable export
  left for most business customers. Expect this file to be the workhorse.
- **BofA business credit cards use a completely different CSV** — see §2.10.

### 1.4 American Express business card

1. Sign in at americanexpress.com → **Statements & Activity**.
2. Select **Recent activity** or one of the last six billing statements (Amex exposes the current cycle
   plus the **six most recent billing statements** — older periods are PDF only).
3. Click the **download / export icon**.
4. Choose file type: `CSV`, `Excel (.xlsx)`, `QFX` (Quicken), `QBO`/`OFX` (QuickBooks).
5. **Critically:** tick the checkbox for extended data. Its label varies by UI version — *"Include all
   additional details"* / *"Include all additional transaction details"*. This is what adds the
   `Extended Details`, `Appears On Your Statement As`, `Address`, `City/State`, `Zip Code`, `Country`,
   `Reference` and `Category` columns. **With it off you get five columns and no stable reference id.**
   Tell the user to leave it on.

For Amex Business Blueprint / business checking, the transactions tab exports CSV with a hard cap of
**2,000 transactions per export** (Amex-documented).

### 1.5 Mercury

1. Sign in at mercury.com → **Transactions**.
2. Filter by account and date range in the left rail (the export honours the active filters).
3. Click **Export** (or the ⋮ menu on the transactions table).
4. Choose the export flavour: **CSV** (the native format documented here), **QuickBooks CSV**, or
   **NetSuite CSV**. The QuickBooks/NetSuite flavours are re-shaped for those importers and have
   *different* columns — always ask for the plain CSV.
5. Statements and bulk exports live under **Settings → Documents & Data**.

**Options that matter:** the filter state is baked into the export. If the user had a single account
selected, you get one account; if "All accounts", the `Source Account` column carries the split.

### 1.6 Ramp

1. Sign in to Ramp → **Expenses → Transactions**.
2. Apply filters (date range, card, user, sync status).
3. Click the **download icon** → the file downloads directly, or is **emailed** if it is large.
4. Admins/managers can open **Export settings** from the same download icon to add columns.

**Options that matter — this is the important one:** the export contains *the columns currently shown in
the table view* unless extra fields have been enabled, and admins can **rename headers and reorder
columns**. Ramp has no guaranteed header row. Treat every Ramp file as a "learn the mapping once, save the
profile" case (§9).

The separate **Custom Accounting CSV** (Settings → Custom Accounting → Export settings → CSV templates)
is a different animal again: a journal-shaped export with `Debit` / `Credit` columns.

### 1.7 Brex

Brex offers two unrelated files:

- **(a) Transactions report** — **Account → Credit → Transactions**, enter a date range, download as
  `XLSX`, `CSV`, `PDF`, `HTML` or `TXT`.
- **(b) Accounting export** — **Accounting → Prepare / Review / Exported**, select rows, click the
  download icon, export as CSV. The shape is defined by a **CSV template** the customer edits under
  *Custom Accounting settings → Export settings → CSV templates*, where they can select columns, reorder
  them by dragging, and **rename the headers**.

**There is therefore no canonical Brex header row.** Like Ramp, Brex requires a saved per-tenant mapping
profile. Note that exporting from the Accounting tab can move rows to the *Exported* state; the Expenses
CSV is "reporting only" and does not.

### 1.8 Wells Fargo business checking

1. Sign in at wellsfargo.com (or Wells Fargo Business Online) → **Accounts** → select the account.
2. Open **Download Account Activity** (under the Activity tab / "More options").
3. Pick a date range. Default is ~90 days; up to **18 months** is available on most business checking
   accounts.
4. **File format:** choose "Comma Delimited (.csv)" or "Spreadsheet (Excel .csv)". `Quicken` and
   `QuickBooks` are the alternatives.
5. Download.

**Options that matter:** the classic Wells Fargo CSV **has no header row at all** (§2.8). Some newer
Business Online exports do emit a header — detect, don't assume.

---

## 2. Columns

A note that applies to every table below: **match headers case-insensitively after trimming whitespace and
stripping a UTF-8 BOM from the first cell.** Several of these banks ship a BOM; Chase and BofA are
frequent offenders.

### 2.1 Chase business checking

Header line, verbatim:

```
Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #,
```

Note the **trailing comma** — there are 8 physical fields and the 8th is unnamed and always empty. A strict
`csv.DictReader` will produce a `None` (Python) or `""` key. Some exports omit it. Handle both.

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Details` | enum string | `DEBIT` | Direction/instrument class. Observed values: `DEBIT`, `CREDIT`, `CHECK`, `DSLIP` (deposit slip). | Yes |
| `Posting Date` | date `MM/DD/YYYY` | `06/08/2026` | Date the item hit the ledger balance. **This is the book date.** | Yes |
| `Description` | string | `ORIG CO NAME:AMERICAN EXPRESS ORIG ID:9493560001` | Raw bank narrative, uppercase, frequently contains commas → always quoted | Yes |
| `Amount` | signed decimal | `-9725.18` | Signed; outflow negative. No currency symbol. Usually no thousands separator, but quoted `"-9,725.18"` appears in older exports — strip commas defensively. | Yes |
| `Type` | enum-ish token | `ACH_DEBIT` | Uppercase transaction-type token. **Not officially documented.** Observed: `ACH_DEBIT`, `ACH_CREDIT`, `ATM`, `CHECK_PAID`, `DEBIT_CARD`, `DEPOSIT`, `FEE_TRANSACTION`, `MISC_CREDIT`, `MISC_DEBIT`, `QUICKPAY_CREDIT`, `QUICKPAY_DEBIT`, `WIRE_INCOMING`, `WIRE_OUTGOING`, `ACCT_XFER`, `LOAN_PMT`. **Treat as an opaque string; never branch on an exhaustive match.** | Yes |
| `Balance` | decimal | `33057.89` | Running account balance *after* this row. Occasionally blank on the newest rows. **Never treat as an amount.** | Yes (may be empty) |
| `Check or Slip #` | string | `1043` | Check number for `CHECK` rows, deposit-slip number for `DSLIP`. Empty otherwise (~90% of rows). | Yes (mostly empty) |
| *(unnamed 8th)* | — | `` | Artefact of the trailing comma. Discard. | No |

**Row order:** newest first (descending `Posting Date`). The `Balance` column therefore *decreases* as you
read downward on a net-inflow month, which trips naive balance-recurrence checks — see §9.

### 2.2 Chase business credit card

Header line, verbatim:

```
Transaction Date,Post Date,Description,Category,Type,Amount,Memo
```

**Variant:** older exports omit the trailing `Memo` column (6 fields). Detect on the prefix
`Transaction Date,Post Date,Description,Category,Type,Amount`, not on exact equality.

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Transaction Date` | date `MM/DD/YYYY` | `04/03/2024` | When the purchase occurred | Yes |
| `Post Date` | date `MM/DD/YYYY` | `04/05/2024` | When it posted to the card. **Use this as the book date**; keep `Transaction Date` for receipt matching. | Yes |
| `Description` | string | `APPLE.COM/BILL` | Merchant string. Multiple internal spaces are normal (`GITHUB  INC.`) — do not collapse before fingerprinting, collapse *inside* the normalizer only. | Yes |
| `Category` | string | `Shopping` | Chase's own MCC-derived category. **Frequently empty on Ink business cards and on `Payment` rows.** | Yes (often empty) |
| `Type` | enum | `Sale` | Observed: `Sale`, `Return`, `Payment`, `Adjustment`, `Fee`. Title case, unlike the checking file's SCREAMING_SNAKE. | Yes |
| `Amount` | signed decimal | `-1.23` | Single signed column. **Purchases NEGATIVE, payments and refunds POSITIVE.** | Yes |
| `Memo` | string | `` | User-entered note. Almost always empty. | No (absent in older exports) |

**No balance column.** **Row order:** newest first.

### 2.3 Bank of America business checking

The file is *not* a plain CSV. Physical layout:

```
line 1   Description,,Summary Amt.
line 2   Beginning balance as of 06/01/2026,,8412.55
line 3   Total credits,,18432.24
line 4   Total debits,,-11854.54
line 5   Ending balance as of 06/17/2026,,14990.25
line 6   (blank)
line 7   Date,Description,Amount,Running Bal.
line 8+  data
```

The real header is on **line 7**. Lines 1–5 are a 3-column summary block whose header (`Description`)
collides with a real column name — a parser that takes "first row containing a known header token" will
pick the wrong row. See §9 for the correct rule.

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Date` | date `MM/DD/YYYY` | `06/09/2026` | Posting date | Yes |
| `Description` | string | `WIRE TYPE:WIRE OUT DATE:260609 TIME:1132 ET TRN:2026060900123456 BNF:GOLDEN VALLEY MILLS` | Very long raw narrative; embeds its own dates and colons. Quoted. | Yes |
| `Amount` | signed decimal | `-6200.00` | Outflow negative. **Quoted with thousands separators** in real exports: `"-6,200.00"`. **Empty on the synthetic beginning-balance row.** | Yes (empty on one row) |
| `Running Bal.` | decimal | `3452.74` | Balance after the row. Note the **trailing period** in the header — match on the prefix `running bal`. | Yes |

**Row order:** follows the on-screen sort at the time of export. **Both ascending and descending are seen
in the wild.** The `Beginning balance as of …` row sits at the *chronological* start, so on a
descending export it is the **last** data row, not the first. Never assume; sort the rows yourself after
parsing and locate the balance row by its description, not its position.

### 2.4 American Express business card

Two header variants, both real. Which one you get depends on the card type and on whether the extended-
details checkbox was ticked.

**Variant A — business/corporate card, extended details ON (13 columns):**

```
Date,Description,Card Member,Account #,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category
```

**Variant B — consumer/single-cardholder, extended details ON (11 columns), no cardholder identity:**

```
Date,Description,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category
```

**Variant C — extended details OFF:** `Date,Description,Card Member,Account #,Amount` (or
`Date,Description,Amount`).

*Sources disagree here and both are correct:* one open-source Amex template lists the 11-column form with
no `Card Member`, another lists the 13-column form with `Card Member` and `Account #`. The difference is
business-vs-consumer product, not a version change. **Detect on the presence of `Card Member`, not on
column count.**

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Date` | date `MM/DD/YYYY` | `06/03/2026` | Transaction date (Amex exports one date only; there is no separate post date) | Yes |
| `Description` | string | `ORGANIC OAT SUPPLY CO` | Cleaned merchant name | Yes |
| `Card Member` | string | `SUSANNA R OKONKWO` | Cardholder on the supplementary card. **Business cards only.** Key field for coding spend by employee. | Business only |
| `Account #` | string | `-31005` | Last 5 of the card, **with a leading hyphen**. It is not a negative number — read as text or Excel will mangle it. | Business only |
| `Amount` | signed decimal | `3980.00` | **Charges POSITIVE, payments and credits NEGATIVE. This is the inverse of Chase, BofA, Mercury and Wells Fargo.** Getting this backwards is the single most common Amex import bug. | Yes |
| `Extended Details` | string | `XXXX...\nORGANIC OAT SUPPLY\nPORTLAND\nOR\nDescription : GROCERY Price : 0.00` | **Multi-line.** Contains literal `\n` inside the quoted field. Requires an RFC-4180 reader, not `split('\n')`. | Extended only |
| `Appears On Your Statement As` | string | `ORGANIC OAT SUPPLY CO PORTLAND   OR` | The raw statement descriptor, padded with runs of spaces | Extended only |
| `Address` | string | `1398 SE DIVISION ST` | Merchant street address | Extended only |
| `City/State` | string | `PORTLAND\nOR` | **Also multi-line** — city and state separated by a newline inside one field | Extended only |
| `Zip Code` | string | `97202-1188` | Leading zeros matter (`02139`) — read as text | Extended only |
| `Country` | string | `UNITED STATES (USA)` | | Extended only |
| `Reference` | string | `320252510123456789` | **Amex reference number — the only stable per-row id any of these files gives you.** 18–24 digits. Use it (see §5). | Extended only |
| `Category` | string | `Merchandise & Supplies-Groceries` | Amex taxonomy, `Major-Minor` shape | Extended only |

**Row order:** newest first.

### 2.5 Mercury

Header line, verbatim (14 columns, exact and stable — Mercury is the best-behaved file in this document):

```
Date (UTC),Description,Amount,Status,Source Account,Bank Description,Reference,Note,Last Four Digits,Name On Card,Category,GL Code,Timestamp,Original Currency
```

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Date (UTC)` | date **`MM-DD-YYYY`** | `04-16-2024` | **Hyphen-separated, month first.** Not ISO, despite looking like it could be. Parsing `04-16-2024` as `%Y-%m-%d` fails loudly; parsing `05-06-2024` as `%d-%m-%Y` fails *silently*. Pin the format. | Yes |
| `Description` | string | `Amazon Web Services` | Mercury's cleaned counterparty name | Yes |
| `Amount` | signed decimal | `-353.63` | Outflow negative, **including on `Mercury Credit` card rows** (unlike Amex) | Yes |
| `Status` | enum | `Sent` | Observed: `Sent`, `Pending`, `Failed`, `Cancelled`. **Only `Sent` should post to the ledger.** | Yes |
| `Source Account` | string | `Mercury Checking xx1234` | Which Mercury account. Values look like `Mercury Checking xx1234`, `Mercury Savings xx5678`, `Mercury Credit`. **This is the routing key when a user exports "all accounts" into one file.** | Yes |
| `Bank Description` | string | `GUSTO; FEE 111111; Launch Platform LLC` | Raw ACH/network descriptor, semicolon-delimited | Yes (may be empty) |
| `Reference` | string | `Profit distribution` | **User-entered memo on outgoing payments, not a bank reference number.** Misleading name. Often empty. | No |
| `Note` | string | `` | Internal note | No |
| `Last Four Digits` | string | `5678` | Card last 4 on `Mercury Credit` rows; empty on checking rows | No |
| `Name On Card` | string | `Susanna Okonkwo` | Cardholder; empty on checking rows | No |
| `Category` | string | `Software` | Mercury category; empty unless set | No |
| `GL Code` | string | `` | Mercury's accounting-integration code. Usually empty. If populated, **prefer it over any inference.** | No |
| `Timestamp` | datetime `MM-DD-YYYY HH:MM:SS` | `04-16-2024 03:25:55` | **UTC, second precision.** The closest thing Mercury gives to a unique key. | Yes |
| `Original Currency` | string | `USD` | Empty on domestic ACH rows, populated (`USD`, `EUR`…) on card rows | No |

**Row order:** newest first.

### 2.6 Ramp

**No guaranteed header row.** The Ramp-documented default set for the Expenses → Transactions export is
these 12 fields:

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Merchant Name` | string | `Meta Platforms` | Merchant | Default |
| `Ramp Category` | string | `Advertising` | Ramp taxonomy | Default |
| `Transaction Date` | date `MM/DD/YYYY` | `06/01/2026` | Purchase date | Default |
| `User` | string | `Susanna Okonkwo` | Cardholder | Default |
| `Ramp Department` | string | `Marketing` | | Default |
| `Ramp Location` | string | `SF HQ` | | Default |
| `Card Last 4` | string | `4417` | Read as text (leading zeros) | Default |
| `Card Display Name` | string | `Marketing – Meta` | Virtual card name | Default |
| `Amount` | decimal | `4212.66` | **Charges positive.** Refunds are *also* positive unless "display refunds in single-line journal entries as negative numbers" is enabled on the accounting template. **This is the Ramp footgun.** | Default |
| `Original Currency Amount` | decimal | `4212.66` | Pre-FX amount | Default |
| `Original Currency Code` | string | `USD` | | Default |
| `Conversion Rate` | decimal | `1.0` | | Default |

Optional columns admins can switch on include `Transaction Time`, `Accounting Date`, `Clearing Date`,
`User Email`, `Merchant Description`, `MCC Code`, `Attendees`, `Flight Ticket Number`, plus — when an
accounting integration is connected — `Account ID`, `Account Name` and tracking categories.

The separate **Custom Accounting CSV** templates have mandatory fields by export shape:
- *Transactions, double line:* `Debit`, `Credit`, `Accounting Date`, `Account Name` **or** `Account ID`
- *Transactions, single line:* `Amount`, `Accounting Date`, `Expense Account Name` **or**
  `Expense Account ID` (with refunds-as-negative enabled)

**Split transactions appear as multiple rows** that sum to the parent charge. Do not also import the
parent.

### 2.7 Brex

**No canonical header row.** Two file families (§1.7). The Brex Transactions API field vocabulary is the
best guide to what a template's columns will be *named after*, even when the customer renames them:
`id`, `description`, `amount` (an object with a minor-units integer and a currency), `initiated_at_date`,
`posted_at_date`, `type`, `card_id`, `merchant`.

Typical exported columns, in the shape most Brex tenants ship:

| Exact header text (typical) | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Transaction Date` | date | `06/01/2026` | Initiated date | Template |
| `Posted Date` | date | `06/03/2026` | Book date | Template |
| `Merchant` | string | `Klaviyo` | | Template |
| `Amount` | decimal | `512.00` | **Charges positive**, refunds negative | Template |
| `Currency` | string | `USD` | | Template |
| `User` | string | `Susanna Okonkwo` | Cardholder | Template |
| `Card Last Four` | string | `0912` | | Template |
| `Memo` | string | `June email platform` | | Template |
| `Budget` | string | `Marketing` | Brex budget/limit name | Template |
| `Department` | string | `Marketing` | | Template |
| `GL Account` | string | `6210 Advertising` | Populated once accounting is configured | Template |
| `Expense ID` | string | `expense_cuvwx2y3z4` | **Stable per-row id when present — prefer it.** | Template |

**Parser requirement:** on the first Brex (or Ramp) import for a tenant, run the heuristics in §9, show the
user the inferred mapping, let them correct it, then **persist it keyed by (institution, header-row
fingerprint)**. Re-use it silently on subsequent imports and re-prompt only when the header fingerprint
changes.

### 2.8 Wells Fargo business checking

**There is no header row.** The classic export is five positional, fully-quoted fields:

```
"06/03/2026","-142.55","*","","UTILITY PAYMENT ACH SOOZ FOODS LLC"
```

| Index | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `0` | date `MM/DD/YYYY` | `06/03/2026` | Posting date | Yes |
| `1` | signed decimal | `-142.55` | Outflow negative. Quoted with thousands separators on large amounts: `"-14,382.91"`. | Yes |
| `2` | literal | `*` | **A constant asterisk on every row.** Occasionally empty. Carries no information — but it is the single most reliable Wells Fargo fingerprint. | Yes |
| `3` | string | `` | Check number when present; empty on the overwhelming majority of rows | Yes (mostly empty) |
| `4` | string | `PURCHASE AUTHORIZED ON 06/02 SQ *COLD BREW SAN FRANCISCO CA S304000000000 CARD 4417` | Description | Yes |

**Variant:** some newer Wells Fargo Business Online exports *do* emit a header
(`Date,Amount,*,Check Number,Description` or similar). Detect, don't assume — §9's headerless test handles
both.

**Row order:** newest first.

### 2.9 The three universal shapes

Every bank file in existence collapses into one of three shapes. Build three code paths, not fifty bank
profiles.

**Shape A — single signed `Amount`.** Chase (both), BofA, Amex, Mercury, Wells Fargo, Ramp, Brex.

```
Date,Description,Amount
06/03/2026,GOLDEN VALLEY MILLS,-6200.00
06/04/2026,SHOPIFY PAYOUT,12480.35
```

Signed value is the truth. The only question is *which direction positive means* — asset convention
(inflow +, used by every checking account here, and by Chase's card) or liability convention (charge +,
used by Amex, Ramp, Brex). Resolve per-institution, never per-file.

**Shape B — separate `Debit` and `Credit` columns, both unsigned.** Capital One, Citi, most credit unions,
most international banks, and Ramp's double-line accounting export.

```
Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-06-03,2026-06-04,4417,GOLDEN VALLEY MILLS,Merchandise,6200.00,
2026-06-09,2026-06-09,4417,PAYMENT THANK YOU,Payment,,9725.18
```

Exactly one of the two is populated per row. Canonicalise to a signed amount:
`signed = credit − debit` under the asset convention, `signed = debit − credit` under the liability
convention. **Validate before trusting:** no more than ~2% of rows may have both columns non-empty and
non-zero. If more do, it is not a debit/credit pair — it is probably `Amount` next to a `Balance` you
mis-identified.

**Shape C — `Amount` plus a `Transaction Type` of `DEBIT`/`CREDIT`.** Common at credit unions, regional
banks, Plaid-style aggregator exports, and many bank *debit card* exports.

```
Date,Description,Category,Type,Amount
2026-06-01,EMPLOYER DIRECT DEPOSIT PAYROLL,Salary,CREDIT,3200.00
2026-06-02,ONLINE PAYMENT TO CHASE CREDIT CARD,Payment,DEBIT,-450.00
```

**The dangerous case:** some issuers emit an *already-signed* amount alongside the type (as above, where
`DEBIT` rows are already negative); others emit an *unsigned* amount and rely on the type. Applying the
type to an already-signed amount double-negates every outflow, and the import looks plausible — the totals
are just wrong.

**Decision rule, computed over the whole file, not per row:**
```
if min(amount) < 0 for any row:            # file is already signed
    use the amount verbatim; ignore Type except as metadata
else:                                       # file is unsigned
    signed = amount if Type in CREDIT_SET else -amount
```
`CREDIT_SET = {CREDIT, CR, C, DEPOSIT, DEP, +}`, `DEBIT_SET = {DEBIT, DR, D, WITHDRAWAL, W, -}`, compared
case-insensitively. If a file is entirely unsigned *and* has no type column *and* has no debit/credit
pair, refuse the import and ask the user — do not guess.

### 2.10 Header variations worth knowing

| Institution / product | Header |
|---|---|
| Chase checking | `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #,` |
| Chase card | `Transaction Date,Post Date,Description,Category,Type,Amount,Memo` |
| BofA checking | `Date,Description,Amount,Running Bal.` (line 7) |
| BofA credit card | `Posted Date,Reference Number,Payee,Address,Amount` |
| Capital One card | `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit` — ISO `YYYY-MM-DD` dates |
| Capital One checking | `Account Number,Transaction Date,Transaction Amount,Transaction Type,Transaction Description,Balance` |
| Citi card | `Status,Date,Description,Debit,Credit` — first header is `Status` |
| Discover card | `Trans. Date,Post Date,Description,Amount,Category` — note the period in `Trans. Date` |
| USAA | contains `Original Description` |
| Mercury | the 14 columns in §2.5 |
| Wells Fargo | none |

---

## 3. Sign and amount conventions

### 3.1 Direction, per institution

| Institution / file | Shape | Positive means | Negate on import? |
|---|---|---|---|
| Chase business checking | A | money **in** | No |
| Chase business credit card | A | **payment/refund** (purchases are negative) | No — it already behaves like an asset column |
| BofA business checking | A | money **in** | No |
| BofA business credit card | A | **charge** | Yes, to reach asset convention |
| **American Express** | A | **charge** | **Yes** |
| Mercury (checking *and* Mercury Credit) | A | money **in** / credit to the card | No |
| Ramp | A | **charge** | Yes |
| Brex | A | **charge** | Yes |
| Wells Fargo | A | money **in** | No |
| Capital One, Citi | B | n/a — `credit − debit` | n/a |
| Generic credit union | C | see §2.9 rule | see §2.9 rule |

Chase's card file is the odd one out among cards: it reports purchases as **negative**, the same polarity
as its checking file. Amex, Ramp and Brex report purchases as **positive**. Two card files from two issuers
covering the same spend will have opposite signs. Store a `sign_convention` on the account, set at account
setup, and apply it before anything else touches the number.

### 3.2 Are credits ever positive in a debit column?

Yes, in two real situations, and both must be handled:

1. **Refund rows in a debit column.** Capital One and Citi put a returned purchase in the `Credit` column
   (correct), but some smaller issuers put a *negative* number in the `Debit` column instead. The
   canonicalisation `signed = credit − debit` handles this automatically as long as you **do not take
   `abs()`** of either column. Never `abs()`.
2. **Ramp refunds.** In the default reporting export, a refund appears as a **positive** number in the
   same `Amount` column as a charge, with nothing to distinguish it but the merchant and the category.
   Only the Custom Accounting template's "display refunds as negative numbers" option fixes it. If the
   tenant has not enabled it, the importer must key off `Ramp Category` / a negative `Original Currency
   Amount`, or ask.

### 3.3 Amount string normalization

Apply this pipeline to every candidate money string, in this order:

1. Strip a UTF-8 BOM (`﻿`) if this is the first cell of the file.
2. Trim ASCII whitespace, plus **U+00A0 non-breaking space** and **U+2009 thin space** (European and some
   Excel-generated exports use these as thousands separators).
3. Strip leading/trailing currency symbols: `$ £ € ¥ ₹ ¤` and the ISO codes `USD`/`CAD` when adjacent.
4. **Parentheses → negative:** `(1,234.56)` → `-1234.56`. Accounting-style exports and every `.xlsx`
   rendered through an accounting number format use this.
5. **Trailing sign → leading sign:** `1234.56-` → `-1234.56`. Mainframe-derived bank files do this.
6. **Trailing `CR`/`DR`:** `1,234.56 CR` → positive, `1,234.56 DR` → negative (UK/Commonwealth
   convention). Strip and apply.
7. Remove `,` thousands separators. **Only after** confirming the decimal separator is `.` — if the file
   has values like `1.234,56`, the roles are swapped (European); detect by checking whether the last
   separator in the string is followed by exactly 2 digits.
8. Remove a leading `+`.
9. Parse as a **decimal, never a float.** `Decimal("0.1") + Decimal("0.2")` is exact; the float version is
   not, and a 2,000-row import accumulates visible cents of error in the balance check.
10. Normalize `-0.00` → `0.00` before it reaches the fingerprint.

Empty string, `-`, `--`, `N/A` and `n/a` all mean "no value", not zero.

---

## 4. Date formats and timezone caveats

| Institution | Format | Notes |
|---|---|---|
| Chase checking | `MM/DD/YYYY` | `Posting Date` only |
| Chase card | `MM/DD/YYYY` | two dates; `Post Date` is the book date |
| BofA checking | `MM/DD/YYYY` | |
| Amex | `MM/DD/YYYY` | one date only |
| **Mercury** | **`MM-DD-YYYY`** | hyphens, month first. `Timestamp` is `MM-DD-YYYY HH:MM:SS`. |
| Ramp | `MM/DD/YYYY` | optional `Transaction Time` column |
| Brex | `MM/DD/YYYY` typical; template-dependent | |
| Wells Fargo | `MM/DD/YYYY` | |
| Capital One card | `YYYY-MM-DD` | the one ISO holdout |
| `.xlsx` of any of the above | **a real date cell, or an Excel serial number** | see §6.8 |

**Try-list, in priority order** (stop at the first format that parses ≥95% of the column):
`%m/%d/%Y`, `%m-%d-%Y`, `%Y-%m-%d`, `%m/%d/%y`, `%d/%m/%Y`, `%b %d, %Y`, `%d-%b-%Y`, `%Y/%m/%d`.

**MM/DD vs DD/MM disambiguation** — scan the *entire* column before deciding:
- If any row's first component > 12 → the file is `DD/MM`.
- Else if any row's second component > 12 → the file is `MM/DD`.
- Else (every date in the file is ambiguous, e.g. a short range in the first 12 days of a month) → default
  to `MM/DD` for US institutions, **but flag the import and show the user three sample rows rendered both
  ways for confirmation.** Silently guessing here produces an import that is off by months and is
  essentially undetectable later.

**Timezone caveats**

- **Mercury is the only one that declares a timezone,** and it declares **UTC** in the header itself
  (`Date (UTC)`). A card swipe at 6pm Pacific on 2026-06-15 exports as `06-16-2026`. For a US company on
  a Pacific or Eastern books close, **convert `Timestamp` from UTC to the entity's book timezone and derive
  the date from that**, rather than trusting `Date (UTC)`. Otherwise a month-end swipe lands in the wrong
  period.
- Every other file in this document emits a **bare local date with no time and no zone.** Treat it as a
  calendar date in the entity's book timezone. Do not construct a `datetime` at midnight UTC and then
  localise it — that shifts US dates back a day.
- Chase's `Posting Date`, BofA's `Date` and Wells Fargo's field 0 are *posting* dates, which the bank
  assigns in its own processing timezone (usually ET). There is nothing you can do about it and nothing
  you need to: the posting date *is* the book date by definition.
- Ramp's optional `Accounting Date` overrides `Transaction Date` for period assignment when present.

---

## 5. Identity and deduplication

**Only one of these files carries a genuinely stable per-row identifier:**

| File | Stable id? | Field |
|---|---|---|
| Amex, extended details ON | **Yes** | `Reference` (18–24 digits, Amex's own reference number) |
| Brex | **Usually** | `Expense ID` when the template includes it |
| Ramp | Sometimes | a transaction/expense id column if the admin enabled it |
| Mercury | No | but `Timestamp` has second precision and is effectively unique |
| Chase checking | No | `Check or Slip #` on the ~10% of rows that are checks |
| Chase card | No | — |
| BofA checking | No | — |
| BofA credit card | **Yes** | `Reference Number` |
| Wells Fargo | No | — |

For everything without an id, the row is identified by a **natural key**:

```
account_id | posting_date (ISO) | signed_amount (2dp) | normalize(description) | check_number
```

where `normalize(description)`:
1. NFKC-normalize, uppercase.
2. Collapse all whitespace runs to a single space, trim.
3. Strip trailing card fragments the bank appends non-deterministically: `CARD \d{4}`, `XXXX\d{4}`,
   `#\d{4,}$`.
4. Strip trailing dates the bank embeds (`ON 06/02`, `DATE:260609`) — these can be restated between a
   same-day pull and a next-day pull.
5. Strip an Amex/Wells trailing authorization code (`S\d{15,}`).
6. Remove non-alphanumeric characters except space.
7. Truncate to 64 characters.

**What must NOT enter the key:** the running balance (it changes with every later transaction), the
category (banks recategorise retroactively), the source filename, the row index within the file, the import
timestamp, the `Type`/`Details` token (Chase restates these), or the *transaction* date when a *posting*
date exists. On Chase's card file, key on `Post Date`, not `Transaction Date`.

The handling of the same key appearing twice on one day is in §10.

---

## 6. Gotchas

### 6.1 Preamble rows before the header
- **BofA:** five summary lines plus a blank line before the real header (§2.3). The summary block's own
  header is `Description,,Summary Amt.` — it contains the word `Description`, so a naive
  "first row that looks like a header" scan picks it.
- **BofA, again:** the first *data* row on a statement download is `Beginning balance as of MM/DD/YYYY`
  with an **empty `Amount` and a populated `Running Bal.`**. It is not a transaction. Drop rows where the
  amount is empty *and* the description matches `^(beginning|ending) balance`.
- Several aggregator and accounting-system re-exports prepend 1–3 title lines and a blank line.
- **Rule:** always scan the first 25 lines for the header (§9.1); never assume line 1.

### 6.2 Footer totals
Some exports append `Total credits`, `Total debits`, `Ending balance` or a bare `Total,,,1234.56` after
the last data row. Drop any trailing row where the date column does not parse as a date. Do this *after*
parsing, not by trimming line count.

### 6.3 Merged cells
Only in `.xlsx`. See §6.8.

### 6.4 Multi-line descriptions
- **Amex `Extended Details` and `City/State` contain literal newlines inside quoted fields.** You must use
  an RFC-4180-compliant reader that respects quoting across line breaks. Splitting the file on `\n` and
  then parsing each line will produce garbage rows for every Amex file with extended details on. This is
  the single most common cause of "my Amex import has 400 rows instead of 120".
- Consequence: **line count ≠ row count.** Any progress bar or row limit must be driven by the parsed row
  count.

### 6.5 Encoding
- **UTF-8 BOM (`EF BB BF`)** on Chase and BofA files. It attaches to the first header cell, so
  `"﻿Details" != "Details"` and detection silently fails. Strip it before anything else.
- **Latin-1 / Windows-1252** in older exports and in any file the user has opened and re-saved in Excel on
  Windows. Symptoms: `Â` before non-breaking spaces, `â€"` where an em-dash should be. Decode order:
  `utf-8-sig` → `utf-8` → `cp1252` → `latin-1` (the last never fails, so it is a safe terminal fallback).
- Line endings are `\r\n` on most of these; some Mac-re-saved files are bare `\r`. Use universal newlines.

### 6.6 Files that are not what they claim
- **HTML saved as `.xls`.** Several bank "Excel" exports are an HTML `<table>`. Sniff the first bytes for
  `<html`, `<!DOCTYPE`, or `<table` and route to an HTML table parser.
- **`.xls` (BIFF8) named `.csv`.** Sniff for the OLE2 magic `D0 CF 11 E0 A1 B1 1A E1`.
- **`.xlsx` named `.csv`.** Sniff for the ZIP magic `50 4B 03 04`.
- **Tab- or semicolon-delimited files named `.csv`.** Sniff the delimiter by counting `,`, `\t`, `;` and
  `|` in the first 10 lines and taking the one with the most consistent per-line count.
- **A PDF the user renamed.** Sniff `%PDF`. Reject with a clear message rather than producing zero rows.
- **Rule: always sniff the content, never trust the extension.**

### 6.7 Pagination, limits, and pending rows
- Chase date-range downloads silently clamp to ~90 days.
- Wells Fargo caps at 18 months.
- Amex exposes the current cycle plus the six most recent billing statements.
- Amex Business Blueprint caps a single export at **2,000 transactions**.
- Ramp emails the file instead of downloading it when the export is large, so the user may hand you a file
  from an email attachment with a different filename.
- **Pending rows:** Chase, BofA and Wells Fargo CSVs contain **posted rows only** — pending is a UI-only
  concept there. Mercury is the exception: it exports `Status` values `Pending`, `Failed` and `Cancelled`
  alongside `Sent`. **Import only `Sent`.** A `Pending` Mercury row that you post will later be joined by
  the `Sent` row with a different `Timestamp`, and you will have double-counted.
- Ramp and Brex may export unsettled authorisations whose amount later changes (tips, fuel holds). If the
  export carries a clearing/posted date, require it to be non-empty before posting.

### 6.8 Excel (`.xlsx`) exports

`.xlsx` is not "CSV with a different extension" and needs its own reader path.

- **Real date cells vs strings.** A cell may hold a `datetime` object (read it directly) *or* a string
  (parse with §4's try-list) *or* a number with a date format applied. In the same column. In the same
  file. Check the cell type per-cell, not per-column.
- **Excel date serial numbers.** A date stored as a number is days since the epoch. The 1900 system's
  epoch is nominally 1900-01-01 = 1, but Excel reproduces the Lotus 1-2-3 bug of treating 1900 as a leap
  year, so **serial 60 is the non-existent 1900-02-29** and every serial after it is off by one relative
  to a naive calculation. The correct conversion for serials > 60 is `date = 1899-12-30 + serial days`.
  Workbooks saved by older Mac Excel use the **1904 system** (`date1904` flag in `workbook.xml`), epoch
  `1904-01-01`; a file read with the wrong epoch is off by exactly **1,462 days (4 years and 1 day)**.
  Read the flag; do not assume.
- **Merged title rows.** The **Amex `.xlsx`** puts its data on a sheet named **`Transaction Details`** with
  the header row at **row 7** — six rows of merged account-summary cells precede it. A merged range reports
  its value in the top-left cell and `None` everywhere else, which looks like a mostly-empty row.
- **Multiple sheets.** Pick the sheet with the most rows that contains a parsable header, not the first
  sheet.
- **Numbers stored as text**, often with a leading apostrophe in the source. `openpyxl` returns the string
  without the apostrophe; `xlrd`-era readers may not.
- **Parentheses negatives are a display format, not the value.** The underlying cell is a proper negative
  float. Read `cell.value`, never the formatted string — and if you *are* reading formatted strings,
  §3.3's parenthesis rule applies.
- **Formulas:** load with `data_only=True` to get cached values. If the workbook was written by a tool that
  never calculated, cached values are `None` and the file is unusable — say so rather than importing zeros.
- **Trailing empty rows.** `max_row` routinely overshoots by hundreds of rows because of stray formatting.
  Stop at the first run of 5 consecutive fully-empty rows.
- **Leading zeros and `Account #`.** Amex's `Account #` value `-31005` and any `Card Last 4` of `0912`
  must be read as text. If the user round-trips the CSV through Excel before sending it, these will already
  have been destroyed — `0912` becomes `912`. Detect and warn; do not silently reconcile against a
  truncated card number.

### 6.9 Rows that must be ignored

| Condition | Action |
|---|---|
| Date cell does not parse | Skip; count as `skipped`, surface the raw line in the import report |
| Amount empty **and** description matches `^(beginning\|ending) balance` | Skip (BofA balance rows) |
| Description matches `^total (credits\|debits)$` | Skip (footer/preamble totals) |
| Mercury `Status` ∈ {`Pending`, `Failed`, `Cancelled`} | Skip |
| Amount parses to exactly `0.00` | Import but flag — these are usually $0 authorisations, occasionally real fee reversals |
| Entire row empty | Skip silently |
| Row field count ≠ header field count | Skip and report; do **not** pad, which shifts every column |

---

## 7. Accounting treatment

### 7.0 The governing principle

**A bank or card file is a CASH file. It must never create revenue.**

Revenue, contra-revenue, sales tax liability and COGS are created by the *channel settlement* files
(Shopify payouts, Amazon settlement reports, Faire, distributor remittances). The bank file's only job for
a channel payout is to move cash into the bank and relieve **Channel Clearing**. If the bank parser books
a Shopify deposit straight to Gross Sales, it (a) understates revenue by the processing fees and discounts
the platform netted out, (b) records zero sales tax liability, and (c) double-counts the moment the
settlement file is imported.

`Channel Clearing` is the control account that makes this safe. If a channel's clearing balance is
persistently non-zero after both files are in, something is missing — that is the intended alarm.

### 7.1 Row type → journal entry

| # | Row type (how to recognise it) | Debit | Credit |
|---|---|---|---|
| 1 | **Channel payout deposit** — inflow, description matches `SHOPIFY`, `AMAZON`, `FAIRE`, `STRIPE`, `SQUARE`, `PAYPAL` | Bank | Channel Clearing – *channel* |
| 2 | **Customer payment on invoice** — inflow matched to an open AR invoice | Bank | AR |
| 3 | **Short-paid remittance** — inflow < the invoice(s) it settles (UNFI, KeHE, retailer) | Bank (net received) **+** Deductions Receivable (shortfall) | AR (gross invoiced) |
| 4 | **Vendor bill payment** — outflow matched to an open AP bill | AP | Bank |
| 5 | **Card payment** — outflow to Amex/Ramp/Brex/Chase card | AP – *card* | Bank |
| 6 | **Bank fee / wire fee / FX fee** — `MONTHLY SERVICE FEE`, `WIRE FEE`, `ANALYSIS CHARGE` | Processing Fees | Bank |
| 7 | **Processor fee debited separately** — Stripe/Square monthly invoice | Processing Fees | Bank |
| 8 | **3PL / freight / warehouse payment** — ShipBob, Flexport, freight carriers | Fulfillment Fees (or AP if accrued) | Bank |
| 9 | **Ad platform charge on a card** — Meta, Google, TikTok, Amazon Ads | Advertising Expense | AP – *card* |
| 10 | **Ingredient / packaging / co-pack purchase** | Inventory | Bank **or** AP – *card* |
| 11 | **Sales tax remittance** — state DOR / Avalara / TaxJar outflow | Sales Tax Payable | Bank |
| 12 | **Transfer between own accounts** | Bank (destination) | Bank (source) |
| 13 | **Card refund on a supply purchase** | AP – *card* | Inventory (or the original expense) |
| 14 | **Interest income** | Bank | Other Income |
| 15 | **Unrecognised outflow** | Uncategorized Expense *(suspense)* | Bank |
| 16 | **Unrecognised inflow** | Bank | Undeposited Receipts *(suspense)* |

**Rows 15 and 16 must always balance** — a suspense account is what makes an unrecognisable row safe to
import rather than a reason to reject the file. Both are flagged for review and reported in the import
summary.

**COGS is never posted from a bank or card file.** A co-packer invoice is `Inventory`, not `COGS`. COGS is
relieved at fulfilment, from the channel file.

### 7.2 Transfer and card-payment de-duplication

Row types 5 and 12 appear in **two** files and would post twice.

**Rule:** when a card file contains a `Payment` row (Chase `Type = Payment`, Amex negative charge with
description matching `PAYMENT.*THANK YOU|ACH PMT|AUTOPAY`, Mercury `Mercury Credit` inflow), search the
ledger for a bank row with:
- the opposite sign,
- amount equal to within $0.00,
- posting date within **±3 calendar days**,
- on an account linked to that card.

If found: link the two rows and **post nothing from the card side**; the bank row already carries the
`Dr AP – card / Cr Bank` entry. If not found: post the card side as `Dr AP – card / Cr Bank Suspense` and
flag it, so that when the bank file is imported later the match can be made and the suspense cleared.

The same rule applies symmetrically to account-to-account transfers (row 12).

### 7.3 Worked example

Sooz Foods LLC, week of 2026-06-01. Two source files: Chase business checking and the Amex business card.
Opening `AP – Amex` balance from the prior statement: **1,341.00 credit**.

**From the Chase business checking CSV**

| # | Row | Entry |
|---|---|---|
| A | `06/02/2026, SHOPIFY DES:PAYOUT, +12,480.35` | Dr **Bank** 12,480.35 / Cr **Channel Clearing – Shopify** 12,480.35 |
| B | `06/03/2026, UNFI DES:REMITTANCE, +18,342.60` against invoices totalling 20,150.00 | Dr **Bank** 18,342.60 · Dr **Deductions Receivable** 1,807.40 / Cr **AR** 20,150.00 |
| C | `06/04/2026, PACIFIC FOODS CO-PACK, -24,600.00` (bill already accrued) | Dr **AP** 24,600.00 / Cr **Bank** 24,600.00 |
| D | `06/05/2026, SHIPBOB INC, -3,118.42` (not accrued) | Dr **Fulfillment Fees** 3,118.42 / Cr **Bank** 3,118.42 |
| E | `06/08/2026, AMERICAN EXPRESS ACH PMT, -9,725.18` | Dr **AP – Amex** 9,725.18 / Cr **Bank** 9,725.18 |
| F | `06/08/2026, MONTHLY SERVICE FEE, -95.00` | Dr **Processing Fees** 95.00 / Cr **Bank** 95.00 |
| G | `06/10/2026, CA DEPT TAX & FEE ADMIN, -2,411.07` | Dr **Sales Tax Payable** 2,411.07 / Cr **Bank** 2,411.07 |

**From the Amex business card CSV** (remember: Amex charges are **positive**, so negate to reach the
liability-increase direction)

| # | Row | Entry |
|---|---|---|
| H | `06/01/2026, META PLATFORMS, 4,212.66` | Dr **Advertising Expense** 4,212.66 / Cr **AP – Amex** 4,212.66 |
| I | `06/03/2026, ORGANIC OAT SUPPLY CO, 3,980.00` | Dr **Inventory** 3,980.00 / Cr **AP – Amex** 3,980.00 |
| J | `06/05/2026, KLAVIYO, 512.00` | Dr **Advertising Expense** 512.00 / Cr **AP – Amex** 512.00 |
| K | `06/06/2026, ORGANIC OAT SUPPLY CO, -320.48` (return) | Dr **AP – Amex** 320.48 / Cr **Inventory** 320.48 |
| L | `06/09/2026, PAYMENT THANK YOU, -9,725.18` | **Suppressed** — matched to row E per §7.2. Posts nothing. |

**Trial balance for the batch**

| Account | Debit | Credit |
|---|---|---|
| Bank | 30,822.95 | 39,949.67 |
| AR | | 20,150.00 |
| Deductions Receivable | 1,807.40 | |
| AP | 24,600.00 | |
| AP – Amex | 10,045.66 | 8,704.66 |
| Channel Clearing – Shopify | | 12,480.35 |
| Fulfillment Fees | 3,118.42 | |
| Processing Fees | 95.00 | |
| Sales Tax Payable | 2,411.07 | |
| Advertising Expense | 4,724.66 | |
| Inventory | 3,980.00 | 320.48 |
| **Total** | **81,605.16** | **81,605.16** |

**Balanced.** ✅

**Control check on `AP – Amex`:** opening credit 1,341.00 + charges 8,704.66 − payment 9,725.18 −
refund-driven debit 320.48 … = 1,341.00 + 8,384.18 − 9,725.18 = **0.00**. The card is paid in full, which
is exactly what the statement says. If this control does not land on the statement's closing balance, the
card file and the bank file disagree and the import should say so.

**Where the remaining accounts come from (context — the bank parser does NOT emit this).** When the
Shopify settlement file for the same payout is imported, it relieves the clearing account created by row A:

| Account | Debit | Credit |
|---|---|---|
| Channel Clearing – Shopify | 12,480.35 | |
| Contra-Revenue – Discounts | 615.00 | |
| Processing Fees | 468.19 | |
| Fulfillment Fees | 1,204.80 | |
| Gross Sales – Shopify DTC | | 13,706.34 |
| Sales Tax Payable | | 1,062.00 |
| **Total** | **14,768.34** | **14,768.34** |

…plus the fulfilment entry `Dr COGS 4,798.72 / Cr Inventory 4,798.72`. `Channel Clearing – Shopify` now
nets to zero, which is the signal that both halves arrived.

---

## 8. Realistic sample files

**Every file below is SYNTHETIC.** Merchants, amounts, names, card fragments and reference numbers are
invented. Structure, quoting, row order, preambles and sign conventions match real exports and are safe to
use as parser fixtures.

### 8.1 `chase_business_checking.csv` — newest first, trailing comma in header, running balance

```csv
Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #,
DEBIT,06/17/2026,CARD PURCHASE 06/16 FEDEX SHIP CTR SAN FRANCISCO CA CARD 4417,-347.80,DEBIT_CARD,22260.33,,
DSLIP,06/16/2026,DEPOSIT  1234567,2180.00,DEPOSIT,22608.13,1234567,
DEBIT,06/15/2026,ORIG CO NAME:GUSTO ORIG ID:9426036891 DESC DATE:260615 CO ENTRY DESCR:GUSTO PAY,-14382.91,ACH_DEBIT,20428.13,,
DEBIT,06/12/2026,"ONLINE DOMESTIC WIRE TRANSFER VIA: SWEETGRAIN PACKAGING CO, REF: INV 20260610",-8750.00,WIRE_OUTGOING,34811.04,,
CREDIT,06/11/2026,ORIG CO NAME:AMAZON.COM ORIG ID:9414447890 DESC DATE:260611 CO ENTRY DESCR:SETTLEMENT,7914.22,ACH_CREDIT,43561.04,,
DEBIT,06/10/2026,ORIG CO NAME:CA DEPT TAX FEE ORIG ID:2822162215 CO ENTRY DESCR:SALES TAX,-2411.07,ACH_DEBIT,35646.82,,
CREDIT,06/09/2026,ONLINE TRANSFER FROM SAV ...5678 TRANSACTION#: 21334455,5000.00,ACCT_XFER,38057.89,,
DEBIT,06/08/2026,MONTHLY SERVICE FEE,-95.00,FEE_TRANSACTION,33057.89,,
DEBIT,06/08/2026,ORIG CO NAME:AMERICAN EXPRESS ORIG ID:9493560001 CO ENTRY DESCR:ACH PMT,-9725.18,ACH_DEBIT,33152.89,,
CHECK,06/05/2026,CHECK # 1043,-1250.00,CHECK_PAID,42878.07,1043,
DEBIT,06/04/2026,ORIG CO NAME:PACIFIC FOODS CO ORIG ID:1204885532 CO ENTRY DESCR:INV 8841,-24600.00,ACH_DEBIT,44128.07,,
CREDIT,06/03/2026,ORIG CO NAME:UNFI ORIG ID:9110001122 DESC DATE:260603 CO ENTRY DESCR:REMITTANCE,18342.60,ACH_CREDIT,68728.07,,
DEBIT,06/02/2026,CARD PURCHASE 06/01 USPS PO 0561 SAN FRANCISCO CA CARD 4417,-184.65,DEBIT_CARD,50385.47,,
CREDIT,06/02/2026,ORIG CO NAME:SHOPIFY ORIG ID:9000012345 DESC DATE:260602 CO ENTRY DESCR:PAYOUT,12480.35,ACH_CREDIT,50570.12,,
DEBIT,06/01/2026,ORIG CO NAME:SHIPBOB INC ORIG ID:1330008877 CO ENTRY DESCR:INV 55120,-3118.42,ACH_DEBIT,38089.77,,
```

*Fixture assertions:* 15 rows; implied opening balance 41,208.19 and closing balance 22,260.33 (net
movement **−18,947.86**). Because the file is newest-first, the recurrence to test is
`Balance[i] = Balance[i+1] + Amount[i]` — i.e. each row's balance equals the balance of the row *below* it
plus that row's own amount. `Check or Slip #` is populated on exactly 2 rows (the `CHECK` and the `DSLIP`).
The two `06/02/2026` rows and the two `06/08/2026` rows exercise same-day ordering.

### 8.2 `chase_business_card.csv` — purchases negative, payments positive, no balance

```csv
Transaction Date,Post Date,Description,Category,Type,Amount,Memo
06/16/2026,06/17/2026,AMAZON WEB SERVICES,Professional Services,Sale,-812.44,
06/15/2026,06/16/2026,AUTOMATIC PAYMENT - THANK YOU,,Payment,3214.90,
06/14/2026,06/15/2026,UPS* 000000W12345,Shipping,Sale,-246.18,
06/12/2026,06/14/2026,SQ *BAY AREA COFFEE ROAST,Food & Drink,Sale,-38.75,
06/11/2026,06/12/2026,SWEETGRAIN PACKAGING CO,Merchandise,Sale,-1420.00,
06/10/2026,06/11/2026,UPS* 000000W12345,Shipping,Return,62.40,
06/09/2026,06/10/2026,GOOGLE *ADS 8823941,Advertising,Sale,-2105.33,
06/07/2026,06/09/2026,CHASE INK ANNUAL FEE,Fees & Adjustments,Fee,-95.00,
06/06/2026,06/08/2026,FOREIGN TRANSACTION FEE,Fees & Adjustments,Adjustment,-12.88,
06/05/2026,06/06/2026,CANVA* 04521883,Professional Services,Sale,-54.00,
06/03/2026,06/04/2026,WHOLE FOODS MKT #10238,Groceries,Sale,-186.22,
06/02/2026,06/03/2026,DOORDASH*BAY GRAIN CO,Food & Drink,Sale,-72.10,
```

*Fixture assertions:* 12 rows; `Type` values exercise `Sale`/`Payment`/`Return`/`Fee`/`Adjustment`;
`Category` empty on the `Payment` row; `Memo` empty everywhere.

### 8.3 `bofa_business_checking.csv` — 5-line preamble, blank line, header on line 7, ascending

```csv
Description,,Summary Amt.
Beginning balance as of 06/01/2026,,8412.55
Total credits,,18432.24
Total debits,,-11854.54
Ending balance as of 06/17/2026,,14990.25

Date,Description,Amount,Running Bal.
06/01/2026,Beginning balance as of 06/01/2026,,"8,412.55"
06/02/2026,SQUARE INC DES:250602P2 ID:L4XXXX1234 INDN:SOOZ FOODS LLC CO ID:9424300002 CCD,"1,942.18","10,354.73"
06/03/2026,FAIRE WHOLESALE DES:PAYOUT ID:FW88213 INDN:SOOZ FOODS LLC CO ID:1455512340 CCD,"3,688.40","14,043.13"
06/04/2026,ADOBE  *ADOBE 408-536-6000 CA 06/03,-59.99,"13,983.14"
06/05/2026,CHECKCARD 0604 USPS PO 0561 SAN FRANCISCO CA 24692166155000000000000,-212.40,"13,770.74"
06/08/2026,AMERICAN EXPRESS DES:ACH PMT ID:W1234567890 INDN:SOOZ FOODS LLC CO ID:1133133497 WEB,"-4,118.00","9,652.74"
06/09/2026,WIRE TYPE:WIRE OUT DATE:260609 TIME:1132 ET TRN:2026060900123456 SVC REF:009876 BNF:GOLDEN VALLEY MILLS,"-6,200.00","3,452.74"
06/10/2026,Online Banking transfer from CHK 4455 Confirmation# 9182736455,"7,500.00","10,952.74"
06/11/2026,BKOFAMERICA ATM 06/11 #000001234 WITHDRWL SAN FRANCISCO CA,-300.00,"10,652.74"
06/12/2026,MONTHLY MAINTENANCE FEE,-29.95,"10,622.79"
06/15/2026,SHOPIFY DES:PAYOUT ID:SHP20260615 INDN:SOOZ FOODS LLC CO ID:9000012345 CCD,"5,301.66","15,924.45"
06/16/2026,Zelle payment to MARISOL Q Conf# xk8812hd4,-850.00,"15,074.45"
06/17/2026,PURCHASE 06/16 SQ *COLD BREW CO SAN FRANCISCO CA,-84.20,"14,990.25"
```

*Fixture assertions:* the parser must find the header on **physical line 7**; must drop the
`Beginning balance` row (empty `Amount`); must import **exactly 12** transactions — **not 13** (counting
the beginning-balance row) and **not 17** (counting the four preamble rows as data). Amounts are quoted
with thousands separators. Control totals tie: `8,412.55 + 18,432.24 − 11,854.54 = 14,990.25`, and
`Running Bal.` is consistent row by row in ascending order.

### 8.4 `amex_business_card.csv` — 13 columns, charges POSITIVE, multi-line `Extended Details`

```csv
Date,Description,Card Member,Account #,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category
06/16/2026,META PLATFORMS INC,SUSANNA R OKONKWO,-31005,4212.66,"MET*8812349021
META PLATFORMS INC
MENLO PARK
CA
Description : ADVERTISING Price : 0.00","META PLATFORMS INC        MENLO PARK           CA","1 HACKER WAY","MENLO PARK
CA",94025-1456,UNITED STATES (USA),320261670001122334,Business Services-Advertising Services
06/15/2026,KLAVIYO INC,SUSANNA R OKONKWO,-31005,512.00,"KLA*0045218833
KLAVIYO INC
BOSTON
MA","KLAVIYO INC               BOSTON               MA","125 SUMMER ST","BOSTON
MA",02110-1615,UNITED STATES (USA),320261660002233445,Business Services-Internet Services
06/14/2026,ORGANIC OAT SUPPLY CO,DEVON T ACHEBE,-41002,3980.00,"OOS 503-555-0184
ORGANIC OAT SUPPLY CO
PORTLAND
OR
Description : FOOD INGREDIENTS Price : 0.00","ORGANIC OAT SUPPLY CO     PORTLAND             OR","1398 SE DIVISION ST","PORTLAND
OR",97202-1188,UNITED STATES (USA),320261650003344556,Merchandise & Supplies-Groceries
06/13/2026,ORGANIC OAT SUPPLY CO,DEVON T ACHEBE,-41002,-320.48,"CREDIT - RETURNED GOODS
ORGANIC OAT SUPPLY CO
PORTLAND
OR","ORGANIC OAT SUPPLY CO     PORTLAND             OR","1398 SE DIVISION ST","PORTLAND
OR",97202-1188,UNITED STATES (USA),320261640004455667,Merchandise & Supplies-Groceries
06/12/2026,UPS SHIP 000000W12345,SUSANNA R OKONKWO,-31005,246.18,"UPS 800-811-1648
UPS SHIP
ATLANTA
GA","UPS* 000000W12345         ATLANTA              GA","55 GLENLAKE PKWY NE","ATLANTA
GA",30328-3474,UNITED STATES (USA),320261630005566778,Transportation-Other Transportation
06/11/2026,SWEETGRAIN PACKAGING CO,DEVON T ACHEBE,-41002,1420.00,"SWG 312-555-0110
SWEETGRAIN PACKAGING CO
CHICAGO
IL","SWEETGRAIN PACKAGING CO   CHICAGO              IL","900 W FULTON MKT","CHICAGO
IL",60607-1225,UNITED STATES (USA),320261620006677889,Merchandise & Supplies-Wholesale Stores
06/10/2026,AMAZON WEB SERVICES,SUSANNA R OKONKWO,-31005,812.44,"AWS 206-266-4064
AMAZON WEB SERVICES
SEATTLE
WA","AMAZON WEB SERVICES       SEATTLE              WA","410 TERRY AVE N","SEATTLE
WA",98109-5210,UNITED STATES (USA),320261610007788990,Business Services-Internet Services
06/09/2026,PAYMENT RECEIVED - THANK YOU,,,-9725.18,"ELECTRONIC PAYMENT RECEIVED","AUTOPAY PAYMENT - THANK YOU","","",,,320261600008899001,
06/08/2026,SHIPBOB INC,DEVON T ACHEBE,-41002,3118.42,"SBB 312-555-0177
SHIPBOB INC
CHICAGO
IL","SHIPBOB INC               CHICAGO              IL","224 N DESPLAINES ST","CHICAGO
IL",60661-1109,UNITED STATES (USA),320261590009900112,Business Services-Other Services
06/06/2026,SQ *BAY AREA COFFEE ROAST,SUSANNA R OKONKWO,-31005,38.75,"SQ 855-700-6000
SQ *BAY AREA COFFEE ROAST
SAN FRANCISCO
CA","SQ *BAY AREA COFFEE ROAST SAN FRANCISCO       CA","1200 VALENCIA ST","SAN FRANCISCO
CA",94110-3729,UNITED STATES (USA),320261570001011223,Restaurant-Restaurant
06/05/2026,CANVA PTY LTD,SUSANNA R OKONKWO,-31005,54.00,"CANVA I04521883
CANVA PTY LTD
SURRY HILLS
NSW","CANVA* 04521883           SURRY HILLS          NSW","110 KIPPAX ST","SURRY HILLS
NSW",2010,AUSTRALIA (AUS),320261560002122334,Business Services-Internet Services
06/04/2026,FOREIGN TRANSACTION FEE,SUSANNA R OKONKWO,-31005,1.62,"FOREIGN TRANSACTION FEE","FOREIGN TRANSACTION FEE","","",,,320261550003233445,Fees & Adjustments-Fees & Adjustments
06/03/2026,UNITED AIRLINES,DEVON T ACHEBE,-41002,684.20,"0162483991002
UNITED AIRLINES
CHICAGO
IL
Passenger Name : ACHEBE/DEVON
Departure Date : 06/22/2026
From : SFO
To : ORD","UNITED     0162483991     CHICAGO              IL","233 S WACKER DR","CHICAGO
IL",60606-6314,UNITED STATES (USA),320261540004344556,Travel-Airline
06/02/2026,GOOGLE *ADS 8823941,SUSANNA R OKONKWO,-31005,2105.33,"GOOGLE *ADS 8823941
GOOGLE LLC
MOUNTAIN VIEW
CA","GOOGLE *ADS 8823941       MOUNTAIN VIEW        CA","1600 AMPHITHEATRE PKWY","MOUNTAIN VIEW
CA",94043-1351,UNITED STATES (USA),320261530005455667,Business Services-Advertising Services
```

*Fixture assertions:* **14 logical rows but 60+ physical lines** — the single most valuable property of
this fixture. A parser that splits on `\n` will fail it. Charges are positive; the payment row is negative;
`Account #` values are text beginning with `-`; `Reference` is unique per row; `Card Member` is empty on
the payment row; one row has an Australian address and a 4-digit postcode.

### 8.5 `mercury.csv` — `MM-DD-YYYY` dates, UTC timestamps, mixed accounts, pending rows

```csv
Date (UTC),Description,Amount,Status,Source Account,Bank Description,Reference,Note,Last Four Digits,Name On Card,Category,GL Code,Timestamp,Original Currency
06-17-2026,Amazon Web Services,-812.44,Sent,Mercury Credit,AMAZON WEB SERVICES AWS.AMAZON.CO WA,,,0912,Susanna Okonkwo,Software,,06-17-2026 04:12:08,USD
06-16-2026,Shopify,12480.35,Sent,Mercury Checking xx1234,SHOPIFY; PAYOUT SHP20260616; SOOZ FOODS LLC,,,,,,,06-16-2026 13:02:44,
06-16-2026,Golden Valley Mills,-6200.00,Pending,Mercury Checking xx1234,Send Money transaction initiated on Mercury,PO 20260610 oat flour,,,,,,06-16-2026 21:44:19,
06-15-2026,Gusto,-14382.91,Sent,Mercury Checking xx1234,GUSTO; PAY 8812349; Sooz Foods LLC,,,,,,,06-15-2026 11:30:02,
06-14-2026,Klaviyo,-512.00,Sent,Mercury Credit,KLAVIYO INC BOSTON MA,,,0912,Susanna Okonkwo,Software,6210,06-14-2026 02:55:31,USD
06-13-2026,Meta Platforms,-4212.66,Sent,Mercury Credit,FACEBK *8812349021 MENLO PARK CA,,,0912,Susanna Okonkwo,Advertising,6210,06-13-2026 06:18:57,USD
06-12-2026,Canva,-54.00,Sent,Mercury Credit,CANVA* 04521883 SURRY HILLS,,,0912,Susanna Okonkwo,Software,,06-12-2026 09:41:23,AUD
06-11-2026,Devon Achebe,-2500.00,Sent,Mercury Checking xx1234,Send Money transaction initiated on Mercury,June contractor invoice,Approved by SO,,,,,06-11-2026 16:08:15,
06-10-2026,Sweetgrain Packaging Co,-1420.00,Failed,Mercury Checking xx1234,Send Money transaction initiated on Mercury,INV 20260610,Insufficient vendor detail,,,,,06-10-2026 18:22:40,
06-09-2026,UNFI,18342.60,Sent,Mercury Checking xx1234,UNFI; REMITTANCE 0609; SOOZ FOODS LLC,,,,,,,06-09-2026 14:07:33,
06-08-2026,Transfer to Mercury Savings,-25000.00,Sent,Mercury Checking xx1234,Internal transfer to Mercury Savings xx5678,,,,,,,06-08-2026 20:15:00,
06-08-2026,Transfer from Mercury Checking,25000.00,Sent,Mercury Savings xx5678,Internal transfer from Mercury Checking xx1234,,,,,,,06-08-2026 20:15:00,
06-05-2026,Interest Payment,41.88,Sent,Mercury Savings xx5678,Interest earned on Mercury Savings,,,,,,,06-05-2026 07:00:00,
06-03-2026,Shipbob,-3118.42,Sent,Mercury Checking xx1234,SHIPBOB INC; INV 55120; Sooz Foods LLC,,,,,,,06-03-2026 15:33:11,
```

*Fixture assertions:* 14 rows, of which **12 are `Sent` and must import**, 1 `Pending` and 1 `Failed` must
be skipped. Three distinct `Source Account` values. The two `06-08-2026 20:15:00` rows are the two halves
of one internal transfer and must be matched, not double-posted. The `AUD` row exercises
`Original Currency`. `06-12-2026` parsed as `%d-%m-%Y` would silently yield 12 December — the test should
assert **12 June**.

### 8.6 `ramp_transactions.csv` — Ramp default 12-column export

```csv
Merchant Name,Ramp Category,Transaction Date,User,Ramp Department,Ramp Location,Card Last 4,Card Display Name,Amount,Original Currency Amount,Original Currency Code,Conversion Rate
Meta Platforms,Advertising,06/16/2026,Susanna Okonkwo,Marketing,SF HQ,4417,Marketing - Paid Social,4212.66,4212.66,USD,1.0
Google Ads,Advertising,06/15/2026,Susanna Okonkwo,Marketing,SF HQ,4417,Marketing - Paid Search,2105.33,2105.33,USD,1.0
Klaviyo,Software,06/14/2026,Susanna Okonkwo,Marketing,SF HQ,4417,Marketing - Paid Social,512.00,512.00,USD,1.0
Amazon Web Services,Software,06/13/2026,Devon Achebe,Engineering,Remote,8820,Infra,812.44,812.44,USD,1.0
Sweetgrain Packaging Co,Merchandise,06/12/2026,Devon Achebe,Operations,Remote,8820,Ops - Packaging,1420.00,1420.00,USD,1.0
Shipbob,Shipping,06/11/2026,Devon Achebe,Operations,Remote,8820,Ops - 3PL,3118.42,3118.42,USD,1.0
Canva,Software,06/10/2026,Susanna Okonkwo,Marketing,SF HQ,4417,Marketing - Paid Social,54.00,82.15,AUD,0.6573
UPS,Shipping,06/09/2026,Devon Achebe,Operations,Remote,8820,Ops - 3PL,246.18,246.18,USD,1.0
UPS,Shipping,06/08/2026,Devon Achebe,Operations,Remote,8820,Ops - 3PL,62.40,62.40,USD,1.0
Organic Oat Supply Co,Merchandise,06/05/2026,Devon Achebe,Operations,Remote,8820,Ops - Ingredients,2388.00,2388.00,USD,1.0
Organic Oat Supply Co,Merchandise,06/05/2026,Devon Achebe,Operations,Remote,8820,Ops - Ingredients,1592.00,1592.00,USD,1.0
Bay Area Coffee Roasters,Meals,06/03/2026,Susanna Okonkwo,Marketing,SF HQ,4417,Marketing - Paid Social,38.75,38.75,USD,1.0
```

*Fixture assertions:* **the `62.40` UPS row on 06/08 is a refund and is positive** — indistinguishable from
a charge without the refunds-as-negative setting. The test should assert that the importer flags it rather
than silently booking it as expense. The two 06/05 `Organic Oat Supply Co` rows are a **split transaction**
summing to 3,980.00 — the parent must not also be imported. The `AUD` row exercises `Conversion Rate`. No
posting date, no transaction id.

### 8.7 `brex_transactions.csv` — one plausible template; headers are tenant-configurable

```csv
Transaction Date,Posted Date,Merchant,Amount,Currency,User,Card Last Four,Memo,Budget,Department,GL Account,Expense ID
06/16/2026,06/17/2026,Meta Platforms,4212.66,USD,Susanna Okonkwo,0912,June paid social,Marketing,Marketing,6210 Advertising,expense_cu8h2k9m4p
06/15/2026,06/16/2026,Google Ads,2105.33,USD,Susanna Okonkwo,0912,June paid search,Marketing,Marketing,6210 Advertising,expense_cu7g1j8l3n
06/14/2026,06/15/2026,Klaviyo,512.00,USD,Susanna Okonkwo,0912,Email platform,Marketing,Marketing,6220 Software,expense_cu6f0h7k2m
06/13/2026,06/14/2026,Amazon Web Services,812.44,USD,Devon Achebe,4455,Infra,Engineering,Engineering,6220 Software,expense_cu5e9g6j1l
06/12/2026,06/13/2026,Sweetgrain Packaging Co,1420.00,USD,Devon Achebe,4455,Carton run 20260610,Operations,Operations,1310 Inventory,expense_cu4d8f5h0k
06/11/2026,06/12/2026,Shipbob,3118.42,USD,Devon Achebe,4455,May 3PL invoice,Operations,Operations,6410 Fulfillment,expense_cu3c7e4g9j
06/10/2026,06/11/2026,Sweetgrain Packaging Co,-186.00,USD,Devon Achebe,4455,Credit for short ship,Operations,Operations,1310 Inventory,expense_cu2b6d3f8h
06/09/2026,06/10/2026,UPS,246.18,USD,Devon Achebe,4455,,Operations,Operations,6410 Fulfillment,expense_cu1a5c2e7g
06/06/2026,06/08/2026,Bay Area Coffee Roasters,38.75,USD,Susanna Okonkwo,0912,Retailer meeting,Marketing,Marketing,6510 Meals,expense_cu0z4b1d6f
06/05/2026,06/08/2026,Organic Oat Supply Co,3980.00,USD,Devon Achebe,4455,Oat flour PO 20260605,Operations,Operations,1310 Inventory,expense_cuzy3a0c5e
```

*Fixture assertions:* charges positive, the credit on 06/10 negative; `Expense ID` unique and usable as the
dedup key directly (§10 rule 1); `GL Account` populated, so the importer should prefer it over category
inference. A second Brex fixture with **renamed and reordered headers** should exist to prove the saved-
mapping path works.

### 8.8 `wells_fargo_checking.csv` — NO HEADER ROW, 5 quoted fields, constant `*` in field 2

```csv
"06/17/2026","-347.80","*","","PURCHASE AUTHORIZED ON 06/16 FEDEX SHP 88123456 MEMPHIS TN S304168123456789 CARD 4417"
"06/16/2026","2,180.00","*","","DEPOSIT MADE IN A BRANCH/STORE"
"06/15/2026","-14,382.91","*","","GUSTO PAY 260615 8812349 SOOZ FOODS LLC"
"06/12/2026","-8,750.00","*","","WT FED#02214 SWEETGRAIN PACKAGING /ORG=SOOZ FOODS LLC SRF# 2026061200123456 TRN#260612001234 RFB#INV20260610"
"06/11/2026","7,914.22","*","","AMAZON.COM SETTLEMENT 260611 9414447890 SOOZ FOODS LLC"
"06/10/2026","-2,411.07","*","","CA DEPT TAX FEE SALES TAX 260610 2822162215 SOOZ FOODS LLC"
"06/09/2026","5,000.00","*","","ONLINE TRANSFER REF #IB0KJ3M4N5 FROM BUSINESS SAVINGS XXXXXX5678 ON 06/09/26"
"06/08/2026","-95.00","*","","MONTHLY SERVICE FEE"
"06/08/2026","-9,725.18","*","","AMERICAN EXPRESS ACH PMT 260608 W1234567890 SOOZ FOODS LLC"
"06/05/2026","-1,250.00","*","1043","CHECK # 1043"
"06/04/2026","-24,600.00","*","","PACIFIC FOODS CO INV 8841 260604 1204885532 SOOZ FOODS LLC"
"06/03/2026","18,342.60","*","","UNFI REMITTANCE 260603 9110001122 SOOZ FOODS LLC"
```

*Fixture assertions:* 12 rows, no header, every field quoted, thousands separators inside the quoted
amounts, field 2 is `*` on every row, field 3 populated on exactly one row. A parser that runs
`DictReader` over this file will consume row 1 as a header and import 11 rows — the test must assert 12.

### 8.9 `shape_b_debit_credit.csv` — separate unsigned Debit and Credit columns

```csv
Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-06-16,2026-06-17,4417,META PLATFORMS INC,Other Services,4212.66,
2026-06-15,2026-06-16,4417,PAYMENT THANK YOU,Payment/Credit,,9725.18
2026-06-14,2026-06-15,4417,KLAVIYO INC,Internet,512.00,
2026-06-13,2026-06-14,8820,AMAZON WEB SERVICES,Internet,812.44,
2026-06-12,2026-06-13,8820,SWEETGRAIN PACKAGING CO,Merchandise,1420.00,
2026-06-11,2026-06-12,8820,SHIPBOB INC,Other Services,3118.42,
2026-06-10,2026-06-11,8820,SWEETGRAIN PACKAGING CO,Merchandise,,186.00
2026-06-09,2026-06-10,8820,UPS SHIP 000000W12345,Other Travel,246.18,
2026-06-06,2026-06-08,4417,SQ *BAY AREA COFFEE ROAST,Dining,38.75,
2026-06-05,2026-06-08,8820,ORGANIC OAT SUPPLY CO,Merchandise,3980.00,
```

*Fixture assertions:* ISO dates (the Capital One exception); exactly one of `Debit`/`Credit` populated per
row; `Card No.` must survive as text; canonicalised `signed = credit − debit` gives −4212.66, +9725.18,
−512.00, … ; no row has both columns populated.

### 8.10 `shape_c_amount_type.csv` — Amount plus DEBIT/CREDIT type, amount ALREADY SIGNED

```csv
Date,Description,Category,Type,Amount
2026-06-17,FEDEX SHIP CTR SAN FRANCISCO CA,Shipping,DEBIT,-347.80
2026-06-16,MOBILE DEPOSIT,Deposit,CREDIT,2180.00
2026-06-15,GUSTO PAY 8812349,Payroll,DEBIT,-14382.91
2026-06-12,WIRE OUT SWEETGRAIN PACKAGING,Transfer,DEBIT,-8750.00
2026-06-11,AMAZON SETTLEMENT,Income,CREDIT,7914.22
2026-06-10,CA DEPT TAX FEE SALES TAX,Taxes,DEBIT,-2411.07
2026-06-09,TRANSFER FROM SAVINGS 5678,Transfer,CREDIT,5000.00
2026-06-08,MONTHLY SERVICE FEE,Fees,DEBIT,-95.00
2026-06-08,AMERICAN EXPRESS ACH PMT,Payment,DEBIT,-9725.18
2026-06-03,UNFI REMITTANCE,Income,CREDIT,18342.60
```

*Fixture assertions:* **because `min(Amount) < 0`, the file is already signed and `Type` must NOT be
applied.** A companion fixture identical except with all amounts unsigned should exist to exercise the
other branch of §2.9's rule; the two must produce **identical** journal entries.

---

## 9. Column mapping heuristics

For an unknown bank file. Every rule below is a computable test, not a judgement call. Run them in order.

### 9.1 Which row is the header

1. Decode the file (§6.5), sniff the delimiter (§6.6), and read the **first 25 physical rows** with a
   quote-aware reader configured to tolerate ragged row lengths.
2. Score each row `r` as a header candidate:
   - `nonblank(r)` = fraction of cells that are non-empty. Require **≥ 0.5**.
   - `textual(r)` = fraction of non-empty cells that do **not** parse as a date and do **not** parse as
     money. Require **≥ 0.8**.
   - `short(r)` = fraction of non-empty cells with length ≤ 40. Require **≥ 0.9**.
   - `unique(r)` = distinct non-empty cells ÷ non-empty cells. Require **= 1.0** (duplicate header names
     are a strong sign you are looking at data).
   - `known(r)` = number of cells matching any name in the vocabularies of §9.2–§9.7. Bonus, not a gate.
   - `score = 0.25·nonblank + 0.35·textual + 0.15·short + 0.25·unique + 0.05·min(known, 4)`
3. **Corroborate with the next row.** A candidate is only valid if the row immediately following it has
   the same field count **and** contains ≥ 1 date-parsable cell **and** ≥ 1 money-parsable cell.
4. Among valid candidates, pick the one with the **highest index** (latest in the file) whose score ≥ 0.6.
   Taking the *last* rather than the first is what makes BofA work: `Description,,Summary Amt.` on line 1
   scores below `Date,Description,Amount,Running Bal.` on line 7 (it fails `nonblank`, having two of three
   cells empty) — and even if it scored comparably, the later row wins.
5. **Headerless detection:** if no candidate scores ≥ 0.6 but row 0 itself has ≥ 1 date-parsable and ≥ 1
   money-parsable cell, the file has no header. Switch to positional mode and assign synthetic names
   `col_0…col_n`.
6. Everything above the chosen header row is preamble; everything after the last row whose date column
   parses is footer. Discard both, but **keep them in the import record** for support.

### 9.2 Which column is the date

**Name candidates** (lowercase, strip `.`/`#`/`(…)` and collapse spaces, then exact-match):
`date`, `posting date`, `post date`, `posted date`, `transaction date`, `trans date`, `tran date`,
`value date`, `booking date`, `effective date`, `settlement date`, `completion date`, `run date`,
`activity date`, `date utc`, `datetime`, `timestamp`.

**Value test** (authoritative — a name match that fails this is rejected): ≥ 90% of non-empty cells in the
column parse under **one single** format from §4's try-list. A column where different rows need different
formats is not a date column, it is a description column that happens to contain dates.

**When more than one date column survives:**
- Prefer the one whose name contains `post` or `settle` — the posting date is the book date.
- Chase card: `Post Date` for the ledger, `Transaction Date` retained as `merchant_date` for receipt
  matching.
- Ramp: `Accounting Date` if present overrides `Transaction Date`.
- If neither name disambiguates, pick the column whose values are **later on average**; posting dates lag
  transaction dates.

**Reject** a "date" column whose values are all identical (that is a statement-period stamp, not a
transaction date).

### 9.3 Which column is the description / payee

**Name candidates:** `description`, `payee`, `name`, `merchant`, `merchant name`, `merchant description`,
`transaction description`, `original description`, `details`, `memo`, `narrative`, `particulars`,
`transaction`, `vendor`, `bank description`.

**Value tests, applied to every text column regardless of name:**
- `cardinality = distinct values ÷ row count`. A description column has **cardinality > 0.5** on a real
  file. **This is what saves you from Chase's `Details` column**, which is named like a description but
  holds only `DEBIT`/`CREDIT`/`CHECK`/`DSLIP` — cardinality ≈ 0.0002. **Reject any candidate with ≤ 8
  distinct values.**
- `mean length ≥ 8` characters.
- Not date-parsable, not money-parsable.

**When two columns qualify** (e.g. Mercury's `Description` and `Bank Description`, or Ramp's
`Merchant Name` and `Memo`): use the one with the **greater mean length** as the canonical description and
retain the other as `payee` / `raw_descriptor`. Match rules and fingerprints use the canonical one, but
store both — the raw descriptor is what the user recognises when reconciling.

### 9.4 Which column is the amount

**Name candidates:** `amount`, `transaction amount`, `amt`, `value`, `net amount`, `charge amount`,
`debit/credit`, `money`, `sum`.

**Value test:** ≥ 90% of non-empty cells parse as money after §3.3's normalization pipeline.

**Then apply the balance exclusion in §9.6 before accepting.** A column named `Amount` that passes the
balance recurrence test against another column is still the amount; a column named anything that *is* the
other side of that recurrence is the balance.

**Additional rejections:**
- A money column whose values are **all the same sign** and whose absolute values are **all > 1000** and
  which is **monotonic in at least 70% of consecutive row pairs** is almost certainly a balance.
- A money column with > 60% zeros is a fee/tax sub-column, not the amount.

### 9.5 Which columns are the debit/credit pair

Find two distinct money-parsable columns whose names fall in:
`{debit, credit}`, `{debit amount, credit amount}`, `{amount debit, amount credit}`,
`{withdrawal, deposit}`, `{withdrawals, deposits}`, `{money out, money in}`, `{paid out, paid in}`,
`{charges, payments}`, `{dr, cr}`, `{debits, credits}`.

**Validation gate (mandatory):** count rows where **both** are non-empty and non-zero. If that count
exceeds **2%** of rows, this is **not** a debit/credit pair — abandon the hypothesis and fall back to §9.4.
Without this gate, `Amount` + `Balance` gets mistaken for a pair on files where both are always populated,
and every entry is wrong.

Canonicalise: `signed = credit − debit` (asset convention) or `debit − credit` (liability convention),
selected by the account's `sign_convention`. **Never `abs()` either side** (§3.2).

### 9.6 Which column is a running balance — and why it must never be an amount

**Name candidates:** `balance`, `running bal`, `running bal.`, `running balance`, `ledger balance`,
`available balance`, `closing balance`, `balance after transaction`, `bal`, `account balance`.

**Value test, which overrides the name in both directions.** Sort rows by the detected date, then for each
pair of consecutive rows check:

```
balance[i] − balance[i−1] == amount[i]     (within $0.005)
```

If this holds for **≥ 80%** of consecutive pairs, column `balance` is a running balance and column `amount`
is the amount. Run the test in **both** row orders — a Chase or Wells Fargo file is newest-first, so
untouched the recurrence appears as `balance[i−1] − balance[i] == amount[i]`. Accept either direction; the
direction that matches also tells you the file's sort order, which is worth recording.

If **two** money columns are present and the recurrence holds with the roles swapped, you have them
backwards — swap.

If the recurrence holds for *neither* assignment, do not guess: the file may be filtered (the user exported
only "deposits"), in which case the balance column is real but non-contiguous. Fall back to the name match,
and mark the balance column `unverified`.

**Why a balance must never be treated as an amount.** A balance is a *stock*; an amount is a *flow*.
Posting balances as amounts does not produce a slightly wrong ledger — it produces a catastrophically wrong
one, and it does so quietly:

- Every journal entry gets the value of the **entire account history at that instant** instead of the
  transaction. In the §8.1 sample, the $347.80 FedEx charge posts as **$22,260.33**.
- The errors do not cancel. On that same 15-row sample the true net movement is **−18,947.86**, while the
  sum of the `Balance` column is **+578,363.73** — off by a factor of thirty on two weeks of activity. A
  12-month import would manufacture tens of millions of dollars of phantom activity against a real
  company's P&L.
- Nothing downstream catches it. Double-entry still balances — each phantom entry has a debit and a credit
  — so the trial balance ties and the books look healthy while every number in them is fiction.
- It is hard to unwind. By the time it surfaces (at reconciliation, or at the accountant's desk), thousands
  of entries have been categorised, matched and possibly filed.

Therefore: **a column that passes the balance recurrence test is disqualified from being the amount,
permanently, regardless of its header text.** If the file has a balance column and no column passes the
amount tests, **fail the import with an explicit message** rather than falling back to the balance.

### 9.7 Which column is a reference / check number

**Name candidates:** `check`, `check number`, `check #`, `check or slip #`, `cheque no`, `serial`,
`reference`, `reference number`, `ref`, `ref #`, `confirmation number`, `transaction id`, `trans id`,
`id`, `expense id`.

**Value-shape tests distinguish the two very different things these names cover:**

| Shape | Interpretation |
|---|---|
| Integer-like, 3–8 digits, populated on **< 25%** of rows | **Check number.** Store as `check_number`; include in the fingerprint. |
| Populated on **> 95%** of rows, length ≥ 10, unique across the file (`distinct = row count`) | **Stable transaction id.** Use it as the dedup key directly (§10 rule 1). |
| Populated on > 95% of rows but **not** unique | A batch/file reference, not a row id. Store, do not dedup on. |
| Free text with spaces and mean length > 20 | A user memo (Mercury's `Reference`). Store as `memo`, never as an id. |

Uniqueness is the decisive test. Mercury's `Reference` holds things like `Profit distribution` and would
be a disastrous dedup key; Amex's `Reference` holds `320261670001122334` and is a perfect one. Their
headers are identical.

### 9.8 Output of the mapping stage

The heuristics produce a `ColumnProfile`:

```
{ header_row_index, delimiter, encoding, sort_order,
  date_col, secondary_date_col, description_col, payee_col,
  amount_col | (debit_col, credit_col) | (amount_col, type_col),
  balance_col, check_number_col, reference_col, id_col,
  date_format, sign_convention, confidence }
```

If `confidence < 0.85`, **show the user the inferred mapping over the first 5 parsed rows and let them
correct it** before anything is written. Persist the corrected profile keyed by
`(institution_id, sha256(normalized_header_row))` and reuse it silently thereafter. Re-prompt only when
that hash changes — which is exactly what happens when a bank changes its export format, and is precisely
when you want a human to look.

---

## 10. Fingerprinting for duplicate detection

Users re-import overlapping date ranges constantly — it is the normal way to catch up after a gap. The
importer must make that safe and idempotent.

### 10.1 Layer 0 — whole-file hash

Store `sha256(raw file bytes)` on every import batch. An identical re-upload is detected instantly, before
parsing, and the user gets "you already imported this exact file on 2026-06-18" rather than a diff. Cheap,
and it catches the most common case.

This is a **convenience**, not the safety net. A user who exports a 1-day-longer range gets a different
file hash and must still be deduplicated row by row.

### 10.2 Layer 1 — native id, when one exists

If §9.7 identified a stable id column:

```
fingerprint = sha256(account_id || ":" || native_id)
```

Stop here. This applies to Amex (`Reference`, extended details on), BofA credit card (`Reference Number`),
Brex (`Expense ID`), Ramp (when the id column is enabled), and any aggregator feed. It is exact, survives
description restatements, and needs no occurrence handling.

### 10.3 Layer 2 — natural key

For everything else:

```
natural_key = sha256(
    account_id          + "\x1f" +
    posting_date_iso    + "\x1f" +     # YYYY-MM-DD
    signed_amount_2dp   + "\x1f" +     # "-9725.18"; normalize "-0.00" -> "0.00"
    normalize(description) + "\x1f" +  # per §5
    check_number_or_empty
)
```

Use `\x1f` (unit separator) rather than `|` or `-` so that a description containing the delimiter cannot
collide with a different field split.

**Explicitly excluded, and why:**

| Excluded | Reason |
|---|---|
| Running balance | changes whenever any later transaction posts |
| Category | banks recategorise retroactively; Chase does this weeks later |
| `Type` / `Details` token | restated between pulls |
| Source filename, row index, import timestamp | not properties of the transaction |
| Transaction date, when a posting date exists | the merchant date can be restated; the posting date cannot |
| Cardholder / `Card Member` | absent from some export variants of the same account |

### 10.4 Two genuinely identical transactions on the same day

Two $4.79 coffees at the same shop on the same day are a **real and common** event, and they are
indistinguishable under the natural key. Hashing alone either drops one (data loss, silent) or keeps both
on every re-import (duplicates, compounding). Neither is acceptable.

**Use occurrence ordinals plus set reconciliation.**

1. Within a single parsed file, group rows by `natural_key`, preserving original file row order.
2. Assign each row in a group an ordinal `0, 1, 2, …`. The stored fingerprint is
   `natural_key || "#" || ordinal`.
3. On import, for each `natural_key` present in the file:
   - `M` = number of rows with that key **in the incoming file**
   - `N` = number of rows already in the ledger with that key, **restricted to the file's date range**
   - Insert `max(0, M − N)` new rows, taking the highest-ordinal ones.
   - If `M < N`, do **not** delete anything. Flag the key for review: either the user exported a narrower
     filter, or the bank reversed something.

This is correct in all four cases that matter:

| Case | `M` | `N` | Result |
|---|---|---|---|
| First import, one coffee | 1 | 0 | insert 1 ✓ |
| First import, two identical coffees | 2 | 0 | insert 2 ✓ |
| Re-import of the same range | 2 | 2 | insert 0 ✓ |
| Re-import after a third coffee posted | 3 | 2 | insert 1 ✓ |

**The date-range restriction on `N` is essential.** Without it, a coffee bought on the same day of a
*different month* with an identical description and amount would suppress a legitimate row. Compute the
file's `[min_date, max_date]` from the parsed rows and scope the ledger query to it.

### 10.5 Layer 3 — near-miss guard against restated descriptions

Banks occasionally restate a description between a same-day pull and a next-day pull (`PENDING - SQ
*COFFEE` → `SQ *COFFEE 12345`). The strict key misses and you insert a duplicate.

Also store a **loose key**: `sha256(account_id || date || signed_amount)`.

On a strict-key miss that coincides with a loose-key **hit** whose existing row has no matching strict key,
**do not insert**. Queue the pair for review as "possible restatement", showing both descriptions. This
converts a silent duplicate into a one-click decision. In practice it fires on well under 1% of rows.

### 10.6 Pending vs posted

Pending rows live in a **separate namespace** and are never fingerprinted into the ledger:

- Mercury `Status ∈ {Pending, Failed, Cancelled}` → skipped entirely (§6.9).
- Ramp/Brex rows with an empty clearing/posted date → held, not posted.
- Chase, BofA and Wells Fargo CSVs contain posted rows only, so this does not arise for them.

When the posted version of a held row arrives, it is matched on `(account, amount ±5%, merchant, date
±4 days)` and the held row is discarded, not reconciled — the posted amount is authoritative (tips and
fuel holds change it).

### 10.7 Store the raw row

Alongside every fingerprint, persist the **raw parsed row as a JSON array** plus the `ColumnProfile` id
used to parse it.

The normalization rules in §5 will change — they always do. When they do, you need to recompute
fingerprints for historical rows without asking users to re-upload files they no longer have. Storing the
raw row makes that a migration; not storing it makes it an apology.

---

## Sources

- [Chase — Account Activity quick reference (Chase Connect)](https://www.chase.com/content/dam/chase-ux/documents/commercial-banking/chase-connect/cc_quickguide_account_activity.pdf)
- [Chase — how to upload your CSV & bank statements (Finaloop)](https://help.finaloop.com/en/articles/9306264-chase-how-to-upload-your-csv-bank-statements)
- [Bank of America — how to upload your CSV & bank statements (Finaloop)](https://help.finaloop.com/en/articles/9306344-bank-of-america-how-to-upload-your-csv-bank-statements)
- [Bank of America statement/CSV conversion notes (DocuClipper)](https://www.docuclipper.com/blog/convert-boa-bank-statement-to-excel/)
- [American Express — Download & export transactions (official FAQ)](https://www.americanexpress.com/us/customer-service/faq.download-export-transactions-software.html)
- [American Express Business Blueprint — Can I export my transactions? (official)](https://www.americanexpress.com/en-us/business/blueprint/help-center/business-blueprint/understanding-insights/faq.can-i-export-my-transactions-.html)
- [Mercury — Exporting transaction data (official support)](https://support.mercury.com/hc/en-us/articles/28768700685844-Exporting-transaction-data)
- [beanhub-extract — Mercury extractor and real Mercury CSV fixture](https://github.com/LaunchPlatform/beanhub-extract)
- [Ramp — Export your data to CSV (official support)](https://support.ramp.com/exporting-your-data-to-csv)
- [Ramp — Custom accounting CSV exports (official support)](https://support.ramp.com/custom-accounting-csv-exports)
- [Brex — Documents for your account (official support)](https://www.brex.com/support/documents-for-your-account)
- [Brex — How the Accounting page works (official support)](https://www.brex.com/support/brex-dashboard-accounting-page)
- [Brex — Reporting for your Brex account (official support)](https://www.brex.com/support/brex-reporting)
- [Wells Fargo CSV export overview (MindsBudget)](https://www.mindsbudget.com/guides/export-wells-fargo-transactions-csv)
- [breadbox — bank CSV template table (Chase, BofA, Capital One, Amex, Wells Fargo)](https://github.com/canalesb93/breadbox)
- [budgetui — bank CSV auto-detection rules incl. the Wells Fargo `*` test and the Amex sign inversion](https://github.com/ShaneMarusczak/budgetui)
- [budgery — Amex column list and Amex `.xlsx` sheet/row offsets](https://github.com/EliRibble/budgery)
- [Real BofA-shaped and Chase-shaped CSV fixtures with preamble handling](https://github.com/apatwal/ledger)

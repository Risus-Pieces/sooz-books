# QuickBooks Online → Sooz Books: Full History Migration

**Status:** research spec for implementation. Written 2026-09-17.
**Scope:** one-time migration of Sooz's complete QBO transaction history into Sooz Books
(`accounts`, `journal_entries`, `journal_lines`, `customers`, `vendors`, `invoices`, `bills`).
**Hard requirement:** every historical month's trial balance in Sooz Books must equal QBO's
trial balance for that month, to the cent.

> **Verification note.** Intuit does not publish machine-readable schemas for its *report exports* —
> only for the Reports API. Column names below marked **(API-verified)** come from Intuit developer
> docs; names marked **(UI, verify in your own export)** are the US English report headers as they
> appear in QBO exports and should be confirmed against Sooz's actual file before hard-coding.
> Where sources disagree, both spellings are given. Build the parser to normalize headers
> (trim, collapse internal whitespace, casefold) and match against a set of accepted aliases.

---

## 1. How you get the file

### 1.1 The one bulk export (do this first, it is cheap)

**Settings ⚙ → TOOLS column → Export data** → two tabs, **Reports** and **Lists**, each item a
toggle → **Export to Excel**. Output is a **single `.zip` of `.xlsx` files**, one workbook per
item. The Lists tab covers Customers, Vendors, Employees, Chart of Accounts, Products and Services,
plus non-posting lists (Estimates, Purchase Orders, Recurring Templates, Attachments).

This is the fastest way to get every list in one shot. It does **not** give you the Journal.

### 1.2 The exports that matter, one at a time

| # | What | Exact navigation path | Options that matter |
|---|---|---|---|
| 1 | **Journal report** (the key one) | **Reports → Standard → For my accountant → Journal**. Set **Report period = Custom**, e.g. `01/01/2019` – `12/31/2019`. **Customize → Rows/Columns → Change columns** to add `Adj`, `Created By`, `Last Modified`, `Location`, `Class`, `Product/Service`, `Qty`. **Customize → Rows/Columns → Group by = None**. Then **Export/Print ▾ → Export to Excel**. | **Run it one calendar month at a time**, not one file for all years — see §6. Accounting method (Cash/Accrual) does **not** apply to the Journal; it is always the posted ledger. |
| 2 | **Chart of Accounts** | **Accounting → Chart of accounts → Run Report** (this opens *Account List*) → **Export/Print ▾ → Export to Excel**. Alternative: **Reports → Standard → Account List**. | Turn account numbers on first: **Settings ⚙ → Account and settings → Advanced → Chart of accounts → Enable account numbers = On**, otherwise the `Account #` column is absent. Also set the report filter **Distribution Account = All** and **include inactive**: `Customize → Filter → Status → Active and Inactive` (inactive accounts still carry history). |
| 3 | **Customers** | **Sales/Customers → Customers → export icon (⬆ in box)**, or **Reports → Standard → Customer Contact List**, or the bulk Export data tool. | Include inactive customers (`Customize → Filter → Status`). |
| 4 | **Vendors** | **Expenses → Vendors → export icon**, or **Reports → Standard → Vendor Contact List**. | Same inactive caveat. |
| 5 | **Products & Services** | **Settings ⚙ → LISTS → Products and services → export icon**. Alternative: **Sales → Products & services → More ▾ → Run report → Export to Excel**. | Include inactive. Inventory items carry `Qty On Hand`/`As of Date` that are *current*, not historical. |
| 6 | **Trial Balance, by month** | **Reports → Standard → For my accountant → Trial Balance**. **Customize → Rows/Columns → Columns = Months**, Report period = one full fiscal year. **Accounting method = Accrual**. → Export to Excel. | Run **once per fiscal year with Columns=Months**, and separately **Accounting method = Cash** if Sooz files cash-basis taxes. This is the migration's acceptance test — get it before you write any code. |
| 7 | **General Ledger** | **Reports → Standard → For my accountant → General Ledger**. Customize → Rows/Columns → add `Num`, `Split`. Period = one month. | Use as a cross-check on the Journal, not as the primary source — it has beginning-balance and per-account total rows the Journal does not. |
| 8 | **Transaction List by Date** | **Reports → search box → "Transaction List by Date"**. Period = one month. | One row per **transaction** (not per line). Useful to count transactions and catch any transaction type the Journal dropped. |
| 9 | **A/R Aging Detail** | **Reports → Standard → Who owes you → A/R Aging Detail**. Set **Report period → As of** = the last day of each month you need. | Run **as of each month-end** you intend to tie out. Aging is a point-in-time snapshot and cannot be recomputed from the current one. |
| 10 | **A/P Aging Detail** | **Reports → Standard → What you owe → A/P Aging Detail**, `as of` month-end. | Same. |
| 11 | **Open Invoices** | **Reports → Standard → Who owes you → Open Invoices**, `as of` month-end. | Gives invoice-level open balance; the Journal cannot reconstruct payment↔invoice application (§2.2). |
| 12 | **Unpaid Bills** | **Reports → Standard → What you owe → Unpaid Bills**, `as of` month-end. | Same. |
| 13 | **Audit Log** | **Settings ⚙ → TOOLS → Audit log** → filter (Date Changed range, Users, Events) → **Export to CSV** button, top right. | This is the **only** export in this list that is natively **CSV**; everything else is `.xlsx`. Export in slices — the log is paginated and the CSV reflects the current filter. |
| 14 | **Bank reconciliation reports** | **Settings ⚙ → TOOLS → Reconcile → History by account → View report** for each completed reconciliation. | Needed for the cash tie-out in §7.4. Download each month's PDF/Excel per bank and credit-card account. |

### 1.3 File format reality

- Reports export as **`.xlsx`**, not CSV. Intuit's own support says P&L-style reports cannot be
  exported as CSV because punctuation in report text breaks the format.
- The **new report experience** does offer a CSV option in some regions/versions, and it is bad:
  values are written **as text**, and CSV output carries a **leading stray character before currency
  values** (users report seeing `Â£`, which is UTF-8 `£` decoded as latin-1; US files show the same
  class of mojibake around `$` and non-breaking spaces). Intuit has called this "working as designed."
- **Therefore: export to Excel, and convert to CSV yourself** (or read the `.xlsx` directly with
  `openpyxl`). Reading the `.xlsx` is strictly better — cells keep numeric types and you avoid the
  text/encoding damage entirely. The CSV fixtures in this document exist so the parser has a
  stable text contract and a test suite; production should prefer the workbook.

---

## 2. Columns

### 2.1 Journal report — the primary ledger source

Default US English columns, in report order:

| Exact header text | Type | Example value | Meaning | Required? |
|---|---|---|---|---|
| `Date` | date | `03/05/2026` | Transaction (posting) date. **Blank on continuation lines** of a multi-line transaction. | Yes (on first line of each txn) |
| `Transaction Type` | string enum | `Invoice` | QBO transaction type — see §2.3. **Blank on continuation lines.** | Yes (first line) |
| `Num` | string | `1042` | The transaction's document number (`DocNumber`). Blank for Transfers and most auto-created transactions. Sources also render this header as `No.` in the new report experience. | No |
| `Adj` | `Yes`/blank | `Yes` | Adjusting-journal-entry flag. **Only present when the file is opened by an Accountant user, or after `Customize → Rows/Columns → Change columns → Adj`.** Non-accountant exports frequently omit the column entirely. | No |
| `Name` | string | `Whole Foods Market NE` | The customer / vendor / employee display name — see §2.4. | No |
| `Memo/Description` | string | `March wholesale order` | Line description; falls back to transaction memo. May contain commas, quotes and embedded newlines. | No |
| `Account` | string | `Travel:Meals` | **Full colon path** of the posting account — see §6.3. | **Yes** — a row with a blank `Account` is not a posting line (§6.1) |
| `Debit` | money | `4560.00` | Debit amount, **always positive or blank**. | one of Debit/Credit |
| `Credit` | money | `1920.00` | Credit amount, **always positive or blank**. | one of Debit/Credit |

Optional columns worth adding via `Customize → Rows/Columns → Change columns`:

| Header | Why you want it |
|---|---|
| `Created By`, `Created Date`, `Last Modified By`, `Last Modified` | Provenance; `Created Date` also helps distinguish two same-day, same-amount transactions (§5). |
| `Class`, `Location` | If Sooz uses classes/locations for channel (Shopify / Amazon / Faire / Wholesale), this is your `channel` dimension. **Check this before anything else** — it decides whether channel is derivable at all. |
| `Product/Service`, `Qty`, `Sales Price`, `Rate` | Maps to `journal_lines.product`. |
| `Customer`, `Vendor`, `Employee` | Splits the ambiguous `Name` column into typed columns. **Strongly recommended** — it removes the §2.4 ambiguity entirely. |
| `Split` | The other side(s) of the line, as a display string. Do not parse it; it truncates to `-Split-`. |
| `Taxable Amount`, `Tax Amount`, `Tax Name` | Only meaningful if Automated Sales Tax is on. |
| `Currency`, `Exchange Rate`, `Foreign Debit`, `Foreign Credit`, `Home Debit`, `Home Credit` | **Only appear when Multicurrency is on.** Their presence is your detector (§6.9). |

**API-verified column names** for the same report via `GET /v3/company/{realmId}/reports/JournalReport`
(these are the `ColType`/`columns` parameter values, and are what you would key on if you take the
API path):

`tx_date`, `txn_type`, `doc_num`, `is_adj`, `name`, `memo`, `account_name`, **`debt_amt`** (yes —
Intuit's spelling for *debit* amount; a documented, long-standing typo in the API surface),
`credit_amt`, `subt_nat_amount`, `klass_name`, `dept_name`, `create_by`, `create_date`,
`last_mod_by`, `last_mod_date`, `cust_name`, `vend_name`, `emp_name`, `item_name`, `quantity`, `rate`.
There is a known intermittent defect where `JournalReport` returns rows **missing the `debt_amt` and
`account_name` columns** — if you take the API path, assert both columns exist in every response's
`Columns` block and fail loudly rather than importing a half-sided entry.

### 2.2 The other exports

**Account List (Chart of Accounts)** — headers vary by version; accept both spellings.

| Header (seen as) | Type | Example | Meaning | Required? |
|---|---|---|---|---|
| `Account #` / `Account Number` / `Number` | string | `4100` | Only present when account numbers are enabled. Keep as **string** — leading zeros are real. | No |
| `Account` / `Account Name` / `Account name` | string | `Sales of Product Income` | **Leaf name only** in this export, *not* the colon path. Sub-accounts are indicated by indentation in the xlsx, which is lost in CSV. | Yes |
| `Type` | string enum | `Income` | QBO account **classification/type**: `Bank`, `Accounts receivable (A/R)`, `Other Current Assets`, `Fixed Assets`, `Accounts payable (A/P)`, `Credit Card`, `Other Current Liabilities`, `Long Term Liabilities`, `Equity`, `Income`, `Cost of Goods Sold`, `Expenses`, `Other Income`, `Other Expense`. | Yes |
| `Detail Type` / `Detail type` | string enum | `Sales of Product Income` | QBO sub-classification. Useful for mapping to Sooz Books categories. | Yes |
| `Description` | string | | Free text. | No |
| `Balance` | money | `18412.55` | **Current** balance as of the report date, in QBO's natural sign. Ignore it for migration; it is not a historical figure. | No |

> **Important:** because this export gives leaf names, you **cannot** join it to the Journal's
> `Account` column (which gives `Parent:Child`) by name alone. Fix: also run
> **Reports → Standard → Account List** with **`Customize → Rows/Columns`** and, if available in your
> version, the `Parent account` column; otherwise pull accounts from the API
> (`SELECT * FROM Account`, which returns `Name`, `FullyQualifiedName`, `ParentRef`, `Id`,
> `AcctNum`, `Active`, `Classification`, `AccountType`, `AccountSubType`, `CurrentBalance`).
> `FullyQualifiedName` is exactly the Journal's `Account` string. **This alone is a strong argument
> for using the API for lists** (§8).

**Customer Contact List / Customers export** (Export data tool is the richest): `Customer`,
`Company Name`, `First Name`, `Middle Name`, `Last Name`, `Display Name`, `Print on Check Name`,
`Phone`, `Mobile`, `Fax`, `Other`, `Email`, `Website`, `Street`, `City`, `State`, `ZIP`, `Country`,
`Ship Street`, `Ship City`, `Ship State`, `Ship ZIP`, `Ship Country`, `Tax Code`, `Terms`,
`Note`, `Balance`. The report version is narrower: `Customer`, `Company`, `Phone Numbers`, `Email`,
`Full Name`, `Billing Address`.
**The join key to the Journal is `Display Name`** (what QBO calls the customer), *not* `Full Name`.

**Vendor Contact List**: `Vendor`, `Phone Numbers`, `Email`, `Full Name`, `Address`,
`Account #` (the vendor's account number *with you*, not a GL account), `Taxpayer ID`, `Balance`.
Export-data version adds `Display Name`, `Company Name`, `Terms`, `1099` (`Yes`/blank).

**Products & Services**: `Product/Service Name` (some versions: `Name`), `SKU`, `Type`
(`Inventory` / `Non-inventory` / `Service` / `Bundle`), `Sales Description`, `Sales Price`, `Cost`,
`Taxable` (`Yes`/blank), `Qty On Hand`, `Reorder Point`, `Income Account`, `Expense Account`,
`Inventory Asset Account` (a.k.a. `Asset Account`), `Purchase Description`, `As of Date`.
Note `Income Account` here is a **colon path** (`Sales of Product Income`), matching the Journal.

**Trial Balance**: `Account` (colon path, e.g. `Travel:Meals`), then `Debit`, `Credit`. With
`Columns = Months` the file becomes `Account`, then a `Debit`/`Credit` pair **per month**, with a
merged month label in a row above the Debit/Credit header row (§6.1). Last row is `TOTAL`.

**General Ledger**: `Date`, `Transaction Type`, `Num`, `Name`, `Memo/Description`, `Split`,
`Amount`, `Balance`. Grouped by account, with a bolded account-name row, a `Beginning Balance` row,
and a `Total for <Account Name>` row. **`Amount` is signed** (see §3) — this is the single biggest
difference from the Journal, and the reason the Journal is the primary source.

**A/R Aging Detail**: `Date`, `Transaction Type`, `Num`, `Customer`, `Due Date`, `Amount`,
`Open Balance`. Grouped under bucket header rows `Current`, `1 - 30`, `31 - 60`, `61 - 90`,
`91 and over`, each followed by `Total for <bucket>`.

**A/P Aging Detail**: `Date`, `Transaction Type`, `Num`, `Vendor`, `Due Date`, `Past Due`,
`Amount`, `Open Balance`. Same bucket grouping.

**Open Invoices**: `Date`, `Transaction Type`, `Num`, `Customer`, `Due Date`, `Amount`,
`Open Balance`; grouped by customer with `Total for <Customer>` rows. Payments and credit memos that
are unapplied appear as **negative** `Open Balance` rows under the customer.

**Unpaid Bills**: `Date`, `Transaction Type`, `Num`, `Vendor`, `Due Date`, `Past Due`, `Amount`,
`Open Balance`; grouped by vendor.

**Audit Log CSV**: `Date Changed`, `User`, `Event`, `Name`, `Amount`, `History`. `Event` reads like
`Added Invoice`, `Changed Invoice`, `Deleted Bill Payment`, `Signed in`. `History` is a long
free-text diff that **contains commas and is quoted**; it is the only column that varies wildly in
length. The Audit Log is evidence, not a data source — use it for §6.11 (deleted/voided) only.

### 2.3 How the Journal labels transaction types

`Transaction Type` is a closed set of display strings. The ones a CPG brand will actually see:

`Invoice`, `Payment`, `Sales Receipt`, `Credit Memo`, `Refund`, `Refund Receipt`, `Deposit`,
`Bill`, `Bill Payment (Check)`, `Bill Payment (Credit Card)`, `Vendor Credit`, `Check`, `Expense`,
`Credit Card Charge`, `Credit Card Credit`, `Credit Card Payment`, `Transfer`, `Journal Entry`,
`Inventory Qty Adjustment`, `Inventory Starting Value`, `Purchase Order` *(non-posting, should not
appear)*, `Paycheck`, `Payroll Check`, `Tax Payment`, `Sales Tax Payment`, `Bill Payment`,
`Cash Purchase`, `Charge`, `Transfer of Funds`, `Global Tax Adjustment`, `Deposit Adjustment`.

Parser rule: **do not enumerate.** Store the raw string in `journal_entries.source_type` and treat
an unrecognized type as a warning, not an error — the lines still balance and still post correctly.
Only the *reporting* mapping in §7 cares about the type.

### 2.4 What the `Name` column actually contains

- For customer-facing transactions (`Invoice`, `Payment`, `Sales Receipt`, `Credit Memo`,
  `Refund Receipt`) it is the customer's **Display Name**, generally repeated on every line of the
  transaction including the income and COGS lines.
- For vendor transactions (`Bill`, `Bill Payment (Check)`, `Check`, `Expense`, `Vendor Credit`) it is
  the vendor's Display Name.
- For `Paycheck` it is the employee.
- For `Journal Entry` it is the **per-line** Name, which QBO allows to differ line to line and to be
  blank on some lines of the same entry. This is the case that breaks naive importers that assume
  one name per transaction.
- For `Transfer`, `Deposit` (the bank-side line), `Inventory Qty Adjustment` and
  `Inventory Starting Value` it is usually **blank**.
- Sub-customers render as `Parent:Sub` (`Whole Foods Market:Northeast`), same colon convention as
  accounts. A customer and a vendor can have the **same display name** — QBO permits it across
  lists — so `Name` alone does not tell you which table to join to.

**Recommendation: add the `Customer`, `Vendor` and `Employee` columns via Customize.** They are
mutually exclusive and typed, and they remove all of the above ambiguity. If you cannot, resolve
`Name` by (a) the transaction type's implied entity kind, falling back to (b) exact match against
the Customers list, then the Vendors list, then the Employees list, and log every collision.

### 2.5 Known limitations of the Journal report

1. **Non-posting transactions are excluded** — Estimates, Purchase Orders, Delayed Charges, Delayed
   Credits, Recurring templates. This is correct and desirable; they have no ledger effect.
2. **Payment application is not represented.** When a `Payment` is applied to `Invoice 1042`, the
   Journal shows only `Dr Undeposited Funds / Cr A/R`. Nothing in the export says *which invoice*
   it paid. You **cannot** rebuild `invoices.paid_amount` or an open-item subledger from the Journal
   alone. Use **Open Invoices / Unpaid Bills as of each month-end**, or the API's `LinkedTxn` array
   on Payment/BillPayment. Budget for this — it is the single most common migration failure.
3. **Transfers** appear as one transaction, type `Transfer`, two lines, `Num` blank, `Name` blank.
   They are indistinguishable from a 2-line Journal Entry except by `Transaction Type`.
4. **Credit card payments** are ambiguous by design: paying an Amex from Checking may appear as
   `Credit Card Payment`, as `Transfer`, as `Expense`, or as `Check`, depending purely on which UI
   screen the bookkeeper used. All four produce `Dr Credit Card liability / Cr Bank`. Map on the
   **account pair**, not the type string.
5. **Inventory adjustments** appear as `Inventory Qty Adjustment` (`Dr/Cr Inventory Asset` against
   the chosen adjustment account) and `Inventory Starting Value` (`Dr Inventory Asset /
   Cr Opening Balance Equity`). QBO's **FIFO recalculation** does *not* generate visible ledger
   transactions — it silently restates the COGS amount on existing sales transactions. A Journal
   export run today for March 2023 can therefore differ from one run last year for the same month.
   **Export every month once, snapshot it, and never re-run** (§6.12).
6. **Rows with no account exist.** The grand `TOTAL` row, and — in QuickBooks Desktop's Journal and
   in some new-experience/Advanced builds — a per-transaction subtotal row. Both have a blank
   `Account`. Skipping any row with a blank `Account` handles all of them.
7. **Multi-line transactions repeat nothing.** `Date`, `Transaction Type`, `Num` and (usually)
   `Name` appear on the **first line only**; continuation lines have those cells empty. You must
   **forward-fill** and use "non-empty `Transaction Type`" as the transaction boundary. A transaction
   whose second line happens to carry a value in `Name` is not a new transaction.
8. **There is no transaction ID column.** See §5.
9. **Row caps.** Large single-file exports get truncated or time out. Empirically, export **one
   calendar month at a time**; a month over ~30k lines should be split by half-month.
10. **Deleted transactions are absent, voided transactions are present as zero-amount rows.** A
    voided invoice shows `Dr A/R 0.00 / Cr Income 0.00` with `Memo/Description` containing `Voided`.
    Keep them: they preserve the document number and prove the gap is intentional.

---

## 3. Sign and amount conventions

**Journal report — the good case.**
- Two separate columns, `Debit` and `Credit`.
- **Both are always non-negative.** The unused one is **empty string**, not `0`, not `0.00`.
- **Exception:** a credit memo / refund / negative-quantity line can produce a *negative* value in
  the `Debit` column rather than a positive value in `Credit`. This is real and it appears in
  refund and inventory-adjustment rows. **Normalize:** a negative `Debit` of `-240.00` is a credit
  of `240.00`, and vice versa. Do this before summing anything.
- Excel export: values are true numbers. **CSV export (new experience): values are text**, may carry
  a leading apostrophe, `$`, thousands commas, and the mojibake described in §1.3.
- Parentheses do **not** appear in the Journal's Debit/Credit columns in the Excel export, but do
  appear in the *PDF* and in some CSV renderings of other reports. Handle `(240.00)` → `-240.00`.

**General Ledger, Trial Balance, Aging — the bad case.**
- General Ledger's `Amount` is a **single signed column in the account's natural direction**:
  positive = debit for asset/expense accounts, positive = credit for income/liability/equity
  accounts. Sign flips meaning depending on the account's `Type`. This is why the GL is a
  cross-check, never the source.
- Trial Balance has separate `Debit`/`Credit`, both positive, but a **contra account legitimately
  appears on its "wrong" side** (a contra-revenue account shows in `Debit`). Do not "correct" it.
- `Open Balance` in Open Invoices / Unpaid Bills is positive for amounts owed and **negative for
  unapplied credits and overpayments**.

**Canonical parse function** (apply to every money cell in every QBO export):

```
strip leading apostrophe
strip U+00A0 (non-breaking space) and any U+00C2 mojibake byte
strip currency symbol ($, £, €) and whitespace
if wrapped in ( ) -> negative, strip parens
strip thousands separators (,)
empty or "-" -> None
parse as Decimal, quantize to 2dp, store as integer cents
```

Sooz Books stores `debit_cents` / `credit_cents` as **non-negative integers**, exactly one of which
is non-zero per line. Round-half-up at the cent is never needed here — QBO amounts are already
2-decimal. If a Journal cell ever has 3+ decimals (it can, on `Rate`/`Qty`, never on Debit/Credit),
that is a bug in the column mapping, not a rounding problem.

---

## 4. Date format(s) and timezone

- **US QBO reports: `MM/DD/YYYY`** (`03/05/2026`). Two-digit month and day, zero-padded.
- **UK/AU/CA-English: `DD/MM/YYYY`.** `03/05/2026` is genuinely ambiguous between the two.
  **Do not sniff.** Read the locale from the export's date-range preamble row, which spells the
  month (`March 1-31, 2026` vs `1 - 31 March 2026`), and/or confirm with the user before import.
  Fail hard if any row parses to a date outside the report's stated period.
- Excel export: the cell may arrive as a **real Excel date serial** rather than text. Reading the
  `.xlsx` with `openpyxl` gives you a `datetime.date` and sidesteps the ambiguity entirely — another
  argument for the workbook over CSV.
- **API: ISO `YYYY-MM-DD`** for `TxnDate` (`tx_date`). No time component.
- **Timezone: transaction dates have none.** `TxnDate` is a plain calendar date with no timezone and
  no time. Never apply a timezone conversion to it; a naive `UTC → local` conversion is the classic
  way to shift a month-end transaction into the wrong month and blow the trial balance tie-out.
- **Metadata timestamps do have a timezone, and it is not UTC.** `MetaData.CreateTime` and
  `LastUpdatedTime` (and the Journal's `Created Date` / `Last Modified` columns) are returned in
  **US Pacific time with an explicit offset** (`2026-03-05T14:22:11-08:00`), regardless of the
  company's own time zone setting. The Audit Log, by contrast, displays in the **company's** time
  zone (**Settings ⚙ → Account and settings → Advanced → Other preferences → Time zone**). If you
  ever correlate the two, normalize both to UTC first.
- Store `journal_entries.date` as a `DATE`, not a timestamp.

---

## 5. Identity and deduplication

**There is no stable unique transaction id in any QBO report export.** The Journal report has no
`Id` column and no option to add one. `Num` is a user-editable document number that is blank for
Transfers, duplicated across transaction types (Invoice 1001 and Check 1001 coexist), and reused
after deletion.

### 5.1 If you use report exports

Build a deterministic composite key. At the **transaction** level:

```
qbo_txn_key = sha256( "|".join([
    transaction_type,          # "Invoice"
    txn_date_iso,              # "2026-03-05"
    num or "",                 # "1042"
    name or "",                # "Whole Foods Market NE"
    total_debits_cents,        # 672000  (sum of the transaction's debit lines)
    line_count,                # 5
]))
```

At the **line** level, append the 0-based line ordinal *within the transaction as exported*:

```
qbo_line_key = sha256(qbo_txn_key + "|" + str(ordinal))
```

Store `qbo_txn_key` on `journal_entries` with a **UNIQUE** constraint. A re-import of an overlapping
date range then becomes an upsert that is a no-op. Also add `Created Date` to the report and include
it in the hash if you have it — it disambiguates the genuinely nasty case: two identical-amount,
same-day, same-vendor expenses (e.g. two $3,275.00 Meta charges on 03/12). Without it, you cannot
tell a duplicate row from a duplicate *transaction*, and collapsing them silently loses $3,275.

**Line ordinal is stable but not guaranteed.** QBO renders a transaction's lines in the order
stored, and re-running the same report reproduces it. It is not a contract. Never delete-and-reinsert
lines on re-import; upsert whole transactions atomically.

### 5.2 If you use the API

You get `Id` (stable, per entity type, per realm) and `SyncToken`. The natural key is
`(realm_id, txn_type, id)`. Store it in a `qbo_ref` column on `journal_entries` and you are done —
dedup, re-run safety, and the ability to link back to QBO's UI
(`https://qbo.intuit.com/app/invoice?txnId={id}`) all fall out for free. **This is a real advantage
over report exports** and feeds directly into §8.

### 5.3 Entity dedup

- Customers/vendors: key on **`Display Name`**, exact, case-sensitive, whitespace-trimmed. QBO
  enforces uniqueness of Display Name *within* each of the customer and vendor lists but **not
  across** them — the same name may exist as both. Key `customers` and `vendors` separately.
- Accounts: key on the **fully-qualified colon path**, not the leaf name (§6.3).

---

## 6. Gotchas

### 6.1 Preamble, grouping and footer rows

Every QBO report export begins with non-tabular rows. Typical Journal `.xlsx`:

```
row 1:  Sooz Foods, LLC                      <- company name, from Account and settings
row 2:  JOURNAL                              <- report title, ALL CAPS
row 3:  March 1-31, 2026                     <- date range; also your locale tell (§4)
row 4:  (blank)
row 5:  Date,Transaction Type,Num,...        <- the real header
row 6+: data
last:   TOTAL,,,,,,,88688.25,88688.25        <- grand total, blank Account
```

Detection rule, not a fixed skip count: **the header row is the first row whose cells, normalized,
contain both `date` and `account`.** Row counts differ between the classic and new report
experiences, between regions, and when a report has filters applied (an extra "Filtered by:" row
appears). Never hard-code `skiprows=4`.

- **Trial Balance with `Columns = Months` has a two-level header**: a merged-cell month label row
  (`Jan 2026`, `Feb 2026`, …) above a `Debit`/`Credit` sub-header row. In CSV the merge collapses to
  a value in the first cell and empties after it — **forward-fill the month label across** before
  pairing with the Debit/Credit row.
- **General Ledger, Aging, Open Invoices** have group header rows (`Checking`, `Current`,
  `Whole Foods Market NE`) with all other cells blank, and `Total for X` / `Beginning Balance` rows.
- **Universal skip rule for the Journal: skip any row with a blank `Account`.** It catches the
  TOTAL, any subtotal variant, and any group header.

### 6.2 Multi-line transactions and sparse cells

Covered in §2.5.7. Concretely:

```python
current = None
for row in rows:
    if row["Transaction Type"]:        # non-empty => new transaction starts here
        current = new_entry(row)
    if not row["Account"]:             # TOTAL / subtotal / group header
        continue
    current.add_line(row)
```
Assert `sum(debits) == sum(credits)` **per transaction**, and abort the whole import on the first
failure. A transaction that does not balance means the parser mis-detected a boundary, every time.

### 6.3 Account naming — the top source of silent corruption

- The Journal's `Account` column is the **fully-qualified path**: `Travel:Meals`,
  `Cost of Goods Sold:Freight In`. The Account List export gives only the **leaf** (`Meals`). They
  do not join.
- **QBO rejects `:` inside an account name**, so splitting the path on `:` is safe — but *verify*:
  scan the Account List export for any name containing `:` before relying on it, and check for
  spaces around the colon (QBO emits `Parent:Child` with none; migrated-from-Desktop files and some
  third-party syncs emit `Parent : Child`). Normalize by splitting on `:` and trimming each segment.
- **Two different accounts can present the same leaf name under different parents** —
  `COGS:Freight` and `Shipping:Freight` are distinct accounts that both leaf-render as `Freight`.
  Importing by leaf name merges them and destroys the P&L. **Key `accounts` on the full path.**
- Account names can be **renamed mid-history**. The Journal export always shows the account's
  *current* name, for every historical row. So a March 2021 Journal exported today uses today's
  names. This is actually helpful — it means all your monthly exports agree — but it means the
  migrated ledger will not match a Trial Balance PDF printed in 2021. Tie out against
  **freshly-exported** Trial Balances only.
- `Accounts Receivable (A/R)` and `Accounts Payable (A/P)` include the parenthetical in the name.
  Don't strip it.
- Inactive accounts still carry history and **render with `(deleted)` appended** in some reports
  (`Old Merchant Fees (deleted)`). Strip the suffix and match to the same account; set
  `accounts.active = false`.

### 6.4 Opening Balance Equity

QBO auto-creates **`Opening Balance Equity`** (equity). It receives the offset whenever an account
is created with an opening balance, and whenever an inventory item is created with a starting
quantity (`Inventory Starting Value` transactions). It is a real posted account with real
transactions in the Journal.

**Migrate it as-is.** Do not "clean it up" during migration — if OBE has a residual balance in QBO,
it must have the same residual in Sooz Books or the balance sheet will not tie. Clean-up is a
separate, post-migration, dated journal entry.

### 6.5 Undeposited Funds

`Undeposited Funds` (Other Current Asset) is QBO's payment holding account. Every
`Payment`/`Sales Receipt` that is not deposited directly lands there; a later `Deposit` sweeps it to
the bank. **Migrate it as a normal account.** In Sooz Books' model it plays the same role as
**Channel Clearing** — but keep them distinct: Undeposited Funds is QBO's history, Channel Clearing
is Sooz Books' go-forward concept. Mapping them to one account will make historical months tie but
will confuse anyone reading the ledger later. Map `Undeposited Funds` → a Sooz Books account
`Channel Clearing:Undeposited Funds (QBO legacy)`.

### 6.6 Reconciliation Discrepancies

QBO auto-creates an expense account named **`Reconciliation Discrepancies`** (Intuit's help text and
the UI both also use the phrasing "Reconcile Discrepancies"; the account itself is
`Reconciliation Discrepancies`). QBO writes a Journal Entry to it when a user force-closes a
reconciliation. **Accept both spellings when matching.** These rows are legitimate postings; migrate
them. Their existence is a signal that a month's cash tie-out (§7.4) may already be broken *in QBO*.

### 6.7 Retained Earnings is computed, not posted

This is the most important structural difference between QBO and a conventional double-entry system.

**QBO never posts a year-end closing entry.** There is no transaction anywhere in the Journal that
zeroes income and expense into `Retained Earnings`. Instead, QBO's Balance Sheet *computes* the
`Retained Earnings` line at report time as: the `Retained Earnings` account's own posted balance,
**plus the sum of all income and expense activity from all prior fiscal years**, and shows the
current fiscal year's income/expense separately as `Net Income`.

Consequences for Sooz Books:
1. **Do not** invent closing entries during migration. If you post them, your trial balance will
   double-count: the closing entry *and* the computed roll-forward.
2. Sooz Books must implement the same reporting rule, or it will not reproduce QBO's balance sheet.
   Pick one and be explicit:
   - **(A) Computed, QBO-compatible (recommended).** Never post closing entries. The balance-sheet
     renderer computes `Retained Earnings = posted RE balance + Σ(income − expense) for all fiscal
     years before the report's fiscal year`, and `Net Income = Σ(income − expense) within the report's
     fiscal year to date`. The **trial balance is unaffected** either way — income and expense
     accounts carry their full lifetime balances in the raw TB, which is exactly what QBO's Trial
     Balance report shows too. This makes month-by-month TB comparison an apples-to-apples equality.
   - **(B) Posted closing entries.** Then your TB will *not* match QBO's for any month after the
     first fiscal year end, and you need a reconciling adjustment in the validation. Don't.
3. A user *can* manually post to `Retained Earnings` in QBO (and often has). Those postings are real
   and appear in the Journal. Migrate them. They are the "posted RE balance" term in (A).

### 6.8 Billable expenses

If billable expenses are on (**Account and settings → Expenses → Bills and expenses → Track billable
expenses and items as income**), a billable line posts **twice**, at two different dates, and
the Journal shows both:
1. At purchase: `Dr Expense (or Dr a "Billable Expense" asset) / Cr Bank or A/P`, with the customer
   in `Name` and an internal billable flag not visible in the export.
2. When invoiced: `Dr A/R / Cr Income` on the invoice, and, if the "as income" setting is on, the
   original expense line is **not** reversed.

The Journal export is self-consistent here — both postings are present and both balance — so a
line-by-line import is correct. The trap is *interpretation*: do not "de-duplicate" what looks like
the same cost appearing twice. It isn't; one is cost, one is reimbursement revenue.

### 6.9 Multicurrency

**Confirm it is off before starting**, three ways:
1. **Settings ⚙ → Account and settings → Advanced → Currency → Multicurrency** — should read *Off*.
   Note: **once on, QBO cannot turn it off.** If it is on, this migration is materially harder and
   the spec below is insufficient.
2. The Journal export has **no** `Currency` / `Exchange Rate` / `Foreign Debit` / `Foreign Credit` /
   `Home Debit` / `Home Credit` columns and the Customize → Change columns list does not offer them.
3. API: `GET /v3/company/{realmId}/preferences` → `CurrencyPrefs.MultiCurrencyEnabled` is `false`.

Build the parser to **hard-fail** if it sees any of those columns, rather than silently reading
`Debit` (which in a multicurrency file may be the *foreign* amount).

### 6.10 Encoding and file mechanics

- Excel exports are `.xlsx` (ZIP/OOXML) — despite the filename, some QBO exports are actually
  **`.xls` or even HTML tables with an `.xls` extension** (a long-standing Intuit behavior, and the
  source of Excel's "the file format does not match the extension" warning). **Sniff the magic
  bytes**: `PK\x03\x04` = xlsx, `\xD0\xCF\x11\xE0` = legacy xls (use `xlrd`), `<html`/`<table` =
  HTML masquerading as a spreadsheet (use `pandas.read_html`). Do not trust the extension.
- CSVs you produce from Excel on a Mac may be **Mac Roman** or CRLF; CSVs from QBO's own CSV path
  are UTF-8 **with the latin-1 mojibake of §1.3 baked in**. Read as `utf-8-sig` (strips BOM), fall
  back to `cp1252`, and post-process `Â` before `£`/`$`/`\xa0`.
- Merged cells in the Trial Balance month header (§6.1) read as one value + empties in CSV, and as a
  `MergedCellRange` in `openpyxl` (the non-anchor cells read as `None`).
- **Multi-line `Memo/Description`.** QBO memos can contain embedded `\n`. In CSV they are inside
  quotes and a naive line-based reader will split a transaction in half. Use a real CSV reader with
  `quotechar='"'` and multi-line support; never `split('\n')`.

### 6.11 Deleted, voided and pending

- **Deleted** transactions are simply absent from the Journal. Their only trace is the Audit Log
  (`Deleted Invoice`). You do not need them — they have no ledger effect — but if a month refuses to
  tie, the Audit Log is where you look.
- **Voided** transactions are present with all amounts `0.00` and `Voided` in the memo. Keep them
  (§2.5.10) so the document-number sequence has no unexplained gaps.
- **"Pending" does not exist in the QBO ledger.** Bank-feed transactions in the *For review* tab are
  not posted and never appear in the Journal. This is correct: they are not yet accounting events.
  It also means the Journal will be *short* relative to a bank statement for the most recent weeks —
  expected, not a bug. Draw the migration cut-off at a **closed, reconciled month-end**.
- **The bank feed only ever imported ~90 days of history** when each account was first connected.
  Anything older was entered manually. Irrelevant to this migration (the ledger is the ledger) but
  it explains gaps in early months.

### 6.12 FIFO restatement means exports are not reproducible

Restated from §2.5.5 because it dictates process: QBO recomputes inventory COGS under FIFO
continuously. Editing a 2023 purchase today changes the COGS *amount* on 2023 sales, with **no new
transaction**. Therefore:

- **Export every month's Journal and Trial Balance in a single sitting**, checksum and archive the
  raw files, and treat that snapshot as the migration's source of truth.
- **Freeze QBO** for the duration: **Settings ⚙ → Account and settings → Advanced → Accounting →
  Close the books**, with a password, dated at the migration cut-off. This is not optional; without
  it a single edit mid-migration desynchronizes months you have already validated.

---

## 7. Accounting treatment

### 7.1 The governing principle

**The QBO Journal report is already a general journal.** Every row is already a debit or a credit
against a named account, and every transaction already balances. The migration is therefore
**not** a re-derivation — it is a **transcription plus an account mapping**. Any logic that
"interprets" an invoice into debits and credits is a bug: QBO already did that, and its answer is
the one the historical trial balance reflects.

Concretely, for every Journal transaction group:

```
journal_entries:
  date             <- Date (forward-filled)
  memo             <- transaction-level memo; fall back to first line's Memo/Description
  source_type      <- "qbo_migration"
  source_subtype   <- Transaction Type, verbatim ("Invoice", "Bill Payment (Check)", ...)
  qbo_txn_key      <- §5.1 hash, UNIQUE
journal_lines (one per Journal row with a non-blank Account):
  account          <- map(Account colon-path) -> Sooz Books account
  debit_cents      <- normalized Debit  (negative Debit -> credit_cents, §3)
  credit_cents     <- normalized Credit
  customer         <- Customer column, or Name resolved as customer (§2.4)
  vendor           <- Vendor column, or Name resolved as vendor
  channel          <- Class or Location column, if Sooz uses them; else NULL
  product          <- Product/Service column
```

### 7.2 Account mapping table (QBO account → Sooz Books category)

| QBO account (colon path) | Sooz Books category |
|---|---|
| `Checking`, `Savings`, any `Bank`/`Credit Card` type account | **Bank** |
| `Accounts Receivable (A/R)` | **AR** |
| `Accounts Payable (A/P)` | **AP** |
| `Undeposited Funds`, `Shopify Clearing`, `Amazon Clearing`, `Faire Clearing` | **Channel Clearing** |
| `Sales of Product Income`, `Sales`, any `Income` account, split by `Class`/`Location` | **Gross Sales by channel** |
| `Discounts given`, `Discounts/Refunds Given`, `Trade Spend`, `Promotional Allowances`, `Sales Returns` | **Contra-Revenue** |
| `Sales Tax Payable`, `California Department of Tax and Fee Administration Payable` | **Sales Tax Payable** |
| `Merchant Account Fees`, `Payment Processing Fees`, `Stripe Fees`, `Shopify Payments Fees` | **Processing Fees** |
| `Shipping and Delivery`, `3PL Fees`, `Fulfillment`, `Amazon FBA Fees` | **Fulfillment Fees** |
| `Advertising`, `Advertising/Promotional`, `Marketing:Paid Media` | **Advertising Expense** |
| `Inventory Asset` | **Inventory** |
| `Cost of Goods Sold` and children (`COGS:Freight In`, `COGS:Co-Pack`) | **COGS** |
| `Vendor Deductions Receivable`, `Chargebacks Receivable`, `Other Current Assets:Deductions` | **Deductions Receivable** |
| `Opening Balance Equity` | **Equity:Opening Balance Equity** (migrate as-is, §6.4) |
| `Retained Earnings` | **Equity:Retained Earnings** (posted balance only, §6.7) |
| `Reconciliation Discrepancies` / `Reconcile Discrepancies` | **Expense:Reconciliation Discrepancies** |
| `Inventory Shrinkage` | **COGS:Inventory Shrinkage** |
| everything else | 1:1, preserving `Type`/`Detail Type` → Sooz Books account class |

The mapping must be **total and reviewed**: emit the full list of distinct `Account` strings across
all Journal exports, with row counts and net amounts, and have the accountant sign off before any
import runs. An unmapped account must abort the import, never default to a suspense account.

### 7.3 Per-transaction-type treatment

| QBO `Transaction Type` | Journal rows you will see | Sooz Books entry |
|---|---|---|
| `Invoice` | `Dr A/R`, `Cr Income`, `Dr Discounts given` (if any), `Cr Sales Tax Payable` (if any), `Dr COGS` + `Cr Inventory Asset` (inventory items) | Transcribe verbatim. Also create/update an `invoices` row from the Open Invoices export (§2.2) keyed on `Num`. |
| `Payment` | `Dr Undeposited Funds` (or Bank), `Cr A/R` | Transcribe. Application to specific invoices comes from `LinkedTxn`/Open Invoices, not from here (§2.5.2). |
| `Sales Receipt` | `Dr Undeposited Funds`, `Cr Income`, `Cr Sales Tax Payable`, `Dr COGS`/`Cr Inventory` | Transcribe. No `invoices` row. |
| `Deposit` | `Dr Bank`, `Cr Undeposited Funds` (+ any direct-deposit income lines) | Transcribe. This is the Channel Clearing → Bank sweep. |
| `Credit Memo` / `Refund Receipt` | `Dr Income` (or Contra-Revenue), `Cr A/R` / `Cr Bank`, reversed COGS/Inventory | Transcribe. Watch for the negative-Debit convention (§3). |
| `Bill` | `Dr Expense` or `Dr Inventory Asset`, `Cr A/P` | Transcribe. Create a `bills` row from Unpaid Bills, keyed on `Num`. |
| `Bill Payment (Check)` / `(Credit Card)` | `Dr A/P`, `Cr Bank`/`Cr Credit Card` | Transcribe. |
| `Vendor Credit` | `Cr Expense`/`Cr Inventory Asset`, `Dr A/P` | Transcribe. For trade deductions, the credit side often maps to **Deductions Receivable**. |
| `Expense` / `Check` / `Credit Card Charge` | `Dr Expense`, `Cr Bank`/`Credit Card` | Transcribe. |
| `Transfer` | `Dr Bank A`, `Cr Bank B` | Transcribe. `Num` and `Name` blank — expected. |
| `Credit Card Payment` | `Dr Credit Card`, `Cr Bank` | Transcribe. Identify by account pair, not type string (§2.5.4). |
| `Journal Entry` | arbitrary N lines, per-line `Name` | Transcribe. Preserve `Adj` into a boolean on the entry. |
| `Inventory Qty Adjustment` | `Dr/Cr Inventory Asset` vs adjustment account | Transcribe → Inventory / COGS:Inventory Shrinkage. |
| `Inventory Starting Value` | `Dr Inventory Asset`, `Cr Opening Balance Equity` | Transcribe. |
| `Paycheck` / `Tax Payment` | payroll expense / liability / bank | Transcribe. |

### 7.4 Fully worked example — March 2026

Five transactions from the fixture in §8, traced end to end. All figures balance.

**(a) Invoice 1042 — Whole Foods Market NE, wholesale order, 03/05/2026**

QBO Journal rows → Sooz Books lines:

| Account (QBO) | Sooz Books category | Debit | Credit |
|---|---|---:|---:|
| `Accounts Receivable (A/R)` | AR | 4,560.00 | |
| `Discounts given` | Contra-Revenue | 240.00 | |
| `Sales of Product Income` | Gross Sales by channel — *Wholesale* | | 4,800.00 |
| `Cost of Goods Sold` | COGS | 1,920.00 | |
| `Inventory Asset` | Inventory | | 1,920.00 |
| | **Totals** | **6,720.00** | **6,720.00** |

Reading: gross sales 4,800.00, trade discount 240.00, net receivable 4,560.00; goods relieved from
inventory at 1,920.00 (40% of gross) giving 2,880.00 gross margin before fees. Wholesale food is
exempt, so `Sales Tax Payable` is untouched.

**(b) Payment + Deposit — same customer, 03/18 and 03/20**

| | Account | Debit | Credit |
|---|---|---:|---:|
| Payment 03/18 | Channel Clearing (`Undeposited Funds`) | 4,560.00 | |
| | AR (`Accounts Receivable (A/R)`) | | 4,560.00 |
| Deposit 03/20 | Bank (`Checking`) | 4,560.00 | |
| | Channel Clearing (`Undeposited Funds`) | | 4,560.00 |

Net effect across (a)+(b): AR is flat, Channel Clearing is flat, Bank +4,560.00,
Gross Sales +4,800.00, Contra-Revenue −240.00, Inventory −1,920.00, COGS +1,920.00. Correct.

**(c) Bill 1889-SZ + Bill Payment 2041 — Pacific Co-Pack LLC**

| | Account | Debit | Credit |
|---|---|---:|---:|
| Bill 03/09 | Inventory | 12,500.00 | |
| | AP | | 12,500.00 |
| Bill Payment (Check) 03/28 | AP | 12,500.00 | |
| | Bank (`Checking`) | | 12,500.00 |

AP nets to zero by month-end, so this vendor must **not** appear on the 03/31 A/P Aging Detail —
that is one of the §7.6 assertions.

**(d) Shopify March settlement — Journal Entry `2026-03-SHOP`, 03/31, three lines**

This is the multi-line case the parser must handle (blank `Date`/`Transaction Type`/`Num` on rows
2 and 3).

| Account | Sooz Books category | Debit | Credit |
|---|---|---:|---:|
| `Checking` | Bank | 18,412.55 | |
| `Merchant Account Fees` | Processing Fees | 842.30 | |
| `Shopify Clearing` | Channel Clearing | | 19,254.85 |
| **Totals** | | **19,254.85** | **19,254.85** |

Reading: Shopify held 19,254.85 of DTC orders in clearing, kept 842.30 in processing fees, wired
18,412.55. Gross DTC sales were recognized earlier by the Sales Receipts that credited
`Shopify Clearing`; this entry only settles it.

**(e) Transfer and inventory adjustment, 03/31**

| | Account | Debit | Credit |
|---|---|---:|---:|
| Transfer | Bank (`Savings`) | 25,000.00 | |
| | Bank (`Checking`) | | 25,000.00 |
| Inventory Qty Adjustment | COGS (`Inventory Shrinkage`) | 318.40 | |
| | Inventory (`Inventory Asset`) | | 318.40 |

**Whole-file check.** Summing all 22 posting rows of §8: **total debits 88,688.25 = total credits
88,688.25**, matching the `TOTAL` row. The parser must assert this equality against the file's own
TOTAL row — it is a free, exact checksum on the entire import and catches any dropped row.

### 7.5 Migration sequence

Run strictly in this order. Each step is a hard gate.

1. **Freeze.** Close the books in QBO at the cut-off date, with a password (§6.12). Record the
   cut-off. Announce it.
2. **Confirm multicurrency is off** (§6.9). If on, stop and re-scope.
3. **Snapshot every export in one sitting.** Chart of Accounts, Customers, Vendors, Products &
   Services; Journal per calendar month for all history; Trial Balance per fiscal year with
   `Columns = Months`, both Accrual and Cash; General Ledger per month; Transaction List by Date per
   month; A/R Aging Detail, A/P Aging Detail, Open Invoices, Unpaid Bills **as of each month-end**;
   reconciliation reports per account per month; Audit Log. Checksum and archive. **Never re-export.**
4. **Load `accounts`** from the Chart of Accounts + API `FullyQualifiedName`. Build and get sign-off
   on the mapping table (§7.2). Abort on any unmapped account.
5. **Load `customers` and `vendors`** keyed on Display Name (§5.3).
6. **Load products** (feeds `journal_lines.product` only; Sooz Books does not need QBO's item math).
7. **Import the Journal, one month at a time, oldest first, each month in one transaction.**
   Per-month gates: (a) every transaction balances; (b) the file's TOTAL row equals the sum of
   imported lines; (c) the resulting trial balance for that month matches QBO's (§7.6) **before you
   import the next month**. Do not batch-import ten years and validate at the end — you will not be
   able to localize the break.
8. **Rebuild the AR and AP subledgers** from Open Invoices / Unpaid Bills as-of snapshots
   (`invoices`, `bills`), then tie each month's subledger total to the control account (§7.6).
9. **Validate everything** (§7.6).
10. **Sign off and lock.** Mark all migrated periods closed in Sooz Books. Only then does anyone
    post a new entry.

### 7.6 Validation procedure — how you prove it

This is the deliverable, not an afterthought. Automate all four; a human should read a
pass/fail table, not tick boxes.

**(1) Trial balance, month by month — the primary test.**
For every month from the first month with activity through the cut-off:
- Compute Sooz Books' trial balance as of that month-end: per account, cumulative
  `Σ debit_cents − Σ credit_cents` for all entries with `date <= month_end`.
- Compare to the corresponding column pair of QBO's monthly Trial Balance export.
- **Compare in integer cents.** Compare **per mapped account** — where several QBO accounts map to
  one Sooz Books account, roll the QBO side up before comparing, and show both sides of the rollup.
- Pass condition: **every account, every month, difference == 0.** Not "under a dollar."
- Also assert `Σ debits == Σ credits` on both sides (catches a broken export, not a broken import).

**(2) AR/AP aging tie-out to control accounts.**
For each month-end: `Σ Open Balance` on the A/R Aging Detail must equal the `Accounts Receivable
(A/R)` balance on that month's trial balance. Same for A/P. Do this **on the QBO side first** —
if QBO itself does not tie (it often doesn't, when someone has journal-entried directly into A/R
without a name), you have found a pre-existing QBO defect, and you must reproduce it exactly rather
than fix it. Then assert the same equality on the Sooz Books side, and assert the two subledgers
agree invoice by invoice on `Num` and `Open Balance`.

**(3) Cash tie-out to bank reconciliations.**
For each bank and credit-card account, for each month with a completed QBO reconciliation: Sooz
Books' balance for that account at the reconciliation's statement-ending date must equal the
statement ending balance on QBO's reconciliation report, adjusted for uncleared items. This is the
test that catches date-parsing errors (§4) — a locale-flipped date shifts cash between months while
leaving the annual TB perfectly correct.

**(4) Row-count and transaction-count reconciliation.**
Per month: count of imported `journal_entries` must equal the transaction count on that month's
Transaction List by Date (excluding non-posting types). Count of `journal_lines` must equal the
Journal export's data-row count (excluding blank-`Account` rows). This catches silently dropped
rows that happen to net to zero.

**What to do when a month does not tie**

Work this list in order; the cause is almost always one of the first four.

| Symptom | Likely cause | Action |
|---|---|---|
| One account off by a round amount; another off by the same amount, opposite sign | Two QBO accounts with the same leaf name collapsed into one (§6.3) | Re-key `accounts` on the full colon path. |
| Off by exactly one transaction's amount; adjacent month off the same amount the other way | Date locale flipped (§4), or a timezone applied to `TxnDate` | Re-parse dates; assert all dates fall inside the report's stated period. |
| Income/expense accounts tie, equity does not, starting at a fiscal year boundary | Closing entries were posted (§6.7) | Delete them; switch to computed Retained Earnings. |
| Everything off by a small, non-round amount | Negative `Debit` values not normalized (§3), or a `(1,234.56)` parsed as positive | Fix the money parser; re-run the whole month. |
| A month ties on TB but not on cash | Undeposited Funds / Deposit timing | Check `Deposit` transactions dated in the following month. |
| Difference is under $0.05 and has no explanation | **Not rounding.** QBO amounts are exact to the cent and the Journal balances exactly. | Do **not** plug it. Find it. A tolerated $0.02 today is an unexplained $2,000 after you scale the same bug across ten years. |
| Genuinely irreconcilable after all of the above | A QBO-side defect (a transaction posted to a deleted account, a corrupted multicurrency remnant) | Post a **single, explicitly-labelled, dated** `Migration Variance` entry to a dedicated equity account, documented with the month, amount and investigation notes. It must be visible forever, never buried in a P&L account, and it must be approved by the accountant in writing. |

---

## 8. API vs. report exports — which path for a one-time full-history migration

**Recommendation: a hybrid. Reports API `JournalReport` for the ledger, entity queries for
everything else.** Do not hand-export 120 spreadsheets, and do not rebuild QBO's posting logic
from entities.

| | Report exports (UI) | Entity API (`SELECT * FROM Invoice` …) | **Reports API (`JournalReport`)** |
|---|---|---|---|
| Debits/credits | **Already computed by QBO** | **You must re-derive them** per transaction type | **Already computed by QBO** |
| Stable transaction IDs | None (§5.1 hashing) | `Id` + `SyncToken` | None |
| Payment↔invoice linkage | Only via Aging/Open Invoices snapshots | **`LinkedTxn` — exact** | No |
| Account full paths | Leaf only, must reconstruct | **`FullyQualifiedName` — exact** | Colon path |
| Effort for ~10 years | 12 exports/yr × several reports, all manual, all at once | Large — you reimplement sales tax, discounts, billable expenses, FIFO COGS, payroll | One paginated call per month |
| Encoding/format damage | High (§1.3, §6.10) | None (JSON) | None (JSON) |
| Auditability | Excellent — the exact file an accountant can open | Poor — no human-readable artifact | Good, but archive the JSON |
| Reproducibility | Snapshot once and freeze | Same FIFO caveat (§6.12) | Same FIFO caveat |

**Why not entities alone.** Rebuilding an `Invoice` into debits and credits means reimplementing
QBO's own posting rules: how a discount line posts, how automated sales tax splits by jurisdiction,
how a billable expense posts twice, how a bundle explodes, and — worst — what FIFO cost QBO assigned
to each sale. You would be writing a competing accounting engine and then hoping it agrees with QBO
to the cent for every month since 2019. It will not. **`JournalReport` hands you QBO's answer.**

**Why not entities never.** You need `Id`s, `FullyQualifiedName`, and `LinkedTxn`. Use entity
queries for the lists and for the AR/AP linkage, and `JournalReport` for the ledger.

**Why not UI exports as the primary.** One-time effort is a fair argument for clicking — but the
manual path multiplies the §6.10 format hazards by 120 files, offers no `Id`s at all, and is not
re-runnable when (not if) you need to redo a month. Do still take the UI exports **as the archived
evidence** for §7.6: an accountant validates against a spreadsheet, not a JSON blob.

**API practicalities** (all verified):
- OAuth 2.0; the access token lives 1 hour, the refresh token 100 days. For a one-time migration,
  get a token and script the refresh — do not plan a multi-day run against one token.
- **Rate limits: 500 requests/minute per realm, max 10 concurrent requests per app.** The batch
  endpoint is throttled separately at **40 requests/minute per realm**, and some resource-intensive
  endpoints at 200/min. Over the limit returns HTTP 429 (sometimes 403); implement exponential
  backoff and honor `Retry-After`. At one `JournalReport` call per month, ten years of history is
  ~120 calls — nowhere near the limit. Entity pulls are the ones that need pacing.
- **Pagination: `STARTPOSITION` / `MAXRESULTS`, with `MAXRESULTS` capped at 1000.** Page entity
  queries: `SELECT * FROM Invoice ORDER BY Id STARTPOSITION 1 MAXRESULTS 1000`, then 1001, etc.
  The Reports API does **not** paginate — request one month at a time to keep responses small and
  to avoid timeouts.
- Pin `minorversion` explicitly on every call, and record it in the migration log. Intuit changes
  default behavior across minor versions.
- Assert the `Columns` block of every `JournalReport` response contains `account_name` and
  `debt_amt`; there is a known defect where they go missing (§2.1).
- Archive the raw JSON alongside the UI exports. The migration must be reproducible from the archive
  without touching QBO again.

**A CSV round trip (QBO → CSV → import) is not a path for this.** QBO's own import tools accept
only bank transactions, customers, vendors, chart of accounts, products, invoices and bills — never
a general journal of arbitrary historical transactions — and they impose per-file row limits and
lossy field mapping. It is an import path *into* QBO, not an export path out of it.

---

## 9. A realistic sample file

**SYNTHETIC — invented data for parser tests. Not real Sooz financials.**

QBO Journal report, exported to Excel and saved as CSV. March 2026. Exercises: the 3-row preamble +
blank line before the header, sparse continuation rows (blank `Date`/`Transaction Type`/`Num`), a
5-line invoice with inventory COGS, a 3-line multi-line journal entry, a bill and its payment, a
transfer with blank `Num`/`Name`, a sub-account colon path, an inventory adjustment, a voided
transaction at 0.00, a quoted memo containing a comma, and the grand `TOTAL` row with a blank
`Account`.

Balance check: debits 88,688.25 = credits 88,688.25 (the two voided 0.00 rows contribute nothing).

```csv
Sooz Foods LLC
JOURNAL
March 1-31, 2026

Date,Transaction Type,Num,Adj,Name,Memo/Description,Account,Debit,Credit
03/05/2026,Invoice,1042,,Whole Foods Market NE,"March wholesale order, PO WFM-8871",Accounts Receivable (A/R),4560.00,
,,,,Whole Foods Market NE,Volume discount 5%,Discounts given,240.00,
,,,,Whole Foods Market NE,Sooz Chili Crisp 6oz x 400,Sales of Product Income,,4800.00
,,,,Whole Foods Market NE,Sooz Chili Crisp 6oz x 400,Cost of Goods Sold,1920.00,
,,,,Whole Foods Market NE,Sooz Chili Crisp 6oz x 400,Inventory Asset,,1920.00
03/09/2026,Bill,1889-SZ,,Pacific Co-Pack LLC,Production run PR-2026-03,Inventory Asset,12500.00,
,,,,Pacific Co-Pack LLC,Production run PR-2026-03,Accounts Payable (A/P),,12500.00
03/12/2026,Expense,,,"Meta Platforms, Inc.",March paid social,Advertising,3275.00,
,,,,"Meta Platforms, Inc.",March paid social,Amex Gold,,3275.00
03/14/2026,Invoice,1043,,Sprouts Farmers Market,Voided,Accounts Receivable (A/R),0.00,
,,,,Sprouts Farmers Market,Voided,Sales of Product Income,,0.00
03/18/2026,Payment,,,Whole Foods Market NE,Check 40122,Undeposited Funds,4560.00,
,,,,Whole Foods Market NE,Check 40122,Accounts Receivable (A/R),,4560.00
03/20/2026,Deposit,,,,Deposit to operating,Checking,4560.00,
,,,,,Deposit to operating,Undeposited Funds,,4560.00
03/28/2026,Bill Payment (Check),2041,,Pacific Co-Pack LLC,Payment for 1889-SZ,Accounts Payable (A/P),12500.00,
,,,,Pacific Co-Pack LLC,Payment for 1889-SZ,Checking,,12500.00
03/31/2026,Journal Entry,2026-03-SHOP,No,,Shopify March settlement,Checking,18412.55,
,,,,,Shopify processing fees,Merchant Account Fees,842.30,
,,,,,Shopify March settlement,Shopify Clearing,,19254.85
03/31/2026,Transfer,,,,,Savings,25000.00,
,,,,,,Checking,,25000.00
03/31/2026,Inventory Qty Adjustment,IQA-118,,,Damaged cases - warehouse count,Cost of Goods Sold:Inventory Shrinkage,318.40,
,,,,,Damaged cases - warehouse count,Inventory Asset,,318.40
TOTAL,,,,,,,88688.25,88688.25
```

### 9.1 A deliberately dirty variant

Same data, exported through the **new report experience's CSV** path with account numbers enabled
and a UK locale. Use this as a second fixture: it exercises leading apostrophes, `$` symbols,
thousands separators, parentheses for negatives, `DD/MM/YYYY`, the `No.` header spelling, the
`Â` mojibake, and a spaced colon path.

```csv
Sooz Foods LLC
JOURNAL
1 - 31 March 2026
Filtered by: Distribution Account = All

Date,Transaction Type,No.,Name,Memo/Description,Account,Debit,Credit
05/03/2026,Invoice,1042,Whole Foods Market NE,"March wholesale order, PO WFM-8871",1200 Accounts Receivable (A/R),'Â$4560.00,
,,,Whole Foods Market NE,Volume discount 5%,4900 Discounts given,'Â$240.00,
,,,Whole Foods Market NE,Sooz Chili Crisp 6oz x 400,4100 Sales of Product Income,,'Â$4;800.00
,,,Whole Foods Market NE,Sooz Chili Crisp 6oz x 400,5000 Cost of Goods Sold,'Â$1;920.00,
,,,Whole Foods Market NE,Sooz Chili Crisp 6oz x 400,1300 Inventory Asset,,'Â$1;920.00
31/03/2026,Credit Memo,CM-204,Sprouts Farmers Market,Damaged case credit,4900 Discounts given,'Â$(118.50),
,,,Sprouts Farmers Market,Damaged case credit,1200 Accounts Receivable (A/R),,'Â$118.50
31/03/2026,Inventory Qty Adjustment,IQA-118,,Damaged cases - warehouse count,5000 Cost of Goods Sold : Inventory Shrinkage,'Â$318.40,
,,,,Damaged cases - warehouse count,1300 Inventory Asset,,'Â$318.40
TOTAL,,,,,,'Â$6;920.40,'Â$6;920.40
```

Note in this variant: thousands separators render as `;` because the file was produced with a
semicolon-delimited European CSV setting and then re-saved — **always check the delimiter before
the decimal separator**, and prefer reading the `.xlsx`.

---

## Sources

- [Export your QuickBooks Online data — Intuit](https://quickbooks.intuit.com/learn-support/en-us/help-article/list-management/export-reports-lists-data-quickbooks-online/L1xleDrLp_US_en_US)
- [Export reports to Excel — Intuit](https://quickbooks.intuit.com/learn-support/en-us/help-article/report-management/export-reports-excel-quickbooks-online/L7iAoP97n_US_en_US)
- [Print a journal entry report in QuickBooks — Intuit](https://quickbooks.intuit.com/learn-support/en-us/help-article/journal-entries/print-journal-entry-report/L1IhAG8PT_US_en_US)
- [New experience reports export to Excel with values stored as text… — QuickBooks Community](https://quickbooks.intuit.com/learn-support/en-uk/reports-and-accounting/new-experience-reports-export-to-excel-with-values-stored-as/00/1280662)
- [Can only export a report to Excel as CSV — QuickBooks Community](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/can-only-export-a-report-to-excel-as-csv/00/1089808)
- [JournalReport — Intuit Developer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalreport)
- [JournalEntry — Intuit Developer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry)
- [JournalReport API not sending debt_amt and account_name columns — Intuit Developer Help](https://help.developer.intuit.com/s/question/0D5TR00000Hlv370AB/i-am-facing-this-issue-since-last-friday-where-journalreport-api-is-not-sending-the-debtamt-and-accountname-columns-in-the-report)
- [QuickBooks Online Reports API: best practices and troubleshooting — Intuit Developer](https://medium.com/intuitdev/quickbooks-online-reports-api-best-practices-and-troubleshooting-31edc9934b4c)
- [QuickBooks Online API throttling changes — Intuit Developer Help](https://help.developer.intuit.com/s/article/QuickBooks-Online-API-throttling-changes-coming-soon)
- [QuickBooks API rate limits — Coefficient](https://coefficient.io/use-cases/quickbooks-api-rate-limits-transaction-data)
- [QuickBooks Online API limitations guide — Satva Solutions](https://satvasolutions.com/blog/quickbooks-online-api-limitations-guide)
- [Set up and use Multicurrency in QuickBooks Online — Intuit](https://quickbooks.intuit.com/learn-support/en-us/help-article/multicurrency/learn-multicurrency-quickbooks-online/L5krkKQi8_US_en_US)
- [How to turn off multi-currency — QuickBooks Community](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/how-to-turn-off-multi-currency/00/182671)
- [Fix issues at the end of a reconciliation in QuickBooks Online — Intuit](https://quickbooks.intuit.com/learn-support/en-us/help-article/statement-reconciliation/fix-issues-end-reconciliation-quickbooks-online/L3mZimyAb_US_en_US)
- [These 12 accounts are automatically created in QuickBooks Online — Lend A Hand Accounting](https://lendahandaccounting.com/2024/03/10/these-12-accounts-are-automatically-created-in-quickbooks-online/)
- [How to Export Lists From QuickBooks Online — Gentle Frog](https://gentlefrog.com/export-lists-from-quickbooks-online/)
- [Export Chart of Accounts in QuickBooks — Dancing Numbers](https://www.dancingnumbers.com/export-chart-of-accounts-quickbooks/)
- [How to export audit logs from QuickBooks Online — SysCloud](https://help.syscloud.com/how-to-export-audit-logs-from-quickbooks-online)
- [The Transaction List by Date in QuickBooks Online — Books Backup](https://booksbackup.com/reports/transaction-list-by-date/)
- [Bank transactions missing in QuickBooks Online (90-day feed limit)](https://bankxlsx.com/blog/bank-transactions-missing-in-quickbooks-online)

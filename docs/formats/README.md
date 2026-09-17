# Importer Specification — Sooz Books

**What this is.** The synthesis layer over the six format research documents in this directory. It
defines the one interface every importer implements, the one deduplication strategy, the one
clearing-account pattern, and the complete row-type → account mapping across all six sources.

**What this is not.** A restatement of the research. Column lists, header variants, gotchas and
worked examples live in the source documents and are cited inline, e.g. `[amazon §5a]`. Read the
source doc before implementing its importer; read this document before implementing *any* of them.

| Doc | Covers |
|---|---|
| `bank-csv.md` | Chase, BofA, Amex, Mercury, Ramp, Brex, Wells Fargo, Capital One, Citi — checking and card |
| `shopify.md` | Shopify Payments balance transactions + orders export |
| `amazon.md` | Amazon Seller Central settlement report, Flat File V2 |
| `faire-wholesale.md` | Faire payout summary (Part A) + direct wholesale remittance advice (Part B) |
| `distributor-deductions.md` | UNFI / KeHE remittances, deduction backup, EDI 820 / 812 |
| `quickbooks-migration.md` | One-time QBO full-history migration |

---

## 1. The common importer contract

### 1.1 Why one interface is possible

The six sources look nothing alike — a headerless five-field Wells Fargo CSV, a 24-column
tab-delimited Amazon `.txt`, an X12 820 envelope, a QBO `.xlsx` with a three-row preamble. But every
one of them decomposes into the same five stages, and each stage has the same failure mode across
all six:

1. **Identify** the file (and reject impostors — every doc independently specifies magic-byte
   sniffing: `[bank-csv §6.6]`, `[shopify §6.5]`, `[amazon §6.6]`, `[faire §6.A.7]`,
   `[distributor §6.2]`, `[quickbooks §6.10]`).
2. **Parse** to typed rows, tolerating bad rows without losing the file.
3. **Fingerprint** each row so re-import is idempotent.
4. **Assert the source's own internal identity** before anything is believed.
5. **Post** balanced double-entry lines.

Stage 4 is the one that makes this a contract rather than a shape. Five of the six sources carry an
arithmetic identity that proves the parse was complete, and the sixth (bank files) carries a
structural one. An importer that cannot state its identity has not been finished.

### 1.2 The interface

```ts
// ---------- money ----------
/** Integer cents. Never float — every source doc says so independently:
 *  [bank-csv §3.3 step 9], [amazon §3 step 4], [faire §7.C.1], [distributor §3.2],
 *  [quickbooks §3]. Parse with a Decimal, store as cents, compare as integers. */
type Cents = number & { readonly __brand: 'Cents' }

type ISODate = string          // 'YYYY-MM-DD', calendar date, no timezone
type ISOInstant = string       // 'YYYY-MM-DDTHH:mm:ssZ'

// ---------- input ----------
interface ParsedFile {
  bytes: Uint8Array            // always keep the raw bytes: [amazon §1a retention], [distributor §6.2]
  sha256: string               // file-level dedup layer, §3.1
  filename: string             // advisory only — never trust the extension [bank-csv §6.6]
  mediaType: string            // sniffed, not declared
  encoding: 'utf-8' | 'utf-8-sig' | 'cp1252' | 'latin-1' | 'ascii'
  text?: string                // decoded, BOM stripped
  sheets?: Sheet[]             // populated for xlsx/xls/HTML-table inputs [bank-csv §6.8]
  receivedAt: ISOInstant
  /** How it arrived. Emailed exports and portal downloads have different failure modes:
   *  an expired Shopify link serves HTML [shopify §6.5]; a SharePoint link dies in three
   *  weeks [distributor §6.2]; Ramp and Faire email large exports [bank-csv §1.6, faire §1.A]. */
  delivery: 'upload' | 'email-attachment' | 'api' | 'sftp'
}

// ---------- detection ----------
interface DetectionResult {
  importerId: string
  /** 0..1. >= 0.90 auto-selects. 0.50–0.90 offers this importer with the reasons shown.
   *  < 0.50 is not offered. Never auto-select two importers at the same confidence —
   *  ask. Chase checking and Chase card must never share a profile [bank-csv §1.2]. */
  confidence: number
  /** Human-readable, ordered strongest first. These strings are shown to the user when
   *  confidence is low and are logged on every import for support.
   *  e.g. "header matches Chase checking exactly (incl. trailing comma)",
   *       "field 2 is '*' on 12/12 rows — Wells Fargo signature" [bank-csv §2.8],
   *       "field 13 is 'shipment-fee-type' — this is Flat File V1" [amazon §2c]. */
  reasons: string[]
  /** Set when the file is recognised but must not be imported. Detection is the right
   *  place to reject: Amazon V1 [amazon §2c], a comma-delimited Amazon file that Excel
   *  re-saved [amazon §6.6], a Shopify export whose first byte is '<' [shopify §6.5],
   *  a QBO multicurrency journal [quickbooks §6.9], an Order Number rendered '1.2E+08'
   *  [faire §6.A.8]. */
  rejection?: { code: string; message: string; remedy: string }
  /** The saved per-tenant column mapping this file matched, when the format has no
   *  canonical header: Ramp, Brex [bank-csv §2.7, §9.8], UNFI/KeHE portal exports
   *  [distributor §0], per-customer remittances [faire §1.B]. */
  profileId?: string
}

// ---------- parsing ----------
interface ParseResult<TRow> {
  rows: TRow[]                 // only rows that survived; never partially-populated rows
  issues: Issue[]              // §1.3
  /** Facts hoisted out of the file that individual rows do not carry. Amazon's currency
   *  and period dates live only on the summary row [amazon §3, §6.3]; BofA's control
   *  totals live in the preamble [bank-csv §6.1]; a QBO report's locale is only knowable
   *  from its date-range line [quickbooks §4]. */
  header: FileHeader
  /** Everything discarded before/after the data block, kept for support. Never silently
   *  thrown away [bank-csv §9.1 step 6]. */
  preamble: string[]
  footer: string[]
  stats: { physicalLines: number; dataRows: number; skipped: number; rowsPadded: number }
  profile: ColumnProfile        // what mapping was actually used, persisted with the batch
}

interface FileHeader {
  accountOrChannelId: string
  currency: string
  periodStart?: ISODate
  periodEnd?: ISODate
  controlTotal?: Cents          // the number §1.4's assertion ties to, when the file states one
  sortOrder?: 'asc' | 'desc' | 'unsorted'
}

// ---------- the contract ----------
interface Importer<TRow> {
  id: string                                        // 'bank.chase.checking', 'amazon.settlement.v2'
  label: string                                     // 'Chase business checking (CSV)'

  detect(file: ParsedFile): DetectionResult
  parse(file: ParsedFile): ParseResult<TRow>        // never throws on one bad row — §1.3
  fingerprint(row: TRow): string                    // stable dedup key — §3
  preview(rows: TRow[], header: FileHeader): PreviewSummary   // §1.4, includes assertions
  toEntries(rows: TRow[], ctx: PostingContext): DraftEntry[]  // §1.5
}
```

### 1.3 The warning model: a bad row must not cost you the file

`parse()` **never throws for a data reason.** It throws only when the file cannot be read at all
(unreadable bytes, no header found). Everything else is an `Issue`.

```ts
type Severity =
  | 'info'    // recorded, shown in the import report, no action
  | 'warn'    // row is imported and posted, but flagged for review
  | 'error'   // row is skipped; the rest of the file still imports
  | 'fatal'   // nothing from this file may post

interface Issue {
  severity: Severity
  code: string                 // stable, machine-readable: 'date.unparsable', 'row.field_count'
  message: string              // what a bookkeeper reads
  rowIndex?: number            // 0-based index into the physical data rows
  rawRow?: string[]            // the offending row verbatim — always attached on error/fatal
  field?: string
  remedy?: string              // "re-download using Download Flat File V2"
}
```

**The rules, derived from what the six documents actually demand:**

1. **`error` skips a row, never the file.** A row whose date does not parse, whose field count
   differs from the header, or which is a footer total is skipped and reported with its raw text
   `[bank-csv §6.9]`. Padding a short row is forbidden — it shifts every column `[bank-csv §6.9]`.
   The single exception is Amazon, where 23-field rows are *legal* and must be padded to 24
   `[amazon §6.2]`; that is a format rule in the parser, not a general one.
2. **`error` escalates to `fatal` automatically in any importer that asserts to a control total.**
   This is the most important rule in the model. If a row is dropped from an Amazon settlement, the
   `Σ amount == total-amount` identity breaks `[amazon §5a]`; if a row is dropped from a Shopify
   payout, the payout tie-out breaks `[shopify §2b]`. In those importers a skipped row is not a
   tolerable loss, it is proof the parse is wrong. The framework enforces this: an importer declares
   `assertsControlTotal: true`, and any `error` issue is promoted to `fatal` before `preview()`
   returns.
3. **Unknown enum values are never dropped.** Amazon: an unknown
   `(transaction-type, amount-type, amount-description)` triple routes to `Suspense — Amazon
   Unmapped` and raises a review task, because dropping it breaks the identity `[amazon §6.9]`.
   Shopify: an unknown `Type` is a hard fail, not a silent drop `[shopify §2b]`. Distributor: an
   unmapped `reason_code` posts to `Unapplied Deductions` and blocks the close `[distributor §7.4]`.
   Faire: an unmapped *header* is a hard fail, because a new fee column silently unbalances every
   entry `[faire §6.A.1]`.
4. **`warn` is for rows that post but are not trusted.** A `$0.00` authorisation `[bank-csv §6.9]`; a
   positive Ramp amount that may be a refund `[bank-csv §3.2]`; a Shopify `refund` row with a
   non-zero `Fee` `[shopify §3]`; a non-zero Faire `Taxes Charged` `[faire §6.A.11]`; a distributor
   deduction referencing an invoice older than 12 months `[distributor §6.4]`.
5. **`fatal` is reserved for "the file is not what it claims, or the parse is provably incomplete."**
   A failed control-total assertion, a wrong format version, a multicurrency QBO journal, a Faire
   payout identity where no candidate clears 95% `[faire §3.A.3]`, a distributor advice failing the
   §6.1 identity `[distributor §6.1]`. On `fatal` the file is quarantined with its raw bytes and its
   issues; nothing is written to the ledger.
6. **Every issue is persisted with the import batch.** The import report is the product surface for
   this model — counts by severity, every `error`/`fatal` with its raw row, and a one-click path to
   the quarantined file.

### 1.4 Assert the source's own identity before anything posts

**Rule: `toEntries()` may not be called until every `fatal`-severity assertion returned by
`preview()` has passed.** This is enforced by the pipeline, not by convention. The importer cannot
opt out; it can only choose which assertions it runs.

```ts
interface Assertion {
  id: string                   // 'amazon.sum_equals_total'
  label: string                // 'Σ amount == total-amount'
  severity: 'fatal' | 'warn'
  passed: boolean
  expected: Cents
  actual: Cents
  difference: Cents
  detail?: string
}

interface PreviewSummary {
  rowCount: number
  dateRange: { min: ISODate; max: ISODate }     // from parsed rows, never from what the user says
  totals: { inflow: Cents; outflow: Cents; net: Cents }
  byType: Array<{ type: string; count: number; amount: Cents }>
  assertions: Assertion[]                        // the table below
  newRows: number                                // after §3 dedup
  duplicateRows: number
  needsReview: number                            // rows that will post with a review flag
  unmapped: Array<{ key: string; count: number; amount: Cents }>  // → suspense
}
```

**The identity each importer must assert:**

| Importer | Assertion | Severity | Source |
|---|---|---|---|
| **Bank / card** | `balance[i] − balance[i−1] == amount[i]` for ≥ 80% of consecutive pairs, in the file's own sort order. A column that passes this is **permanently disqualified from being the amount column** | fatal (when a balance column exists) | `[bank-csv §9.6]` |
| **Bank / card** | BofA preamble control: `beginning + total credits − total debits == ending` | fatal (BofA) | `[bank-csv §8.3]` |
| **Bank / card** | Per-account card control: `opening AP–card + charges − payments == statement closing balance` | warn | `[bank-csv §7.3]` |
| **Shopify** | `Net == Amount − Fee` on **every** row. One failure hard-fails the file — it catches a locale or decimal misparse in a single check | fatal | `[shopify §3]` |
| **Shopify** | `Σ Net where Payout Date = D and Type ≠ 'payout'` == `−Amount` of the `payout` row for D. `pending` rows excluded | fatal | `[shopify §6 gotcha 9]` |
| **Shopify** | Per order: `Σ(Lineitem price × qty) − Σ Lineitem discount == Subtotal` | warn | `[shopify §3]` |
| **Amazon** | `Σ amount` over all detail rows `== total-amount` on the summary row, **exact to the cent, no tolerance.** A mismatch means a truncated download, not an accounting problem — never plug it | fatal | `[amazon §5a]` |
| **Amazon** | `\|Current Reserve Amount(N)\| == Previous Reserve Amount Balance(N+1)` across consecutive settlements. A break means a missing settlement file — the best completeness check in the system | fatal (cross-file) | `[amazon §5b]` |
| **Amazon** | Amazon-attributable net movement in `Sales Tax Payable == 0.00` after posting; any residual is genuinely Sooz-collected tax and is raised for review | warn | `[amazon §7c]` |
| **Faire (A)** | Payout identity probe: one of candidate_1 / _2 / _3 holds within $0.01 on ≥ 95% of probe rows (rows with `Quantity Damaged or Missing = 0`). Locked per brand account and persisted. **If none clears 95%, fail loudly rather than posting** | fatal | `[faire §3.A.3]` |
| **Faire (A)** | Per row after the lock: residual == damages, cross-checked against `Quantity Damaged or Missing × unit wholesale price` from the Product Info export. Non-zero residual with zero quantity → suspense + flag | warn | `[faire §6.A.4]` |
| **Remittance (B)** | Per row: `amount_paid == invoice_amount − discount_taken − deduction_amount`. A failure means the mapping profile is wrong | fatal | `[faire §3.B.1]` |
| **Distributor** | `Σ(INVOICE lines) + Σ(non-INVOICE lines) == payment_total`. Quarantine the whole advice on failure — the three usual causes are an unparsed footer counted as data, an inverted sign, and backup belonging to a different payment | fatal | `[distributor §6.1]` |
| **QuickBooks** | `Σ debits == Σ credits` **per transaction**. A transaction that does not balance means the parser mis-detected a transaction boundary, every time | fatal | `[quickbooks §6.2]` |
| **QuickBooks** | Imported line total == the file's own `TOTAL` row. A free exact checksum on the whole file | fatal | `[quickbooks §7.4]` |
| **QuickBooks** | Per-month trial balance equals QBO's, **per mapped account, in integer cents, difference == 0.** Not "under a dollar" | fatal (gate per month) | `[quickbooks §7.6]` |

Two corollaries worth stating explicitly:

- **Never plug a difference.** `[amazon §5a]` says it about truncated files; `[quickbooks §7.6]` says
  it about sub-$0.05 variances ("a tolerated $0.02 today is an unexplained $2,000 after you scale the
  same bug across ten years"). The only sanctioned exception is QBO's single, dated, explicitly
  labelled `Migration Variance` entry to a dedicated equity account, approved in writing
  `[quickbooks §7.6]`.
- **Tolerances are per-source and declared, not ambient.** Faire: `$0.01` per row, `$0.05` per batch
  `[faire §3.A.6]`. Bank balance recurrence: `$0.005` `[bank-csv §9.6]`. Amazon, Shopify,
  distributor, QBO: exact.

### 1.5 Posting

```ts
interface PostingContext {
  entityId: string
  bookTimezone: string          // e.g. 'America/Los_Angeles' — see the date rules in the table, §2
  accounts: AccountResolver     // semantic name → account id; throws on unmapped, never defaults
  openPeriod: { start: ISODate; end: ISODate }
  channel: string               // 'shopify' | 'amazon' | 'faire' | 'unfi' | 'kehe' | ...
  standardCosts: CostLookup     // SKU → unit cost; settlement files never carry cost [amazon §7e]
  config: Record<string, unknown>  // documented per-importer flags, §5.8
}

interface DraftEntry {
  date: ISODate                 // period assignment, per the rules in §2
  memo: string
  sourceType: string            // importer id
  sourceRef: string             // settlement-id, payout key, payment_number, qbo_txn_key
  lines: DraftLine[]            // Σ debit == Σ credit, asserted before the entry is returned
  reviewFlags: ReviewFlag[]
}

interface DraftLine {
  account: string               // semantic name from §6, resolved through ctx.accounts
  debit: Cents                  // exactly one of debit/credit is non-zero
  credit: Cents
  memo?: string
  dimensions: { channel?: string; customer?: string; vendor?: string; sku?: string;
                promotion?: string; taxTreatment?: 'self_remitted' | 'marketplace_facilitator' }
  sourceRowFingerprint: string
}
```

`toEntries()` returns **drafts**. Nothing is posted by an importer; the pipeline posts, after dedup,
after assertions, and after any required human review. Every draft line carries the fingerprint of
the row that produced it, which is what makes an import reversible and a restatement possible.

---

## 2. The six formats compared

| | **Bank / card** | **Shopify** | **Amazon** | **Faire (A) / Remittance (B)** | **UNFI / KeHE** | **QuickBooks** |
|---|---|---|---|---|---|---|
| **Delivery** | Manual download per bank portal; Ramp emails large exports; Amex caps one export at 2,000 txns `[bank-csv §1]` | Admin export dialog; ≤ 50 rows in-browser, larger **emailed** and the link expires into an HTML error page `[shopify §1a, §6.5]` | Seller Central → Payments → **All Statements** → Download Flat File V2, or poll SP-API `getReports`. **Reports cannot be requested; only ~90 days retained — archive every file** `[amazon §1]` | A: brand portal Orders/Payouts → Export CSV, large files emailed. B: emailed PDF, emailed/SFTP CSV, EDI 820, or **nothing at all** `[faire §1]` | Email from ≥ 4 UNFI senders (PDF / zip / expiring SharePoint link); myUNFI; Dispute Center **Advanced Search**; KeHE CONNECT Deductions tab; EDI via VAN `[distributor §1]` | Per-report "Export to Excel", **one calendar month at a time**; bulk zip for lists; Audit Log is the only native CSV; or Reports API `[quickbooks §1]` |
| **File type** | CSV (Wells Fargo **headerless**), `.xlsx`, HTML-as-`.xls`, OLE2-as-`.csv` — all in the wild `[bank-csv §6.6, §6.8]` | Plain CSV, UTF-8; "CSV for Excel" variant carries a BOM; large exports arrive as a **ZIP of several CSVs each with its own header** `[shopify §6]` | **Tab-delimited `.txt`, 24 columns**, ASCII/LF, no quoting. **Do not use a quote-aware reader — split on `\t`** `[amazon §6.16]` | A: CSV, frequently BOM'd, XLSX-disguised. B: anything — PDF needing OCR, XLSX, pipe- or tab-delimited `.csv`, latin-1 `[faire §6]` | CSV / XLSX / PDF / zip / HTML-as-`.xls`; **no published column spec at all** — profile-driven `[distributor §0]` | `.xlsx` (read with openpyxl); QBO's own CSV path bakes in latin-1 mojibake and text-typed numbers `[quickbooks §1.3]` |
| **Stable unique row id** | **Rarely.** Amex `Reference` (extended details ON), BofA card `Reference Number`, Brex `Expense ID`. Chase, BofA checking, Wells Fargo, Mercury: none `[bank-csv §5]` | Balance txns: **no**, the API has an id but the CSV omits it. Orders: **yes**, `Id` `[shopify §5]` | **No row id.** `adjustment-id` exists on ~15% of rows. `settlement-id` is the *file* key `[amazon §5d]` | A: **no payout id exists at all**; `Order Number` is unique per order but **not per row**. B: `payment_reference` when present `[faire §5]` | EDI `TRN02` yes; UNFI `EAST-9876543`; KeHE prefixed invoice `INV1234567IA`. **Row level: never** `[distributor §5.1]` | **None** in any report export. API gives `Id` + `SyncToken` `[quickbooks §5]` |
| **Sign convention** | Three shapes: signed `Amount` / unsigned `Debit`+`Credit` / `Amount`+`DEBIT\|CREDIT` type. Asset vs liability polarity is **per institution**: Amex, Ramp, Brex charges **positive**; Chase card purchases **negative** `[bank-csv §2.9, §3.1]` | One signed `Amount` from the balance's perspective, **plus a `Fee` that is always positive even though it is a deduction.** Orders export: all positive magnitudes `[shopify §3]` | One signed `amount`. **Positive = Amazon owes Sooz.** Credits legitimately appear positive inside fee rows — never infer sign from the description. EU files use a **decimal comma** `[amazon §3]` | A: **positive-magnitude fee columns**, not signed amounts; `Payout Amount` may be negative. B: all positive, except credit-memo rows which are negative `[faire §3]` | **No single convention.** Signed, unsigned+flag, parentheses, trailing minus, Debit/Credit pair, and a `Deduction Amount` column holding `420.00` meaning `−420.00`. **Detect, never assume** `[distributor §3.1]` | `Debit`/`Credit` both non-negative — **except** refunds and inventory adjustments, which put a *negative* number in `Debit`. GL's `Amount` is signed by the account's natural direction `[quickbooks §3]` |
| **Date format** | `MM/DD/YYYY` mostly; **Mercury `MM-DD-YYYY` in UTC**; Capital One ISO; `.xlsx` serials with the 1900 leap-year bug and the 1904 Mac epoch `[bank-csv §4, §6.8]` | `YYYY-MM-DD HH:MM:SS ±HHMM` in **store timezone**, and **the offset shifts with DST**. Use the store-local date for period assignment `[shopify §4]` | `YYYY-MM-DD … UTC` (US) or `DD.MM.YYYY` (UK/EU). **`posted-date` is a UTC calendar date** — convert `posted-date-time` to `America/Los_Angeles` for period assignment `[amazon §4]` | A: `YYYY-MM-DD`, bare dates, **no timezone — never convert**; blank `Payout Date` = unpaid. B: no standard; store the format per customer profile `[faire §4]` | EDI `CCYYMMDD`; portals `MM/DD/YYYY`; XLSX serials. Treat as naive **US/Central**. `BPR16` effect date drives the period, not the bank date `[distributor §4]` | `MM/DD/YYYY` US vs `DD/MM/YYYY` UK — **do not sniff**, read the locale from the report's spelled-out date-range row. `TxnDate` has no timezone; metadata timestamps are in **US Pacific** `[quickbooks §4]` |
| **Needs a clearing account** | **No — it is the other side.** A bank file's only job for a channel payout is `Dr Bank / Cr Channel Clearing`. **A bank file must never create revenue** `[bank-csv §7.0]` | **Yes** — `Channel Clearing – Shopify Payments` | **Yes** — `Amazon Clearing`, plus `Amazon Reserve` for the two reserve rows `[amazon §7a]` | A: **yes** — `Faire Clearing`; Sooz carries **no AR** for a Faire order. B: **no** — real `AR – Wholesale` against the customer `[faire §7.A.1, §7.B]` | **Yes** — `Channel Clearing — UNFI` / `— KeHE`, so the advice posts in its own period regardless of ACH settlement `[distributor §7.2]` | N/A (historical transcription). QBO's `Undeposited Funds` maps to `Channel Clearing:Undeposited Funds (QBO legacy)` — **keep it distinct** from go-forward clearing `[quickbooks §6.5]` |
| **Asserts to a control total** | **Structural, not arithmetic** — the balance recurrence, plus BofA's preamble totals. Most files state no total `[bank-csv §9.6, §8.3]` | **Yes** — payout tie-out, and `Net == Amount − Fee` per row `[shopify §6.9]` | **Yes, exactly** — `Σ amount == total-amount`, verified at diff 0.00 on seven real files `[amazon §5a]` | A: **derived, not printed** — the identity probe, then batch sum vs deposit. B: **yes** per row, and `payment_total` (which frequently disagrees with `Σ amount_paid` — trust the bank) `[faire §3.A.3, §6.B.3]` | **Yes** — the §6.1 identity against `payment_total` `[distributor §6.1]` | **Yes, three** — per-transaction balance, the file `TOTAL` row, and the monthly trial balance `[quickbooks §7.6]` |

**The pattern the table exposes:** the three sources that state an exact control total (Amazon,
distributor, QBO) are the *safest* to build, because the file proves its own completeness. The two
that state none (bank files, Faire) are where silent corruption lives — which is precisely why
`[bank-csv §9.6]` spends a full section on why a balance column posted as an amount produces a
trial balance that ties perfectly while every number in it is fiction, and why `[faire §3.A.3]`
makes the importer *probe* for its identity rather than assume one.

---

## 3. Deduplication

Users re-import overlapping ranges constantly — it is the normal way to catch up after a gap
`[bank-csv §10]`. Three layers, in order. Every layer is mandatory; each catches what the one above
it cannot.

### 3.1 Layer 0 — file hash

`sha256(raw bytes)` on every import batch, checked **before parsing**. The user gets "you already
imported this exact file on 2026-06-18" instantly. Specified independently by `[bank-csv §10.1]`,
`[amazon §5d]`, `[distributor §5.2]`.

This is a **convenience, not the safety net**: a user who exports one extra day gets a different
hash `[bank-csv §10.1]`. Two sources add a rule on top of it worth generalising:

> **If the container id matches a prior import but the hash differs, reject and alert.** A closed
> Amazon settlement should never change; a changed one means Amazon re-issued it (rare) or someone
> opened it in Excel (common, and destructive) `[amazon §5d]`. Faire says the same for a reconciled
> payout batch whose re-imported `batch_amount` differs `[faire §5.A]`.

### 3.2 Layer 1 — native id where one exists

```
fingerprint = sha256(scope_id + ':' + native_id)
```

Stop here. Exact, survives description restatements, needs no occurrence handling `[bank-csv §10.2]`.
Applies to: Amex `Reference`, BofA card `Reference Number`, Brex `Expense ID`, Ramp's id column when
enabled `[bank-csv §5]`; Shopify orders `Id` `[shopify §5b]`; EDI `TRN02` `[distributor §5.1]`; QBO
API `(realm_id, txn_type, Id)` `[quickbooks §5.2]`.

The trap: **uniqueness, not the header, decides.** Mercury's `Reference` holds `Profit distribution`
and would be a disastrous dedup key; Amex's `Reference` holds `320261670001122334` and is a perfect
one. The headers are identical `[bank-csv §9.7]`. Test: populated on > 95% of rows, length ≥ 10,
`distinct == row count`.

### 3.3 Layer 2 — the fingerprint recipe, per format

| Format | Fingerprint |
|---|---|
| **Bank / card** (no native id) | `sha256(account_id ⟂ posting_date_iso ⟂ signed_amount_2dp ⟂ normalize(description) ⟂ check_number)` where `⟂` is `\x1f` (a unit separator, so a description containing the delimiter cannot collide) and `normalize()` is NFKC + uppercase + collapse whitespace + strip trailing `CARD \d{4}` / `XXXX\d{4}` / embedded dates / auth codes + truncate to 64 `[bank-csv §5, §10.3]` |
| **Shopify** balance txns | Container: `payout_key = (source, currency, payout_date, payout_total)`. Row: `sha256(payout_date ⟂ transaction_date_utc ⟂ type ⟂ order ⟂ amount ⟂ fee ⟂ checkout ⟂ ordinal)` `[shopify §5a]` |
| **Shopify** orders | `(Id, line_ordinal)`, with `snapshot_exported_at`. A later export of the same `Id` is an **update, not a duplicate** — `Refunded Amount`, `Financial Status` and `Fulfillment Status` mutate after export `[shopify §5b]` |
| **Amazon** | Container: `settlement-id`. Row: `(settlement-id, transaction-type, amount-type, amount-description, order-id, order-item-code, adjustment-id, sku, posted-date-time, amount, row_ordinal)` `[amazon §5d]` |
| **Faire** (A) | `sha256(normalize(order_number) ⟂ iso(payout_date) or 'UNPAID' ⟂ cents(payout_amount) ⟂ cents(order_total) ⟂ cents(total_commission))`. Batch: `(brand_account_id, payout_date, currency)` `[faire §5.A]` |
| **Remittance** (B) | Deposit: `(customer_id, payment_reference)`; fallback `(customer_id, payment_date, round(Σ amount_paid,2), row_count)`. Line: `(customer_id, payment_reference, invoice_number, sequence_within_reference)` — **the sequence matters**: a payer can emit two lines for one invoice (partial payment + deduction line) `[faire §5.B]` |
| **UNFI / KeHE** | Payment: `(source_system, region_dc, payment_number)` — **region is part of the key**; `9876543` alone is not unique across UNFI East and West. Line: `(source, payment_number, line_type, document_number, reference_invoice_number, reason_code, line_amount)`; fallback hash over `normalise(reason_description)` when `document_number` is missing (common in PDF extracts) `[distributor §5.2]` |
| **QuickBooks** | `qbo_txn_key = sha256(transaction_type ⟂ txn_date_iso ⟂ num ⟂ name ⟂ total_debits_cents ⟂ line_count)`, plus `Created Date` when the column was added — it is what distinguishes two identical same-day same-vendor charges. Line: `qbo_txn_key ⟂ ordinal` `[quickbooks §5.1]` |

**What must never enter a fingerprint**, unanimous across the docs: a running balance (changes with
every later transaction), a category (banks recategorise retroactively), a `Type`/`Details` token
(restated between pulls), the source filename, the row index within the file, the import timestamp,
the cardholder name (absent from some export variants of the same account), or the *transaction*
date when a *posting* date exists `[bank-csv §5, §10.3]`.

**Always store the raw parsed row as JSON alongside the fingerprint**, with the `ColumnProfile` id
used to parse it. Normalisation rules will change — they always do — and you need to recompute
historical fingerprints without asking users to re-upload files they no longer have. Storing the raw
row makes that a migration; not storing it makes it an apology `[bank-csv §10.7]`.

### 3.4 Two identical transactions on the same day — the occurrence index

Two $4.79 coffees at the same shop on the same day are a real, common event, and they are
indistinguishable under any natural key. Hashing alone either drops one (silent data loss) or keeps
both on every re-import (compounding duplicates). Neither is acceptable `[bank-csv §10.4]`.

**The mechanism: an ordinal within an idempotency container, plus set reconciliation on import.**

1. Within one parsed file, group rows by natural key, **preserving file row order**.
2. Assign each row in a group an ordinal `0, 1, 2, …`. The stored fingerprint is
   `natural_key || '#' || ordinal`.
3. On import, for each natural key present in the file:
   - `M` = rows with that key **in the incoming file**
   - `N` = rows already in the ledger with that key, **restricted to the container's scope**
   - insert `max(0, M − N)` rows, taking the highest ordinals
   - if `M < N`, **delete nothing** — flag the key for review (the user exported a narrower filter,
     or the bank reversed something)

| Case | M | N | Result |
|---|---|---|---|
| First import, one coffee | 1 | 0 | insert 1 |
| First import, two identical coffees | 2 | 0 | insert 2 |
| Re-import of the same range | 2 | 2 | insert 0 |
| Re-import after a third coffee posted | 3 | 2 | insert 1 |

**The scope restriction on `N` is the part that is easy to get wrong.** Without it, a coffee bought
on the same day-of-month in a *different* month with an identical description and amount suppresses a
legitimate row. The scope is the **idempotency container**, and each format has a different one:

| Format | Idempotency container | Why |
|---|---|---|
| Bank / card | The file's parsed `[min_date, max_date]` | The file is a window, nothing more `[bank-csv §10.4]` |
| Shopify | The **payout** | A `paid` payout is immutable once issued; its row set never changes. Import one payout per file `[shopify §5a, §6.7]` |
| Amazon | The **settlement** | Settlements do not overlap; a given `posted-date-time` appears in exactly one. **Overlapping re-import is structurally impossible if you key on `settlement-id`** — the main reason to prefer this report over Date Range Reports `[amazon §5d]` |
| Faire (A) | The **payout batch** `(brand, payout_date, currency)` | `[faire §5.A]` |
| Remittance / distributor | The **payment** `(source, region, payment_number)` | A corrected remittance with the same reference is a *reversal and re-apply*, not a line-by-line diff `[faire §5.B, distributor §5.2]` |
| QuickBooks | The **calendar month** | Exports are taken one month at a time and each month is a gated transaction `[quickbooks §7.5]` |

Where the container is immutable (Shopify payout, Amazon settlement), M/N reconciliation collapses to
"import the whole container or skip it" — which is why those two importers are the cheapest to make
correct. Where it is a mere date window (bank files), the full ordinal machinery is required.

### 3.5 Layer 3 — the near-miss guard

Banks restate a description between a same-day pull and a next-day pull (`PENDING - SQ *COFFEE` →
`SQ *COFFEE 12345`). The strict key misses and a duplicate is inserted. So also store a **loose key**
`sha256(account_id ⟂ date ⟂ signed_amount)`. On a strict-key miss that coincides with a loose-key hit
whose existing row has no matching strict key, **do not insert** — queue the pair as "possible
restatement" showing both descriptions. It fires on well under 1% of rows and converts a silent
duplicate into a one-click decision `[bank-csv §10.5]`.

### 3.6 Pending rows live in a separate namespace

Never fingerprinted into the ledger, because the posted version arrives later with a different key:
Mercury `Status ∈ {Pending, Failed, Cancelled}` is skipped outright `[bank-csv §6.9]`; Ramp/Brex rows
with an empty clearing date are held `[bank-csv §6.7]`; Shopify `pending` rows go to a provisional
staging table that is **deleted and replaced wholesale on each import** `[shopify §5a]`; Amazon's
still-open settlement (Statement View) is simply not imported `[amazon §1a]`; a UNFI adjustment with
no `payment_number` is a *claim*, recorded as a memo, not a journal entry `[distributor §6.4]`; QBO
bank-feed "For review" items are not in the Journal at all, which is correct `[quickbooks §6.11]`.

---

## 4. The clearing-account pattern

### 4.1 The rule

> **Every channel settlement posts to a clearing account. The bank deposit clears it. A bank file
> never creates revenue.**

This is stated independently, in almost the same words, by `[bank-csv §7.0]`, `[shopify §7b]`,
`[amazon §7a]`, `[faire §7.A.1]` and `[distributor §7.2]`. It is the single most load-bearing
convention in the product.

If the bank parser books a Shopify deposit straight to Gross Sales it (a) understates revenue by the
fees and discounts the platform netted out, (b) records zero sales-tax liability, and (c)
double-counts the moment the settlement file is imported `[bank-csv §7.0]`.

### 4.2 The diagram

```
       CHANNEL SIDE                      CLEARING                      BANK SIDE
  (settlement / payout file)          (one per channel)             (bank CSV)

  Shopify balance txns          ┌──────────────────────────┐
  ─────────────────────────────>│                          │
    Dr Clearing   993.62        │  Channel Clearing –      │
    Dr Contra-Rev  66.37        │  Shopify Payments        │        SHOPIFY DES:PAYOUT
    Dr Proc Fees   50.18        │                          │             +560.28
    Dr Fulfillment 89.39        │   debits from the        │<───────────────────────────
      Cr Gross Sales   968.00   │   settlement file        │      Dr Bank        560.28
      Cr Shipping Inc    6.95   │           ↕              │        Cr Clearing  560.28
      Cr Tips Payable   10.00   │   credits from the       │
      Cr Sales Tax      63.32   │   bank deposit           │
                                │                          │
                                │   balance ──────> 0.00   │
                                └──────────────────────────┘
                                             │
                          ┌──────────────────┴──────────────────┐
                          │ non-zero at month end means one of: │
                          │  • deposit in transit (normal)      │
                          │  • pending/unpaid rows (normal)     │
                          │  • a dropped or mis-signed row (BUG)│
                          └─────────────────────────────────────┘
```

The `payout` / `Transfer` row inside the settlement file is **not posted as its own journal line.**
It is the *control*: its amount must equal the balance left in clearing after every other row of that
payout has posted. Then the bank deposit, imported separately, debits Bank and credits Clearing,
taking it to zero. **That zero is the proof nothing was dropped** `[shopify §7b]`. Amazon states the
same in its own terms: a non-zero per-settlement `Amazon Clearing` balance means either the deposit
has not landed or a row was mis-posted `[amazon §7e step 3]`.

### 4.3 Why the account has to exist at all: three real lags

1. **Settlement date ≠ deposit date.** A Shopify payout dated `2026-09-14` arrives 1–2 business days
   later `[shopify §4]`. An Amazon deposit *initiates* on `deposit-date` and lands 1–5 business days
   later, under a bank memo that shows no settlement id `[amazon §5b]`. A Faire payout dated
   August 31 frequently hits the bank in September `[faire §4.A]`. A distributor remittance dated
   `09/30` whose cash clears `10/01` belongs in **September** — do not let the bank feed's date drive
   the period `[distributor §4]`.
2. **Revenue earned before cash is due.** Faire rows with a blank `Payout Date` are shipped-but-unpaid
   inside the 30/60-day window: real revenue and a real receivable from Faire, with no bank-side
   expectation `[faire §4.A, §6.A.13]`. Shopify `pending` rows at `2026-09-30 23:59:59` book to
   clearing and reconcile to the admin's "Payout balance" figure `[shopify §7d]`.
3. **Many-to-one and one-to-many deposits.** Amazon can batch two settlements into one ACH — the bank
   match must allow many-settlements-to-one-deposit `[amazon §5b]`. A Shopify payout can be
   **negative**, collected by debiting the bank `[shopify §6.19]`. A Faire batch can be negative in a
   bad week `[faire §3.A.2]`. A distributor advice can net negative, which is an **AP balance owed to
   the distributor, not negative cash** `[distributor §6.4]`.

### 4.4 What a non-zero clearing balance means at month end

| Clearing balance | Reading | Action |
|---|---|---|
| Equals the sum of payouts/settlements with a deposit date in the last 1–5 business days | **Deposit in transit. Normal.** | None. Appears on the exception report as *aging 0–5d* |
| Equals `Σ Net` of Shopify `pending` rows, or `Σ Payout Amount` of Faire rows with a blank `Payout Date` | **Earned, not yet payable. Normal.** | Reconcile to the platform's own "payout balance" figure `[shopify §7d]` |
| Non-zero after both halves of a settlement are in | **Bug.** A row was dropped, mis-signed, or an `adjustment` is still sitting in Suspense `[shopify §7e step 4]` | Block the close |
| Aged > 15 days with no matching deposit | Missing bank file, failed payout (`payout_failure` / `payout_cancellation` — the bank deposit will never appear `[shopify §2b]`), or a settlement file never imported | Investigate; check the Amazon reserve chain `[amazon §5b]` |
| Persistent residue that never clears | The Faire payout identity is mis-resolved `[faire §7.A.1]`, or clearing is being used as a suspense account | Re-run the §3.A.3 probe; reclassify |

### 4.5 The exception report

One report, run at close, that surfaces every clearing account. **The close is blocked while any
line in section (a), (c) or (f) is non-empty.**

```
CLEARING & SUSPENSE EXCEPTIONS — period 2026-09

(a) Clearing balances by channel and age
    channel | balance | aged 0-5d | 6-15d | 16-30d | >30d | expected-in-transit | UNEXPLAINED
    Shopify |  560.28 |    560.28 |     — |      — |    — |              560.28 |        0.00
    Amazon  |  189.55 |         — |     — | 189.55 |    — |                0.00 |      189.55  <-- BLOCK
    Faire   | 2,341.10|  1,120.00 |     — |      — |    — |            1,221.10 |        0.00
    KeHE    |       — |         — |     — |      — |    — |                   — |           —

(b) Settlements / payouts with no matching bank deposit   (aged, with the expected amount)
(c) Bank deposits matched to no settlement                 <-- BLOCK: revenue may be unrecorded
(d) Amazon reserve chain: |Current Reserve(N)| vs Previous Reserve Balance(N+1)  [amazon §5b]
(e) Rows routed to suspense, by account and age:
       Suspense — Shopify Review        (unclassified `adjustment` rows)   [shopify §7b]
       Suspense — Amazon Unmapped       (unknown vocabulary triples)       [amazon §6.9]
       Unapplied Deductions             (unmapped reason codes)            [distributor §7.4]
       Unapplied Customer Cash          (stage-6 cash application)         [faire §7.C.1]
       Uncategorized Expense / Undeposited Receipts (bank suspense)        [bank-csv §7.1]
(f) Assertion failures and quarantined files this period   <-- BLOCK
(g) Sales Tax Payable: Amazon-attributable net movement (target 0.00)      [amazon §7c]
(h) Card controls: AP–<card> computed closing vs statement closing         [bank-csv §7.3]
```

Section (e) has a target of **$0.00 at close** for every line — that is the importer's own health
metric, and it should trend to zero every month `[distributor §10]`.

---

## 5. The account mapping

**This is the artifact to implement first.** Every row type across all six formats, by semantic
account name. Accounts in **bold** are from the Sooz Books chart categories; accounts in *italics*
are additions the chart does not yet contain (§5.8).

### 5.1 Bank and card files — a cash file, never a revenue file

`[bank-csv §7.1]`. Rows 15 and 16 are what make an unrecognisable row *safe to import* rather than a
reason to reject the file — both balance, both are flagged.

| # | Row type (recognition) | Debit | Credit |
|---|---|---|---|
| 1 | Channel payout deposit — inflow matching `SHOPIFY`, `AMAZON`, `FAIRE`, `STRIPE`, `SQUARE`, `PAYPAL` | **Bank** | **Channel Clearing** – *channel* |
| 2 | Customer payment matched to an open AR invoice | **Bank** | **AR** |
| 3 | Short-paid remittance (inflow < invoices it settles) | **Bank** (net) + **Deductions Receivable** (shortfall) | **AR** (gross invoiced) |
| 4 | Vendor bill payment, bill already accrued | **AP** | **Bank** |
| 5 | Card payment to Amex / Ramp / Brex / Chase card | **AP** – *card* | **Bank** |
| 6 | Bank fee, wire fee, FX fee, analysis charge | **Processing Fees** | **Bank** |
| 7 | Processor fee debited separately (Stripe/Square monthly invoice) | **Processing Fees** | **Bank** |
| 8 | 3PL / freight / warehouse payment, not accrued | **Fulfillment Fees** | **Bank** |
| 9 | Ad platform charge on a card (Meta, Google, TikTok, Amazon Ads) | **Advertising** | **AP** – *card* |
| 10 | Ingredient / packaging / co-pack purchase | **Inventory** | **Bank** or **AP** – *card* |
| 11 | Sales tax remittance to a state DOR / Avalara / TaxJar | **Sales Tax Payable** | **Bank** |
| 12 | Transfer between own accounts | **Bank** (destination) | **Bank** (source) |
| 13 | Card refund on a supply purchase | **AP** – *card* | **Inventory** (or the original expense) |
| 14 | Interest income | **Bank** | **Other Income** |
| 15 | Unrecognised outflow | *Uncategorized Expense* (suspense) | **Bank** |
| 16 | Unrecognised inflow | **Bank** | *Undeposited Receipts* (suspense) |

**Two rules that override everything above:**

- **COGS is never posted from a bank or card file.** A co-packer invoice is **Inventory**, not
  **COGS**. COGS is relieved at fulfilment, from the channel file `[bank-csv §7.1]`.
- **Rows 5 and 12 appear in two files and would post twice.** When a card file contains a payment row
  (Chase `Type = Payment`, Amex negative charge matching `PAYMENT.*THANK YOU|ACH PMT|AUTOPAY`, Mercury
  Credit inflow), search for a bank row with the opposite sign, equal amount to the cent, posting date
  within **±3 calendar days**, on a linked account. Found → link and **post nothing from the card
  side**. Not found → post `Dr AP–card / Cr Bank Suspense` and flag, so the later bank import clears
  it `[bank-csv §7.2]`.

### 5.2 Shopify

`[shopify §7b]`. Every row's other leg is **Channel Clearing – Shopify Payments** ("Clearing" below).

| Balance-transaction row | Debit | Credit |
|---|---|---|
| `charge` (decomposed against the orders export) | **Channel Clearing** (gross `Amount`) + **Contra-Revenue – Discounts** | **Gross Sales – Shopify DTC**, *Shipping Income*, **Sales Tax Payable**, *Tips Payable* |
| `charge` — the `Fee` column | **Processing Fees – Shopify Payments** | **Channel Clearing** |
| `charge` on a foreign-currency order — conversion portion of `Fee` | **Processing Fees** (conversion sub-account) | **Channel Clearing** |
| `refund` | **Contra-Revenue – Returns & Refunds**, *Shipping Income* (reversal), **Sales Tax Payable** (reversal) | **Channel Clearing** |
| `dispute` — accepting the loss | **Contra-Revenue – Chargebacks**, **Sales Tax Payable** (reversal) | **Channel Clearing** |
| `dispute` — contesting it | **Deductions Receivable – Disputes** | **Channel Clearing** |
| `chargeback_fee` / `chargeback_hold` | **Processing Fees** / **Deductions Receivable** | **Channel Clearing** |
| `dispute_reversal`, `dispute_withdrawal` | **Channel Clearing** | **Contra-Revenue – Chargebacks** (or **Deductions Receivable**), **Sales Tax Payable** |
| `billing_debit` (Shopify's own invoice) | *Software & Platform Expense* / **Advertising** / *Sales Tax Compliance Expense*, per the Shopify bill | **Channel Clearing** |
| `shipping_label`, `shipping_label_adjustment` | **Fulfillment Fees – Shipping Labels** | **Channel Clearing** |
| `adjustment` = marketplace sales tax withheld | **Sales Tax Payable – Marketplace Facilitator** | **Channel Clearing** |
| `adjustment` = anything else | *Suspense – Shopify Review* | **Channel Clearing** |
| `reserved_funds` / reversal | *Reserve Receivable* ⇄ **Channel Clearing** | — |
| `customs_duty`, `import_tax` | *Duties Payable* | **Channel Clearing** |
| `payout` | **no entry** — it is the control (§4.2) | — |
| Bank deposit (from the bank file) | **Bank** | **Channel Clearing** |
| Fulfilment, from the orders export | **COGS** | **Inventory – Finished Goods** |
| Restocked refund | **Inventory – Finished Goods** | **COGS** |

**Tax treatment is decided by `Source`, at import time, per row** `[shopify §7g]`:

- `Source = web` / `pos` → Sooz is seller of record → **Sales Tax Payable – Self-Remitted**.
- `Source = shop_app` → the Shop channel is a marketplace facilitator (SC Commerce Services Inc.,
  since 2025-01-01) → credit **Sales Tax Payable – Marketplace Facilitator** on the sale and debit the
  same account when Shopify withholds it. Net zero *in the same entry*, by design, so the tax report
  shows the full taxable sale and no phantom liability survives the period.
- Getting this wrong either double-pays a state or understates a liability. Tag every tax amount
  `self_remitted` or `marketplace_facilitator` at import.

**Three traps in this table:** `billing_debit` is **not** a processing fee and must never land in
Processing Fees `[shopify §7f]`. `Shipping` on the orders export is *income*; `shipping_label` on the
balance export is *expense* — **never net them** `[shopify §6.21]`. A `charge` `Amount` is not
revenue: it is product − discounts + shipping + tax + tip, and for a split-tender or gift-card order
it is only the card portion `[shopify §6.10, §6.11]`.

### 5.3 Amazon

`[amazon §7b]`. Every non-reserve row's other leg is **Amazon Clearing** ("AC"): a positive `amount`
debits AC, a negative `amount` credits AC.

| `transaction-type` / `amount-type` / `amount-description` | Sign | Debit | Credit |
|---|---|---|---|
| `Order` / `ItemPrice` / `Principal`, `Shipping`, `GiftWrap` | + | **Amazon Clearing** | **Gross Sales – Amazon** |
| `Liquidations` / `ItemPrice` / `Principal` | + | **Amazon Clearing** | **Gross Sales – Amazon Liquidations** *(separate line — the margin is catastrophic and will distort unit economics)* |
| `Order` / `Promotion` / `Principal`, `Shipping` | − | **Contra-Revenue – Amazon Promotions** | **Amazon Clearing** |
| `Refund` / `ItemPrice` / `Principal`, `Shipping`, `Goodwill` | − | **Contra-Revenue – Returns & Allowances** | **Amazon Clearing** |
| `Refund` / `ItemPrice` / `RestockingFee` | **+** | **Amazon Clearing** | **Contra-Revenue – Returns & Allowances** *(a credit to contra-revenue — you kept part of the refund)* |
| `Order`/`Refund` / `ItemPrice` / `Tax`, `ShippingTax` | ± | **Amazon Clearing** / **Sales Tax Payable** | **Sales Tax Payable** / **Amazon Clearing** |
| `Order`/`Refund` / `ItemWithheldTax` / `MarketplaceFacilitatorTax-*` | ∓ | **Sales Tax Payable** | **Amazon Clearing** |
| `Order`/`Refund` / `ItemWithheldTax` / `MarketplaceFacilitatorVAT-*` | ∓ | *VAT Payable* | **Amazon Clearing** |
| `Order` / `Promotion` / `TaxDiscount` | − | **Sales Tax Payable** | **Amazon Clearing** — tax side of the promo, **not** contra-revenue |
| `Order` / `ItemFees` / `Commission`, `VariableClosingFee`, `DigitalServicesFee` | − | **Processing Fees** (`Selling Fees – Amazon`) | **Amazon Clearing** |
| `Refund` / `ItemFees` / `Commission` | **+** | **Amazon Clearing** | **Processing Fees** *(referral fee returned)* |
| `Refund` / `ItemFees` / `RefundCommission` | − | **Processing Fees** *(20% refund-admin fee)* | **Amazon Clearing** |
| `ServiceFee` / `other-transaction` / `Subscription`, `Coupon redemption fee`, `LightningDealFee` | − | **Processing Fees** | **Amazon Clearing** |
| `Order` / `ItemFees` / `FBAPerUnitFulfillmentFee`, `FBAWeightBasedFee`, `FBAPerOrderFulfillmentFee`, `ShippingChargeback`, `GiftwrapChargeback` | − | **Fulfillment Fees – Amazon FBA** | **Amazon Clearing** |
| `ServiceFee` / `other-transaction` / `StorageRenewalBilling`, `FBAStorageFee`, `FBALongTermStorageFee` | − | **Fulfillment Fees – Amazon FBA** | **Amazon Clearing** |
| `ServiceFee` / `other-transaction` / `FBAInboundTransportationFee` | − | **Inventory – FBA** *(if capitalising freight-in — recommended for a CPG book)* else **Fulfillment Fees** | **Amazon Clearing** |
| `other-transaction` / `RemovalComplete` | − | **Fulfillment Fees – Amazon FBA** (+ transfer inventory FBA → warehouse at cost, no P&L) | **Amazon Clearing** |
| `other-transaction` / `DisposalComplete` | − | **Fulfillment Fees – Amazon FBA** *plus* **COGS – Inventory Shrink** / **Inventory – FBA** | **Amazon Clearing** |
| `Liquidations` / `ItemFees` / `LiquidationsBrokerageFee` | − | **Fulfillment Fees – Amazon FBA** | **Amazon Clearing** |
| `ServiceFee` / **`Cost of Advertising`** / `TransactionTotalAmount` | − | **Advertising – Amazon** | **Amazon Clearing** |
| `other-transaction` / `FBA Inventory Reimbursement` / `WAREHOUSE_LOST`, `WAREHOUSE_DAMAGE`, `MISSING_FROM_INBOUND`, `CS_ERROR_ITEMS`, … | + | **Amazon Clearing** | **Other Income – FBA Reimbursements** *(or* **Deductions Receivable – Amazon** *if already accrued)* |
| `other-transaction` / `other-transaction` / `Current Reserve Amount` | − | *Amazon Reserve* | **Amazon Clearing** |
| `other-transaction` / `other-transaction` / `Previous Reserve Amount Balance` | + | **Amazon Clearing** | *Amazon Reserve* |
| **unknown triple** | ± | *Suspense — Amazon Unmapped* + review task — **never dropped** | **Amazon Clearing** |
| Bank deposit (from the bank file) | **Bank** | **Amazon Clearing** |
| Fulfilment, `sku` × `quantity-purchased` × standard cost | **COGS – Amazon** | **Inventory – FBA** |

**Four Amazon-specific traps worth carrying into code review:**

1. **Advertising's semantics live in `amount-type`, not `amount-description`.** The description is the
   meaningless `TransactionTotalAmount`. A parser keyed only on `amount-description` mis-buckets
   every ad row `[amazon §7b]`. And if Amazon Ads is billed to a credit card instead of deducted from
   disbursements, ad spend never appears here at all and comes from the Ads invoices —
   **double-counting ads is the most common error in this importer.** Pick one source and assert the
   other is empty `[amazon §6.14]`.
2. **Marketplace facilitator tax must net to zero.** `ItemPrice/Tax +6.30` and
   `ItemWithheldTax/MarketplaceFacilitatorTax-Principal −6.30` are the same order line. Post both so
   the §1.4 sum still ties, then assert the Amazon-attributable movement in **Sales Tax Payable** is
   `0.00`. Any residual is genuinely Sooz-collected tax and is the *only* real liability. **Never
   accrue from the `ItemPrice/Tax` row alone** — that makes Sooz look like it owes thousands Amazon
   already paid `[amazon §7c]`.
3. **A reimbursement is not a sale.** No customer, no sales tax, no referral fee. Booking it to
   **Gross Sales** inflates channel revenue and makes the gross-margin bridge unreconcilable. Pair it
   with `Dr COGS – Inventory Shrink / Cr Inventory – FBA` for the lost units `[amazon §7b]`.
4. **`Non-Amazon US` = Multi-Channel Fulfillment.** `Principal` is `0.00` and only an FBA fee is
   charged; the revenue lives in Shopify and `merchant-order-id` carries the Shopify order name.
   Route the fee to **Fulfillment Fees — MCF (Shopify)**. Posting a $0 Amazon sale is wrong
   `[amazon §6.12]`.
5. **Shipping income is a wash for FBA.** `ItemPrice/Shipping +5.99` is almost always matched by
   `ItemFees/ShippingChargeback −5.99`. Book **both or neither**; booking only the credit inflates
   gross margin by the shipping amount `[amazon §6.11]`.

### 5.4 Faire (Part A — marketplace)

`[faire §7.A.2]`. Faire, not the retailer, owes Sooz, so **there is no AR for a Faire order.**

| Row type | Debit | Credit |
|---|---|---|
| Marketplace order (per row) | **Channel Clearing** (*Faire Clearing*) `payout_amount` · **Contra-Revenue – Promotions & Trade** `promotions_applied` · **Processing Fees – Faire Commission** `total_commission + new_customer_fee` · **Processing Fees** `payment_processing_fees` · **Fulfillment Fees** `insider_fees_charged_to_brand` · **Contra-Revenue – Returns & Allowances** `damages_value` *(derived residual)* | **Gross Sales – Faire Marketplace** `order_total` · *Gross Sales – Faire : Shipping* `shipping_costs_applied` |
| Faire Direct order | identical, `total_commission = 0` | **Gross Sales – Faire Direct** |
| Negative clawback row (`Order Total = 0.00`, negative payout) | **Contra-Revenue – Returns & Allowances** | **Channel Clearing** |
| `Taxes Charged` (Faire is merchant of record) | **not posted by default.** Config flag `faire_brand_is_tax_remitter` (false) → when true, `Cr` **Sales Tax Payable** and increase the clearing debit by the same amount | — |
| `Insider Fees Charged to Faire` | **never posted.** Faire's own cost, shown for transparency. Posting it double-counts shipping expense — **the single most common source of an unbalanced Faire entry** `[faire §6.A.9]` | — |
| COGS, from the Product Info export | **COGS** | **Inventory – Finished Goods** |
| Faire Ads (billed separately, not in this file) | **Advertising** | **Bank** / **AP** – *card* |
| Bank deposit of the payout batch | **Bank** | **Channel Clearing** |

**Note on commission classification:** Sooz is the **principal** in a Faire sale (owns the inventory,
sets the price, ships the goods), so revenue is gross and commission is a **selling expense**, not
contra-revenue. The chart has no `Channel Commission Expense`, so it maps to **Processing Fees** —
that is a chart limitation, not an accounting judgement; move it when the account is added
`[faire §7 chart note]`.

### 5.5 Direct wholesale & foodservice (Faire Part B)

`[faire §7.B]`. Real AR against the customer.

| Event | Debit | Credit |
|---|---|---|
| Invoice issued | **AR** `invoice_total` | **Gross Sales – Wholesale Direct** / **Gross Sales – Foodservice**; **Sales Tax Payable** *(usually 0 — sale for resale)*; plus **COGS** / **Inventory** at standard cost |
| Payment in full | **Bank** | **AR** |
| Early-payment discount taken in window (2/10 net 30) | **Bank** `amount_paid` · **Contra-Revenue – Early Payment Discounts** `discount_taken` | **AR** (face) |
| Discount taken **outside** the window (`> invoice_date + discount_days + grace`) | **Bank** · **Deductions Receivable** *(code `UNAUTH_DISC`)* | **AR** |
| Short-pay, **valid contracted trade** (signed agreement / accrued promo) | **Bank** · **Contra-Revenue – Promotions & Trade** | **AR** |
| Short-pay, **valid return/allowance** (documented damage, shortage) | **Bank** · **Contra-Revenue – Returns & Allowances** | **AR** |
| Short-pay, **disputed or undocumented** — the default | **Bank** · **Deductions Receivable** + open a dispute case | **AR** |
| Deduction later conceded | **Contra-Revenue – Returns & Allowances** | **Deductions Receivable** |
| Deduction later recovered | **Bank** | **Deductions Receivable** |
| Deduction written off as bad | *Bad Debt Expense* | **Deductions Receivable** |
| Credit memo issued proactively | **Contra-Revenue – Returns & Allowances** | **AR** |
| Credit memo **applied** on a later remittance | **AR movement only — no new expense.** The P&L hit happened when the memo was issued; double-hitting contra-revenue here is the most common error in this flow `[faire §7.B.5]` | |
| Deposit that cannot be applied (stage 6) | **Bank** | *Unapplied Customer Cash* + a cash-application task. **Never leave a bank line unposted, and never auto-apply oldest-first without a flag** `[faire §7.C.1]` |

**Default when uncertain: Deductions Receivable.** It keeps disputed money visible as an asset under
active collection instead of quietly eroding revenue. A configurable auto-write-off threshold (e.g.
under $25) sends trivial amounts straight to Contra-Revenue to keep the dispute queue signal-rich
`[faire §7.B.4]`.

### 5.6 UNFI / KeHE distributor remittances

`[distributor §7.4]`. Every advice: cash to **Channel Clearing**, AR relieved at **gross**, deductions
split three ways.

| Reason class (examples) | Debit on import | Credit |
|---|---|---|
| Net cash of the advice | **Channel Clearing – UNFI/KeHE** | — |
| The invoices being paid | — | **AR – UNFI/KeHE** at **full gross**, never net |
| **Funded trade promotion** — MCB, off-invoice, scan-down, billback, TPR, ad fee, coupon, demo, display (KeHE `H`, `N`, `AD`, `Y`, `U`, `J`; UNFI `UOI`, `MCB`, `10`–`12`; X12 `16`, `56`, `57`) | *Accrued Trade Promotion Liability* **if accrued** (§5.7), else **Contra-Revenue – Trade Promotion** | **AR** |
| **Listing / entry costs** — slotting, new item, free fill, intro (KeHE `S`, `I`, `IAA`, `P`) | **Contra-Revenue – Slotting & New Item** | **AR** |
| **Product condition** — spoils, unsaleables, swell, out-of-date, reclamation, fairshare (KeHE `G`, `Q`, `CS`, `GP`; UNFI `05`, `CNDM`; X12 `11`–`13`, `D8`) | **Contra-Revenue – Spoils & Unsaleables** | **AR** |
| **Terms** — 2/10 net 30 cash discount (KeHE `CD`) | **Contra-Revenue – Cash/Terms Discount** | **AR** |
| **Freight allowance** — KeHE `FF` at $0.25–$0.40/lb; UNFI freight allowance; X12 `54` | **Contra-Revenue – Freight Allowance** | **AR** |
| **Distributor service fees** — KeHE Connect BI 2% (`MA`), MCB admin 8%/min $65 (`IA`), EP fee; UNFI SSA 2.5% | **Contra-Revenue – Distributor Fees** *(configurable per code → **Advertising** / Data & Analytics Expense where a **distinct service at fair value** was received — ASC 606)* | **AR** |
| **Compliance fines** — OTIF/fill-rate (`SLF`), late delivery (`AVL`), BOL (`LCBOL`), pallet (`LCP`/`LCPV`), label, ASN, routing, W&M | **Contra-Revenue – Distributor Fees & Fines** *(configurable → **Fulfillment Fees**)* | **AR** |
| **Billing correction** — shortage / case cuts / pricing discrepancy **proven valid** | **Gross Sales – Distributor** (+ **Inventory**/**COGS** correction, or *Inventory Shrink* if lost in transit) | **AR** |
| **Disputable claim** — shortage (`C`, `KC`, `01`, `-111`), pricing (`02`), unauthorized, duplicate, post-audit. **The default** | **Deductions Receivable** + open a dispute with a due date from `dispute_window_days` | **AR** |
| **Recovery** — `RP`, `…PB`, price-protection credit, X12 `52`/`53`/`63` | **Channel Clearing** | **Deductions Receivable** — **never revenue** |
| Partial recovery | **Channel Clearing** (allowed) + **Contra-Revenue – Deduction Write-offs** (denied) | **Deductions Receivable** |
| Write-off (dispute denied, or window closed unused) | **Contra-Revenue – Deduction Write-offs** *(not bad debt — under ASC 606 this is consideration retained by the customer)* | **Deductions Receivable** |
| Valuation allowance at close (trailing recovery rate) | **Contra-Revenue – Deduction Write-offs** (reserve) | *Allowance for Disputed Deductions* (contra-asset) |
| **Bottle deposit** (KeHE `BD`) | *Container Deposit Liability* — **not Sales Tax Payable** `[distributor §3.3]` | **AR** |
| Broker fee (`BF`) | *Broker Commission Expense* | **AR** |
| **Unmapped reason code** | *Unapplied Deductions* (suspense) — blocks the close, forces human mapping | **AR** |
| Advice nets negative (deductions > invoices) | **AR** relief as normal | **AP** — a balance owed to the distributor, **not negative cash** `[distributor §6.4]` |
| Bank feed match | **Bank** | **Channel Clearing** |

**A remittance without its deduction backup imports as cash + gross AR relief + a single
*Unapplied Deduction* suspense line — never as a guess at contra-revenue** `[distributor §0]`. The
backup commonly arrives days later, and the claim (EDI 812) commonly arrives days-to-weeks *before*
the money. The importer must tolerate both orders.

### 5.7 Trade-spend accruals — where the deduction actually lands

`[distributor §7.6]`. The deduction for an August promotion arrives on a September or October check.
Recognising trade spend only when the deduction lands inflates August's net revenue and puts a margin
hole in October that has nothing to do with October. Under ASC 606 the discount is **variable
consideration**, recognised **when the related revenue is recognised**.

| Step | Debit | Credit |
|---|---|---|
| ① Promotion runs (August), 500 planned cases × $1.00 + est. admin fee | **Contra-Revenue – Trade Promotion** 500.00 · **Contra-Revenue – Distributor Fees** 65.00 | *Accrued Trade Promotion Liability* 565.00 |
| ② September remittance — the actual deduction hits the **liability**, not contra-revenue | *Accrued Trade Promotion Liability* 485.00 | **AR** 485.00 |
| ③ Promotion closed — **the variance** goes to contra-revenue | *Accrued Trade Promotion Liability* 80.00 | **Contra-Revenue – Trade Promotion** (accrual variance) 80.00 |

Never release an accrual silently — every release is a journal entry with the promotion id in the
memo. Age any accrual with no activity for 2× its expected claim lag onto a review report.

### 5.8 QuickBooks migration — mapping, not derivation

`[quickbooks §7.1]`. **The QBO Journal report is already a general journal.** Every row is already a
debit or credit against a named account and every transaction already balances. The migration is a
**transcription plus an account mapping**. Any logic that "interprets" an invoice into debits and
credits is a bug — QBO already did that, and its answer is what the historical trial balance
reflects.

| QBO account (colon path) | Sooz Books category |
|---|---|
| `Checking`, `Savings`, any `Bank` / `Credit Card` type account | **Bank** |
| `Accounts Receivable (A/R)` | **AR** |
| `Accounts Payable (A/P)` | **AP** |
| `Undeposited Funds`, `Shopify Clearing`, `Amazon Clearing`, `Faire Clearing` | **Channel Clearing** (map Undeposited Funds to `Channel Clearing:Undeposited Funds (QBO legacy)` — keep it distinguishable) |
| `Sales of Product Income`, `Sales`, any `Income` account, split by `Class`/`Location` | **Gross Sales by channel** |
| `Discounts given`, `Trade Spend`, `Promotional Allowances`, `Sales Returns` | **Contra-Revenue** |
| `Sales Tax Payable`, `<State> Department of Tax and Fee Administration Payable` | **Sales Tax Payable** |
| `Merchant Account Fees`, `Payment Processing Fees`, `Stripe Fees`, `Shopify Payments Fees` | **Processing Fees** |
| `Shipping and Delivery`, `3PL Fees`, `Fulfillment`, `Amazon FBA Fees` | **Fulfillment Fees** |
| `Advertising`, `Marketing:Paid Media` | **Advertising** |
| `Inventory Asset` | **Inventory** |
| `Cost of Goods Sold` and children (`COGS:Freight In`, `COGS:Co-Pack`) | **COGS** |
| `Vendor Deductions Receivable`, `Chargebacks Receivable` | **Deductions Receivable** |
| `Opening Balance Equity` | *Equity:Opening Balance Equity* — **migrate as-is**, do not clean up during migration |
| `Retained Earnings` | *Equity:Retained Earnings* — **posted balance only**; never invent closing entries (§5.9) |
| `Reconciliation Discrepancies` / `Reconcile Discrepancies` | *Expense:Reconciliation Discrepancies* |
| everything else | 1:1, preserving `Type` / `Detail Type` |

**The mapping must be total and signed off.** Emit the full list of distinct `Account` strings across
every monthly Journal export, with row counts and net amounts, and have the accountant approve it
before any import runs. **An unmapped account aborts the import — it never defaults to suspense.**
This is the one place in the system where suspense is *not* the safe answer, because a migration
suspense line silently breaks the trial-balance equality that is the migration's whole acceptance
test.

**Key `accounts` on the full colon path, never the leaf.** `COGS:Freight` and `Shipping:Freight` both
leaf-render as `Freight`; merging them destroys the P&L `[quickbooks §6.3]`.

### 5.9 Accounts the chart does not yet have

The mapping above requires these beyond the given categories (Bank, AR, AP, Channel Clearing, Gross
Sales, Contra-Revenue, Sales Tax Payable, Processing Fees, Fulfillment Fees, Advertising, Inventory,
COGS, Deductions Receivable, Other Income). Add them before the first importer ships:

| Account | Type | Needed by |
|---|---|---|
| `Shipping Income` | Revenue | Shopify — shipping charged to the customer is income and is **not** the label cost `[shopify §7a]` |
| `Tips Payable` | Liability | Shopify — tips are inside the `charge` and recoverable only as a residual `[shopify §6.16]` |
| `Software & Platform Expense` | Expense | Shopify `billing_debit` — plan, apps, themes, domains `[shopify §7f]` |
| `Sales Tax Compliance Expense` | Expense | Shopify Tax transaction fees (may fold into the above) `[shopify §7a]` |
| `Duties Payable`, `VAT Payable` | Liability | Shopify Markets, Amazon EU/UK `[shopify §2b, amazon §7b]` |
| `Reserve Receivable` / `Amazon Reserve` | Asset | Shopify `reserved_funds`, Amazon reserve rows — balance sheet only, no P&L `[shopify §7b, amazon §7b]` |
| `Accrued Trade Promotion Liability` | Liability | Distributor accruals (§5.7) |
| `Allowance for Disputed Deductions` | Contra-asset | Deductions Receivable valuation `[distributor §7.3 Entry D]` |
| `Container Deposit Liability` | Liability | KeHE `BD` bottle deposits — **not** Sales Tax Payable `[distributor §3.3]` |
| `Broker Commission Expense` | Expense | KeHE `BF` `[distributor §9.2]` |
| `Bad Debt Expense` | Expense | Written-off wholesale deductions `[faire §7.B.4]` |
| `Unapplied Customer Cash` | Liability | Cash-application stage 6 `[faire §7.C.1]` |
| `Uncategorized Expense`, `Undeposited Receipts` | Suspense | Bank rows 15/16 `[bank-csv §7.1]` |
| `Suspense – Shopify Review`, `Suspense – Amazon Unmapped`, `Unapplied Deductions` | Suspense | Unknown vocabulary, per importer |
| `Equity:Opening Balance Equity`, `Equity:Retained Earnings`, `Equity:Migration Variance` | Equity | QBO migration `[quickbooks §6.4, §6.7, §7.6]` |
| `COGS:Inventory Shrink` | COGS | Amazon lost/damaged units, QBO inventory adjustments |

**One structural decision the chart implies** `[quickbooks §6.7]`: **never post year-end closing
entries.** QBO computes `Retained Earnings` at report time as the posted RE balance plus all prior
fiscal years' income and expense. If Sooz Books posts closing entries, its trial balance will not
match QBO's for any month after the first fiscal year end. Implement the computed, QBO-compatible
rule.

---

## 6. Implementation order and risk

Ranked by value-to-effort **for this company** — a CPG brand selling DTC on Shopify, 3P on Amazon,
wholesale through Faire and distribution through UNFI/KeHE, migrating off QBO.

| # | Importer | Value | Effort | Why here |
|---|---|---|---|---|
| **1** | **Bank & card CSV** | **Critical — unblocks everything** | High | Nothing else can be *proven* without it. Every clearing account in §4 needs the deposit side; until the bank importer exists, no channel importer can demonstrate that it dropped nothing. Effort is high in breadth (9 institutions, 3 shapes, 2 file families per bank) but `[bank-csv §2.9]`'s "build three code paths, not fifty bank profiles" caps it, and the column-mapping heuristics in `[bank-csv §9]` handle the unknown-bank tail. |
| **2** | **Amazon settlement V2** | High | **Lowest per dollar reconciled** | One file, one exact assertion (`Σ amount == total-amount`, diff 0.00 on seven real files), one immutable container key. Overlapping re-import is *structurally impossible* `[amazon §5d]`. No join to a second file is needed for the settlement entry. The vocabulary is large and open-ended, but the suspense rule makes that a backlog item rather than a blocker. Build this before Shopify to establish the clearing pattern on the easiest possible source. |
| **3** | **Shopify** | **Highest revenue** | Medium-high | Two files that must be joined on order name; neither alone produces a correct entry `[shopify §intro]`. The payout tie-out is a strong control, but the decomposition has real edges: gift cards settle off-gateway, tips and duties have no column and come out as a residual, multi-currency must use the *implied* rate from the balance row (a market rate will not tie), and `adjustment` rows are not self-describing and must never auto-post. |
| **4** | **Faire (Part A)** | Medium | **Low** | One flat 19-column CSV. The §3.A.3 identity probe means the importer discovers its own column semantics rather than guessing, which removes most of the risk for very little code. The trap list is short and mechanical (`Insider Fees Charged to Faire` never posts; `Order Number` is a string; one order can span several payout rows). Good value for a small build. |
| **5** | **UNFI / KeHE — staged** | **Highest dollar leakage** | **Highest** | Deductions run 5–15% of gross revenue and 10–40% of them are contestable `[distributor §10]` — the largest recoverable number in the business. But there is **no published file spec**, headers vary by portal release, backup arrives separately (or by OCR'd PDF, or not at all), the reason-code taxonomy runs to hundreds of codes, and doing it properly requires an accrual ledger and a dispute workflow with window timers. **Ship it in two stages.** Stage 1 (small): cash to clearing + gross AR relief + a single `Unapplied Deductions` line, which is exactly what `[distributor §0]` prescribes for a remittance without backup — this alone gets the cash and AR right. Stage 2 (large): reason-code classification, accruals, Deductions Receivable and the dispute engine. |
| **6** | **QuickBooks full history** | High, but **one-time** | **Highest one-time** | Gated by an acceptance test that admits no tolerance: every account, every month, difference exactly zero `[quickbooks §7.6]`. Take the **opening-balance shortcut first** — migrate a single dated opening trial balance at a closed, reconciled month-end and run Sooz Books forward — then backfill full history behind that cut-off. Use the hybrid path: Reports API `JournalReport` for the ledger (QBO has already computed the debits and credits; re-deriving them means rebuilding QBO's sales tax, discount, billable-expense and FIFO logic and hoping it agrees to the cent — it will not) and entity queries for `FullyQualifiedName` and `LinkedTxn` `[quickbooks §8]`. |

### 6.1 The five biggest risks, and what retires each

| Risk | Consequence | Mitigation |
|---|---|---|
| **A balance column posted as an amount** | Catastrophic and *silent*: every entry gets the account's entire history, the trial balance still ties, and the books look healthy while every number is fiction. On a 15-row sample, true net movement `−18,947.86` vs summed balances `+578,363.73` `[bank-csv §9.6]` | The balance recurrence test, mandatory, run in both row orders. A column that passes it is **permanently disqualified from being the amount.** If a file has a balance column and no column passes the amount tests, **fail the import** rather than falling back |
| **Revenue booked from a bank deposit** | Understated revenue, zero sales-tax liability, then double-counted when the settlement file arrives `[bank-csv §7.0]` | §4's clearing pattern, plus the exception-report line "bank deposits matched to no settlement", which blocks the close |
| **A dropped row in a control-totalled file** | Amazon: the identity breaks and the import is rejected — so this fails *loudly*. The danger is a team that responds by relaxing the assertion | §1.3 rule 2: in any importer that asserts a control total, a row-level `error` is promoted to `fatal`. No tolerance, ever, on Amazon / distributor / QBO |
| **The distributor reason-code map guessing** | Trade spend either overstated (recoveries credited to revenue) or understated (valid disputes written off). Misrouting `PB`/`RP` recoveries is named as the single most common way trade-spend reporting gets overstated `[distributor §6.4]` | Unmapped code → `Unapplied Deductions`, which **blocks the close**. Default disposition for anything unproven is `Deductions Receivable`, not contra-revenue |
| **Subset-sum cash application (remittance stage 5)** | With 40 invoices averaging $1,000, thousands of subsets hit any target; a confident wrong allocation silently corrupts AR aging `[faire §7.C.1]` | Cap the candidate set at 60, require uniqueness, prefer a contiguous oldest-first run, and **never let stage 5 auto-post** — every low-confidence allocation is queued for human confirmation, and a short-paid invoice's residual becomes a visible deduction record rather than closing the invoice |

### 6.2 Build order within each importer

Every importer, in this sequence. Do not reorder — each step is what makes the next one checkable.

1. `detect()` + the rejection cases, with fixtures for each impostor file type.
2. `parse()` against the doc's synthetic fixtures, asserting the counts the fixture states — e.g.
   BofA must import **exactly 12** rows, not 13 (counting the beginning-balance row) and not 17
   (counting the preamble) `[bank-csv §8.3]`; the Amex fixture is **14 logical rows in 60+ physical
   lines** `[bank-csv §8.4]`; the Wells Fargo fixture must import **12**, not 11 `[bank-csv §8.8]`;
   the Shopify orders fixture must sum to `1,155.60` grouped and `2,268.95` ungrouped, proving the
   grouping bug `[shopify §8b]`.
3. The §1.4 assertions, with a deliberately broken fixture for each one.
4. `fingerprint()` + the §3.4 M/N table as four unit tests.
5. `preview()`.
6. `toEntries()`, with the doc's fully worked example as an end-to-end golden test — every source doc
   ships one that balances to a stated total, and that total is the test's expected value.

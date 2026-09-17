# Distributor Remittances & Deductions — UNFI and KeHE

**Source systems:** UNFI (myUNFI / UNFI Supplier Portal / Dispute Center by Direct Commerce), KeHE (KeHE CONNECT Supplier / K‑Solve), plus the EDI channel (810 / 812 / 820 / 852).
**Consumer:** Sooz Books importer → balanced journal entries.
**Status:** research specification. Read §0 before trusting any column name.

---

## 0. Read this first — what is and is not authoritative

This is the one import in Sooz Books where **there is no published file spec**. Shopify, Amazon and Stripe publish column-level documentation. UNFI and KeHE do not. What exists publicly:

| Layer | Public documentation? | Confidence |
|---|---|---|
| X12 EDI 810 / 812 / 820 / 852 segment structure and element 426 reason codes | Yes — ASC X12 standard, and many retailer implementation guides are public (Kroger, Safeway, AAFES, 3M) | **High.** Build the EDI parser to spec. |
| KeHE invoice/deduction **prefix codes** (`IA`, `MCB`, `H`, `N`, `S`, `G`, `FF`, `SLF`…) | Yes — widely republished from KeHE supplier docs | **High** on the code→meaning mapping, **medium** on completeness |
| UNFI deduction **code families** (`01`, `02`, `05`, `10–12`, `30+`) and string codes (`MCB`, `UOI`, `CNDM`, `LCP`, `LCBOL`, `AVL`) | Partially — UNFI's own *Supplier Deduction Key* (`Supplier Deduction Key 01.14.2025.xlsx`, reported as **446 codes across 55 categories**) lives behind the supplier portal login | **Medium.** Treat the shipped table as a seed, not a closed set. |
| UNFI adjustment / payment **number formats** | Yes, documented by third-party dispute tooling | **High** |
| The **CSV column headers** of a myUNFI or KeHE CONNECT export | **No** | **Low.** Headers vary by portal release, region and export screen. |

**Design consequence, and this is the most important sentence in this document:**

> Do **not** hard-code column names for the portal exports. Build a **per-source header-mapping profile** (a small YAML/JSON dictionary of `canonical_field → [accepted header aliases]`), normalise every incoming file into the canonical schema in §2.4, and fail loudly with "unmapped header: `<text>`" rather than guessing. Hard-code only the EDI 820/812 element positions, which are standardised.

Two different things arrive and both must be imported:

1. **The remittance advice** — "we paid you $X, here are the invoices and here is what we took off." Money movement. Always exists.
2. **The deduction backup** — "here is *why* we took $850 off, line by line, with reason codes." Often a **separate file, sent separately, sometimes days later, sometimes only on request.** The accounting cannot be finished without it.

A remittance without backup should import as cash + AR relief + a single **Unapplied Deduction** suspense line, never as a guess at contra-revenue.

---

## 1. How you get the file

### 1.1 UNFI

**Channel A — email (primary today).** UNFI emails the remittance and, separately, deduction backup. Reported reality:

- There are **at least four different UNFI sender addresses** used for deduction detail. Whitelist all of them and route by subject, not sender alone.
- Attachments are inconsistent: **PDF**, **.zip containing spreadsheets or text files or more PDFs**, or **a link to a SharePoint folder** you must click through to download a zip or individual files.
- When backup is not emailed, request it: **`DeductionsBackup@unfi.com`**.
- MCB (manufacturer chargeback) documents are sent on a **weekly** cadence; sign up via **`supplierdeductiondisputemgmt@unfi.com`**.

**Channel B — myUNFI portal.**
`https://www.myunfi.com` (supplier login; customer-side is `customers.unfi.com`) → **Supplier Dashboard** → the portal shows posted invoices, payments, and deductions taken.

**Channel C — Dispute Center (launched February 2026, built by Direct Commerce, Inc.).**
`myunfi.com` → left nav → blue **"GO TO DISPUTE CENTER"** button.
Inside:
- **Activity Center → View Payments** — last 30 days.
- **My Docs** — adjustments and payments bucketed by **30 / 60 / 90 days**.
- **Quick Search** (top right) — by payment number or adjustment number.
- **Advanced Search** — date ranges, amounts, document types, status; **this is the screen that exports invoice, adjustment, payment and dispute detail**. Use Advanced Search with a wide date range, not the 30-day Activity Center, or you will silently miss rows.
- Dispute upload accepts **PDF, TIFF, JPEG, XLSX, CSV**, **max 20 MB per file**. A **bulk CSV template** exists for submitting many disputes at once.

**Options that matter when exporting from UNFI:**
- Choose a **date range that overlaps the previous export by ≥ 7 days** — deductions post late and backfill.
- Export **per region (EAST / WEST) separately** if the screen offers it; region is part of the identity key (§5) and the two regions use different promotional code vocabularies (§3 of the reason table).
- Include **status = all**, not just open. Closed/paid disputes carry the `PB` repayment lines you need to recognise recoveries.

**Deductions that never appear in the Dispute Center** and must be handled by email — the importer should tag these so a human is routed correctly:

| Deduction owner | Route to |
|---|---|
| AP Cash Terms | `UNFINaturalResearch@unfi.com` |
| SAS (recovery audit) | `UNFICorr@sasrecovery.com` |
| SASIF (freight audit) | `UNFIFrt@sasrecovery.com` |
| PRGX (post-audit) | `UNFIAudit@prgx.com` |

### 1.2 KeHE

**KeHE CONNECT Supplier** (`connect.kehe.com`; KeHE recommends Chrome).

- **Deductions:** log in → **Deductions** tab → pull **open deductions** → **download the remittance detail for each deduction**. The detail gives deduction type, the invoice it ties to, and the dollar amount.
- **Documents / remittance archive:** **My Company → Supplier Management → Documents**.
- **K‑Solve** — the dispute case tool, a grid inside CONNECT. The **first column shows the invoice number with the deduction prefix appended**, e.g. `INV1234567IA`. This is where you find the credit lines that appear on your check.
- **Programs / AAP requests:** **CONNECT Supplier® → General** tab.
- Vendor support: `vendorsupport@kehe.com`.

**Options that matter when exporting from KeHE:**
- Export **open *and* closed** deductions. A closed deduction that was won produces a later `RP` (REPAYMENT) credit you must match back.
- KeHE aggregates MCB funding **per supplier × DC combination on a bi-weekly schedule** — so one deduction line can span many invoices and many stores. Export at the **deduction-detail** level, not the summary level, or you lose the invoice linkage entirely.

### 1.3 EDI (preferred long-term path)

Set up through your VAN / EDI provider. UNFI requires **850, 855, 856, 810, 820, 997**; **812** and **852** are added by agreement. KeHE runs the same core set. Files arrive as flat X12 with `~` segment terminator and `*` element separator (component `>`).

This is the only channel that gives you **structured, coded, line-level deduction data with no OCR**. If the brand can afford EDI, the 812 + 820 pair replaces every PDF in §1.1–1.2.

---

## 2. Columns

### 2.1 EDI 820 — Payment Order / Remittance Advice (authoritative)

The money and the invoice-level split. `005010` element positions:

| Segment.Element | X12 name | Type | Example | Meaning | Required? |
|---|---|---|---|---|---|
| `BPR01` | Transaction Handling Code | AN 1/2 | `C` | `C` = payment accompanied by remittance detail; `I` = remittance only, no money; `D` = make payment only | Yes |
| `BPR02` | Monetary Amount | R 1/18 | `17242.31` | **Net cash paid.** Always positive, always absolute value | Yes |
| `BPR03` | Credit/Debit Flag | ID 1/1 | `C` | `C` credit, `D` debit | Yes |
| `BPR04` | Payment Method Code | ID 3/3 | `ACH` | `ACH`, `CHK`, `FWT` (wire), `NON` (info only) | Yes |
| `BPR05` | Payment Format Code | ID 1/10 | `CCP` | `CCP` = cash concentration/disbursement plus addenda, `CTX` = corporate trade exchange | No |
| `BPR06`–`BPR09` | Originating DFI (payer bank) | | `01*071000013*DA*1234567890` | Payer routing/account | No |
| `BPR12`–`BPR15` | Receiving DFI (your bank) | | `01*021000021*DA*9876543210` | Your routing/account | No |
| `BPR16` | Payment Effect Date | DT 8/8 | `20260911` | **Settlement date — use this as the bank date**, not the file date | Yes in practice |
| `TRN02` | Reference Identification | AN 1/30 | `0009941177` | **Payment / check / ACH trace number. This is your primary dedup key.** | Yes |
| `TRN03` | Originating Company Identifier | AN 10/10 | `1364000000` | Payer company ID | No |
| `DTM01/02` | Date/Time Qualifier + Date | | `097*20260911` | `097` = transaction creation date | No |
| `N1*PR` | Payer name/ID | | `KEHE DISTRIBUTORS LLC*91*KEHE01` | Who paid | Yes |
| `N1*PE` | Payee name/ID | | `SOOZ FOODS INC*91*SZ4471` | You, and **your vendor number at the distributor** | Yes |
| `RMR01` | Reference ID Qualifier | ID | `IV` | `IV` = invoice, `PO` = purchase order, `CM` = credit memo, `DM` = debit memo | Yes |
| `RMR02` | Reference Identification | AN 1/30 | `INV4471001` | **Your invoice number as the distributor stored it** | Yes |
| `RMR03` | Payment Action Code | ID | `PO` | `PO` = payment on account, `AJ` = adjustment, `PP` = partial payment. **Values vary by partner — read their guide** | No |
| `RMR04` | Monetary Amount | R | `9150.00` | **Amount actually paid against this invoice** | Yes |
| `RMR05` | Total Invoice Amount | R | `10000.00` | **Gross invoice amount** | No (but usually sent) |
| `RMR06` | Discount Taken | R | `0.00` | Terms/cash discount taken on this invoice | No |
| `ADX01` | Monetary Amount | R | `-420.00` | **Deduction amount. Negative = money withheld** | Yes (if ADX present) |
| `ADX02` | **Adjustment Reason Code (element 426)** | ID 2/2 | `16` | The coded reason. See §9.1 | Yes (if ADX present) |
| `ADX03` | Reference ID Qualifier | ID | `IV` | Qualifier for ADX04 | No |
| `ADX04` | Reference Identification | AN | `INV4471001H` | **The deduction document number** — KeHE puts the prefixed invoice here | No |
| `REF*PO` | Purchase order | AN | `4471882` | PO the invoice came from | No |
| `DTM*003` | Invoice date | DT | `20260828` | Original invoice date | No |

**Header variation to guard against:** some implementation guides state *"only one ADX is permitted per RMR."* Others allow many. If your partner enforces one-ADX-per-RMR, the same invoice appears in **multiple RMR loops** — once per deduction — and `RMR05` (gross) is then repeated on each, so **summing `RMR05` double-counts gross sales.** Dedup gross by `RMR02` before totalling.

Raw sample (synthetic):

```
ISA*00*          *00*          *ZZ*KEHEDIST       *ZZ*SOOZFOODS      *260911*0730*U*00501*000004471*0*P*>~
GS*RA*KEHEDIST*SOOZFOODS*20260911*0730*4471*X*005010~
ST*820*0001~
BPR*C*17242.31*C*ACH*CCP*01*071000013*DA*1234567890*1364000000**01*021000021*DA*9876543210*20260911~
TRN*1*0009941177*1364000000~
DTM*097*20260911~
N1*PR*KEHE DISTRIBUTORS LLC*91*KEHE01~
N1*PE*SOOZ FOODS INC*91*SZ4471~
ENT*1~
RMR*IV*INV4471001*PO*9150.00*10000.00*0.00~
REF*PO*4471882~
DTM*003*20260828~
ADX*-420.00*16*IV*INV4471001H~
ADX*-65.00*29*IV*INV4471001IA~
ADX*-365.00*59*IV*INV4471001C~
RMR*IV*INV4471002*PO*5825.34*6420.50*0.00~
ADX*-212.40*56*IV*INV4471002N~
ADX*-96.75*11*IV*INV4471002G~
ADX*-158.00*54*IV*INV4471002FF~
ADX*-128.41*16*IV*INV4471002MA~
CTT*2~
SE*20*0001~
GE*1*4471~
IEA*1*000004471~
```

### 2.2 EDI 812 — Credit/Debit Adjustment (the document a CSV remittance cannot replace)

The 812 is the **claim**, issued when the distributor decides to charge you — often **before** the money is taken. It is sent as a separate transaction set; the 820 later shows the same money as an `ADX`.

| Segment.Element | Name | Type | Example | Meaning | Required? |
|---|---|---|---|---|---|
| `BCD01` | Date | DT 8/8 | `20260903` | **Claim/adjustment creation date** — drives *days-to-deduction* (§10) | Yes |
| `BCD02` | Credit/Debit Adjustment Number | AN 1/22 | `C4471982` | **The claim number. Quote this when disputing.** | Yes |
| `BCD03` | Transaction Handling Code | ID | `C` | Handling | Yes |
| `BCD04` | Monetary Amount | R | `365.00` | Total adjustment | Yes |
| `BCD05` | Credit/Debit Flag Code | ID 1/1 | `D` | `C` = credit to you, `D` = debit (deduction) | Yes |
| `BCD07` | Correction Indicator | ID | | Replaces a prior claim | No |
| `BCD08`/`REF` | Original invoice / document number | AN | `INV4471001` | Ties the claim to the invoice | Usually |
| `CDD01` | **Adjustment Reason Code (element 426)** | ID 2/2 | `59` | Coded reason — see §9.1 | Yes |
| `CDD02` | Credit/Debit Flag | ID | `D` | Direction for this line | Yes |
| `CDD03` | Monetary Amount | R | `365.00` | Line amount | Yes |
| `CDD04`–`CDD06` | Quantity / UOM / unit price | | `24*CA*15.21` | **Units and unit price behind the claim** | No |
| `IT1` | Baseline item data | | `IT1**24*CA*15.21*UP*857392004112` | **Item-level UPC + qty + price** | No |
| `SAC` | Service/Promotion/Allowance/Charge | | `SAC*A*C310***42000` | Allowance type and amount, with the promotion/deal identifier | No |
| `N1*ST` | Ship-to / DC | | `N1*ST*UNFI RICHBURG*92*05` | **Which DC the claim came from** | No |
| `ITD` | Terms | | | Payment terms invoked | No |
| `TDS/CTT` | Totals / control | | `TDS*36500` `CTT*3` | Totals, line count | Yes |

**What the 812 carries that a CSV/PDF remittance does not:**

1. **A coded reason (`CDD01`, X12 element 426)** instead of a free-text description you have to fuzzy-match.
2. **Item-level detail** — UPC, case quantity, unit price, deal/SAC identifier. A remittance gives you one dollar amount; the 812 lets you prove "you claimed 24 cases but the BOL says 24 shipped."
3. **The claim date (`BCD01`) separate from the payment date.** This is the only way to compute *days-to-deduction* and to see a claim before the cash is short.
4. **A stable claim number (`BCD02`)** you can dispute against **before** the deduction hits a check.
5. **Ship-to / DC identity (`N1*ST`)**, which is how you attribute a deduction to a DC and a promotion window.
6. **Direction (`BCD05`)** — an explicit credit vs debit flag, so recoveries are unambiguous rather than "a positive number on a remittance."

### 2.3 EDI 810 / 852 (context)

- **810 Invoice** — what *you* send. The invoice number in `BIG02` is the join key everything else references. Any mismatch between the 810, the 856 ASN and the 850 PO is the single largest generator of shortage and pricing deductions.
- **852 Product Activity Data** — what the distributor sends you about movement. Key segments: `XQ` (reporting date; `XQ02` = date, or start date when `XQ03` holds an end date), `LIN` (item), `ZA` (the workhorse — one `ZA` per activity code per item, e.g. `QS` quantity sold, `QA`/`QP` quantity available/on hand, `QO` on order), `XPO` (related POs). **The 852 is not an accounting document — never journalise from it.** Use it to (a) estimate promotional accruals from actual sell-through units, and (b) validate MCB claims: if the 852 says 300 units moved during the deal window and the MCB bills 420 units, you have a disputable line.

### 2.4 Canonical normalised schema (what every parser writes)

Every UNFI/KeHE file — CSV, XLSX, PDF-extract, or EDI — lands in this one shape. This is the fixture format in §8.

| Column | Type | Example | Meaning | Required? |
|---|---|---|---|---|
| `source_system` | enum | `KEHE` | `UNFI` \| `KEHE` \| `DPI` | Yes |
| `remit_advice_number` | string | `0004471` | Distributor's remittance/advice document number | No |
| `payment_number` | string | `EFT-88214113` | Check or ACH/EFT number. UNFI form: `EAST-9876543` | **Yes** |
| `payment_date` | date | `2026-09-11` | Settlement/effect date (`BPR16`) | **Yes** |
| `payment_method` | enum | `ACH` | `ACH` \| `CHK` \| `FWT` | No |
| `payment_total` | decimal(14,2) | `17242.31` | Net cash for the whole advice; repeated on every row | **Yes** |
| `region_dc` | string | `EAST` / `05` | UNFI region (`EAST`/`WEST`) or KeHE DC number | No (Yes for UNFI) |
| `line_type` | enum | `DEDUCTION` | `INVOICE` \| `DEDUCTION` \| `CREDIT` \| `DISCOUNT` \| `REPAYMENT` \| `UNAPPLIED` | **Yes** |
| `document_number` | string | `9876501-111-EAST` | The deduction/adjustment's own number | Yes for non-INVOICE |
| `reference_invoice_number` | string | `INV4471001` | Invoice the line applies to; **may be blank** | No |
| `invoice_date` | date | `2026-08-28` | Original invoice date | No |
| `claim_date` | date | `2026-09-03` | 812 `BCD01`; blank for CSV sources | No |
| `reason_code` | string | `MCB` / `H` / `01` | **Verbatim source code, uppercased, untranslated** | Yes for non-INVOICE |
| `reason_description` | string | `MCB PROMO BILLBACK - DEAL 88214` | Free text as printed; newlines collapsed to spaces | No |
| `deal_number` | string | `88214` | Promotion/deal/authorisation number when present | No |
| `po_number` | string | `4471882` | PO reference | No |
| `item_upc` | string(14) | `00857392004112` | **Left-pad to 14; never let a CSV reader eat the leading zeros** | No |
| `item_description` | string | `SOOZ CHILI CRISP 6/7.5OZ` | | No |
| `quantity` | decimal(12,3) | `24` | Cases/units claimed | No |
| `unit_amount` | decimal(12,4) | `17.5000` | Per-unit allowance or price | No |
| `line_amount` | decimal(14,2) | `-420.00` | **Signed** — see §3 | **Yes** |
| `currency` | char(3) | `USD` | | Yes |
| `source_file_hash` | sha256 | `9f1c…` | Provenance of the physical file | Yes |
| `source_row_number` | int | `14` | Row in the original file | Yes |

**Observed header aliases to seed the mapping profile** (low confidence, verify against the brand's first real export — these are the variants third-party tooling reports encountering):

| Canonical | UNFI-side aliases seen | KeHE-side aliases seen |
|---|---|---|
| `payment_number` | `Payment Number`, `Payment #`, `Check Number`, `Check/EFT` | `Check Number`, `Check #`, `Payment Ref` |
| `payment_date` | `Payment Date`, `Check Date`, `Pay Date` | `Check Date`, `Remit Date` |
| `document_number` | `Adjustment Number`, `Adjustment #`, `Deduction Number`, `Document Number` | `Invoice Number` *(with prefix appended)*, `Deduction ID`, `Claim #` |
| `reference_invoice_number` | `Invoice Number`, `Invoice #`, `Original Invoice` | `Reference Invoice`, `Orig Invoice` |
| `reason_code` | `Deduction Type`, `Reason Code`, `Adj Type`, `Code` | `Prefix`, `Deduction Code`, `Type` |
| `reason_description` | `Description`, `Reason`, `Adjustment Description`, `Comments` | `Description`, `Deduction Description` |
| `line_amount` | `Amount`, `Adjustment Amount`, `Deduction Amount`, `Net Amount` | `Amount`, `Deduction Amount`, `Credit Amount` |
| `region_dc` | `Region`, `Division`, `Warehouse`, `DC` | `DC`, `Branch`, `Warehouse` |

---

## 3. Sign and amount conventions

**There is no single convention across these sources. The parser must detect, not assume.**

### 3.1 What you will encounter

| Pattern | Where seen | How it renders |
|---|---|---|
| Single signed column, deductions negative | EDI 820 `ADX01`; most portal CSV exports | `-420.00` |
| Single **unsigned** column, direction in a separate flag | EDI 812 (`BCD05`/`CDD02` = `C`/`D`); some KeHE exports | `420.00` + `D` |
| **Parentheses for negative** | Excel/PDF exports formatted for humans | `(420.00)` |
| Trailing minus | Mainframe-origin text files | `420.00-` |
| Separate `Debit` / `Credit` columns, both positive | Some UNFI statement-style exports | `Debit=420.00`, `Credit=` |
| Currency symbol + thousands separators | PDF and XLSX exports | `$1,122.00`, `$ (1,122.00)` |
| Deductions as **positive** in a column literally named "Deduction Amount" | KeHE deduction-detail screens | `420.00` meaning *−420.00* |

That last row is the trap. A column named `Deduction Amount` holding `420.00` and a column named `Amount` holding `-420.00` mean the same thing.

### 3.2 The rule to implement

Normalise **everything** to a single signed `line_amount` where:

- **Negative = money the distributor kept** (deductions, fees, fines, allowances, cash discounts).
- **Positive = money the distributor paid or gave back** (invoice gross, repayments/`RP`/`PB` dispute wins, price-protection credits).

Sign resolution order, per source profile:

1. If an explicit direction flag exists (`BCD05`, `CDD02`, a `D/C` column) → use it, ignore the number's sign.
2. Else if the column is one of `Deduction Amount` / `Chargeback Amount` / `Claim Amount` → **force negative** regardless of printed sign.
3. Else strip `$`, `,`, spaces, and non-breaking spaces (`U+00A0`, common in XLSX exports); convert `(x)` and `x-` to `-x`; take the sign as printed.
4. Then **assert the arithmetic identity** (§6.1). If it fails, do not post — quarantine the file.

**Parsing details:**
- Strip `$`, `USD`, `,`, ` `, `−` (Unicode minus), and thin spaces before `Decimal()`.
- Never use floats. `Decimal` with 2dp for money, 4dp for `unit_amount`.
- `1,122.00` vs `1.122,00` — these are US-only files; if a comma appears as the decimal separator, quarantine rather than guess.
- Zero-amount rows are real (a $0.00 adjustment that documents a closed claim). Keep them; they carry reason codes.

### 3.3 Currency and tax

- **USD only.** KeHE Canada / UNFI Canada would be CAD — if `currency` is anything but `USD`, quarantine.
- **Sales Tax Payable is normally `$0.00` on this source.** Distributor sales are wholesale-for-resale under a resale certificate. If a remittance line references sales tax, it is almost always a **bottle deposit** (KeHE prefix `BD`, "BOTTLE DEPOSIT"), which is a **deposit liability**, not sales tax. Map it to a `Container Deposit Liability` account, not `Sales Tax Payable`, and flag it for review.

---

## 4. Date formats and timezone

| Field | Format seen | Notes |
|---|---|---|
| EDI dates (`BPR16`, `DTM02`, `BCD01`) | `CCYYMMDD` → `20260911` | 8-digit, unambiguous. **No timezone.** |
| EDI time (`DTM03`, `GS05`) | `HHMM` or `HHMMSS` | Interchange local time; ignore for accounting |
| `ISA09` interchange date | `YYMMDD` → `260911` | **2-digit year.** Pivot: `00–79` → 20xx, `80–99` → 19xx. Never use as a business date. |
| myUNFI / Dispute Center exports | `MM/DD/YYYY` → `09/11/2026` | US format |
| KeHE CONNECT exports | `MM/DD/YYYY`, occasionally `M/D/YY` | Two-digit year appears in some grid exports |
| XLSX exports | **Excel serial number** → `46276` | Cells typed as date; openpyxl returns `datetime`, `csv` reading of a converted file returns the serial. Detect integers in the 40000–60000 range in a date column and convert from the 1900 epoch with the leap-year bug. |
| PDF remittances | `MM/DD/YY` or `DD-MON-YYYY` → `11-SEP-2026` | OCR-dependent |

**Timezone caveat.** None of these dates carry a timezone and none are timestamps. Treat every distributor date as a **naive calendar date in US/Central** (both UNFI's and KeHE's AP operations are US-based; KeHE is headquartered in Naperville, IL). Practical consequences:

- The **`payment_date` / `BPR16` effect date is the date you should post the journal entry to.** It is *not* the date the money lands in the brand's bank — ACH settlement can be the same day or the next banking day, and a check date can precede the deposit by a week or more. This is exactly why cash goes to **Channel Clearing** on import and is relieved when the bank feed matches (§7.2).
- Month-end: a remittance dated `09/30` whose cash clears `10/01` belongs in **September**. Do not let the bank feed's date drive the period.
- The **claim date (`BCD01`) can be weeks earlier than the payment date.** Keep both. `days_to_deduction = payment_date − invoice_date`; `claim_lag = payment_date − claim_date`.

---

## 5. Identity and deduplication

### 5.1 Is there a stable unique id?

**Yes for the payment. Mostly yes for the deduction. Never for the "row."**

| Source | Stable id | Format | Notes |
|---|---|---|---|
| EDI 820 | `TRN02` | `0009941177` | The ACH/check trace. **The payment-level dedup key.** Stable across retransmissions of the same payment. |
| EDI 812 | `BCD02` | `C4471982` | The claim number. Stable; `BCD07` correction indicator signals a replacement. |
| UNFI payment | Payment number | `EAST-9876543` = `{REGION}-{payment id}` | Region prefix is part of the key; `9876543` alone is **not unique across regions**. |
| UNFI adjustment | Adjustment number | `9876543-111-EAST` = `{adjustment id}-{deduction type}-{REGION}` | Type segment: `000` = deduction, `111` = chargeback. Also seen as a `-111` suffix directly on invoice numbers for quantity/pricing chargebacks. |
| KeHE deduction | Prefixed invoice number | `INV1234567IA` = `{invoice}{prefix}` | Shown in K‑Solve's first column. **The prefix is part of the identifier** — the same invoice can carry `…H`, `…N` and `…G` lines simultaneously. |
| KeHE special invoice suffixes | `…PP`, `…PB` | `INV1234567PP` | `PP` = prepayment (and its negative reversal); `PB` = **dispute win / payback** against the original disputed invoice number |

### 5.2 Dedup keys to implement

**Level 1 — file.** `sha256(file bytes)`. Catches literal re-uploads of the same attachment. **Necessary but far from sufficient** — UNFI and KeHE re-issue remittances with cosmetic differences (a re-run PDF, a wider date range).

**Level 2 — payment (the one that matters).**
```
payment_key = (source_system, region_dc_or_null, payment_number)
```
If a payment_key already exists with a posted journal entry, the entire advice is a re-import: **skip, and report "already imported on <date> as JE #<n>."** Do not merge.

**Level 3 — line, for overlapping date ranges.** When an export covers `08/01–09/30` and the prior one covered `08/01–09/15`, most rows repeat. Key each line:
```
line_key = (source_system, payment_number, line_type,
            coalesce(document_number, ''),
            coalesce(reference_invoice_number, ''),
            coalesce(reason_code, ''),
            line_amount)
```
**Level 4 — fallback fingerprint** when `document_number` is missing (common in PDF-extracted UNFI backup):
```
fingerprint = sha256(source_system | payment_number | reference_invoice_number |
                     reason_code | normalise(reason_description) | line_amount | invoice_date)
```
where `normalise()` upper-cases, collapses whitespace, and strips punctuation.

**Level 5 — ordinal disambiguator.** Two genuinely identical deduction lines on one payment do occur (two DCs, same reason, same amount, aggregated into one advice). Append an occurrence ordinal within `(payment_key, fingerprint)` so the second `-65.00` MCB fee is `…#2` rather than being dropped. **Dropping a true duplicate is worse than importing one — it silently understates trade spend.** Surface both to the user and let them confirm.

### 5.3 Matching a deduction back to its invoice

`reference_invoice_number` is blank more often than you would like — allowance-type deductions (SSA, Connect BI, spoils fairshare, freight allowance) are charged at the account level. Resolution order:

1. Exact match on `reference_invoice_number`.
2. If blank but `deal_number` present → match to the promotion, then to the invoices in the deal's ship window.
3. If blank and the reason code is in the **account-level** class (§9) → do not force an invoice; post against the customer, not the invoice.
4. Otherwise → `UNAPPLIED` suspense and a review task.

---

## 6. Gotchas

### 6.1 The one check that catches almost everything

```
sum(line_amount where line_type = 'INVOICE')
  + sum(line_amount where line_type != 'INVOICE')      # all negative + any positive credits
  == payment_total
```
If this does not hold to the cent, **quarantine the whole advice**. The three usual causes: an unparsed footer total row got counted as data; a sign was inverted; the backup file covers a different payment than the remittance.

### 6.2 File and encoding

- **"CSV" that is really XLS/XLSX.** Sniff magic bytes: `D0 CF 11 E0` (legacy OLE `.xls`), `50 4B 03 04` (`.xlsx` zip). Both are routinely emailed with a `.csv` extension.
- **"CSV" that is really HTML.** Portal "Export" buttons on older grids emit an HTML `<table>` with a `.xls` name. Sniff for `<html` / `<table` in the first 512 bytes.
- **UTF-8 BOM (`EF BB BF`)** on portal exports — strip it, or your first header becomes `﻿Payment Number` and never matches the alias table.
- **latin-1 / cp1252** in PDF-derived text files: `\x92` smart apostrophes in product names (`SOOZ\x92S CHILI CRISP`), `\xa0` non-breaking spaces inside amounts. Decode with `cp1252` fallback; never `utf-8` strict.
- **Mixed line endings** (`\r\n` and `\r`) in mainframe-origin text backup.
- **Password-protected zips** — UNFI backup zips are occasionally protected; the password is in the email body, not the attachment.
- **SharePoint links that expire.** Download immediately on receipt and archive the bytes; the link will be dead when a human investigates in three weeks.

### 6.3 Structure

- **Preamble rows.** 2–8 rows above the header: company name, "Remittance Advice", date range, page number, a blank row. Locate the header by scanning for the first row where ≥ 3 cells match known aliases, not by assuming row 1.
- **Footer totals.** `TOTAL`, `Grand Total`, `Net Payment`, `*** END OF REPORT ***`, and often a repeated total after each DC section. Drop rows where `reference_invoice_number` is blank **and** `reason_code` is blank **and** the description matches `^(grand )?total|^net |^\*+`.
- **Repeating page headers** in PDF-extracted text — the header line reappears every ~40 rows.
- **Merged cells in XLSX**: the payment number is written once and merged down over 30 rows. `openpyxl` returns `None` for all but the top-left cell. Forward-fill `payment_number`, `payment_date`, `region_dc` after reading.
- **Multi-line descriptions.** `MCB PROMO BILLBACK\nDEAL 88214 08/01-08/28\nSPROUTS SW DIV` inside one CSV field. Quoted correctly by good exporters, **not** by PDF extraction. Collapse `\r?\n` to a single space before the fingerprint hash, or the same row hashes differently between two exports.
- **Section-per-DC layouts.** KeHE MCB funding is aggregated per supplier × DC; a single advice can have a block per DC, each with its own sub-header and sub-total.
- **Pagination.** Portal grids cap at 100/500/1000 rows per export. If `row_count` equals a round cap, assume truncation and re-export in narrower date slices. Log the boundary.

### 6.4 Business-logic traps

- **Pending vs posted.** UNFI's Dispute Center shows adjustments *proposed* and *taken*. Only import what is reflected in a payment. An adjustment with no `payment_number` is a **claim**, not a deduction — record it as an open claim (memo), not a journal entry.
- **A deduction arrives before or after its remittance.** The 812/claim commonly precedes the 820 by days-to-weeks. Backup files commonly *follow* the payment. Both directions happen; the importer must tolerate an advice with no backup and backup with no advice.
- **`PP` prepayment rows and their reversals.** A KeHE invoice ending `PP` with a positive amount is a prepayment; the same number with a **negative** amount later is its reversal. Net them; do not book two revenue events.
- **`PB` / `RP` dispute-win rows are positive.** They are not sales. They must relieve **Deductions Receivable**, not credit revenue. Misrouting these is the single most common way trade-spend reporting gets overstated.
- **UNFI SSA consolidation (effective 1 Feb 2026).** SSA allowances that used to appear on *every invoice* now arrive as **one consolidated monthly deduction per region (East and West), posted within about two weeks after month-end.** A parser tuned to pre-2026 files will find per-invoice SSA lines missing and a large unexplained monthly line. Handle both shapes; the economics are unchanged, only timing and presentation.
- **KeHE MCB admin fee minimums.** 8 % of the MCB amount, **minimum $65 per DC**, billed bi-weekly. The fee line will **not** be 8 % of the promo line when the minimum binds — do not "correct" it. EP fees: 8 % per invoice, **minimum $35, maximum $700** (one source reports max $500 — verify against the brand's current KeHE agreement; **sources disagree, so make it a configurable ceiling, not a constant**).
- **KeHE freight allowance** is quoted at **$0.25–$0.40 per pound**, so the line amount is weight-driven and will never reconcile to a percentage of the invoice.
- **UNFI service-level fines**: reported as a **3 % fine on shorted goods when fill rate falls below 95 %**, with shortships billed at **UNFI list price** (not your wholesale price) and overships taken at a **35 % off-invoice discount**. Recalls carry a reported **$3,000 base fee**. These are amounts you cannot derive from your own invoice — always take the distributor's number and dispute separately.
- **One deduction, many invoices** and **one invoice, many deductions** are both normal. The data model must be many-to-many.
- **Negative net advices.** If deductions exceed invoices, there is no cash and the distributor carries a receivable against you. `payment_total` will be `0.00` with a negative carry-forward, or negative. Post the AR relief and create an **AP balance owed to the distributor**, not negative cash.
- **Post-audit claims arrive up to 3 years later**, from third-party auditors (PRGX for UNFI, plus SAS/SASIF for recovery and freight). They reference invoices that are long closed and are frequently duplicates of deductions already taken. **Never auto-post a deduction whose `reference_invoice_number` is older than 12 months** — route to review.

---

## 7. Accounting treatment

### 7.1 Account categories used

| Category | Role for this source |
|---|---|
| **Bank** | Actual cash, on bank-feed match only |
| **Channel Clearing** | `Channel Clearing — UNFI` / `— KeHE`. Holds the net remittance between the advice date and the bank match |
| **AR** | `AR — UNFI`, `AR — KeHE`. Relieved at **gross invoice**, always |
| **AP** | Only when the advice nets negative (you owe the distributor) or when a fee is separately invoiced rather than deducted |
| **Gross Sales by channel** | `Gross Sales — Distributor — UNFI` / `— KeHE`. Never touched by a deduction except a genuine billing correction |
| **Contra-Revenue** | Sub-accounts: `Trade Promotion (MCB/Billback/Scan)`, `Off-Invoice Allowance`, `Slotting & New Item`, `Spoils & Unsaleables`, `Cash/Terms Discount`, `Freight Allowance`, `Distributor Fees & Fines`, `Deduction Write-offs` |
| **Sales Tax Payable** | Normally untouched — resale exemption (§3.3) |
| **Processing Fees** | Not used for distributor remittances (this is a card/marketplace concept) |
| **Fulfillment Fees** | Actual freight and logistics **services you bought**, not allowances |
| **Advertising Expense** | Only where a **distinct advertising service at fair value** was received |
| **Inventory / COGS** | Shipment-side only, plus genuine shortage corrections |
| **Deductions Receivable** | **The disputed portion.** An asset, with a valuation allowance |

### 7.2 The posting pattern

Step 1 — **when the invoice ships** (from the 810, not this file):

```
Dr  AR — KeHE                              10,000.00
    Cr  Gross Sales — Distributor — KeHE              10,000.00

Dr  COGS                                    5,800.00
    Cr  Inventory                                      5,800.00
```

Step 2 — **when a promotion runs** (accrual; see §7.6):

```
Dr  Contra-Revenue — Trade Promotion          500.00
    Cr  Accrued Trade Promotion Liability                500.00
```

Step 3 — **when the remittance imports** (§7.3).

Step 4 — **when the bank feed matches**:

```
Dr  Bank                                    9,150.00
    Cr  Channel Clearing — KeHE                        9,150.00
```

Cash goes to **Channel Clearing** on import and to **Bank** on match. This keeps the remittance posting in the correct period regardless of when ACH settles, and makes an unmatched clearing balance a visible exception rather than a silent reconciliation break.

### 7.3 The core worked example — $10,000 invoice paid with a $9,150 ACH

**Facts.** Invoice `INV4471001`, gross **$10,000.00**, shipped 2026‑08‑28, COGS $5,800.00. KeHE ACH `0009941177` settles 2026‑09‑11 for **$9,150.00**. Deduction backup shows three lines totalling **$850.00**:

| # | Doc | Code | Description | Amount | Verdict | Why |
|---|---|---|---|---|---|---|
| 1 | `INV4471001H` | `H` | `MCB PROMO BILLBACK — DEAL 88214` | −420.00 | **Valid trade spend** | Signed deal sheet, 420 units × $1.00, inside the 08/01–08/28 window; 852 sell-through confirms ≥ 420 units |
| 2 | `INV4471001IA` | `IA` | `MCB ADMIN FEE 8% (MIN $65/DC)` | −65.00 | **Valid fee** | 8 % × 420.00 = $33.60, below the $65 per-DC minimum, so the minimum binds |
| 3 | `INV4471001C` | `C` | `CASE CUTS — 24 CS SHORT` | −365.00 | **Disputed** | Signed BOL and POD show all 480 cases delivered |

$420.00 + $65.00 + $365.00 = **$850.00**. $10,000.00 − $850.00 = **$9,150.00** ✓

#### Entry A — remittance import, **no accrual in place** (simplest correct form)

| Account | Debit | Credit |
|---|---:|---:|
| Channel Clearing — KeHE | 9,150.00 | |
| Contra-Revenue — Trade Promotion (MCB) | 420.00 | |
| Contra-Revenue — Distributor Fees (MCB admin) | 65.00 | |
| **Deductions Receivable — KeHE** | 365.00 | |
| AR — KeHE | | 10,000.00 |
| **Totals** | **10,000.00** | **10,000.00** |

The four requested pieces, explicitly:
- **(a) cash received** → `Channel Clearing — KeHE` $9,150.00 (becomes `Bank` on feed match)
- **(b) AR relieved** → `AR — KeHE` credit **$10,000.00 — the full gross**, not the net
- **(c) contra-revenue for valid trade spend** → $420.00 + $65.00 = $485.00
- **(d) Deductions Receivable for the disputed portion** → $365.00

#### Entry A′ — remittance import, **with the accrual from §7.6 in place** (what Sooz Books should do by default)

A **$565.00** accrual was booked when the promotion ran in August: 500 planned units × $1.00 = $500.00 promo, plus an estimated MCB admin fee of `max(8% × 500.00, 65.00)` = $65.00. See §7.6 ① for that entry.

| Account | Debit | Credit |
|---|---:|---:|
| Channel Clearing — KeHE | 9,150.00 | |
| **Accrued Trade Promotion Liability** (420.00 promo + 65.00 admin fee) | 485.00 | |
| Deductions Receivable — KeHE | 365.00 | |
| AR — KeHE | | 10,000.00 |
| **Totals** | **10,000.00** | **10,000.00** |

Both valid trade lines hit the **liability**, not contra-revenue — the contra-revenue was already recognised in August, the promotion's period. Contra-revenue in the payment period is only the **variance**, released when the promotion closes (§7.6 ③: $565.00 accrued − $485.00 actual = **$80.00** favourable).

The four requested pieces are unchanged: cash $9,150.00, AR relieved at the full gross $10,000.00, $485.00 of valid trade spend (recognised in August rather than September), and $365.00 to Deductions Receivable.

#### Entry B — the disputed $365.00 is **recovered**

KeHE approves the K‑Solve case; the next advice carries a positive line `INV4471001PB` / `RP  REPAYMENT  +365.00`.

| Account | Debit | Credit |
|---|---:|---:|
| Channel Clearing — KeHE | 365.00 | |
| Deductions Receivable — KeHE | | 365.00 |
| **Totals** | **365.00** | **365.00** |

**No revenue is recognised.** Revenue was never reduced for this item.

*Variant — partial recovery.* KeHE allows $250.00 and denies $115.00:

| Account | Debit | Credit |
|---|---:|---:|
| Channel Clearing — KeHE | 250.00 | |
| Contra-Revenue — Deduction Write-offs | 115.00 | |
| Deductions Receivable — KeHE | | 365.00 |
| **Totals** | **365.00** | **365.00** |

#### Entry C — the disputed $365.00 is **written off**

Either the dispute is denied, or the 180-day K‑Solve window closes unused.

| Account | Debit | Credit |
|---|---:|---:|
| Contra-Revenue — Deduction Write-offs | 365.00 | |
| Deductions Receivable — KeHE | | 365.00 |
| **Totals** | **365.00** | **365.00** |

Write-offs go to **contra-revenue**, not bad debt expense: under ASC 606 this is consideration retained by the customer, a reduction of the transaction price, and it belongs above gross profit where trade spend is measured.

*If the write-off is a genuine shortage that was real* (product truly never delivered), the correct entry is different — it is a billing correction, not trade spend:

| Account | Debit | Credit |
|---|---:|---:|
| Gross Sales — Distributor — KeHE | 365.00 | |
| Deductions Receivable — KeHE | | 365.00 |
| Inventory | 220.40 | |
| COGS | | 220.40 |
| **Totals (each pair)** | **365.00 / 220.40** | **365.00 / 220.40** |

(24 cases × $15.21 sell price = $365.04 ≈ $365.00; 24 × $9.183 standard cost = $220.40 returned to inventory if the goods are recovered; if the goods were lost in transit, debit `Inventory Shrink` instead of `Inventory`.)

#### Entry D — valuation allowance on Deductions Receivable

At each close, reserve the portion of open disputes you do not expect to win, using your own trailing recovery rate (§10). At a 60 % expected recovery on a $12,400 open disputed balance:

| Account | Debit | Credit |
|---|---:|---:|
| Contra-Revenue — Deduction Write-offs (reserve) | 4,960.00 | |
| Allowance for Disputed Deductions (contra-asset) | | 4,960.00 |
| **Totals** | **4,960.00** | **4,960.00** |

### 7.4 Rule table — reason class → journal treatment

| Class | Examples | Debit on import | Notes |
|---|---|---|---|
| **Funded trade promotion** | MCB, off-invoice, scan-down, billback, TPR, ad fee, coupon, demo, display | `Accrued Trade Promotion Liability` if accrued, else `Contra-Revenue — Trade Promotion` | Always contra-revenue, never marketing expense, when it is funding *that customer's* price |
| **Listing / entry costs** | Slotting, new item allowance, free fill, intro allowance | `Contra-Revenue — Slotting & New Item` | Upfront payment to a customer; recognise as a reduction of revenue as the related revenue is recognised. Short listing terms → expense on receipt |
| **Product condition allowances** | Spoils, unsaleables, swell, damages, out-of-date, reclamation, fairshare | `Contra-Revenue — Spoils & Unsaleables` | Percentage-of-sales fairshare allowances are contra-revenue even though no product comes back |
| **Terms** | 2 % 10 net 30 early-payment discount | `Contra-Revenue — Cash/Terms Discount` | Variable consideration. Accrue the expected discount at invoicing rather than discovering it on the remittance |
| **Freight allowance** | KeHE `FF` at $0.25–$0.40/lb, UNFI freight allowance | `Contra-Revenue — Freight Allowance` | An allowance off price. Distinguish from *actual freight services purchased*, which are `Fulfillment Fees` |
| **Distributor service fees** | KeHE Connect BI 2 %, UNFI SSA 2.5 %, MCB admin 8 %, EP fee 8 %, AAP 2 % | Default `Contra-Revenue — Distributor Fees`; **configurable** to `Advertising Expense` / `Data & Analytics Expense` | ASC 606: a payment to a customer is contra-revenue **unless** in exchange for a **distinct** good or service at fair value. A BI data subscription is a defensible distinct service; an admin fee on your own promotion is not. Make it a per-code flag with a documented default |
| **Compliance fines** | OTIF/fill-rate fine, service level fine, late delivery (`AVL`), BOL (`LCBOL`), pallet (`LCP`/`LCPV`), label, ASN, routing, W&M fine | Default `Contra-Revenue — Distributor Fees & Fines`; configurable to `Fulfillment Fees` | Same ASC 606 logic. Many brands prefer opex for operational visibility — allow it, but disclose consistently |
| **Billing corrections** | Shortage/case cuts/OS&D **when valid**, pricing discrepancy **when valid** | `Gross Sales — <channel>` (+ inventory/COGS correction) | This is **not trade spend.** Reversing revenue here keeps the trade-spend KPI honest |
| **Disputable claim** | Any of the above where you hold contradicting backup, plus all unauthorized deductions and post-audit claims | **`Deductions Receivable`** | The default for shortage, pricing, unauthorized MCB, duplicate, and post-audit until proven |
| **Recovery** | `PB`, `RP`, price-protection credit | Credit `Deductions Receivable` | Never revenue |
| **Unknown** | Unmapped reason code | `Unapplied Deductions` (suspense) | Blocks close; forces human mapping |

### 7.5 The vocabulary, and whether it is trade spend or a claim

| Term | What it means | Trade spend (contra-revenue) or disputable claim? | Typical dispute window |
|---|---|---|---|
| **MCB (manufacturer chargeback)** | The distributor discounts product to a retailer and bills the discount back to you. KeHE example: 25 % off or BOGO offered to a retail partner, deducted from your payment | **Trade spend** when it matches a signed deal sheet, the units are within plan, and the dates are inside the promo window. **Disputable** when duplicated, outside the window, at a rate you never approved, or billed for more units than the 852 shows moved | KeHE 180 days; UNFI ~30–60 days practical, adjustments > 12 months denied |
| **MCB admin fee** | KeHE's processing fee on the MCB: **8 % of the MCB amount (units × MCB per-unit × 8 %), minimum $65 per DC, billed bi-weekly** | **Trade spend** (contra-revenue) by default; a fee on your own promotion is not a distinct service | Disputable only on arithmetic/minimum-application errors |
| **Off-invoice (OI)** | A per-case discount applied at the moment of invoice; flows supplier → wholesaler → retailer | **Trade spend.** Usually already reflected in the invoice price, so it should **not** appear again as a deduction. If it does, **it is a duplicate — dispute** | Same as MCB |
| **Scan-down / scan allowance** | You fund a per-unit discount for each unit *scanned at retail*; billed on actual scan data | **Trade spend.** Disputable when scan counts exceed shipments, or scans are claimed outside the window | 180 days (KeHE) |
| **Billback** | Any promotion invoiced after the fact rather than taken off-invoice. UNFI East uses `UOI(mmyy)` for billbacks tied to promotional activity | **Trade spend** if authorised; **disputable** as "unauthorized promotional activity" when no signed deal exists | 30–60 days (UNFI) |
| **Slotting** | Payment for shelf placement / warehouse authorisation on a new item | **Trade spend** (contra-revenue). Disputable when billed twice, or for items never authorised | 60–180 days |
| **Free fill** | Free cases for initial store set | **Trade spend.** Value the cases at *your price*, not the distributor's list price — a frequent overcharge | 60–180 days |
| **New item allowance / intro allowance (`I`, `IAA`)** | Per-item, per-DC setup charge | **Trade spend.** Disputable when charged per store instead of per DC, or for discontinued items | 60–180 days |
| **Spoils / unsaleables / swell** | Damaged, expired, or unsaleable product credited to retailers and charged back; often a flat *fairshare* percentage instead of item detail | **Trade spend** when it is a contracted fairshare rate. **Disputable** when charged beyond the policy rate or without proof | UNFI up to 12 months; KeHE 180 days |
| **Shortage / OS&D / case cuts (`C`, `KC`, `01`, `-111`)** | "We received fewer cases than you invoiced." Over, Short & Damaged | **Disputable claim first.** Among the most frequently invalid deduction types in the natural channel. Signed BOL + POD is decisive. Only when proven valid does it become a **billing correction to Gross Sales**, not trade spend | UNFI 30–60 days, denied > 12 months; KeHE 180 days, plus a ~48-hour window to answer a UDR (unloading discrepancy report) at the dock |
| **Pricing discrepancy (`02`, `-111`)** | Invoice price ≠ the price on file | **Disputable claim.** Resolved with the PO and the signed deal sheet. Valid ones are billing corrections | 30–60 days (UNFI) |
| **Unauthorized deduction** | Any deduction with no matching agreement, PO, or claim document | **Always a disputable claim** → `Deductions Receivable` on day one | Whatever the source's window is; file immediately |
| **Post-audit claim** | A third-party auditor (PRGX for UNFI; SAS/SASIF for recovery and freight) re-examines old payments and claims missed allowances — **months to ~3 years after the sale** | **Disputable claim.** Up to half are reported wrong, inflated, or duplicates of deductions already taken. Keep signed BOLs, promotion agreements and backup **at least 3 years** | Often only ~5 days to research before it is taken; then the normal window. Route to the auditor's mailbox, not the Dispute Center |
| **Freight allowance (`FF`)** | Per-pound allowance for the distributor hauling your freight; KeHE **$0.25–$0.40/lb** | **Trade spend** (allowance). Disputable on weight/rate errors | 60–180 days |
| **Fill rate / OTIF fines / service level fine (`SLF`, `AVL`)** | Penalties for short-shipping or late delivery. UNFI: reported **3 % fine on shorted goods below a 95 % fill rate**; short-ships billed at **UNFI list price**; over-ships taken at a **35 % off-invoice discount**; late delivery fined when > 30 minutes past appointment (`AVL(PO#)`) | **Charge, not trade spend** economically — but still consideration payable to a customer, so contra-revenue by default. **Disputable** with routing confirmations, appointment records, and ASN timestamps | UNFI ~60 days recommended, up to 12 months |
| **Ad / TPR / promotional fees (`AD`, `CA`, `KA`, `H`, `N`, `Y`)** | Circular ads, temporary price reductions, displays, demos, coupons, food shows | **Trade spend.** Becomes `Advertising Expense` only if you receive a **distinct advertising service at fair value** — rare, and you must hold evidence of fair value | 60–180 days |
| **Early payment discount (2 % 10 net 30)** | Both UNFI and KeHE operate **2 % 10 days, net 30**, measured from invoice receipt **or** the date goods become available for sale, **whichever is later**. KeHE also offers a 2 % / net 61 variant for special events | **Trade spend** (cash discount, contra-revenue). **Disputable** when taken outside the 10-day window — a common and very collectible error | 60–180 days |
| **Compliance chargebacks (`LCPV`, `LCP`, `LCBOL`, ASN, routing, label, W&M)** | Pallet build, placard/labeling, incomplete BOL/packing slip, ASN accuracy, routing, weights-and-measures | **Charge**; contra-revenue by default. Often disputable when duplicated or misapplied — backup is routing confirmations, ASN records, labeling photos, specs | 60 days recommended; up to 12 months at UNFI |
| **UDR (unloading discrepancy report)** | KeHE's dock-level count discrepancy notice | **Disputable**, but the first window is brutally short | **~48 hours** at the dock, then the 180-day deduction window |
| **SSA (UNFI Simplified Supplier Approach)** | UNFI's consolidated supplier fee, reported at **2.5 % of purchases** (effective 1 May 2024), consolidated into **one monthly deduction per region from 1 Feb 2026** | **Trade spend / distributor fee** (contra-revenue). Rarely disputable on principle, frequently disputable on calculation | 12 months |
| **Connect BI fee / AAP (KeHE)** | Connect BI data access at a flat **2 %** of sales; AAP rolls lumper fees, new item setup, MCB fees, EP fees and DC intro allowances into a flat **2 % invoice allowance** | Contra-revenue by default; **Connect BI is the strongest candidate in this whole list for classification as a distinct service → operating expense.** Make it configurable | Calculation errors only |

### 7.6 Trade spend accruals — why, how, and the variance

**Why the accrual exists.** The deduction for an August promotion typically arrives on a September or October check — sometimes later. If you only recognise trade spend when the deduction lands, August shows inflated net revenue and October shows a margin hole that has nothing to do with October. Under ASC 606 the discount is **variable consideration**: it must be estimated and recognised **when the related revenue is recognised**, constrained so that a significant reversal is not probable. The promotion is the triggering event, not the cash.

**How to estimate.** Two methods; use both and reconcile.

*Method 1 — bottom-up, per promotion (preferred where a deal sheet exists):*
```
accrual = planned_units × allowance_per_unit × expected_participation_rate
        + fixed_fees (slotting, ad fee, admin fee floor)
```
Worked: 500 planned cases × $1.00/case MCB × 100 % = **$500.00**, plus an expected MCB admin fee of `max(8% × 500.00, 65.00)` = **$65.00** → total accrual **$565.00**.

*Method 2 — top-down, per customer (the safety net for everything not on a deal sheet):*
```
accrual = gross_sales_for_period × historical_gross_to_net_rate_for_that_customer
```
If KeHE historically deducts **8.5 %** of gross, accrue 8.5 % of each month's KeHE gross sales. Recompute the rate on a trailing 6–12 months, per customer, excluding disputed-and-recovered amounts.

Use Method 1 where a promotion exists and Method 2 for the residual, and never sum them naively — the top-down rate already contains the promotions. Practical rule: accrue Method 1 promotion-by-promotion, then accrue the **difference** between the Method 2 total and the Method 1 total as a general "unidentified trade" accrual, floored at zero.

**Entries, end to end.**

① Promotion runs (August), planned 500 cases at $1.00:

| Account | Debit | Credit |
|---|---:|---:|
| Contra-Revenue — Trade Promotion (MCB) | 500.00 | |
| Contra-Revenue — Distributor Fees (MCB admin, est.) | 65.00 | |
| Accrued Trade Promotion Liability | | 565.00 |
| **Totals** | **565.00** | **565.00** |

② September remittance: the deduction is **charged against the accrual**, not against contra-revenue (this is Entry A′ from §7.3, shown isolated):

| Account | Debit | Credit |
|---|---:|---:|
| Accrued Trade Promotion Liability | 485.00 | |
| AR — KeHE | | 485.00 |
| **Totals** | **485.00** | **485.00** |

(420.00 promo + 65.00 admin fee = 485.00 actual against 565.00 accrued.)

③ Promotion closed, residual released — **the variance goes to contra-revenue**:

| Account | Debit | Credit |
|---|---:|---:|
| Accrued Trade Promotion Liability | 80.00 | |
| Contra-Revenue — Trade Promotion (accrual variance) | | 80.00 |
| **Totals** | **80.00** | **80.00** |

A **credit** to contra-revenue = a favourable variance = the promotion cost less than planned (only 420 of 500 planned cases were claimed). An unfavourable variance (actual > accrued) is the mirror: debit contra-revenue, credit the liability, and it is a real signal — either the deal ran longer than approved or you are being over-billed.

**Close the promotion; do not leave the accrual open forever.** Release rules to implement:
- Release the residual when the promotion's **deduction window closes** — practically, when the last ship date is older than the source's dispute/claim window (KeHE 180 days, UNFI 12 months), or earlier when the deal is manually closed.
- Age the accrual: any promotion accrual with **no activity for 2× its expected claim lag** goes on a review report. Brands that reconcile every promotion **within 30 days of completion** are reported to recover an additional **8–12 % of trade spend** otherwise lost to errors.
- Never release an accrual into revenue silently. Every release is a journal entry with the promotion id in the memo.

---

## 8. Realistic sample files

> **SYNTHETIC — every value below is invented for parser fixtures.** No real UNFI or KeHE data, vendor number, deal number, bank routing number, or UPC appears here. Codes and formats are modelled on published descriptions. Use as test fixtures only.

### 8.1 `fixtures/kehe_remittance_2026-09-11.csv` — KeHE, canonical shape, 15 data rows

Arithmetic: invoices `10,000.00 + 6,420.50 + 3,187.25 = 19,607.75`; deductions total `−2,730.44`; repayment `+365.00`; net `= 17,242.31` = `payment_total`.

```csv
source_system,remit_advice_number,payment_number,payment_date,payment_method,payment_total,region_dc,line_type,document_number,reference_invoice_number,invoice_date,reason_code,reason_description,deal_number,item_upc,quantity,unit_amount,line_amount,currency
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,05,INVOICE,,INV4471001,08/28/2026,,SOOZ FOODS INV 4471001,,,,,10000.00,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,05,INVOICE,,INV4471002,09/02/2026,,SOOZ FOODS INV 4471002,,,,,6420.50,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,12,INVOICE,,INV4471003,09/04/2026,,SOOZ FOODS INV 4471003,,,,,3187.25,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,05,DEDUCTION,INV4471001H,INV4471001,08/28/2026,H,"MCB PROMO BILLBACK 08/01-08/28 SPROUTS SW DIV",88214,00857392004112,420,1.0000,-420.00,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,05,DEDUCTION,INV4471001IA,INV4471001,08/28/2026,IA,MCB ADMIN FEE 8 PCT MIN $65 PER DC,88214,,,,-65.00,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,05,DEDUCTION,INV4471001C,INV4471001,08/28/2026,C,CASE CUTS 24 CS SHORT PO 4471882,,00857392004112,24,15.2100,-365.00,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,05,DEDUCTION,INV4471002N,INV4471002,09/02/2026,N,SCAN ALLOWANCE 08/15-09/01,88301,00857392004129,177,1.2000,-212.40,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,05,DEDUCTION,INV4471002G,INV4471002,09/02/2026,G,DAMAGES OR SPOILS WHSE CREDIT,,,,,-96.75,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,05,DEDUCTION,INV4471002FF,INV4471002,09/02/2026,FF,FREIGHT ALLOWANCE 527 LB @ 0.30,,,527,0.3000,-158.00,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,05,DEDUCTION,INV4471002MA,INV4471002,09/02/2026,MA,KEHE CONNECT BI ALLOWANCE 2 PCT,,,,,-128.41,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,12,DEDUCTION,INV4471003S,INV4471003,09/04/2026,S,SLOTTING 5 ITEMS X 3 DC,,,15,50.0000,-750.00,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,12,DEDUCTION,INV4471003SLF,INV4471003,09/04/2026,SLF,SERVICE LEVEL FINE FILL RATE 91 PCT,,,,,-95.62,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,12,DEDUCTION,INV4471003Q,INV4471003,09/04/2026,Q,OUT OF DATE CREDITS RETAILER RECLAIM,,00857392004136,6,7.8500,-47.10,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,,DISCOUNT,ADV0004471CD,,,CD,TERMS DISCOUNT 2 PCT 10 NET 30,,,,,-392.16,USD
KEHE,0004471,EFT-88214113,09/11/2026,ACH,17242.31,05,REPAYMENT,INV4390117PB,INV4390117,06/19/2026,RP,REPAYMENT DISPUTE WON KSOLVE CASE 771204,,,,,365.00,USD
```

### 8.2 `fixtures/unfi_remittance_east_2026-09-04.csv` — UNFI East, 10 data rows

Arithmetic: invoices `12,480.00 + 4,210.75 = 16,690.75`; deductions `−2,293.82`; credit `+624.00`; net `= 15,020.93`.

```csv
source_system,remit_advice_number,payment_number,payment_date,payment_method,payment_total,region_dc,line_type,document_number,reference_invoice_number,invoice_date,reason_code,reason_description,deal_number,po_number,line_amount,currency
UNFI,RA-2026-0904-E,EAST-9876543,09/04/2026,ACH,15020.93,EAST,INVOICE,,8871234,08/14/2026,,SOOZ FOODS INV 8871234,,4471882,12480.00,USD
UNFI,RA-2026-0904-E,EAST-9876543,09/04/2026,ACH,15020.93,EAST,INVOICE,,8871290,08/21/2026,,SOOZ FOODS INV 8871290,,4471955,4210.75,USD
UNFI,RA-2026-0904-E,EAST-9876543,09/04/2026,ACH,15020.93,EAST,DEDUCTION,9876501-111-EAST,8871234,08/14/2026,01,SHORTAGE CASES NOT RECEIVED PO 4471882,,4471882,-624.00,USD
UNFI,RA-2026-0904-E,EAST-9876543,09/04/2026,ACH,15020.93,EAST,DEDUCTION,9876502-111-EAST,8871234,08/14/2026,02,PRICING DISCREPANCY LIST VS DEAL PRICE,,4471882,-187.20,USD
UNFI,RA-2026-0904-E,EAST-9876543,09/04/2026,ACH,15020.93,EAST,DEDUCTION,9876503-000-EAST,8871290,08/21/2026,UOI0826,OFF INVOICE BILLBACK PROMO AUG 2026,UOI0826,,-455.00,USD
UNFI,RA-2026-0904-E,EAST-9876543,09/04/2026,ACH,15020.93,EAST,DEDUCTION,9876504-000-EAST,,,05,SPOILS UNSALEABLES FAIRSHARE ALLOWANCE,,,-210.35,USD
UNFI,RA-2026-0904-E,EAST-9876543,09/04/2026,ACH,15020.93,EAST,DEDUCTION,9876505-000-EAST,,,LCBOL,BOL PACKING SLIP COMPLIANCE FINE PO 4471882,,4471882,-150.00,USD
UNFI,RA-2026-0904-E,EAST-9876543,09/04/2026,ACH,15020.93,EAST,DEDUCTION,9876506-000-EAST,,,AVL,LATE DELIVERY 47 MIN PAST APPT PO 4471882,,4471882,-250.00,USD
UNFI,RA-2026-0904-E,EAST-9876543,09/04/2026,ACH,15020.93,EAST,DEDUCTION,9876507-000-EAST,,,SSA,SIMPLIFIED SUPPLIER APPROACH 2.5 PCT MONTHLY EAST AUG 2026,,,-417.27,USD
UNFI,RA-2026-0904-E,EAST-9876543,09/04/2026,ACH,15020.93,EAST,CREDIT,9876508-000-EAST,,,PB,DISPUTE WIN ADJ 9812345-111-EAST,,,624.00,USD
```

### 8.3 `fixtures/kehe_remittance_2026-09-11_dirty.csv` — the adversarial variant

Same payment as §8.1, exported from the human-formatted grid. The parser must produce byte-identical canonical output from both. Note the BOM, the preamble, the currency symbols, the parentheses, the separate Debit/Credit columns, the embedded newline, the merged/blank-filled payment number, and the footer total.

```csv
﻿KeHE Distributors LLC
Remittance Advice
Period: 08/28/2026 - 09/04/2026    Page 1 of 1

Check/EFT,Check Date,DC,Invoice Number,Inv Date,Prefix,Description,Debit,Credit
EFT-88214113,09/11/2026,05,INV4471001,08/28/2026,,SOOZ FOODS INV 4471001,,"$10,000.00"
,,05,INV4471002,09/02/2026,,SOOZ FOODS INV 4471002,,"$6,420.50"
,,12,INV4471003,09/04/2026,,SOOZ FOODS INV 4471003,,"$3,187.25"
,,05,INV4471001H,08/28/2026,H,"MCB PROMO BILLBACK
DEAL 88214  08/01-08/28
SPROUTS SW DIV",$420.00,
,,05,INV4471001IA,08/28/2026,IA,MCB ADMIN FEE 8% (MIN $65/DC),$65.00,
,,05,INV4471001C,08/28/2026,C,CASE CUTS - 24 CS SHORT,$365.00,
,,05,INV4471002N,09/02/2026,N,SCAN ALLOWANCE 08/15-09/01,$212.40,
,,05,INV4471002G,09/02/2026,G,DAMAGES OR SPOILS,$96.75,
,,05,INV4471002FF,09/02/2026,FF,FREIGHT ALLOWANCE,$158.00,
,,05,INV4471002MA,09/02/2026,MA,KEHE CONNECT BI ALLOWANCE,$128.41,
,,12,INV4471003S,09/04/2026,S,SLOTTING,$750.00,
,,12,INV4471003SLF,09/04/2026,SLF,SERVICE LEVEL FINE,$95.62,
,,12,INV4471003Q,09/04/2026,Q,OUT OF DATE CREDITS,$47.10,
,,,,,CD,TERMS DISCOUNT 2% 10 NET 30,$392.16,
,,05,INV4390117PB,06/19/2026,RP,REPAYMENT - KSOLVE 771204,,$365.00
,,,,,,TOTAL NET PAYMENT,,"$17,242.31"
*** END OF REPORT ***
```

---

## 9. Reason-code reference table (ship as seed data)

Schema for the seed table:

```
reason_codes(
  source_system,        -- UNFI | KEHE | X12 | DPI
  code,                 -- verbatim, uppercase
  label,                -- human name
  class,                -- promo | listing | condition | terms | freight | fee | fine | correction | recovery | unknown
  default_account,      -- GL category
  is_trade_spend,       -- bool: counts in trade spend KPI
  default_disposition,  -- ACCRUAL | CONTRA_REVENUE | DEDUCTIONS_RECEIVABLE | GROSS_SALES | RECOVERY | SUSPENSE
  dispute_window_days,  -- int, null if n/a
  required_backup,      -- text
  confidence            -- HIGH | MEDIUM  (see §0)
)
```

### 9.1 X12 element 426 — Adjustment Reason Code (authoritative, `ADX02` / `CDD01`)

| Code | Description | class | default_disposition |
|---|---|---|---|
| `01` | Pricing Error | correction | DEDUCTIONS_RECEIVABLE |
| `02` | Allowance/Charge Error | correction | DEDUCTIONS_RECEIVABLE |
| `03` | Extension Error | correction | DEDUCTIONS_RECEIVABLE |
| `04` | Item Not Accepted - Damaged | condition | DEDUCTIONS_RECEIVABLE |
| `05` | Item Not Accepted - Quality | condition | DEDUCTIONS_RECEIVABLE |
| `06` | Quantity Contested | correction | DEDUCTIONS_RECEIVABLE |
| `07` | Incorrect Product | correction | DEDUCTIONS_RECEIVABLE |
| `08` | Substitute Product | correction | DEDUCTIONS_RECEIVABLE |
| `09` | Terms of Sale Error | terms | DEDUCTIONS_RECEIVABLE |
| `10` | Pallet/Container Charge Error | fine | DEDUCTIONS_RECEIVABLE |
| `11` | Returns - Damage | condition | CONTRA_REVENUE |
| `12` | Returns - Quality | condition | CONTRA_REVENUE |
| `13` | Returns - Dating | condition | CONTRA_REVENUE |
| `14` | Returns - Promotion | promo | CONTRA_REVENUE |
| `15` | Returns - Recall | condition | CONTRA_REVENUE |
| `16` | **Non-Invoice Related Allowance/Charge** | promo | ACCRUAL → CONTRA_REVENUE |
| `17` | Required Data Missing | fine | DEDUCTIONS_RECEIVABLE |
| `19` | Duplicate Billing | correction | DEDUCTIONS_RECEIVABLE |
| `22` | Weight Error | correction | DEDUCTIONS_RECEIVABLE |
| `23` | Special Charge Not Authorized | fine | DEDUCTIONS_RECEIVABLE |
| `24` | Incorrect Discount | terms | DEDUCTIONS_RECEIVABLE |
| `25` | Item Not Accepted | condition | DEDUCTIONS_RECEIVABLE |
| `26` | Invoice Cancelled | correction | GROSS_SALES |
| `27` | Product Transfers Subject to Charge Back | promo | CONTRA_REVENUE |
| `28` | Rebated Shipments | promo | CONTRA_REVENUE |
| `29` | Fee Incorrect | fee | DEDUCTIONS_RECEIVABLE |
| `43` | Missing Discount | terms | CONTRA_REVENUE |
| `44` | Required Documents Missing | fine | DEDUCTIONS_RECEIVABLE |
| `45` | Stale Bill Over 180 Days Old | correction | DEDUCTIONS_RECEIVABLE |
| `48` | Service Charge | fee | CONTRA_REVENUE |
| `49` | Processing Charge | fee | CONTRA_REVENUE |
| `52` | Credit for Previous Overpayment | recovery | RECOVERY |
| `53` | Remittance for Previous Underpayment | recovery | RECOVERY |
| `54` | **Freight Deducted** | freight | CONTRA_REVENUE |
| `55` | Tax Deducted | correction | SUSPENSE (review) |
| `56` | **Advertising Allowance Taken** | promo | ACCRUAL → CONTRA_REVENUE |
| `57` | **Volume Discount Taken** | promo | ACCRUAL → CONTRA_REVENUE |
| `59` | **Item not received** (shortage) | correction | DEDUCTIONS_RECEIVABLE |
| `60` | No open item on file | correction | SUSPENSE |
| `61` | No open order on file | correction | SUSPENSE |
| `62` | Material/Item Description Error | correction | DEDUCTIONS_RECEIVABLE |
| `63` | Customer Paid Invoice Which Was Previously Disputed | recovery | RECOVERY |
| `D8` | Count and Recount Allowance | condition | CONTRA_REVENUE |
| `D9` | Store Stock Price Protection | promo | CONTRA_REVENUE |
| `E1` | Recoupment | correction | DEDUCTIONS_RECEIVABLE |
| `E2` | Covered By Debit Memo | correction | SUSPENSE |
| `E3` | Withholding | correction | DEDUCTIONS_RECEIVABLE |
| `E4` | Warehouse Stock Price Protection | promo | CONTRA_REVENUE |
| `E5` | Invoice Price Protection | promo | CONTRA_REVENUE |
| `ZZ` | Mutually Defined | unknown | SUSPENSE |

(The full 426 list runs to roughly 60 codes in 4010/3010 and **600+ across the extended core deduction code work** published jointly by ASC X12 and X9. Ship the table above; fall through to SUSPENSE for anything else.)

### 9.2 KeHE invoice/deduction prefixes (HIGH confidence on mapping)

The prefix is **appended to the invoice number** (`INV1234567IA`) and shown in K‑Solve's first column.

| Prefix | Label | class | is_trade_spend | default_disposition |
|---|---|---|---|---|
| `IA` | KEHE INVOICE ADJUSTMENTS | fee | yes | CONTRA_REVENUE |
| `IAA` | INTRO ALLOWANCE | listing | yes | CONTRA_REVENUE |
| `I` | NEW ITEM SET UP | listing | yes | CONTRA_REVENUE |
| `S` | SLOTTING | listing | yes | CONTRA_REVENUE |
| `SS` | SHAWS SLOTTING | listing | yes | CONTRA_REVENUE |
| `MS` | MEIJERS SLOTTING | listing | yes | CONTRA_REVENUE |
| `P` / `PL` / `IP` / `NP` | PLACEMENT (retailer-required / independent / natural store) | listing | yes | CONTRA_REVENUE |
| `H` | PROMOTION (BROAD) — the general MCB/billback bucket | promo | yes | ACCRUAL |
| `HN` | NEW SEASON PROMO/BILLBACK | promo | yes | ACCRUAL |
| `TG` | SPECIAL DEAL PROMOTION | promo | yes | ACCRUAL |
| `SH` | SHOW PROMOTION | promo | yes | ACCRUAL |
| `PG` | PROMOTION OVERFLOW | promo | yes | ACCRUAL |
| `N` / `NN` / `SN` / `MN` / `KN` / `SWN` / `BL` / `CVSN` / `FTN` | SCANS (by retailer) | promo | yes | ACCRUAL |
| `AD` / `CA` / `KA` / `AA` / `AN` | ADVERTISING / AD PACKAGE | promo | yes | ACCRUAL |
| `D` / `DB` / `MM` | DEMO | promo | yes | ACCRUAL |
| `Y` | DISPLAY | promo | yes | ACCRUAL |
| `ML` | MEIJERS DISPLAY ALLOWANCE | promo | yes | ACCRUAL |
| `U` / `UH` / `SC` | COUPON | promo | yes | ACCRUAL |
| `K` | SPIF | promo | yes | CONTRA_REVENUE |
| `M` | SAMPLES | promo | yes | CONTRA_REVENUE |
| `R` | RESETS | promo | yes | CONTRA_REVENUE |
| `F` | FOOD SHOW | promo | yes | CONTRA_REVENUE |
| `Z` | SALES MEETING | promo | yes | CONTRA_REVENUE |
| `J` | WAREHOUSE BILLBACK | promo | yes | ACCRUAL |
| `ME` | MEIJERS EDLP | promo | yes | ACCRUAL |
| `XPP` | PRICE PROTECTION | promo | yes | CONTRA_REVENUE |
| `RDF` | RETAIL DISCOUNT | promo | yes | CONTRA_REVENUE |
| `MK` | MARK DOWN CREDITS | promo | yes | CONTRA_REVENUE |
| `G` | DAMAGES OR SPOILS | condition | yes | CONTRA_REVENUE |
| `CS` | CUSTOMER SPOILAGE ALLOWANCE | condition | yes | CONTRA_REVENUE |
| `Q` | OUT OF DATE CREDITS | condition | yes | CONTRA_REVENUE |
| `QM` / `QT` | WAREHOUSE CREDITS — SALV1 / SALV2 | condition | yes | CONTRA_REVENUE |
| `GP` / `HB` / `JW` / `SV` / `SW` | RETAILER RECLAMATION (Publix / HEB / Jewel / Supervalu / Shaws) | condition | yes | CONTRA_REVENUE |
| `WG` | WALMART SPOILS | condition | yes | CONTRA_REVENUE |
| `L` | RECALL | condition | yes | CONTRA_REVENUE |
| `MD` | MFG DISCONTINUED | condition | yes | CONTRA_REVENUE |
| `C` | CASE CUTS (shortage) | correction | **no** | **DEDUCTIONS_RECEIVABLE** |
| `KC` | KEHE AUDIT — PRODUCT SHORT / PRICE CHANGE | correction | no | **DEDUCTIONS_RECEIVABLE** |
| `KP` | SHORT ON DEAL | correction | no | **DEDUCTIONS_RECEIVABLE** |
| `MGP` | OI AUDIT — MOVEMENT GREATER THAN PURCHASE | correction | no | **DEDUCTIONS_RECEIVABLE** |
| `ALB` / `MX` / `RR` | RETAILER / CHAIN AUDIT | correction | no | **DEDUCTIONS_RECEIVABLE** |
| `E` | FINE | fine | no | CONTRA_REVENUE (configurable → Fulfillment Fees) |
| `SLF` | SERVICE LEVEL FINE | fine | no | CONTRA_REVENUE (configurable) |
| `FF` | FREIGHT | freight | yes | CONTRA_REVENUE |
| `BF` | BROKER FEE | fee | no | Broker Commission Expense |
| `MA` | KEHE CONNECT BI ALLOWANCE (2 %) | fee | configurable | CONTRA_REVENUE *or* Data & Analytics Expense |
| `PF` | PUBLICATION LISTING FEE | fee | yes | CONTRA_REVENUE |
| `AG` / `IX` | GLADSON / IX-ONE IMAGING | fee | no | Operating Expense |
| `BD` | BOTTLE DEPOSIT | other | no | **Container Deposit Liability** (not Sales Tax Payable) |
| `RM` / `V` / `VR` | VENDOR RETURN | condition | yes | CONTRA_REVENUE + Inventory/COGS reversal |
| `W` | DIRECT SHIP | other | no | SUSPENSE (review) |
| `RP` | **REPAYMENT** | recovery | n/a | **RECOVERY** (credit Deductions Receivable) |
| `…PB` suffix | Dispute win / payback | recovery | n/a | **RECOVERY** |
| `…PP` suffix | Prepayment and its reversal | other | no | SUSPENSE → net against AR |
| `DED` | AEA PROGRAM / MARKETING SOLUTIONS / SPOILS ALLOWANCE / FREIGHT ALLOWANCE / OFF INVOICE ALLOWANCES (DPI) | promo | yes | ACCRUAL |
| `CLANW` / `CLAWE` / `CLARM` | DPI NORTHWEST / WEST / ROCKY MOUNTAIN | other | no | route to DPI sub-ledger |

### 9.3 UNFI codes (MEDIUM confidence — seed only)

**Numeric families** (reported grouping; verify against the brand's own *Supplier Deduction Key*):

| Family | Meaning | default_disposition |
|---|---|---|
| `01` | Shortages | DEDUCTIONS_RECEIVABLE |
| `02` | Pricing discrepancies | DEDUCTIONS_RECEIVABLE |
| `05` | Unsaleables and damages | CONTRA_REVENUE |
| `10`–`12` | Advertising and promotional charges, incl. MCB and off-invoice | ACCRUAL |
| `30`+ | Compliance and logistics fees (late shipment, labeling, pallet) | CONTRA_REVENUE (configurable) |

**String codes:**

| Code pattern | Meaning | Region | default_disposition |
|---|---|---|---|
| `MCB(yyyymmdd)` + tag `A` / `C` / `E` | Manufacturer chargeback for a customer-specific deal; `A` = ad, `C` = price, `E` = EDLP | **West** | ACCRUAL |
| `UOI(mmyy)` | Billback tied to promotional activity; flagged "unauthorized" when no signed deal exists | **East** | ACCRUAL, else DEDUCTIONS_RECEIVABLE |
| `OI` / `OIA` | Off-invoice allowance | both | ACCRUAL |
| `CBPB` | Chargeback payback | both | RECOVERY |
| `[DC#]CNDM(mmmyy)` | Concealed damage by DC — e.g. `01CNDM` Rocklin, `02CNDM` Seattle, `05CNDM` Denver | West | CONTRA_REVENUE |
| `LCPV(PO#)` | Pallet build standard failure | both | CONTRA_REVENUE (fine) |
| `LCP(PO#)` | Pallet placard / labeling miss | both | CONTRA_REVENUE (fine) |
| `LCBOL(PO#)` | Incomplete BOL or packing slip | both | CONTRA_REVENUE (fine) |
| `AVL(PO#)` | Late delivery (> 30 min past appointment) | both | CONTRA_REVENUE (fine) |
| `W&M FINE` | Weights-and-measures conformance fine | both | CONTRA_REVENUE (fine) |
| `ASN COMPLIANCE` | ASN/EDI accuracy fine | both | CONTRA_REVENUE (fine) |
| `ROUTING FINE` | Shipped outside routing requirements | both | CONTRA_REVENUE (fine) |
| `LABEL FINE` | Pallet/case labeling failure | both | CONTRA_REVENUE (fine) |
| `SSA` | Simplified Supplier Approach, reported 2.5 % of purchases; consolidated to one monthly deduction per region from 1 Feb 2026 | both | CONTRA_REVENUE (distributor fee) |
| `-111` suffix on an invoice number | Quantity/pricing chargeback | both | DEDUCTIONS_RECEIVABLE |
| `…PP` suffix | Prepayment / its negative reversal | both | SUSPENSE → net against AR |
| `…PB` suffix | Dispute win | both | RECOVERY |

**Dispute windows to seed** (`dispute_window_days`):

| Source | Window | Hard cutoff |
|---|---|---|
| KeHE — K‑Solve | **180 days** from deduction date; resolution ~21 days | Dispute option disappears from the portal once the window closes |
| KeHE — UDR at the dock | **~48 hours** | Then falls back to the 180-day window |
| UNFI — Dispute Center | practical filing window reported as **30–60 days**; resolution **35–45 days**; one appeal per dispute | **Adjustments older than 12 months are denied** |
| UNFI — compliance fines | 60 days recommended | 12 months |
| Post-audit (PRGX / SAS / SASIF) | often **~5 days** to research before the money is taken | Claims arrive up to ~3 years after the sale |

Set an **alert at 60 % of the window elapsed** and a **hard escalation at 80 %**. A dispute open past 60 days without movement needs escalation regardless of the window.

---

## 10. KPIs the importer must be able to produce

All of these fall out of the canonical schema in §2.4 plus the accrual ledger. Define them once, here, so the reports agree.

| KPI | Formula | Read it as | Reference range (vendor/consultant estimates — **no public industry benchmark exists**) |
|---|---|---|---|
| **Trade spend % of gross sales** | `Σ(contra-revenue lines where is_trade_spend) ÷ Σ(Gross Sales by channel)` — by customer, by month, by promotion | The real cost of distribution | Distributor/retailer deductions commonly quoted at **5–15 % of gross revenue**; up to **20 %** including trade promotions; ~**8 %** is a frequently cited midpoint |
| **Deduction rate** | `Σ(all deduction line_amounts, absolute) ÷ Σ(gross invoiced)` for the same period | Everything taken off, valid or not. Broader than trade spend — includes fines and disputed claims | **2–15 %** of gross sales |
| **Disputable exposure** | `Σ(Deductions Receivable opened) ÷ Σ(all deductions)` | How much of the load is contestable | Invalid/duplicated/preventable share commonly cited at **10–40 %**, with a wider **5–60 %** range by category |
| **Dispute recovery rate** | `Σ(recoveries received) ÷ Σ(Deductions Receivable closed in period)` — cash-weighted, not case-count-weighted | The collections engine's efficiency. **Feeds the §7.3 Entry D reserve directly** | Reported **31 %** manual, **54 %** with structured workflow, **72 %** with automation; one vendor case study **52 % → 84 %** |
| **Dispute win rate** | `count(cases won) ÷ count(cases closed)` | Case-level quality. Diverges from recovery rate when you win many small cases and lose few large ones — track both | — |
| **Write-off rate** | `Σ(Contra-Revenue — Deduction Write-offs) ÷ Σ(Gross Sales)` | Money conceded | Mid-market CPG reported to write off **1.2–2.4 % of gross revenue** annually |
| **Days-to-deduction** | `avg(payment_date − invoice_date)` for deduction lines; also report p50/p90 | How long cash stays at risk and how long an accrual must be held before release | Varies by reason class — compute per class, not in aggregate |
| **Claim lag** | `avg(payment_date − claim_date)` (812 sources only) | Warning time between claim and cash | — |
| **Days-to-resolution** | `avg(dispute_closed_date − dispute_filed_date)` | Portal throughput | UNFI ~**35–45 days**; KeHE ~**21 days** |
| **Window burn** | `(today − deduction_date) ÷ dispute_window_days` per open claim | **The one to put on the dashboard.** Anything > 0.8 is about to become a permanent write-off | — |
| **Accrual-to-actual variance** | `(Σ actual deductions charged to a promotion − Σ accrued) ÷ Σ accrued`, per promotion and rolled up per customer per month | Whether the gross-to-net estimate is trustworthy. Persistent negative = over-accruing and understating revenue; persistent positive = under-accruing, and a margin surprise is coming | Target within **±10 %** at the customer-month level; investigate any single promotion outside ±25 % |
| **Unapplied deduction balance** | `Σ(SUSPENSE lines not yet classified)` and its age | The importer's own health metric. Should trend to zero every close | Target **$0** at close |
| **Open Deductions Receivable ageing** | balance bucketed 0–30 / 31–60 / 61–90 / 91–180 / 180+ days | Drives the reserve and the escalation queue | Brands that reconcile each promotion **within 30 days of completion** are reported to recover an extra **8–12 %** of trade spend |

---

## 11. Implementation checklist

1. Header-mapping profiles per source + release (`unfi_dispute_center_v1`, `kehe_connect_deductions_v1`, `edi_820_005010`, `edi_812_004010`), each with an alias dictionary and a sign-resolution rule.
2. Magic-byte sniffing before any parse; reject HTML/XLS masquerading as CSV with a clear message.
3. Normalise into §2.4, compute `source_file_hash` and `source_row_number` on every row.
4. **Assert the §6.1 arithmetic identity. Quarantine on failure. Never post a partially-understood advice.**
5. Dedup at all five levels of §5.2; report, never silently drop.
6. Classify by `reason_code` against the §9 seed table; anything unmapped → `Unapplied Deductions` + a review task; never guess.
7. Post the §7.2 pattern: gross AR relief, cash to Channel Clearing, disputed portion to Deductions Receivable, valid promo to the accrual first and contra-revenue only for the variance.
8. Open a dispute record with a due date derived from `dispute_window_days` at the moment a `DEDUCTIONS_RECEIVABLE` line is created; alert at 60 %, escalate at 80 %.
9. Reserve Deductions Receivable at close using the trailing dispute recovery rate.
10. Release promotion accruals on a rule, with a journal entry and a promotion id in the memo — never silently.

---

## Sources

- [UNFI and KeHE Deductions Guide for CPG Brands — Glimpse](https://www.tryglimpse.com/post/unfi-kehe-supplier-deductions)
- [UNFI's Deduction Ecosystem — SPS Commerce / SupplyPike Help Center](https://help.supplypike.com/en/articles/15926163-unfi-s-deduction-ecosystem)
- [UNFI Deduction Types — SPS Commerce / SupplyPike Help Center](https://help.supplypike.com/en/articles/14992828-unfi-deduction-types)
- [How To Submit and Appeal a Deduction Dispute in UNFI's Dispute Center — SPS Commerce](https://www.spscommerce.com/community/articles/how-to-submit-and-appeal-a-deduction-dispute-in-unfis-dispute-center)
- [How Natural Suppliers Dispute UNFI Deductions — SPS Commerce](https://www.spscommerce.com/community/articles/how-natural-suppliers-dispute-unfi-deductions)
- [A Complete Guide to UNFI Cash Application and Deductions — Confido](https://www.confidotech.com/blogs/manage-deductions-and-disputes-for-unfi)
- [UNFI Compliance & Weights-and-Measures Fine Codes — OverDeduct](https://www.overdeduct.com/deductions/unfi/codes/compliance-fines)
- [UNFI Deduction Codes Explained — RemitParse](https://remitparse.com/blog/unfi-deduction-codes-explained)
- [UNFI EDI Requirements: 2026 Guide — Crstl](https://www.crstl.ai/blog/unfi-edi-requirements)
- [UNFI SSA Deduction Change in 2026 — Promomash](https://www.promomash.com/blog/unfi-ssa-deduction-change-2026)
- [myUNFI Supplier Dashboard](https://www.myunfi.com/supplier-dashboard)
- [KeHE Promotions: Manufacturer Chargebacks (MCBs) and Extra Performance (EP) Fees — SPS Commerce](https://www.spscommerce.com/community/articles/kehe-promotions-manufacturer-chargebacks-mcbs-and-extra-performance-ep-fees)
- [A Guide to Disputing KeHE Deductions in K-Solve — SPS Commerce](https://www.spscommerce.com/community/articles/a-guide-to-disputing-kehe-deductions-in-k-solve)
- [KeHE Deductions and Invoice Prefixes — SPS Commerce](https://www.spscommerce.com/community/articles/kehe-deductions-and-invoice-prefixes)
- [KeHE Deduction Codes & Invoice Prefixes — iNymbus](https://blog.inymbus.com/kehe-deductions-codes-invoice-prefix)
- [Launching into KeHE: Deductions and Cash Application — Confido](https://www.confidotech.com/resources/launching-into-kehe-deductions-and-cash-application)
- [How to Dispute KeHE Deductions in K-Solve — OverDeduct](https://www.overdeduct.com/distributors/kehe/how-to-dispute)
- [KeHE Distributors Payment Terms — Resolve](https://resolvepay.com/blog/kehe-distributors-payment-terms)
- [KeHE and UNFI Deductions: The Codes, the Clocks, and What Expires When — Endless Commerce](https://endlesscommerce.com/playbook/kehe-and-unfi-deductions-codes-and-clocks/)
- [X12 EDI Element 426 Adjustment Reason Code — Stedi](https://www.stedi.com/edi/x12-003010/element/426)
- [ASC X12 & X9 Technical Report — Core Adjustment/Deduction Reason Code List](https://cdn.ymaws.com/www.rvcf.com/resource/resmgr/docs/x9-x12_technicalreportcorede.pdf)
- [EDI 820 Payment Order/Remittance Advice — Kroger implementation guide (public)](https://edi.kroger.com/EDIPortal/documents/Maps/kroger/5010EDI820_01152021.pdf)
- [812 Credit/Debit Adjustment — Kroger implementation guide (public)](https://edi.kroger.com/EDIPortal/documents/Maps/kroger/5010EDI812.pdf)
- [EDI 812 Credit/Debit Adjustment — SPS Commerce](https://www.spscommerce.com/edi-document/edi-812-credit-debit-adjustment/)
- [EDI 820 Remittance Advice: Adjustments, Credits, Deductions (RMR/ADX) — 9ci](https://www.9ci.com/articles/edi-820-remittance-advise-adjustments-credits-deductions-rmr-adx)
- [X12 EDI 852 Product Activity Data — Stedi](https://www.stedi.com/edi/x12-005020/852)
- [EDI 852 Product Activity Data: Sell-Through and Replenishment Guide — OrderSync](https://ordersync.io/guides/edi/852-product-activity-data)
- [Revenue Recognition in the Consumer Products Industry — RSM US (Sept 2023)](https://rsmus.com/content/dam/rsm/insights/financial-reporting/1pdf/Changes-to-revenue-recognition-in-the-consumer-products-industry-202309.pdf)
- [4.3 Variable consideration — PwC Viewpoint](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/revenue_from_contrac/revenue_from_contrac_US/chapter_4_determinin_US/43variable_considera_US.html)
- [6.3 Variable Consideration — Deloitte DART](https://dart.deloitte.com/USDART/home/codification/revenue/asc606-10/roadmap-revenue-recognition/chapter-6-step-3-determine-transaction/6-3-variable-consideration)
- [Accruals for CPG Brands: Trade Spend, Deductions, and Promotions — Guidance](https://guidance.so/blog/accruals-cpg-brands.html)
- [CPG Trade Spend and Deductions: Accounting Done Right — Eightx](https://eightx.co/blog/cpg-trade-spend-accounting)
- [CPG Deduction Benchmark — OverDeduct](https://www.overdeduct.com/benchmarks/cpg-deduction-benchmark)
- [Deduction Management for CPG Brands — Endless Commerce](https://endlesscommerce.com/playbook/deduction-management-for-cpg-brands/)
- [The Complete Guide to Post-Audit Deductions — SpeedyLabs](https://blog.speedylabs.ai/post-audit-deductions/)
- [What is a Post Audit? — SPS Commerce / SupplyPike Help Center](https://help.supplypike.com/en/articles/7175001-what-is-a-post-audit)

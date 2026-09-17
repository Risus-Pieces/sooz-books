# Sooz Books — Design Spec

**Date:** 2026-09-17
**Status:** Approved, in build

## Problem

Sooz is a CPG company with a co-manufactured product sold through five channels: DTC (Shopify),
Amazon, retail via distributors, wholesale/Faire, and restaurants/foodservice. QuickBooks is the
current system of record and it does not model what actually drives the P&L for a brand like this:

- Channel payouts arrive **net** of fees, so revenue is understated and fees are invisible.
- Distributor short-pays (deductions, chargebacks, billbacks) look like partial payments instead of
  trade spend that needs validating and disputing.
- Landed cost from a co-packer (tolling + ingredients + packaging + freight-in) is not rolled into
  inventory, so gross margin per SKU and per channel is guesswork.

Sooz Books replaces QuickBooks as the system of record with a double-entry general ledger that
models these things natively, and ingests bank statements as CSV/Excel uploads.

## Decisions

| Topic | Decision |
|---|---|
| Role | Full double-entry GL, replaces QuickBooks |
| Bank intake | CSV / Excel upload with saved per-bank mapping profiles |
| Deployment | Hosted web app (Vercel + Supabase), team login with roles |
| Inventory | Peasy remains the ops system of record for quantities; books carry values |
| Production | Co-manufacturer; landed cost = tolling + ingredients + packaging + freight-in |
| Migration | Full QuickBooks transaction history |
| Basis | Accrual books with a cash-basis report toggle |
| Categorization | Rules first, AI suggestion second, human approval always |
| Entity | Single US entity, USD only |

## Architecture

- **Next.js 16** (App Router, TypeScript, Server Actions) on **Vercel**.
- **Supabase** Postgres + Auth + Storage. Project `sooz-books` (`rufzfaecfhrlnnhvsfyv`, us-west-1).
- **Drizzle ORM** over `postgres.js` for typed queries and real multi-statement transactions.
- Money is stored as **integer cents** (`bigint`). No floating point anywhere in the money path.
- Tailwind v4 + local shadcn-style components, TanStack Table for registers, Recharts for charts.
- Vitest for logic and DB-invariant tests; Playwright for end-to-end flows.

### Ledger invariants — enforced in the database

These are constraint triggers in Postgres, not application checks, so no code path can bypass them:

1. **Balance.** A posted journal entry's debits equal its credits (deferred to commit).
2. **Immutability.** A posted entry and its lines cannot be altered or deleted; corrections are a
   reversing entry plus a new entry.
3. **Period lock.** Nothing posts into a closed period.
4. **Audit.** Every write to a financial table records who, when, and the before/after row.
5. **Single debit-or-credit.** Each line carries exactly one of a debit or a credit, both ≥ 0.

Every module posts through one function, `postJournalEntry()` in `src/lib/ledger/post.ts`. Nothing
else writes to `journal_lines`.

### Dimensions

Journal lines carry optional `channel_id`, `customer_id`, `vendor_id` and `product_id`. This is what
makes "gross margin by channel" and "trade spend as a percent of gross sales by customer" reportable
from the ledger itself rather than from a side system.

## Modules

| Phase | Module |
|---|---|
| 0 | Foundation: scaffold, database, auth, roles, app shell |
| 1 | General ledger: CPG chart of accounts, journal entries, periods, audit, TB / P&L / BS |
| 2 | Bank intake: CSV/XLSX import profiles, dedupe, rules + AI review queue, reconciliation |
| 3 | AR / AP: customers, invoices, receipts; vendors, bills, payments; aging; 1099 |
| 4 | Channel payouts: Shopify, Amazon, Faire settlement importers; clearing accounts; sales tax |
| 5 | Trade spend & deductions: promotions, remittance import, deduction workbench, accruals |
| 6 | Inventory value & COGS from Peasy: landed cost, monthly COGS batches, tie-out, margin |
| 7 | Planning: budget vs actual, 13-week cash forecast, cash flow statement, cash-basis toggle |
| 8 | Close & migration: close checklist, period lock, QuickBooks history import, go-live |

## Verification

Each phase ends with its tests green and a demo against seed data. The accounting identities
(assets = liabilities + equity; TB debits = credits; AR/AP aging equals its control account) are
asserted in tests on every report. The QuickBooks migration is gated on a month-by-month trial
balance comparison showing zero variance before go-live.

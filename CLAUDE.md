# Sooz Books

Double-entry accounting software for **Sooz**, a CPG (consumer packaged goods) food brand with a
co-manufactured product. It replaces QuickBooks as the system of record. Sooz sells through five
channels: DTC (Shopify), Amazon, retail via distributors, wholesale/Faire, and restaurants/foodservice.

Design spec: [docs/superpowers/specs/2026-09-17-sooz-books-design.md](docs/superpowers/specs/2026-09-17-sooz-books-design.md)
Import format research: `docs/formats/`

## Stack

Next.js 16 App Router · TypeScript · Tailwind v4 · Drizzle ORM over postgres.js · Supabase
(Postgres + Auth + Storage) · Vitest · deployed on Vercel.

Supabase project `sooz-books` (`rufzfaecfhrlnnhvsfyv`, us-west-1). `DATABASE_URL` in `.env.local` is a
session-mode pooler URL for the dedicated `sooz_app` role. Inspect the live database with
`psql "$DATABASE_URL"`.

## Non-negotiables

1. **Money is integer cents in `bigint` columns.** No floating point anywhere in the money path.
   Use `parseMoney` / `formatMoney` / `allocateCents` from `src/lib/money.ts`.
2. **`postJournalEntry()` in `src/lib/ledger/post.ts` is the only code that writes `journal_lines`.**
   Every module — bank import, invoices, bills, payouts, deductions, COGS, migration — posts through it.
3. **The legal posting sequence is draft → lines → post, in one transaction.** The database refuses to
   accept lines on an already-posted entry, and a posted entry is immutable. Corrections are reversals.
4. **Every write transaction sets `app.user_id` first** (use `withActor()` from `src/db/client.ts`), or
   the audit trail records a null actor.
5. **Revenue is never booked net.** A channel settlement posts full gross detail against that channel's
   clearing account; the bank deposit clears it to zero.
6. **Dates are `YYYY-MM-DD` strings**, not `Date` objects. `new Date('2026-03-01')` is UTC midnight and
   renders as Feb 28 in US timezones — that class of bug is not acceptable in a ledger.
7. **Nothing posts from an import without human approval**, except via a rule the owner explicitly marked
   `auto_post`.

## Database invariants (enforced by triggers, verified by tests)

A posted entry balances and has ≥ 2 lines · posted entries and their lines are immutable and
undeletable · nothing posts into a closed period · every financial write lands in `audit_log` ·
a reconciled bank transaction is locked.

Migrations are hand-written SQL in `supabase/migrations/`, applied with
`psql "$DATABASE_URL" -f supabase/migrations/<file>.sql`. Drizzle is used for typed queries, not for
generating migrations.

## Layout

```
src/db/schema/       Drizzle table definitions mirroring the live schema
src/lib/ledger/      posting engine, reversals, periods, balances, chart of accounts
src/lib/banking/     statement parsing, import profiles, fingerprints, rules, AI suggestions, reconcile
src/lib/importers/   shopify, amazon, faire, distributor remittances, peasy, quickbooks
src/lib/reports/     trial balance, P&L, balance sheet, cash flow, aging, margin, forecast
src/lib/auth/        roles and capabilities
src/app/(app)/       the authenticated application
```

## Conventions

- Server Actions for every mutation; they check a capability, call a `src/lib` function, and return a
  structured `{ok:false, error}` rather than throwing at the UI. Components never touch the database.
- Capability checks come from `src/lib/auth/roles.ts` (`can(role, capability)`), never inline role
  string comparisons.
- Account codes are referenced through `ACCOUNTS` in `src/lib/ledger/coa.ts`, never as bare strings.
- Reports return the shared `{columns, rows}` shape from `src/lib/reports/types.ts`.
- Tests run against the live database and must clean up after themselves; the seeded chart of accounts
  is shared state, so never delete from `accounts`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

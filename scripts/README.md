# scripts/

## `import-relay.ts`: Relay intake, end to end

```
npx tsx scripts/import-relay.ts            # import, or re-import onto what is already there
npx tsx scripts/import-relay.ts --reset    # clear the four Relay accounts' statements first
npx tsx scripts/import-relay.ts --no-ai    # skip the AI tier (no model call)
```

This script sends the 36 real Relay exports in `data/statements/relay/` through the production
`previewImport` / `commitImport` path and into the four seeded Relay `bank_accounts`. It then
asserts the following:

1. All 36 files import. Header-only files are not errors.
2. Importing every file a second time inserts zero rows.
3. The September `(Partial)` file, then a simulated full September, then the partial again
   inserts nothing new. Relay has not closed September yet, so the full month is simulated by
   re-serialising the partial's own rows with CRLF endings. The bytes differ, which makes the
   row-level fingerprint guard do the work instead of the file-hash guard.
4. The suggestion pipeline puts every row in exactly one tier: auto-posted, rule, transfer,
   vendor default, AI, unsuggested or excluded. Each tier is reported by count and by dollars.
   Founder ACH pulls land in equity, never revenue. Amazon is never auto-categorized.
5. Every balance chain ties, both per file and across the stored account. ••9726 must run
   $1,000.00 → $529.67 and ••9973 must run $0.00 → $0.47.
6. A separate parser, which shares no code with `src/lib/banking`, re-reads the CSVs. Its
   counts, totals, (date, amount) multiset and payee text must match what was stored.

The script exits 1 if any check fails. It never posts to the ledger.

Accounts are matched by mask **and** `institution = 'Relay' and active`. The live-database test
suites create inactive throwaway accounts that reuse mask 9726. `--reset` refuses to run if any
Relay transaction is already posted or reconciled.

Do not run it while `vitest` runs the live-database suites. Both read the same date windows for
transfer detection, and a test's cleanup can delete an import batch this script is using.

## `import-square.ts`: Square settlement intake

```
npx tsx scripts/import-square.ts <settlements.csv>             # import
npx tsx scripts/import-square.ts <settlements.csv> --dry-run   # tie out and match; write nothing
```

Calls `importSquareSettlements` (`src/lib/importers/square-intake.ts`). Every settlement must tie
to the cent or nothing from the file is written. Each settlement becomes one `payout_imports` row
(provider `square`, keyed on its settlement key, so re-importing an overlapping range is free) with
its non-zero components in `payout_lines`, and the Relay deposits carrying its `SQ` + YYMMDD
reference are linked to it (`bank_transactions.matched_type = 'payout'`). Nothing posts to the
ledger. No real Square export has been seen yet: validate the parser against one before relying on it.

## The AI tier in `import-relay.ts`

`commitImport` now runs the AI tier itself (`src/lib/banking/ai-tier.ts`) over the rows it inserts.
The script calls the same `applyAiSuggestions` again over the whole ledger, so rows imported before a
model was configured are still asked about. `--no-ai` switches both off.

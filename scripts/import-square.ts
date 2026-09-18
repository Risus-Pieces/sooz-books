/**
 * Sooz Books — import a Square settlement export.
 *
 * ```
 * npx tsx scripts/import-square.ts <settlements.csv>             # import
 * npx tsx scripts/import-square.ts <settlements.csv> --dry-run   # parse, tie out and match; write nothing
 * ```
 *
 * Every settlement in the file is tied out to the cent, written to `payout_imports`
 * (keyed on its settlement key, so re-importing an overlapping range is free) and
 * matched to the Relay deposits carrying its `SQ` + YYMMDD reference. Nothing posts
 * to the ledger. Exits 1 when the file cannot be imported.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `.env.local` into `process.env`, before `@/db/client` opens its pool. Existing variables win. */
function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const paths = args.filter((arg) => arg !== '--dry-run');
  if (paths.length !== 1) {
    out('Usage: npx tsx scripts/import-square.ts <settlements.csv> [--dry-run]');
    return 2;
  }

  loadEnvFile(join(REPO_ROOT, '.env.local'));
  const { formatMoney } = await import('@/lib/money');
  const { importSquareSettlements, SquareImportError } = await import('@/lib/importers/square-intake');
  const { sql } = await import('@/db/client');

  try {
    const path = resolve(paths[0]);
    const result = await importSquareSettlements({
      filename: basename(path),
      bytes: readFileSync(path),
      userId: null,
      dryRun,
    });

    out(`${result.filename} — ${result.preview.settlementCount} settlements, net ${formatMoney(result.preview.netTotalCents)}${dryRun ? ' (dry run: nothing written)' : ''}`);
    for (const settlement of result.settlements) {
      const match = settlement.match === null ? 'already imported' : `${settlement.match.status}: ${settlement.match.reason}`;
      out(
        `  ${settlement.date} ${settlement.bankReference}  gross ${formatMoney(settlement.grossCents)}  fees ${formatMoney(settlement.feesCents)}  net ${formatMoney(settlement.netCents)}  ${settlement.outcome} — ${match}`,
      );
    }
    for (const warning of result.preview.warnings) out(`  ${warning.severity.toUpperCase()} ${warning.code}: ${warning.message}`);
    out(`inserted ${result.inserted}, already imported ${result.alreadyImported}, deposits linked ${result.depositsLinked}`);
    return result.preview.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof SquareImportError) {
      out(`Not imported (${error.code}): ${error.message}`);
      if (error.remedy !== null) out(error.remedy);
      return 1;
    }
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);

/**
 * Ask the model about every Relay transaction still waiting in the review queue that no
 * rule, vendor default or history could place, and print what it proposed.
 *
 *   npx tsx scripts/ai-suggest-queue.ts
 *
 * Suggestions are written back as suggestions only: every row stays 'unreviewed' and
 * nothing is posted. Rows a human has already reviewed are never touched.
 */
import 'dotenv/config';
import { config } from 'dotenv';

config({ path: '.env.local', override: true });

async function main(): Promise<void> {
  const { db, sql } = await import('@/db/client');
  const { applyAiSuggestions } = await import('@/lib/banking/ai-tier');
  const { formatMoney } = await import('@/lib/money');

  const queue = await sql<{ id: string }[]>`
    select bt.id
      from bank_transactions bt
      join bank_accounts ba on ba.id = bt.bank_account_id
     where ba.institution = 'Relay' and ba.active
       and bt.status = 'unreviewed'
     order by bt.txn_date, bt.id`;

  const report = await applyAiSuggestions(
    queue.map((r) => r.id),
    { userId: null },
  );

  const rows = await sql<
    {
      txn_date: string;
      counterparty: string | null;
      amount_cents: string;
      code: string | null;
      name: string | null;
      suggestion_source: string | null;
      suggestion_confidence: string | null;
      suggestion_reasoning: string | null;
    }[]
  >`
    select bt.txn_date::text, bt.counterparty, bt.amount_cents::text,
           a.code, a.name, bt.suggestion_source::text,
           bt.suggestion_confidence::text, bt.suggestion_reasoning
      from bank_transactions bt
      join bank_accounts ba on ba.id = bt.bank_account_id
      left join accounts a on a.id = bt.suggested_account_id
     where ba.institution = 'Relay' and ba.active
       and bt.status = 'unreviewed'
       and bt.suggestion_source = 'ai'
     order by bt.txn_date, bt.id`;

  process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n\n`);
  for (const r of rows) {
    const conf = r.suggestion_confidence === null ? '  -  ' : Number(r.suggestion_confidence).toFixed(2);
    process.stdout.write(
      `${r.txn_date}  ${formatMoney(Number(r.amount_cents)).padStart(10)}  ${(r.counterparty ?? '').slice(0, 22).padEnd(22)}` +
        `  -> ${r.code ?? '----'} ${(r.name ?? '').slice(0, 30).padEnd(30)} ${conf}  ${r.suggestion_reasoning ?? ''}\n`,
    );
  }
  process.stdout.write(
    `\n${rows.length} rows now carry an AI suggestion (${report.unanswered} unanswered, ${report.discarded} discarded); all remain unreviewed.\n`,
  );

  await sql.end();
  void db;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

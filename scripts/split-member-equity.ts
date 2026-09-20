/**
 * Give each member their own capital accounts, and attribute the contributions already posted.
 *
 *   npx tsx scripts/split-member-equity.ts --dry-run
 *   npx tsx scripts/split-member-equity.ts
 *
 * Sooz has two members, and until now every dollar either of them put in landed in one pooled
 * account, 3015. This creates four accounts — contributions and draws for each member — moves
 * the pooled balance onto them, and points each member, and the two rules that categorise their
 * ACH pulls, at the right one.
 *
 * The order matters. The reclassifying entry debits 3015, and an account with children is a
 * rollup that nothing may post to, so the new contribution accounts are created as siblings,
 * the entry is posted while 3015 is still a leaf, and only then are they nested under it. That
 * nesting is what keeps the dashboard's founder card correct: it walks the account tree.
 *
 * Safe to run twice: each step checks whether it has already been done.
 */
import 'dotenv/config';
import { config } from 'dotenv';

// override: false so an explicit DATABASE_URL (a local replica, a test database) always wins over
// .env.local; with override: true it would silently have written to production instead.
config({ path: '.env.local', override: false });

interface Member {
  email: string;
  /** How the member is named on their accounts. */
  label: string;
  contributionsCode: string;
  drawsCode: string;
  /** The bank text their personal transfers arrive with. */
  sourceMatch: string;
  /** True for the member who funded the accounts the books opened with. */
  ownsOpeningBalance: boolean;
}

const MEMBERS: readonly Member[] = [
  {
    email: 'boxuanzhao1128@gmail.com',
    label: 'Risus',
    contributionsCode: '3016',
    drawsCode: '3021',
    sourceMatch: 'CHASE COLLEGE',
    ownsOpeningBalance: true,
  },
  {
    email: 'mo@drinksooz.com',
    label: 'Mo',
    contributionsCode: '3017',
    drawsCode: '3022',
    sourceMatch: 'SafeBalance',
    ownsOpeningBalance: false,
  },
];

const DRY_RUN = process.argv.includes('--dry-run');

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** One posted line sitting on the pooled contributions account, with what it came from. */
interface PooledLine {
  entryDate: string;
  cents: number;
  sourceType: string;
  bankText: string | null;
}

/** Which member a pooled line belongs to, by the bank text it arrived with. */
function ownerOf(line: PooledLine, money: (cents: number) => string): Member {
  const text = (line.bankText ?? '').toLowerCase();
  const matched = MEMBERS.find((m) => text.includes(m.sourceMatch.toLowerCase()));
  if (matched !== undefined) return matched;
  if (line.sourceType === 'opening_balance') {
    const owner = MEMBERS.find((m) => m.ownsOpeningBalance);
    if (owner !== undefined) return owner;
  }
  throw new Error(
    `Cannot say whose contribution this is: ${line.entryDate} ${money(line.cents)} ` +
      `(${line.sourceType}${line.bankText === null ? '' : `, "${line.bankText}"`}). ` +
      `Add its bank text to a member's sourceMatch and run again.`,
  );
}

async function main(): Promise<void> {
  const { and, eq, sql } = await import('drizzle-orm');
  const { db, sql: pg, withActor } = await import('@/db/client');
  const { accounts, appUsers, categorizationRules } = await import('@/db/schema');
  const { createAccount, getAccountByCodeIn, updateAccount } = await import('@/lib/ledger/accounts');
  const { ACCOUNTS } = await import('@/lib/ledger/coa');
  const { postJournalEntry } = await import('@/lib/ledger/post');
  const { formatMoney } = await import('@/lib/money');

  const members = await Promise.all(
    MEMBERS.map(async (m) => {
      const [row] = await db.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.email, m.email));
      if (row === undefined) throw new Error(`No user in the books for ${m.email}.`);
      return { ...m, userId: row.id };
    }),
  );
  const actor = members.find((m) => m.ownsOpeningBalance)?.userId ?? members[0].userId;

  // ---- who contributed what -------------------------------------------------
  const rows = await pg<{ entry_date: string; cents: string; source_type: string; bank_text: string | null }[]>`
    select e.entry_date, (l.credit_cents - l.debit_cents)::text as cents,
           e.source_type, coalesce(bt.description, bt.counterparty) as bank_text
      from journal_lines l
      join accounts a on a.id = l.account_id and a.code = ${ACCOUNTS.MEMBER_CONTRIBUTIONS}
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      left join bank_transactions bt on bt.journal_entry_id = e.id
     order by e.entry_date, e.entry_no`;
  const lines: PooledLine[] = rows.map((r) => ({
    entryDate: r.entry_date,
    cents: Number(r.cents),
    sourceType: r.source_type,
    bankText: r.bank_text,
  }));

  const share = new Map<string, number>(members.map((m) => [m.email, 0]));
  for (const line of lines) {
    const owner = ownerOf(line, formatMoney);
    share.set(owner.email, (share.get(owner.email) ?? 0) + line.cents);
  }
  const pooledTotal = lines.reduce((sum, l) => sum + l.cents, 0);
  const attributed = [...share.values()].reduce((sum, c) => sum + c, 0);
  if (attributed !== pooledTotal) {
    throw new Error(`Attributed ${formatMoney(attributed)} of ${formatMoney(pooledTotal)}; they must match.`);
  }

  say(`${lines.length} posted contributions on ${ACCOUNTS.MEMBER_CONTRIBUTIONS}, ${formatMoney(pooledTotal)} in total:`);
  for (const m of members) say(`  ${m.label.padEnd(8)}${formatMoney(share.get(m.email) ?? 0).padStart(12)}`);

  if (DRY_RUN) {
    say('\n--dry-run: nothing written.');
    await pg.end({ timeout: 5 });
    return;
  }

  // ---- 1. the four accounts; contributions start as siblings of 3015 -------
  await withActor(actor, async (tx) => {
    for (const m of members) {
      for (const [code, name, parentCode, subtype] of [
        [m.contributionsCode, `Contributions — ${m.label}`, ACCOUNTS.COMMON_STOCK, 'equity'],
        [m.drawsCode, `Draws — ${m.label}`, ACCOUNTS.OWNER_DRAWS, 'contra_equity'],
      ] as const) {
        if ((await getAccountByCodeIn(tx, code)) !== null) {
          say(`account ${code} already exists`);
          continue;
        }
        await createAccount(
          {
            code,
            name,
            type: 'equity',
            subtype,
            parentCode,
            description:
              subtype === 'equity'
                ? `Money ${m.label} has put into the company. Their capital, not the company's earnings.`
                : `Cash ${m.label} has taken out. Contra-equity, never an expense.`,
          },
          { userId: actor, tx },
        );
        say(`created ${code} ${name}`);
      }
    }
  });

  const pooled = await getAccountByCodeIn(db, ACCOUNTS.MEMBER_CONTRIBUTIONS);
  if (pooled === null) throw new Error(`${ACCOUNTS.MEMBER_CONTRIBUTIONS} is missing.`);

  // ---- 2. move the pooled balance onto them, while 3015 is still a leaf -----
  const nested = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.parentId, pooled.id)).limit(1);
  if (nested.length > 0) {
    say('contributions are already attributed; nothing to reclassify');
  } else if (pooledTotal === 0) {
    say('nothing sits on the pooled account; nothing to reclassify');
  } else {
    const ids = new Map<string, string>();
    for (const m of members) {
      const row = await getAccountByCodeIn(db, m.contributionsCode);
      if (row === null) throw new Error(`${m.contributionsCode} is missing.`);
      ids.set(m.email, row.id);
    }
    const today = new Date().toISOString().slice(0, 10);
    const posted = await withActor(actor, (tx) =>
      postJournalEntry(
        {
          date: today,
          memo: 'Attribute member contributions to each member',
          sourceType: 'manual',
          lines: [
            { accountId: pooled.id, debitCents: pooledTotal, memo: 'Pooled contributions, now attributed' },
            ...members
              .filter((m) => (share.get(m.email) ?? 0) !== 0)
              .map((m) => ({
                accountId: ids.get(m.email) as string,
                creditCents: share.get(m.email) as number,
                memo: `${m.label}'s contributions to date`,
              })),
          ],
        },
        { userId: actor, tx },
      ),
    );
    say(`posted entry #${posted.entryNo}: ${formatMoney(pooledTotal)} attributed`);
  }

  // ---- 3. nest the contribution accounts under 3015 -------------------------
  await withActor(actor, async (tx) => {
    for (const m of members) {
      const row = await getAccountByCodeIn(tx, m.contributionsCode);
      if (row === null) throw new Error(`${m.contributionsCode} is missing.`);
      if (row.parentId === pooled.id) continue;
      await updateAccount(row.id, { parentCode: ACCOUNTS.MEMBER_CONTRIBUTIONS }, { userId: actor, tx });
      say(`nested ${m.contributionsCode} under ${ACCOUNTS.MEMBER_CONTRIBUTIONS}`);
    }
  });

  // ---- 4. each member points at their own accounts -------------------------
  await withActor(actor, async (tx) => {
    for (const m of members) {
      const contributions = await getAccountByCodeIn(tx, m.contributionsCode);
      const draws = await getAccountByCodeIn(tx, m.drawsCode);
      if (contributions === null || draws === null) throw new Error(`${m.label}'s accounts are missing.`);
      await tx
        .update(appUsers)
        .set({ contributionsAccountId: contributions.id, drawsAccountId: draws.id })
        .where(eq(appUsers.id, m.userId));
      say(`${m.label} → ${m.contributionsCode} / ${m.drawsCode}`);
    }
  });

  // ---- 5. the rules that categorise their ACH pulls ------------------------
  await withActor(actor, async (tx) => {
    for (const m of members) {
      const contributions = await getAccountByCodeIn(tx, m.contributionsCode);
      if (contributions === null) continue;
      const updated = await tx
        .update(categorizationRules)
        .set({ accountId: contributions.id })
        .where(
          and(
            eq(categorizationRules.accountId, pooled.id),
            sql`${categorizationRules.conditions}::text ilike ${`%${m.sourceMatch}%`}`,
          ),
        )
        .returning({ name: categorizationRules.name });
      for (const rule of updated) say(`rule "${rule.name}" → ${m.contributionsCode}`);
    }
  });

  // ---- 6. what the books say now -------------------------------------------
  const codes = [
    ACCOUNTS.MEMBER_CONTRIBUTIONS,
    ...MEMBERS.map((m) => m.contributionsCode),
    ACCOUNTS.OWNER_DRAWS,
    ...MEMBERS.map((m) => m.drawsCode),
  ];
  const after = await pg<{ code: string; name: string; cents: string }[]>`
    select a.code, a.name,
           coalesce(sum(l.credit_cents - l.debit_cents), 0)::text as cents
      from accounts a
      left join journal_lines l on l.account_id = a.id
      left join journal_entries e on e.id = l.entry_id and e.status = 'posted'
     where a.code in ${pg(codes)}
     group by a.id, a.code, a.name
     order by a.code`;
  say('\nafter:');
  for (const row of after) {
    say(`  ${row.code}  ${row.name.padEnd(26)}${formatMoney(Number(row.cents)).padStart(12)}`);
  }

  await pg.end({ timeout: 5 });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

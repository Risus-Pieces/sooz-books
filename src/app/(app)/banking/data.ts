/**
 * The banking writes and computed reads the engine in `@/lib/banking` does not provide:
 * excluding a row the money never moved for (and bringing it back), saving a categorization
 * rule from the rules screen, and previewing what a rule being edited would match.
 *
 * Every write runs through `inBankingTx`, which sets the actor for the audit log and turns a
 * reconciliation lock into the engine's typed error. Nothing here posts: excluding a row keeps
 * it out of the ledger, and a rule only ever proposes.
 */

import { eq, sql as sqlTag } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { accounts, bankAccounts, bankTransactions, categorizationRules, vendors } from '@/db/schema';
import { type BankingCtx, BankingError, inBankingTx } from '@/lib/banking/post';
import {
  RULE_DIRECTIONS,
  type CategorizationRule,
  type RuleCondition,
  createRuleEngine,
  inspectRegexSource,
  loadCategorizationRules,
  parseRuleConditions,
} from '@/lib/banking/rules';
import type { LedgerDb } from '@/lib/ledger/post';

import type { RuleDraft, RulePreview, RulePreviewRow } from '@/components/banking/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertId(value: string, what: string): void {
  if (!UUID.test(value)) throw new BankingError('txn_not_found', `${what} ${JSON.stringify(value)} is not an id.`);
}

// ---------------------------------------------------------------------------
// Excluding
// ---------------------------------------------------------------------------

interface ExcludableRow {
  id: string;
  status: string;
  journalEntryId: string | null;
  reconciledAt: Date | null;
  transferPairId: string | null;
}

async function lockForExclusion(tx: Tx, txnId: string): Promise<ExcludableRow> {
  assertId(txnId, 'Bank transaction');
  const [row] = await tx
    .select({
      id: bankTransactions.id,
      status: bankTransactions.status,
      journalEntryId: bankTransactions.journalEntryId,
      reconciledAt: bankTransactions.reconciledAt,
      transferPairId: bankTransactions.transferPairId,
    })
    .from(bankTransactions)
    .where(eq(bankTransactions.id, txnId))
    .for('update');
  if (row === undefined) throw new BankingError('txn_not_found', `Bank transaction ${txnId} does not exist.`);
  if (row.reconciledAt !== null) {
    throw new BankingError('reconciled', 'This transaction is reconciled and locked. Undo the reconciliation first.');
  }
  if (row.journalEntryId !== null) {
    throw new BankingError('already_posted', 'This transaction is posted. Unpost it before excluding it.');
  }
  return row;
}

/**
 * Marks unposted rows as excluded: the bank printed them but no money moved (a returned
 * ACH, a duplicate the bank itself reversed). An excluded row can never post. A transfer
 * leg has to be unpaired first, so its partner is never left pointing at an excluded row.
 */
export async function excludeTransactions(txnIds: readonly string[], ctx: BankingCtx): Promise<number> {
  return inBankingTx(ctx, async (tx) => {
    let changed = 0;
    for (const id of [...new Set(txnIds)].sort()) {
      const row = await lockForExclusion(tx, id);
      if (row.status === 'excluded') continue;
      if (row.transferPairId !== null) {
        throw new BankingError(
          'wrong_status',
          'This transaction is one leg of a transfer pair. Unpair it before excluding it.',
        );
      }
      await tx.update(bankTransactions).set({ status: 'excluded' }).where(eq(bankTransactions.id, id));
      changed += 1;
    }
    return changed;
  });
}

/**
 * Returns excluded rows to review, with the suggestion they arrived with. A returned payment
 * and its original are linked and cancel out, so they come back together or not at all:
 * bringing back one half alone would put money in the books that never moved.
 */
export async function includeTransactions(txnIds: readonly string[], ctx: BankingCtx): Promise<number> {
  const wanted = new Set(txnIds);
  return inBankingTx(ctx, async (tx) => {
    let changed = 0;
    for (const id of [...wanted].sort()) {
      const row = await lockForExclusion(tx, id);
      if (row.status !== 'excluded') continue;
      if (row.transferPairId !== null && !wanted.has(row.transferPairId)) {
        throw new BankingError(
          'wrong_status',
          'This transaction and the one it is linked to cancel each other out. Select both and return them together.',
        );
      }
      await tx.update(bankTransactions).set({ status: 'unreviewed' }).where(eq(bankTransactions.id, id));
      changed += 1;
    }
    return changed;
  });
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Every reason the draft cannot be saved or run, in words. Pure. */
export function ruleDraftProblems(draft: RuleDraft): string[] {
  const problems: string[] = [];
  if (draft.conditions.length === 0) problems.push('add at least one condition');
  const parsed = parseRuleConditions(draft.conditions);
  problems.push(...parsed.problems.filter((problem) => !/has no value|is empty/.test(problem)));
  draft.conditions.forEach((condition, index) => {
    if (condition.value.trim() === '') problems.push(`condition ${index + 1} has nothing to match`);
    else if (condition.op === 'regex') {
      const inspected = inspectRegexSource(condition.value);
      if (!inspected.safe) problems.push(`condition ${index + 1}'s pattern cannot be used: ${inspected.reason}`);
    }
  });
  if (!RULE_DIRECTIONS.includes(draft.direction)) problems.push(`"${String(draft.direction)}" is not a direction`);
  for (const [label, value] of [
    ['minimum', draft.amountMinCents],
    ['maximum', draft.amountMaxCents],
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      problems.push(`the ${label} amount must be zero or more`);
    }
  }
  if (draft.amountMinCents !== null && draft.amountMaxCents !== null && draft.amountMinCents > draft.amountMaxCents) {
    problems.push('the minimum amount is larger than the maximum');
  }
  if (!Number.isSafeInteger(draft.priority) || draft.priority < 1 || draft.priority > 9999) {
    problems.push('priority must be a whole number from 1 to 9999');
  }
  return problems;
}

function trimmedConditions(conditions: readonly RuleCondition[]): RuleCondition[] {
  // A regex is used exactly as typed; the other operators ignore surrounding space anyway.
  return conditions.map((c) => ({ field: c.field, op: c.op, value: c.op === 'regex' ? c.value : c.value.trim() }));
}

async function assertRuleTargets(tx: Tx, draft: RuleDraft): Promise<{ code: string; name: string }> {
  if (draft.accountId === null) {
    throw new BankingError('rule_invalid', 'Choose the account this rule codes matching transactions to.');
  }
  assertId(draft.accountId, 'Account');
  const [account] = await tx
    .select({
      code: accounts.code,
      name: accounts.name,
      active: accounts.active,
      isBank: accounts.isBank,
      isControl: accounts.isControl,
      isRollup: sqlTag<boolean>`exists (select 1 from accounts child where child.parent_id = accounts.id)`,
      isBankFeed: sqlTag<boolean>`exists (select 1 from bank_accounts ba where ba.account_id = accounts.id)`,
    })
    .from(accounts)
    .where(eq(accounts.id, draft.accountId));
  if (account === undefined) throw new BankingError('rule_invalid', 'That account does not exist.');
  if (!account.active) throw new BankingError('rule_invalid', `${account.code} ${account.name} is inactive.`);
  if (account.isRollup) {
    throw new BankingError('rule_invalid', `${account.code} ${account.name} is a heading; choose one of the accounts under it.`);
  }
  if (account.isControl) {
    throw new BankingError(
      'rule_invalid',
      `${account.code} ${account.name} is kept by its sub-ledger; a bank rule cannot post to it.`,
    );
  }
  if (account.isBank || account.isBankFeed) {
    throw new BankingError(
      'rule_invalid',
      `${account.code} ${account.name} is a bank account. Money between two of the company's own accounts is a transfer, not a rule.`,
    );
  }
  if (draft.vendorId !== null) {
    assertId(draft.vendorId, 'Vendor');
    const [vendor] = await tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, draft.vendorId));
    if (vendor === undefined) throw new BankingError('rule_invalid', 'That vendor does not exist.');
  }
  if (draft.bankAccountId !== null) {
    assertId(draft.bankAccountId, 'Bank account');
    const [bank] = await tx.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.id, draft.bankAccountId));
    if (bank === undefined) throw new BankingError('rule_invalid', 'That bank account does not exist.');
  }
  return { code: account.code, name: account.name };
}

/**
 * Creates or updates a rule. Turning `auto_post` on — or editing a rule that already posts
 * without review — needs `mayAutoPost`: a rule that posts on its own is the owner's decision.
 * Editing never touches a transaction; the rule applies from the next import.
 */
export async function saveRule(
  draft: RuleDraft,
  ctx: BankingCtx & { mayAutoPost: boolean },
): Promise<{ id: string; name: string }> {
  const problems = ruleDraftProblems(draft);
  if (problems.length > 0) {
    throw new BankingError('rule_invalid', `This rule cannot be saved yet: ${problems.join('; ')}.`);
  }
  return inBankingTx(ctx, async (tx) => {
    const account = await assertRuleTargets(tx, draft);
    const conditions = trimmedConditions(draft.conditions);

    let wasAutoPost = false;
    if (draft.id !== null) {
      assertId(draft.id, 'Rule');
      const [existing] = await tx
        .select({ autoPost: categorizationRules.autoPost })
        .from(categorizationRules)
        .where(eq(categorizationRules.id, draft.id))
        .for('update');
      if (existing === undefined) throw new BankingError('rule_invalid', 'That rule no longer exists.');
      wasAutoPost = existing.autoPost;
    }
    if ((draft.autoPost || wasAutoPost) && !ctx.mayAutoPost) {
      throw new BankingError(
        'not_permitted',
        wasAutoPost
          ? 'This rule posts without review, so only the owner can change it.'
          : 'Only the owner can let a rule post without review.',
      );
    }

    const name = draft.name.trim() || `${conditions[0].value} → ${account.code} ${account.name}`;
    const values = {
      name,
      priority: draft.priority,
      bankAccountId: draft.bankAccountId,
      conditions,
      direction: draft.direction,
      amountMinCents: draft.amountMinCents,
      amountMaxCents: draft.amountMaxCents,
      accountId: draft.accountId,
      vendorId: draft.vendorId,
      memoTemplate: draft.memoTemplate === null || draft.memoTemplate.trim() === '' ? null : draft.memoTemplate.trim(),
      autoPost: draft.autoPost,
      active: draft.active,
    };

    if (draft.id === null) {
      const [created] = await tx
        .insert(categorizationRules)
        .values({ ...values, createdBy: ctx.userId })
        .returning({ id: categorizationRules.id });
      return { id: created.id, name };
    }
    await tx.update(categorizationRules).set(values).where(eq(categorizationRules.id, draft.id));
    return { id: draft.id, name };
  });
}

/** Switches a rule on or off. An auto-post rule is the owner's to touch. */
export async function setRuleActive(
  ruleId: string,
  active: boolean,
  ctx: BankingCtx & { mayAutoPost: boolean },
): Promise<void> {
  assertId(ruleId, 'Rule');
  await inBankingTx(ctx, async (tx) => {
    const [rule] = await tx
      .select({ autoPost: categorizationRules.autoPost })
      .from(categorizationRules)
      .where(eq(categorizationRules.id, ruleId))
      .for('update');
    if (rule === undefined) throw new BankingError('rule_invalid', 'That rule no longer exists.');
    if (rule.autoPost && !ctx.mayAutoPost) {
      throw new BankingError('not_permitted', 'This rule posts without review, so only the owner can change it.');
    }
    await tx
      .update(categorizationRules)
      .set({ active })
      .where(eq(categorizationRules.id, ruleId));
  });
}

// ---------------------------------------------------------------------------
// Rule preview
// ---------------------------------------------------------------------------

interface PreviewTxnRow {
  id: string;
  bank_account_id: string;
  mask: string | null;
  txn_date: string;
  description: string;
  counterparty: string | null;
  reference: string | null;
  amount_cents: string;
  posted: boolean;
}

const PREVIEW_SAMPLE = 12;

/**
 * What the draft would match among every imported transaction, and how many of those it
 * would actually win against the other active rules. Read-only. A condition on the bank's
 * type label is only known while a file imports, so it matches nothing here and says so.
 */
export async function previewRule(draft: RuleDraft, exec?: LedgerDb): Promise<RulePreview> {
  const problems = ruleDraftProblems(draft);
  if (draft.conditions.some((c) => c.field === 'type')) {
    problems.push('the transaction type is only read while a statement imports, so this preview cannot test it');
  }
  if (problems.length > 0) return { matched: 0, wins: 0, posted: 0, sample: [], problems };

  const runner = exec ?? (await import('@/db/client')).db;
  const txns = (await runner.execute(sqlTag`
      select bt.id, bt.bank_account_id, ba.mask, bt.txn_date::text, bt.description, bt.counterparty,
             bt.reference, bt.amount_cents::text, (bt.journal_entry_id is not null) as posted
        from bank_transactions bt
        join bank_accounts ba on ba.id = bt.bank_account_id
       where bt.status <> 'excluded'
       order by bt.txn_date desc, bt.id desc`)) as unknown as PreviewTxnRow[];
  // A test hands in its rolled-back transaction as a LedgerDb; the loader only calls execute.
  const loaded = await loadCategorizationRules(exec === undefined ? {} : { tx: exec as unknown as Tx });

  const draftId = draft.id ?? '00000000-0000-0000-0000-000000000000';
  const candidate: CategorizationRule = {
    id: draftId,
    name: draft.name.trim() || 'This rule',
    priority: draft.priority,
    bankAccountId: draft.bankAccountId,
    conditions: trimmedConditions(draft.conditions),
    amountMinCents: draft.amountMinCents,
    amountMaxCents: draft.amountMaxCents,
    direction: draft.direction,
    accountId: draft.accountId,
    vendorId: draft.vendorId,
    customerId: null,
    channelId: null,
    memoTemplate: draft.memoTemplate,
    autoPost: draft.autoPost,
    active: true,
    hitCount: 0,
    lastHitAt: null,
  };
  const others = loaded.rules.filter((rule) => rule.id !== draftId && rule.active);
  const engine = createRuleEngine([...others, candidate]);

  let matched = 0;
  let wins = 0;
  let posted = 0;
  const sample: RulePreviewRow[] = [];
  for (const row of txns) {
    const amountCents = Number(row.amount_cents);
    const evaluation = engine.evaluate({
      id: row.id,
      bankAccountId: row.bank_account_id,
      txnDate: row.txn_date,
      payee: row.counterparty,
      description: row.description,
      reference: row.reference,
      type: null,
      amountCents,
    });
    if (!evaluation.matches.some((rule) => rule.id === draftId)) continue;
    matched += 1;
    const won = evaluation.winner?.id === draftId;
    if (won) wins += 1;
    if (row.posted) posted += 1;
    if (sample.length < PREVIEW_SAMPLE) {
      sample.push({
        id: row.id,
        txnDate: row.txn_date,
        payee: (row.counterparty ?? '').trim() || row.description,
        reference: row.reference,
        amountCents,
        bankMask: row.mask,
        wonBy: won ? null : (evaluation.winner?.name ?? null),
        posted: row.posted,
      });
    }
  }
  return { matched, wins, posted, sample, problems };
}

/**
 * The `stage_*` half of stage-then-confirm.
 *
 * Each function checks the caller's capability, validates the change exactly as posting would (the
 * banking engine's and the ledger's own preview functions, not copies of their rules), writes a
 * `mcp_stagings` row holding the normalised change plus what the person is shown, and returns that.
 * Nothing here touches the ledger. Whatever fails validation is reported back by name and left out
 * of the staging, so a batch of fifty with two problems stages forty-eight and says which two.
 */
import { inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { vendors } from '@/db/schema';
import { requireCapability } from '@/lib/auth/roles';
import { isBankingError, previewApproval } from '@/lib/banking/post';
import { isCalendarDate } from '@/lib/dates';
import { getAccountByCodeIn } from '@/lib/ledger/accounts';
import { memberEquityAccount } from '@/lib/ledger/member-equity';
import { type LedgerDb, previewJournalEntry } from '@/lib/ledger/post';
import { parseMoney } from '@/lib/money';

import { resolveAccount } from './accounts';
import { McpInputError, assertMayStage, describeError } from './errors';
import { KEY_STAGE_TTL_MINUTES, createStaging, supersedeStagings } from './staging';
import { type McpUser, keyClientId } from './types';
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES, bankSummary, postedLineCount } from './stage-support';

export interface StageCtx {
  /** Tests run inside a rolled-back transaction; production leaves this out. */
  tx?: LedgerDb;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_RE, 'Not a valid id');

export const PERSONAL_MEMO = 'Personal purchase — owner draw';
export const MAX_BANK_ITEMS = 50;

// ---------------------------------------------------------------------------
// Bank decisions
// ---------------------------------------------------------------------------

export const bankDecisionsInput = z.object({
  items: z
    .array(
      z.object({
        txn_id: uuid,
        action: z.enum(['accept', 'personal', 'exclude']),
        account: z.string().min(1).optional(),
        vendor_id: uuid.nullable().optional(),
        memo: z.string().max(200).optional(),
        confirm_different_transaction: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(MAX_BANK_ITEMS),
});
export type BankDecisionsInput = z.infer<typeof bankDecisionsInput>;

export const bankPayloadSchema = z.object({
  items: z.array(
    z.object({
      action: z.enum(['accept', 'personal', 'exclude']),
      txnId: uuid,
      // Everything below is the choice exactly as it was previewed, resolved at staging time. Commit
      // passes it all explicitly, so a suggestion that changes in between cannot change what posts.
      accountId: uuid.optional(),
      vendorId: uuid.nullable().optional(),
      customerId: uuid.nullable().optional(),
      channelId: uuid.nullable().optional(),
      memo: z.string().optional(),
      confirmedNew: z.boolean().optional(),
    }),
  ),
});
export type BankPayload = z.infer<typeof bankPayloadSchema>;

export interface PreviewLine {
  account: string;
  debitCents: number;
  creditCents: number;
}

export interface BankPreview {
  entries: {
    txnId: string;
    date: string;
    bank: string;
    amountCents: number;
    action: 'accept' | 'personal';
    memo: string;
    vendor: string | null;
    /** What the bank printed. Untrusted. */
    description: string;
    lines: PreviewLine[];
    /** Things the person must know before saying yes, e.g. that the duplicate guard was overridden. */
    warnings: string[];
  }[];
  exclusions: { txnId: string; date: string; bank: string; amountCents: number; description: string }[];
  problems: { txnId: string; reason: string }[];
}

export interface Staged<P> {
  /** Null when nothing could be staged. */
  stageId: string | null;
  expiresAt: Date | null;
  preview: P;
}

export async function stageBankDecisions(
  user: McpUser,
  input: BankDecisionsInput,
  ctx: StageCtx = {},
): Promise<Staged<BankPreview>> {
  assertMayStage(user);
  requireCapability(user.role, 'bank.approve');
  const exec = ctx.tx ?? db;
  const bankCtx = { userId: user.id, ...(ctx.tx === undefined ? {} : { tx: ctx.tx }) };

  const payload: BankPayload = { items: [] };
  const preview: BankPreview = { entries: [], exclusions: [], problems: [] };
  const seen = new Set<string>();
  const vendorIds = new Set<string>();
  const vendorOf: { index: number; vendorId: string | null }[] = [];

  for (const item of input.items) {
    const txnId = item.txn_id;
    try {
      if (seen.has(txnId)) throw new McpInputError('This transaction appears twice in the request.');
      seen.add(txnId);

      if (item.action === 'exclude') {
        const summary = await bankSummary(exec, txnId);
        preview.exclusions.push({ txnId, ...summary });
        payload.items.push({ action: 'exclude', txnId });
        continue;
      }

      let accountId: string;
      let memo = item.memo;
      let vendorId = item.vendor_id;
      if (item.action === 'personal') {
        accountId = (await memberEquityAccount(exec, user.id, 'draws')).id;
        memo ??= PERSONAL_MEMO;
        vendorId = null;
      } else {
        if (item.account === undefined) {
          throw new McpInputError(
            'Say which account this goes to. Staging never falls back to the suggestion; ask the user if unsure.',
          );
        }
        const account = await resolveAccount(exec, item.account);
        if (!account.active) throw new McpInputError(`${account.code} ${account.name} is inactive.`);
        accountId = account.id;
      }

      const asked = {
        txnId,
        accountId,
        ...(vendorId === undefined ? {} : { vendorId }),
        ...(item.action === 'personal' ? { customerId: null, channelId: null } : {}),
        ...(memo === undefined || memo.trim() === '' ? {} : { memo }),
      };
      // The duplicate guard is only overridden when it actually fired, and the person is told.
      const warnings: string[] = [];
      let confirmedNew = false;
      let shown;
      try {
        shown = await previewApproval(asked, bankCtx);
      } catch (error) {
        if (!(isBankingError(error) && error.code === 'already_booked' && item.confirm_different_transaction === true)) {
          throw error;
        }
        warnings.push(`DUPLICATE WARNING: ${error.message} Posting anyway because you said this is a different transaction.`);
        shown = await previewApproval({ ...asked, confirmedNew: true }, bankCtx);
        confirmedNew = true;
      }
      const summary = await bankSummary(exec, txnId);
      if (shown.vendorId !== null) vendorIds.add(shown.vendorId);
      vendorOf.push({ index: preview.entries.length, vendorId: shown.vendorId });
      preview.entries.push({
        txnId,
        date: shown.txnDate,
        bank: shown.bankAccountName,
        amountCents: shown.amountCents,
        action: item.action,
        memo: shown.memo,
        vendor: null,
        description: summary.description,
        warnings,
        lines: shown.lines.map((line) => ({
          account: `${line.accountCode} ${line.accountName}`,
          debitCents: line.debitCents,
          creditCents: line.creditCents,
        })),
      });
      payload.items.push({
        action: item.action,
        txnId,
        accountId,
        vendorId: shown.vendorId,
        customerId: shown.customerId,
        channelId: shown.channelId,
        memo: shown.memo,
        ...(confirmedNew ? { confirmedNew: true } : {}),
      });
    } catch (error) {
      preview.problems.push({ txnId, reason: describeError(error) });
    }
  }

  if (vendorIds.size > 0) {
    const names = await exec.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, [...vendorIds]));
    const byId = new Map(names.map((row) => [row.id, row.name]));
    for (const { index, vendorId } of vendorOf) {
      if (vendorId !== null) preview.entries[index].vendor = byId.get(vendorId) ?? null;
    }
  }

  if (payload.items.length === 0) return { stageId: null, expiresAt: null, preview };
  const { id, expiresAt } = await createStaging(exec, {
    userId: user.id,
    clientId: keyClientId(user) ?? user.clientId,
    ...(user.key ? { ttlMinutes: KEY_STAGE_TTL_MINUTES } : {}),
    kind: 'bank_decisions',
    payload,
    preview,
  });
  // A newer stage for the same rows replaces the old one: a stage the person turned down must not
  // stay confirmable behind their back.
  await supersedeStagings(exec, user.id, 'bank_decisions', payload.items.map((item) => item.txnId), id, keyClientId(user) ?? user.clientId);
  return { stageId: id, expiresAt, preview };
}

// ---------------------------------------------------------------------------
// Journal entry
// ---------------------------------------------------------------------------

export const journalEntryInput = z.object({
  date: z.string(),
  memo: z.string().max(300).optional(),
  lines: z
    .array(
      z.object({
        account: z.string().min(1),
        debit: z.string().optional(),
        credit: z.string().optional(),
        memo: z.string().max(200).optional(),
      }),
    )
    .min(2)
    .max(50),
});
export type JournalEntryInput = z.infer<typeof journalEntryInput>;

export const journalPayloadSchema = z.object({
  date: z.string(),
  memo: z.string().optional(),
  lines: z.array(
    z.object({
      accountId: uuid,
      debitCents: z.number().int().nonnegative(),
      creditCents: z.number().int().nonnegative(),
      memo: z.string().optional(),
    }),
  ),
});
export type JournalPayload = z.infer<typeof journalPayloadSchema>;

export interface JournalPreview {
  date: string;
  memo: string | null;
  totalCents: number;
  lines: { account: string; debitCents: number; creditCents: number; memo: string | null }[];
}

function amountOf(label: string, text: string | undefined): number {
  if (text === undefined || text.trim() === '') return 0;
  try {
    return parseMoney(text);
  } catch {
    throw new McpInputError(`${label} "${text}" is not an amount. Use dollars, for example 125.40.`);
  }
}

export async function stageJournalEntry(
  user: McpUser,
  input: JournalEntryInput,
  ctx: StageCtx = {},
): Promise<Staged<JournalPreview>> {
  assertMayStage(user);
  requireCapability(user.role, 'ledger.post');
  const exec = ctx.tx ?? db;
  if (!isCalendarDate(input.date)) throw new McpInputError(`"${input.date}" is not a date. Use YYYY-MM-DD.`);

  const payload: JournalPayload = {
    date: input.date,
    ...(input.memo === undefined || input.memo.trim() === '' ? {} : { memo: input.memo.trim() }),
    lines: [],
  };
  for (const [index, line] of input.lines.entries()) {
    const account = await resolveAccount(exec, line.account);
    payload.lines.push({
      accountId: account.id,
      debitCents: amountOf(`Line ${index + 1} debit`, line.debit),
      creditCents: amountOf(`Line ${index + 1} credit`, line.credit),
      ...(line.memo === undefined || line.memo.trim() === '' ? {} : { memo: line.memo.trim() }),
    });
  }

  // Throws the ledger's own typed error (unbalanced, closed period, rollup, …) for the caller to relay.
  const shown = await previewJournalEntry(
    {
      date: payload.date,
      ...(payload.memo === undefined ? {} : { memo: payload.memo }),
      sourceType: 'manual',
      lines: payload.lines,
    },
    exec,
  );
  const preview: JournalPreview = {
    date: shown.date,
    memo: shown.memo,
    totalCents: shown.totalCents,
    lines: shown.lines.map((line) => ({
      account: `${line.accountCode} ${line.accountName}`,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      memo: line.memo,
    })),
  };
  const { id, expiresAt } = await createStaging(exec, {
    userId: user.id,
    clientId: keyClientId(user) ?? user.clientId,
    ...(user.key ? { ttlMinutes: KEY_STAGE_TTL_MINUTES } : {}),
    kind: 'journal_entry',
    payload,
    preview,
  });
  return { stageId: id, expiresAt, preview };
}

// ---------------------------------------------------------------------------
// New account
// ---------------------------------------------------------------------------

export const newAccountInput = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  type: z.enum(ACCOUNT_TYPES),
  parent_code: z.string().min(1).optional(),
  subtype: z.enum(ACCOUNT_SUBTYPES).optional(),
  description: z.string().max(300).optional(),
});
export type NewAccountInput = z.infer<typeof newAccountInput>;

export const accountPayloadSchema = z.object({
  code: z.string(),
  name: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  parentCode: z.string().nullable(),
  subtype: z.string().nullable(),
  description: z.string().nullable(),
});
export type AccountPayload = z.infer<typeof accountPayloadSchema>;

export interface AccountPreview {
  code: string;
  name: string;
  type: string;
  parent: string | null;
  subtype: string | null;
  /** Free text from the caller. Untrusted. */
  description: string | null;
  warnings: string[];
}

export async function stageNewAccount(
  user: McpUser,
  input: NewAccountInput,
  ctx: StageCtx = {},
): Promise<Staged<AccountPreview>> {
  assertMayStage(user);
  requireCapability(user.role, 'settings.manage');
  const exec = ctx.tx ?? db;
  const code = input.code.trim();
  const name = input.name.trim();
  const warnings: string[] = [];

  if ((await getAccountByCodeIn(exec, code)) !== null) {
    throw new McpInputError(`Account code ${code} is already taken.`);
  }
  let parentLabel: string | null = null;
  if (input.parent_code !== undefined) {
    const parent = await getAccountByCodeIn(exec, input.parent_code.trim());
    if (parent === null) throw new McpInputError(`There is no parent account ${input.parent_code}.`);
    if (parent.type !== input.type) {
      throw new McpInputError(`${parent.code} ${parent.name} is ${parent.type}; a child account must be the same type.`);
    }
    parentLabel = `${parent.code} ${parent.name}`;
    const posted = await postedLineCount(exec, parent.id);
    if (posted > 0) {
      warnings.push(
        `${parentLabel} already has ${posted} posted line${posted === 1 ? '' : 's'}. Once it has a child it becomes a header that cannot be posted to, so new activity must go to its children.`,
      );
    }
  }

  const payload: AccountPayload = {
    code,
    name,
    type: input.type,
    parentCode: input.parent_code?.trim() ?? null,
    subtype: input.subtype ?? null,
    description: input.description ?? null,
  };
  const preview: AccountPreview = {
    code,
    name,
    type: input.type,
    parent: parentLabel,
    subtype: payload.subtype,
    description: payload.description,
    warnings,
  };
  const { id, expiresAt } = await createStaging(exec, {
    userId: user.id,
    clientId: keyClientId(user) ?? user.clientId,
    ...(user.key ? { ttlMinutes: KEY_STAGE_TTL_MINUTES } : {}),
    kind: 'new_account',
    payload,
    preview,
  });
  return { stageId: id, expiresAt, preview };
}

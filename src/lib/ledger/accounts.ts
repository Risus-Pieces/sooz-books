/**
 * The chart of accounts as it lives in the database.
 *
 * `./coa` holds the chart Sooz was set up with — the seed and the semantic
 * `ACCOUNTS` map application code posts against. This module is the runtime
 * view: what is actually in `accounts` today, including anything added since,
 * and the operations that change it.
 *
 * Accounts are never deleted. A journal line points at one forever, so the only
 * retirement is deactivation, and an account with history can only be retired
 * once a successor is named to carry its reporting forward.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { cache } from 'react';

import { db, withActor } from '@/db/client';
import { accounts, journalEntries, journalLines, type Account, type AccountType } from '@/db/schema';
import { today } from '@/lib/dates';
import { isUniqueViolation } from '@/lib/db-errors';

import {
  AccountInUseError,
  DuplicateAccountError,
  InvalidReferenceError,
  UnknownAccountError,
} from './errors';
import type { LedgerDb } from './post';

export interface AccountCtx {
  userId: string | null;
  tx?: LedgerDb;
}

export interface NewAccountInput {
  code: string;
  name: string;
  type: AccountType;
  subtype?: string | null;
  parentCode?: string | null;
  description?: string | null;
  isBank?: boolean;
  isControl?: boolean;
  clearingForChannelId?: string | null;
}

/**
 * The fields that may change on an existing account. `code` is not among them:
 * every module references accounts through the codes in `./coa`, and renumbering
 * one under a running ledger would silently redirect everything that posts to it.
 */
export interface AccountPatch {
  name?: string;
  type?: AccountType;
  subtype?: string | null;
  parentCode?: string | null;
  description?: string | null;
  isBank?: boolean;
  active?: boolean;
}

export interface AccountNode extends Account {
  children: AccountNode[];
  depth: number;
}

export async function listAccounts(
  options: { activeOnly?: boolean } = {},
  exec: LedgerDb = db,
): Promise<Account[]> {
  const { activeOnly = false } = options;
  if (activeOnly) {
    return exec.select().from(accounts).where(eq(accounts.active, true)).orderBy(asc(accounts.code));
  }
  return exec.select().from(accounts).orderBy(asc(accounts.code));
}

/**
 * Resolves one account code, memoised for the life of a request: a page that
 * renders twenty amounts against the same account asks Postgres once.
 */
export const getAccountByCode = cache(async (code: string): Promise<Account | null> => {
  const [account] = await db.select().from(accounts).where(eq(accounts.code, code));
  return account ?? null;
});

/** Same lookup, inside a caller's transaction, where request memoisation must not apply. */
export async function getAccountByCodeIn(exec: LedgerDb, code: string): Promise<Account | null> {
  const [account] = await exec.select().from(accounts).where(eq(accounts.code, code));
  return account ?? null;
}

async function requireAccountRow(exec: LedgerDb, accountId: string): Promise<Account> {
  const [account] = await exec.select().from(accounts).where(eq(accounts.id, accountId));
  if (account === undefined) throw new UnknownAccountError({ accountId }, 'missing');
  return account;
}

async function resolveParent(
  exec: LedgerDb,
  parentCode: string | null | undefined,
  type: AccountType,
): Promise<string | null> {
  if (parentCode === null || parentCode === undefined) return null;
  const parent = await getAccountByCodeIn(exec, parentCode);
  if (parent === null) throw new UnknownAccountError({ accountCode: parentCode }, 'missing');
  if (parent.type !== type) {
    throw new InvalidReferenceError(
      'parentCode',
      parentCode,
      `Account ${parentCode} is ${parent.type}; a child account must be the same type.`,
    );
  }
  return parent.id;
}

export async function createAccount(input: NewAccountInput, ctx: AccountCtx): Promise<Account> {
  const code = input.code.trim();
  const name = input.name.trim();
  if (code === '') throw new InvalidReferenceError('code', input.code, 'An account needs a code.');
  if (name === '') throw new InvalidReferenceError('name', input.name, 'An account needs a name.');

  const work = async (tx: LedgerDb): Promise<Account> => {
    if ((await getAccountByCodeIn(tx, code)) !== null) throw new DuplicateAccountError(code);
    const parentId = await resolveParent(tx, input.parentCode, input.type);

    const [created] = await tx
      .insert(accounts)
      .values({
        code,
        name,
        type: input.type,
        subtype: input.subtype ?? null,
        parentId,
        description: input.description ?? null,
        isBank: input.isBank ?? false,
        isControl: input.isControl ?? false,
        clearingForChannelId: input.clearingForChannelId ?? null,
        active: true,
      })
      .returning();
    return created;
  };

  try {
    return ctx.tx ? await work(ctx.tx) : await withActor(ctx.userId, work);
  } catch (error) {
    // The unique index is the real arbiter; the check above only makes the
    // common case a clean message instead of a constraint name. The violation
    // arrives wrapped in drizzle's query error, never at the top level.
    if (isUniqueViolation(error, 'accounts_code_key')) throw new DuplicateAccountError(code);
    throw error;
  }
}

/** Posted lines on an account — what makes a change to its shape unsafe. */
async function postedLineCount(exec: LedgerDb, accountId: string): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalLines.accountId, accountId), eq(journalEntries.status, 'posted')));
  return Number(row?.count ?? 0);
}

export async function updateAccount(
  accountId: string,
  patch: AccountPatch,
  ctx: AccountCtx,
): Promise<Account> {
  const work = async (tx: LedgerDb): Promise<Account> => {
    const existing = await requireAccountRow(tx, accountId);
    const type = patch.type ?? existing.type;

    if (patch.type !== undefined && patch.type !== existing.type) {
      // Changing a type re-signs every figure the account has ever carried and
      // moves it between statements; history has to be reversed out first.
      const posted = await postedLineCount(tx, accountId);
      if (posted > 0) {
        throw new AccountInUseError(
          accountId,
          existing.code,
          posted,
          `Account ${existing.code} already carries ${posted} posted ` +
            `${posted === 1 ? 'line' : 'lines'} as ${existing.type}; its type cannot change.`,
        );
      }
    }

    const values: Partial<typeof accounts.$inferInsert> = {};
    if (patch.name !== undefined) values.name = patch.name.trim();
    if (patch.type !== undefined) values.type = patch.type;
    if (patch.subtype !== undefined) values.subtype = patch.subtype;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.isBank !== undefined) values.isBank = patch.isBank;
    if (patch.active !== undefined) values.active = patch.active;
    if (patch.parentCode !== undefined) {
      values.parentId = await resolveParent(tx, patch.parentCode, type);
    }
    if (Object.keys(values).length === 0) return existing;

    const [updated] = await tx
      .update(accounts)
      .set(values)
      .where(eq(accounts.id, accountId))
      .returning();
    return updated;
  };

  return ctx.tx ? work(ctx.tx) : withActor(ctx.userId, work);
}

export interface DeactivateOptions extends AccountCtx {
  /** The account that takes over. Required once the account has posted history. */
  successorCode?: string | null;
}

/**
 * Retires an account. One with posted lines needs a successor: its balance stays
 * in the ledger forever, and whoever reads next year's report has to be told
 * where the activity went.
 *
 * @throws {AccountInUseError} the account has posted lines and no successor was named
 */
export async function deactivateAccount(
  accountId: string,
  options: DeactivateOptions,
): Promise<Account> {
  const work = async (tx: LedgerDb): Promise<Account> => {
    const existing = await requireAccountRow(tx, accountId);
    if (!existing.active) return existing;

    const posted = await postedLineCount(tx, accountId);
    const successorCode = options.successorCode ?? null;

    if (posted > 0 && successorCode === null) {
      throw new AccountInUseError(accountId, existing.code, posted);
    }

    let note: string | null = null;
    if (successorCode !== null) {
      const successor = await getAccountByCodeIn(tx, successorCode);
      if (successor === null) {
        throw new UnknownAccountError({ accountCode: successorCode }, 'missing');
      }
      if (successor.id === accountId) {
        throw new InvalidReferenceError(
          'successorCode',
          successorCode,
          'An account cannot succeed itself.',
        );
      }
      if (!successor.active) {
        throw new UnknownAccountError({ accountCode: successorCode }, 'inactive');
      }
      if (successor.type !== existing.type) {
        throw new InvalidReferenceError(
          'successorCode',
          successorCode,
          `Account ${successorCode} is ${successor.type}; the successor must be ${existing.type}.`,
        );
      }
      note = `Closed ${today()}; use ${successor.code} ${successor.name} instead.`;
    }

    const description =
      note === null
        ? existing.description
        : [existing.description, note].filter((part) => part !== null && part !== '').join(' ');

    const [updated] = await tx
      .update(accounts)
      .set({ active: false, description })
      .where(eq(accounts.id, accountId))
      .returning();
    return updated;
  };

  return options.tx ? work(options.tx) : withActor(options.userId, work);
}

/**
 * Nests accounts under their parents for display. Codes order the siblings, and
 * an account whose parent is not in the input becomes a root rather than
 * disappearing — a filtered list must still show everything it was given.
 */
export function buildAccountTree(rows: readonly Account[]): AccountNode[] {
  const nodes = new Map<string, AccountNode>();
  for (const row of rows) nodes.set(row.id, { ...row, children: [], depth: 0 });

  const roots: AccountNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  const byCode = (a: AccountNode, b: AccountNode): number => a.code.localeCompare(b.code);
  const setDepth = (node: AccountNode, depth: number): void => {
    node.depth = depth;
    node.children.sort(byCode);
    for (const child of node.children) setDepth(child, depth + 1);
  };

  roots.sort(byCode);
  for (const root of roots) setDepth(root, 0);
  return roots;
}

export async function accountTree(
  options: { activeOnly?: boolean } = {},
  exec: LedgerDb = db,
): Promise<AccountNode[]> {
  return buildAccountTree(await listAccounts(options, exec));
}

/** Depth-first walk of a tree, for rendering an indented list. */
export function flattenAccountTree(nodes: readonly AccountNode[]): AccountNode[] {
  const out: AccountNode[] = [];
  const visit = (node: AccountNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}

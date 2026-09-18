'use server';

/**
 * Every mutation the ledger interface can make.
 *
 * Each one does the same four things in the same order: check the capability,
 * hand the work to `@/lib/ledger`, turn a typed ledger failure into the
 * `{ ok: false, error }` the client renders as a toast, and revalidate the
 * routes whose figures just moved. Nothing in `src/components` or a page
 * component writes to the database.
 *
 * Drafts are the one thing written here directly rather than through
 * `postJournalEntry`. A draft has not happened yet — it is not balanced, it may
 * have one line or none, and the ledger's invariants deliberately do not apply
 * to it — so there is nothing for the posting engine to do with one. The moment
 * a draft becomes real it goes through `postJournalEntry` like everything else:
 * `postEntry` posts a fresh, fully validated entry and deletes the draft it
 * came from, both in the same transaction.
 */

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';

import { withActor, type Tx } from '@/db/client';
import { journalEntries, journalLines, type AccountType } from '@/db/schema';
import { isForbiddenError } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { isCalendarDate } from '@/lib/dates';
import { isQueryError, postgresErrorOf } from '@/lib/db-errors';
import {
  createAccount,
  deactivateAccount,
  updateAccount,
  type AccountPatch,
} from '@/lib/ledger/accounts';
import {
  EntryNotFoundError,
  ImmutableEntryError,
  InvalidAmountError,
  InvalidDateError,
  InvalidReferenceError,
  PeriodHasDraftsError,
  isLedgerError,
} from '@/lib/ledger/errors';
import { closePeriod, reopenPeriod } from '@/lib/ledger/periods';
import { postJournalEntry, translateLedgerDbError, type DraftLine } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';
import type {
  AccountEditForm,
  ActionFailure,
  ActionResult,
  EntryInput,
  EntryLineInput,
  EntryRef,
  NewAccountForm,
  ReversalRef,
} from '@/components/ledger/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCOUNT_TYPES: readonly AccountType[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
];

/**
 * A failure the interface can act on. A ledger error already carries its own
 * explanation and the detail a message needs; a database refusal the ledger
 * recognises — a trigger's, or a deferred check at COMMIT — becomes that ledger
 * error. Anything else is unexpected and is passed through rather than hidden,
 * because the people using these books are the people who can report what
 * broke — except the text of a failed query, which carries the SQL and every
 * bound value and is never shown.
 */
function failure(error: unknown): ActionFailure {
  const translated = translateLedgerDbError(error);
  if (translated instanceof PeriodHasDraftsError) {
    return {
      code: translated.code,
      message: translated.message,
      blocking: translated.drafts.map((draft) => ({
        id: draft.id,
        entryNo: draft.entryNo,
        date: draft.date,
        memo: draft.memo,
      })),
    };
  }
  if (isLedgerError(translated)) return { code: translated.code, message: translated.message };
  if (isForbiddenError(error)) return { code: 'forbidden', message: error.message };

  const pg = postgresErrorOf(error);
  if (pg !== null) {
    return { code: 'unexpected', message: `The database refused this change: ${pg.message}` };
  }
  if (isQueryError(error)) {
    return { code: 'unexpected', message: 'The database could not complete this request.' };
  }
  if (error instanceof Error) return { code: 'unexpected', message: error.message };
  return { code: 'unexpected', message: 'Something went wrong.' };
}

function ok<T>(value: T): ActionResult<T> {
  return { ok: true, value };
}

function fail<T>(error: unknown): ActionResult<T> {
  return { ok: false, error: failure(error) };
}

function refreshLedger(): void {
  revalidatePath('/ledger');
  revalidatePath('/ledger/audit');
  revalidatePath('/dashboard');
  revalidatePath('/close');
}

/** Shape checks that must hold before anything is written, draft or posted. */
function validateEntry(input: EntryInput): void {
  if (!isCalendarDate(input.date)) throw new InvalidDateError(String(input.date));
  if (input.draftId !== null && !UUID.test(input.draftId)) {
    throw new InvalidReferenceError('draftId', input.draftId, 'That draft reference is not valid.');
  }

  input.lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (!UUID.test(line.accountId)) {
      throw new InvalidReferenceError('accountId', line.accountId, `Line ${lineNo} has no account.`);
    }
    for (const [side, amount] of [
      ['debit', line.debitCents],
      ['credit', line.creditCents],
    ] as const) {
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new InvalidAmountError(lineNo, `${side} must be a whole number of cents`, line.debitCents, line.creditCents);
      }
    }
    if (line.debitCents > 0 && line.creditCents > 0) {
      throw new InvalidAmountError(
        lineNo,
        'carries both a debit and a credit; a line takes one side only',
        line.debitCents,
        line.creditCents,
      );
    }
    for (const [field, value] of [
      ['channelId', line.channelId],
      ['productId', line.productId],
    ] as const) {
      if (value !== null && !UUID.test(value)) {
        throw new InvalidReferenceError(field, value, `Line ${lineNo} has an invalid ${field}.`);
      }
    }
  });
}

function toDraftLines(lines: readonly EntryLineInput[]): DraftLine[] {
  return lines.map((line) => ({
    accountId: line.accountId,
    debitCents: line.debitCents,
    creditCents: line.creditCents,
    ...(line.memo === null ? {} : { memo: line.memo }),
    channelId: line.channelId,
    productId: line.productId,
  }));
}

/** Reads the draft being edited under a lock, so two tabs cannot interleave. */
async function lockDraft(tx: Tx, entryId: string): Promise<{ entryNo: number }> {
  const [existing] = await tx
    .select({ entryNo: journalEntries.entryNo, status: journalEntries.status })
    .from(journalEntries)
    .where(eq(journalEntries.id, entryId))
    .for('update');

  if (existing === undefined) throw new EntryNotFoundError(entryId);
  if (existing.status !== 'draft') {
    throw new ImmutableEntryError(
      `Entry #${existing.entryNo} has been posted and can no longer be edited. Reverse it instead.`,
    );
  }
  return { entryNo: existing.entryNo };
}

/**
 * Saves work in progress. Lines are rewritten wholesale rather than diffed:
 * `journal_lines` numbers its rows within an entry, and a partial update would
 * have to renumber them anyway.
 */
export async function saveDraftEntry(input: EntryInput): Promise<ActionResult<EntryRef>> {
  try {
    const user = await requireCapability('ledger.post');
    validateEntry(input);

    const memo = input.memo.trim();
    const saved = await withActor(user.id, async (tx): Promise<EntryRef> => {
      const existingId = input.draftId;
      let entry: EntryRef;

      if (existingId === null) {
        const [created] = await tx
          .insert(journalEntries)
          .values({
            entryDate: input.date,
            memo: memo === '' ? null : memo,
            status: 'draft',
            sourceType: 'manual',
            createdBy: user.id,
          })
          .returning({ id: journalEntries.id, entryNo: journalEntries.entryNo });
        entry = { entryId: created.id, entryNo: created.entryNo };
      } else {
        entry = { entryId: existingId, entryNo: (await lockDraft(tx, existingId)).entryNo };
        await tx
          .update(journalEntries)
          .set({ entryDate: input.date, memo: memo === '' ? null : memo })
          .where(eq(journalEntries.id, existingId));
        await tx.delete(journalLines).where(eq(journalLines.entryId, existingId));
      }

      if (input.lines.length > 0) {
        await tx.insert(journalLines).values(
          input.lines.map((line, index) => ({
            entryId: entry.entryId,
            lineNo: index + 1,
            accountId: line.accountId,
            debitCents: line.debitCents,
            creditCents: line.creditCents,
            memo: line.memo,
            channelId: line.channelId,
            productId: line.productId,
          })),
        );
      }

      return entry;
    });

    refreshLedger();
    revalidatePath(`/ledger/${saved.entryId}`);
    return ok(saved);
  } catch (error) {
    return fail(error);
  }
}

/**
 * Posts an entry into the ledger.
 *
 * A draft the entry grew out of is deleted in the same transaction, which is
 * why the posted entry carries a new number: a posted entry is immutable, so it
 * is written fresh by the posting engine with every check applied rather than
 * having a draft promoted underneath it.
 */
export async function postEntry(input: EntryInput): Promise<ActionResult<EntryRef>> {
  try {
    const user = await requireCapability('ledger.post');
    validateEntry(input);

    const memo = input.memo.trim();
    const posted = await withActor(user.id, async (tx): Promise<EntryRef> => {
      if (input.draftId !== null) await lockDraft(tx, input.draftId);

      const entry = await postJournalEntry(
        {
          date: input.date,
          ...(memo === '' ? {} : { memo }),
          sourceType: 'manual',
          lines: toDraftLines(input.lines),
        },
        { userId: user.id, tx },
      );

      if (input.draftId !== null) {
        await tx
          .delete(journalEntries)
          .where(and(eq(journalEntries.id, input.draftId), eq(journalEntries.status, 'draft')));
      }

      return { entryId: entry.entryId, entryNo: entry.entryNo };
    });

    refreshLedger();
    revalidatePath(`/ledger/${posted.entryId}`);
    return ok(posted);
  } catch (error) {
    return fail(error);
  }
}

/** Deletes a draft. A posted entry is refused by the database, and by this. */
export async function deleteDraftEntry(entryId: string): Promise<ActionResult<{ entryId: string }>> {
  try {
    const user = await requireCapability('ledger.post');
    if (!UUID.test(entryId)) throw new EntryNotFoundError(entryId);

    await withActor(user.id, async (tx) => {
      await lockDraft(tx, entryId);
      await tx
        .delete(journalEntries)
        .where(and(eq(journalEntries.id, entryId), eq(journalEntries.status, 'draft')));
    });

    refreshLedger();
    return ok({ entryId });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Reverses a posted entry. The reversal is dated on the original's date unless
 * that month is closed, in which case `reverseEntry` moves it to the first open
 * one and says so — `movedFrom` carries that back for the toast.
 */
export async function reverseJournalEntry(
  entryId: string,
  date: string | null,
  memo: string | null,
): Promise<ActionResult<ReversalRef>> {
  try {
    const user = await requireCapability('ledger.post');
    if (!UUID.test(entryId)) throw new EntryNotFoundError(entryId);
    if (date !== null && !isCalendarDate(date)) throw new InvalidDateError(date);

    const trimmedMemo = memo === null ? '' : memo.trim();
    const result = await reverseEntry(entryId, {
      ...(date === null ? {} : { date }),
      ...(trimmedMemo === '' ? {} : { memo: trimmedMemo }),
      userId: user.id,
    });

    refreshLedger();
    revalidatePath(`/ledger/${entryId}`);
    revalidatePath(`/ledger/${result.entryId}`);
    return ok({
      entryId: result.entryId,
      entryNo: result.entryNo,
      date: result.date,
      movedFrom: result.requestedDate,
      linked: result.linked,
    });
  } catch (error) {
    return fail(error);
  }
}

export async function createLedgerAccount(
  input: NewAccountForm,
): Promise<ActionResult<{ accountId: string; code: string }>> {
  try {
    const user = await requireCapability('settings.manage');
    if (!ACCOUNT_TYPES.includes(input.type)) {
      throw new InvalidReferenceError('type', input.type, `${input.type} is not an account type.`);
    }

    const account = await createAccount(
      {
        code: input.code,
        name: input.name,
        type: input.type,
        subtype: input.subtype,
        parentCode: input.parentCode,
        description: input.description,
        isBank: input.isBank,
      },
      { userId: user.id },
    );

    revalidatePath('/ledger/accounts');
    revalidatePath('/ledger/audit');
    return ok({ accountId: account.id, code: account.code });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Edits an account. A code never changes — every module addresses accounts by
 * the codes in `@/lib/ledger/coa`, so renumbering one under a running ledger
 * would silently redirect everything that posts to it — and `updateAccount`
 * refuses a type change once the account carries posted lines.
 */
export async function updateLedgerAccount(
  accountId: string,
  patch: AccountEditForm,
): Promise<ActionResult<{ accountId: string }>> {
  try {
    const user = await requireCapability('settings.manage');
    if (!UUID.test(accountId)) {
      throw new InvalidReferenceError('accountId', accountId, 'That account reference is not valid.');
    }
    if (!ACCOUNT_TYPES.includes(patch.type)) {
      throw new InvalidReferenceError('type', patch.type, `${patch.type} is not an account type.`);
    }

    const values: AccountPatch = {
      name: patch.name,
      type: patch.type,
      subtype: patch.subtype,
      parentCode: patch.parentCode,
      description: patch.description,
      isBank: patch.isBank,
    };
    await updateAccount(accountId, values, { userId: user.id });

    revalidatePath('/ledger/accounts');
    revalidatePath('/ledger/audit');
    return ok({ accountId });
  } catch (error) {
    return fail(error);
  }
}

/** Retires an account. One with posted history needs a successor named. */
export async function deactivateLedgerAccount(
  accountId: string,
  successorCode: string | null,
): Promise<ActionResult<{ accountId: string }>> {
  try {
    const user = await requireCapability('settings.manage');
    if (!UUID.test(accountId)) {
      throw new InvalidReferenceError('accountId', accountId, 'That account reference is not valid.');
    }

    const successor = successorCode === null || successorCode.trim() === '' ? null : successorCode.trim();
    await deactivateAccount(accountId, { userId: user.id, successorCode: successor });

    revalidatePath('/ledger/accounts');
    revalidatePath('/ledger/audit');
    return ok({ accountId });
  } catch (error) {
    return fail(error);
  }
}

/** Reactivates an account that was retired. */
export async function reactivateLedgerAccount(
  accountId: string,
): Promise<ActionResult<{ accountId: string }>> {
  try {
    const user = await requireCapability('settings.manage');
    if (!UUID.test(accountId)) {
      throw new InvalidReferenceError('accountId', accountId, 'That account reference is not valid.');
    }

    await updateAccount(accountId, { active: true }, { userId: user.id });

    revalidatePath('/ledger/accounts');
    revalidatePath('/ledger/audit');
    return ok({ accountId });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Closes a month. `closePeriod` refuses while a draft is dated inside it and
 * hands back the offending entries, which the close screen lists.
 */
export async function closeAccountingPeriod(
  year: number,
  month: number,
): Promise<ActionResult<{ year: number; month: number }>> {
  try {
    const user = await requireCapability('ledger.close');
    await closePeriod(year, month, user.id);

    revalidatePath('/close');
    revalidatePath('/ledger');
    revalidatePath('/dashboard');
    return ok({ year, month });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Reopens a closed month. Owner only, and the caller has to have typed the
 * period back — reopening lets figures already given to the bank or the
 * accountant move, so it is not something to do by reflex.
 */
export async function reopenAccountingPeriod(
  year: number,
  month: number,
  confirmation: string,
): Promise<ActionResult<{ year: number; month: number }>> {
  try {
    const user = await requireCapability('ledger.reopen');

    const expected = `${year}-${String(month).padStart(2, '0')}`;
    if (confirmation.trim() !== expected) {
      return fail(
        new InvalidReferenceError(
          'confirmation',
          confirmation,
          `Type ${expected} to confirm reopening that period.`,
        ),
      );
    }

    await reopenPeriod(year, month, user.id);

    revalidatePath('/close');
    revalidatePath('/ledger');
    revalidatePath('/dashboard');
    return ok({ year, month });
  } catch (error) {
    return fail(error);
  }
}

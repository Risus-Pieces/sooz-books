/**
 * Recurring journal entries: rent, depreciation, amortised prepaids, standing
 * accruals.
 *
 * A recurring entry is a template (account codes and amounts, balanced) with a
 * schedule. `generateDueRecurringEntries` walks every active template whose next
 * date has arrived and, for each date that is due, writes the entry and moves
 * `next_date` on:
 *
 *   - as a DRAFT, for a person to review and post from the ledger — the default,
 *     because nothing reaches the ledger without a human except by a decision
 *     made in advance;
 *   - POSTED through `postJournalEntry`, only when the template is `auto_post`.
 *
 * A draft is written the same way the ledger's own "save draft" writes one: an
 * entry row in status `draft` and its lines. A draft has not happened, carries
 * no balance and is invisible to every report; it becomes real only when it is
 * posted, which goes through `postJournalEntry` like everything else.
 *
 * Idempotent twice over. Each template is locked while it is advanced, so two
 * runs at once cannot both generate the same date; and an entry already raised
 * from the template for a date (draft or posted, and not reversed) is never
 * raised again, so a re-run after a crash, or after someone moved `next_date`
 * back by hand, does not double-book the rent.
 *
 * Schedules keep their anchor day: a monthly entry on the 31st lands on 30 April
 * and 28 February and goes back to the 31st in March.
 */

import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';

import {
  type RecurringEntry,
  type RecurringEntryLine,
  channels,
  journalEntries,
  journalLines,
  products,
  recurringEntries,
} from '@/db/schema';
import { type CalendarDate, addDays, dateParts, daysInMonth, isCalendarDate, today } from '@/lib/dates';
import { isLedgerError } from '@/lib/ledger/errors';
import { isPeriodOpen } from '@/lib/ledger/periods';
import { type DraftLine, type LedgerDb, postJournalEntry, translateLedgerDbError } from '@/lib/ledger/post';
import { addMonths } from '@/lib/reports/types';

import { PlanningError, type PlanningCtx, inTx, reader } from './context';

export type RecurringFrequency = 'weekly' | 'monthly' | 'quarterly' | 'annually';

export const RECURRING_FREQUENCIES: readonly RecurringFrequency[] = ['weekly', 'monthly', 'quarterly', 'annually'];

const MONTHS_PER_STEP: Readonly<Record<Exclude<RecurringFrequency, 'weekly'>, number>> = {
  monthly: 1,
  quarterly: 3,
  annually: 12,
};

function iso(year: number, month: number, day: number): CalendarDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The date in `date`'s month on the anchor day, clamped to the month's length. */
function onAnchorDay(date: CalendarDate, anchorDay: number): CalendarDate {
  const { year, month } = dateParts(date);
  return iso(year, month, Math.min(anchorDay, daysInMonth(year, month)));
}

/** The occurrence after `current`. Pure. */
export function nextOccurrence(
  current: CalendarDate,
  frequency: RecurringFrequency,
  anchorDay: number,
): CalendarDate {
  if (frequency === 'weekly') return addDays(current, 7);
  const { year, month } = dateParts(current);
  return onAnchorDay(addMonths(iso(year, month, 1), MONTHS_PER_STEP[frequency]), anchorDay);
}

/** The first occurrence on or after `startDate`. Pure. */
export function firstOccurrence(
  startDate: CalendarDate,
  frequency: RecurringFrequency,
  anchorDay: number,
): CalendarDate {
  if (frequency === 'weekly') return startDate;
  const inMonth = onAnchorDay(startDate, anchorDay);
  if (inMonth >= startDate) return inMonth;
  const { year, month } = dateParts(startDate);
  return onAnchorDay(addMonths(iso(year, month, 1), 1), anchorDay);
}

function anchorDayOf(entry: Pick<RecurringEntry, 'dayOfMonth' | 'startDate'>): number {
  return entry.dayOfMonth ?? dateParts(entry.startDate).day;
}

/* ------------------------------------------------------------------ template */

export interface NewRecurringEntryInput {
  name: string;
  frequency: RecurringFrequency;
  /** Day of month for monthly, quarterly and annual schedules. Defaults to the start date's day. */
  dayOfMonth?: number | null;
  startDate: CalendarDate;
  endDate?: CalendarDate | null;
  memo?: string | null;
  template: readonly RecurringEntryLine[];
  /** Posts without review. Set deliberately; the default is a draft for a person to post. */
  autoPost?: boolean;
}

interface ResolvedTemplateLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
  channelId: string | null;
  productId: string | null;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  code: string;
  type: string;
  active: boolean;
  is_control: boolean;
  is_rollup: boolean;
}

/**
 * Checks a template against the chart and resolves its codes. Refuses an
 * unbalanced template, a line with both or neither side, a rollup, an inactive
 * account, and a control account (AR and AP move only through their
 * sub-ledgers).
 */
async function resolveTemplate(exec: LedgerDb, template: readonly RecurringEntryLine[]): Promise<ResolvedTemplateLine[]> {
  if (template.length < 2) throw new PlanningError('invalid_input', 'A recurring entry needs at least two lines.');
  let debits = 0;
  let credits = 0;
  template.forEach((line, i) => {
    const d = line.debitCents;
    const c = line.creditCents;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0) {
      throw new PlanningError('invalid_input', `Line ${i + 1}: amounts must be whole, non-negative cents.`);
    }
    if ((d > 0) === (c > 0)) {
      throw new PlanningError('invalid_input', `Line ${i + 1}: a line takes a debit or a credit, not both or neither.`);
    }
    debits += d;
    credits += c;
  });
  if (debits !== credits) {
    throw new PlanningError('invalid_input', `The template does not balance: debits ${debits} ≠ credits ${credits}.`);
  }

  const codes = [...new Set(template.map((l) => l.accountCode.trim()))];
  const rows = await exec.execute<AccountRow>(sql`
    select a.id, a.code, a.type::text as type, a.active, a.is_control,
           exists (select 1 from accounts c where c.parent_id = a.id) as is_rollup
      from accounts a
     where a.code in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})
  `);
  const byCode = new Map([...rows].map((r) => [r.code, r]));

  const channelCodes = [...new Set(template.flatMap((l) => (l.channelCode ? [l.channelCode.trim().toUpperCase()] : [])))];
  const channelRows =
    channelCodes.length === 0
      ? []
      : await exec.select({ id: channels.id, code: channels.code }).from(channels).where(inArray(channels.code, channelCodes));
  const channelByCode = new Map(channelRows.map((r) => [r.code.toUpperCase(), r.id]));

  const skus = [...new Set(template.flatMap((l) => (l.productSku ? [l.productSku.trim()] : [])))];
  const productRows =
    skus.length === 0 ? [] : await exec.select({ id: products.id, sku: products.sku }).from(products).where(inArray(products.sku, skus));
  const productBySku = new Map(productRows.map((r) => [r.sku, r.id]));

  return template.map((line, i) => {
    const account = byCode.get(line.accountCode.trim());
    const where = `Line ${i + 1}`;
    if (account === undefined) throw new PlanningError('invalid_input', `${where}: account ${line.accountCode} is not in the chart.`);
    if (account.is_rollup) throw new PlanningError('invalid_input', `${where}: ${account.code} is a heading; use an account under it.`);
    if (!account.active) throw new PlanningError('invalid_input', `${where}: ${account.code} is inactive.`);
    if (account.is_control) {
      throw new PlanningError('invalid_input', `${where}: ${account.code} is a control account and moves only through invoices and bills.`);
    }
    let channelId: string | null = null;
    if (line.channelCode) {
      const found = channelByCode.get(line.channelCode.trim().toUpperCase());
      if (found === undefined) throw new PlanningError('invalid_input', `${where}: channel ${line.channelCode} does not exist.`);
      channelId = found;
    }
    let productId: string | null = null;
    if (line.productSku) {
      const found = productBySku.get(line.productSku.trim());
      if (found === undefined) throw new PlanningError('invalid_input', `${where}: product ${line.productSku} does not exist.`);
      productId = found;
    }
    return {
      accountId: account.id,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      memo: line.memo?.trim() || null,
      channelId,
      productId,
    };
  });
}

export async function createRecurringEntry(input: NewRecurringEntryInput, ctx: PlanningCtx): Promise<RecurringEntry> {
  const name = input.name.trim();
  if (name === '') throw new PlanningError('invalid_input', 'A recurring entry needs a name.');
  if (!RECURRING_FREQUENCIES.includes(input.frequency)) {
    throw new PlanningError('invalid_input', `"${String(input.frequency)}" is not a schedule.`);
  }
  if (!isCalendarDate(input.startDate)) throw new PlanningError('invalid_input', 'The start date must be YYYY-MM-DD.');
  const endDate = input.endDate ?? null;
  if (endDate !== null && (!isCalendarDate(endDate) || endDate < input.startDate)) {
    throw new PlanningError('invalid_input', 'The end date must be on or after the start date.');
  }
  const dayOfMonth = input.dayOfMonth ?? null;
  if (dayOfMonth !== null && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) {
    throw new PlanningError('invalid_input', 'The day of month must be between 1 and 31.');
  }

  return inTx(ctx, async (tx) => {
    await resolveTemplate(tx, input.template);
    const anchor = dayOfMonth ?? dateParts(input.startDate).day;
    const [created] = await tx
      .insert(recurringEntries)
      .values({
        name,
        frequency: input.frequency,
        dayOfMonth,
        startDate: input.startDate,
        endDate,
        nextDate: firstOccurrence(input.startDate, input.frequency, anchor),
        memo: input.memo?.trim() || null,
        template: input.template.map((l) => ({ ...l, accountCode: l.accountCode.trim() })),
        autoPost: input.autoPost === true,
        createdBy: ctx.userId,
      })
      .returning();
    return created;
  });
}

/** Stops a template generating. Entries already raised are left as they are. */
export async function deactivateRecurringEntry(id: string, ctx: PlanningCtx): Promise<RecurringEntry> {
  return inTx(ctx, async (tx) => {
    const [updated] = await tx
      .update(recurringEntries)
      .set({ active: false })
      .where(eq(recurringEntries.id, id))
      .returning();
    if (updated === undefined) throw new PlanningError('not_found', 'That recurring entry does not exist.');
    return updated;
  });
}

export async function listRecurringEntries(exec?: LedgerDb): Promise<RecurringEntry[]> {
  return reader(exec).select().from(recurringEntries).orderBy(asc(recurringEntries.nextDate), asc(recurringEntries.name));
}

/* ---------------------------------------------------------------- generation */

export interface GeneratedOccurrence {
  date: CalendarDate;
  entryId: string;
  entryNo: number;
  status: 'draft' | 'posted';
}

export interface RecurringRunResult {
  recurringId: string;
  name: string;
  generated: GeneratedOccurrence[];
  /** Dates skipped because an entry for them already exists. */
  alreadyRaised: CalendarDate[];
  /** Why generation stopped early, when it did; `next_date` stays on the date that failed. */
  error: string | null;
  nextDate: CalendarDate;
  active: boolean;
}

/** An entry already raised from the template for the date, and not reversed. */
async function existingOccurrence(tx: LedgerDb, recurringId: string, date: CalendarDate): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    select e.id from journal_entries e
     where e.source_type = 'recurring' and e.source_id = ${recurringId} and e.entry_date = ${date}
       and e.reversed_by_id is null
       and not exists (select 1 from journal_entries r where r.reverses_id = e.id)
     limit 1
  `);
  return rows.length > 0;
}

async function writeDraft(
  tx: LedgerDb,
  entry: RecurringEntry,
  date: CalendarDate,
  lines: readonly ResolvedTemplateLine[],
  userId: string | null,
): Promise<{ entryId: string; entryNo: number }> {
  const [created] = await tx
    .insert(journalEntries)
    .values({
      entryDate: date,
      memo: entry.memo ?? entry.name,
      status: 'draft',
      sourceType: 'recurring',
      sourceId: entry.id,
      createdBy: userId,
    })
    .returning({ id: journalEntries.id, entryNo: journalEntries.entryNo });
  await tx.insert(journalLines).values(
    lines.map((line, index) => ({
      entryId: created.id,
      lineNo: index + 1,
      accountId: line.accountId,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      memo: line.memo,
      channelId: line.channelId,
      productId: line.productId,
    })),
  );
  return { entryId: created.id, entryNo: created.entryNo };
}

async function generateOne(
  tx: LedgerDb,
  recurringId: string,
  asOf: CalendarDate,
  userId: string | null,
): Promise<RecurringRunResult> {
  const [entry] = await tx.select().from(recurringEntries).where(eq(recurringEntries.id, recurringId)).for('update');
  const result: RecurringRunResult = {
    recurringId,
    name: entry.name,
    generated: [],
    alreadyRaised: [],
    error: null,
    nextDate: entry.nextDate,
    active: entry.active,
  };
  if (!entry.active) return result;

  const lines = await resolveTemplate(tx, entry.template);
  const anchor = anchorDayOf(entry);
  let next = entry.nextDate;
  let lastPosted = entry.lastPostedDate;

  while (next <= asOf && (entry.endDate === null || next <= entry.endDate)) {
    if (!(await isPeriodOpen(next, tx))) {
      result.error = `${next} falls in a closed period, so it was not raised. Reopen the period or move the schedule on.`;
      break;
    }
    if (await existingOccurrence(tx, entry.id, next)) {
      result.alreadyRaised.push(next);
    } else if (entry.autoPost) {
      const draftLines: DraftLine[] = lines.map((line) => ({
        accountId: line.accountId,
        debitCents: line.debitCents,
        creditCents: line.creditCents,
        ...(line.memo === null ? {} : { memo: line.memo }),
        channelId: line.channelId,
        productId: line.productId,
      }));
      const posted = await postJournalEntry(
        { date: next, memo: entry.memo ?? entry.name, sourceType: 'recurring', sourceId: entry.id, lines: draftLines },
        { userId, tx },
      );
      result.generated.push({ date: next, entryId: posted.entryId, entryNo: posted.entryNo, status: 'posted' });
      lastPosted = next;
    } else {
      const draft = await writeDraft(tx, entry, next, lines, userId);
      result.generated.push({ date: next, ...draft, status: 'draft' });
    }
    next = nextOccurrence(next, entry.frequency, anchor);
  }

  const finished = entry.endDate !== null && next > entry.endDate;
  await tx
    .update(recurringEntries)
    .set({ nextDate: next, lastPostedDate: lastPosted, active: !finished })
    .where(eq(recurringEntries.id, entry.id));
  result.nextDate = next;
  result.active = !finished;
  return result;
}

/**
 * Raises every recurring entry due on or before `asOf` (default: today on the
 * books' calendar). Each template runs in its own transaction — a savepoint
 * inside the caller's, when one is given — so one template refused (a closed
 * period, an account since deactivated) does not stop the rest.
 */
export async function generateDueRecurringEntries(
  ctx: PlanningCtx,
  options: { asOf?: CalendarDate; recurringIds?: readonly string[] } = {},
): Promise<RecurringRunResult[]> {
  const asOf = options.asOf ?? today();
  if (!isCalendarDate(asOf)) throw new PlanningError('invalid_input', `${String(asOf)} is not a YYYY-MM-DD date.`);

  const due = await reader(ctx.tx)
    .select({ id: recurringEntries.id, name: recurringEntries.name, nextDate: recurringEntries.nextDate })
    .from(recurringEntries)
    .where(
      and(
        eq(recurringEntries.active, true),
        lte(recurringEntries.nextDate, asOf),
        options.recurringIds === undefined ? undefined : inArray(recurringEntries.id, [...options.recurringIds]),
      ),
    )
    .orderBy(asc(recurringEntries.nextDate), asc(recurringEntries.name));

  const results: RecurringRunResult[] = [];
  for (const row of due) {
    try {
      const run = (tx: LedgerDb) => generateOne(tx, row.id, asOf, ctx.userId);
      results.push(ctx.tx !== undefined ? await ctx.tx.transaction(run) : await inTx(ctx, run));
    } catch (error) {
      const translated = translateLedgerDbError(error);
      results.push({
        recurringId: row.id,
        name: row.name,
        generated: [],
        alreadyRaised: [],
        error:
          translated instanceof PlanningError || isLedgerError(translated)
            ? translated.message
            : 'The entry could not be raised.',
        nextDate: row.nextDate,
        active: true,
      });
    }
  }
  return results;
}

/** Templates with a date due on or before `through` that have not been raised. */
export async function overdueRecurringEntries(
  through: CalendarDate,
  exec?: LedgerDb,
): Promise<Array<{ id: string; name: string; nextDate: CalendarDate }>> {
  return reader(exec)
    .select({ id: recurringEntries.id, name: recurringEntries.name, nextDate: recurringEntries.nextDate })
    .from(recurringEntries)
    .where(
      and(
        eq(recurringEntries.active, true),
        lte(recurringEntries.nextDate, through),
        sql`(${recurringEntries.endDate} is null or ${recurringEntries.nextDate} <= ${recurringEntries.endDate})`,
      ),
    )
    .orderBy(asc(recurringEntries.nextDate));
}

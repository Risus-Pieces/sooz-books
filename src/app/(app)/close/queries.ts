/**
 * The reads behind the close screen. Nothing here writes: the automatic checks
 * are run read-only against the books as they stand, each in its own savepoint,
 * so the screen shows what a close would find right now without recording it.
 * Recording a run is `runCloseChecks`, behind the Re-run checks button.
 */

import { sql } from 'drizzle-orm';

import type {
  CloseMonthOption,
  CloseTaskRow,
  CloseTaskState,
  ClosedPeriodRow,
} from '@/components/planning/types';
import { db } from '@/db/client';
import { STANDARD_TASKS, getCloseChecklist, type ChecklistView } from '@/lib/close/checklist';
import { type AutoCheck, isAutoCheck, runCheck } from '@/lib/close/checks';
import { BOOKS_TIME_ZONE, periodOf, today } from '@/lib/dates';
import { listPeriods, periodEnd, periodStart } from '@/lib/ledger/periods';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthName(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

const STAMP = new Intl.DateTimeFormat('en-US', {
  timeZone: BOOKS_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function stamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : STAMP.format(date);
}

/**
 * Every month from the first day the books have anything in them — the first
 * bank line, the first opening balance, the first entry — through this month.
 */
export async function closeMonths(): Promise<CloseMonthOption[]> {
  const now = periodOf(today());
  const [bounds] = await db.execute<{ first: string | null }>(sql`
    select least(
             (select min(txn_date) from bank_transactions),
             (select min(opening_date) from bank_accounts where opening_balance_cents <> 0),
             (select min(entry_date) from journal_entries),
             (select min(make_date(year, month, 1)) from periods)
           )::text as first
  `);
  const first = bounds?.first ? periodOf(bounds.first) : now;
  const periods = await listPeriods({ from: first, to: now });
  return periods.map((p) => ({
    key: monthKey(p.year, p.month),
    year: p.year,
    month: p.month,
    label: monthName(p.year, p.month),
    status: p.status,
    current: p.year === now.year && p.month === now.month,
  }));
}

/** Where to go to fix what a task finds. */
function fixFor(key: string, year: number, month: number): CloseTaskRow['fix'] {
  const start = periodStart(year, month);
  const end = periodEnd(year, month);
  switch (key) {
    case 'bank_transactions_reviewed':
      return { href: '/banking/review', label: 'Open the review queue' };
    case 'no_draft_entries':
      return { href: `/ledger?from=${start}&to=${end}&status=draft`, label: 'Show the drafts' };
    case 'bank_recs_complete':
      return { href: '/banking/reconcile', label: 'Reconcile' };
    case 'clearing_zero':
      return { href: '/channels/payouts', label: 'Match payouts' };
    case 'ar_ties':
      return { href: `/sales/aging`, label: 'Receivables aging' };
    case 'ap_ties':
      return { href: `/purchases/aging`, label: 'Payables aging' };
    case 'cogs_posted':
      return { href: '/inventory/cogs', label: 'COGS batches' };
    case 'inventory_tieout':
      return { href: '/inventory/valuation', label: 'Inventory valuation' };
    case 'trial_balance_balances':
      return { href: `/reports/trial-balance?from=${start}&to=${end}`, label: 'Trial balance' };
    case 'accruals_booked':
      return { href: '/ledger/new', label: 'New journal entry' };
    case 'review_statements':
      return { href: `/reports/profit-loss?from=${start}&to=${end}`, label: 'Profit & loss' };
    case 'recurring_raised':
      return { href: `/ledger?from=${start}&to=${end}`, label: 'Entries in the month' };
    default:
      return null;
  }
}

async function liveResults(
  checks: readonly AutoCheck[],
  year: number,
  month: number,
): Promise<Map<AutoCheck, { ok: boolean; message: string }>> {
  const ctx = { year, month, start: periodStart(year, month), end: periodEnd(year, month), exec: db, options: {} };
  const out = new Map<AutoCheck, { ok: boolean; message: string }>();
  // One at a time: each check holds a pooled connection for its savepoint, and
  // the pool this app shares is small.
  for (const check of checks) {
    const result = await runCheck(check, ctx);
    out.set(check, { ok: result.ok, message: result.message });
  }
  return out;
}

export interface CloseScreen {
  year: number;
  month: number;
  checklistId: string | null;
  checklistStatus: 'open' | 'in_progress' | 'complete' | null;
  periodStatus: 'open' | 'closed';
  tasks: CloseTaskRow[];
}

export async function closeScreen(year: number, month: number): Promise<CloseScreen> {
  const view: ChecklistView | null = await getCloseChecklist(year, month);
  const [period] = await listPeriods({ from: { year, month }, to: { year, month } });
  const periodStatus = period?.status ?? 'open';

  const autoChecks = STANDARD_TASKS.map((t) => t.autoCheck).filter((c): c is AutoCheck => c !== null);
  const live = periodStatus === 'open' ? await liveResults(autoChecks, year, month) : new Map();

  const byKey = new Map((view?.tasks ?? []).map((t) => [t.key, t]));
  const keys = [...STANDARD_TASKS.map((t) => t.key), ...(view?.tasks ?? []).map((t) => t.key)];
  const seen = new Set<string>();
  const tasks: CloseTaskRow[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const standard = STANDARD_TASKS.find((t) => t.key === key);
    const stored = byKey.get(key);
    const autoCheck = stored?.autoCheck ?? standard?.autoCheck ?? null;
    const state: CloseTaskState = stored === undefined ? 'not_started' : stored.status;
    const liveResult = autoCheck !== null && isAutoCheck(autoCheck) ? (live.get(autoCheck) ?? null) : null;
    tasks.push({
      key,
      id: stored?.id ?? null,
      label: stored?.label ?? standard?.label ?? key,
      description: stored?.description ?? standard?.description ?? '',
      blocking: stored?.blocking ?? standard?.blocking ?? true,
      automatic: autoCheck !== null,
      state,
      notes: stored?.notes ?? null,
      completedLabel: stamp(stored?.completedAt ?? null),
      live: liveResult,
      recorded:
        stored?.result === null || stored?.result === undefined
          ? null
          : {
              ok: stored.result.ok,
              message: stored.result.message,
              checkedAtLabel: stamp(stored.result.checkedAt) ?? '',
            },
      fix: fixFor(key, year, month),
    });
  }

  return {
    year,
    month,
    checklistId: view?.checklist.id ?? null,
    checklistStatus: view?.checklist.status ?? null,
    periodStatus,
    tasks,
  };
}

interface ClosedRow extends Record<string, unknown> {
  year: number;
  month: number;
  closed_at: string | Date | null;
  full_name: string | null;
  email: string | null;
  checklist_status: string | null;
  skipped: string | number | null;
}

/** Every closed month, newest first, with who closed it and how. */
export async function closedPeriods(): Promise<ClosedPeriodRow[]> {
  const rows = await db.execute<ClosedRow>(sql`
    select p.year, p.month, p.closed_at, u.full_name, u.email,
           c.status as checklist_status,
           (select count(*) from close_tasks t where t.checklist_id = c.id and t.status = 'skipped') as skipped
      from periods p
      left join app_users u on u.id = p.closed_by
      left join close_checklists c on c.year = p.year and c.month = p.month
     where p.status = 'closed'
     order by p.year desc, p.month desc
  `);
  return [...rows].map((r) => ({
    key: monthKey(Number(r.year), Number(r.month)),
    year: Number(r.year),
    month: Number(r.month),
    label: monthName(Number(r.year), Number(r.month)),
    closedAtLabel: stamp(r.closed_at),
    closedByLabel: r.full_name?.trim() || r.email || null,
    viaChecklist: r.checklist_status === 'complete',
    skippedCount: Number(r.skipped ?? 0),
  }));
}

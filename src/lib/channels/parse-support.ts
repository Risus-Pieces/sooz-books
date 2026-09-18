/**
 * Small pieces every settlement parser needs: header normalization, strict money and
 * date reading, the per-line fingerprint, and the assertion record.
 */

import { createHash } from 'node:crypto';

import { type CalendarDate, isCalendarDate, parseDateInput } from '@/lib/dates';
import type { Assertion } from '@/lib/importers/types';
import { formatMoney, parseMoney } from '@/lib/money';

/** Lowercase, alphanumerics only: `Total Commission Charged` and `total_commission_charged` agree. */
export function headerKey(header: string): string {
  return header
    .normalize('NFKC')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Reads a money cell to integer cents, or returns an error message. Blank is an error
 * unless `blankIsZero` — settlement columns are never optional by being empty.
 */
export function readCents(
  cell: string | undefined,
  options: { blankIsZero?: boolean } = {},
): { ok: true; cents: number } | { ok: false; reason: string } {
  const text = (cell ?? '').trim();
  if (text === '' || text === '-') {
    return options.blankIsZero === true ? { ok: true, cents: 0 } : { ok: false, reason: 'the amount is blank' };
  }
  try {
    return { ok: true, cents: parseMoney(text) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The calendar date of a provider timestamp, read from its own digits: `2026-09-11 13:47:03 -0400`
 * is 11 September wherever this code runs. Never converted through a `Date`.
 */
export function readCalendarDate(cell: string | undefined): CalendarDate | null {
  const text = (cell ?? '').trim();
  if (text === '') return null;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(text);
  if (iso !== null) return isCalendarDate(iso[1]) ? iso[1] : null;
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s.*)?$/.exec(text);
  if (dotted !== null) {
    const candidate = `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
    return isCalendarDate(candidate) ? candidate : null;
  }
  try {
    return parseDateInput(text.split(/\s+/)[0] ?? text);
  } catch {
    return null;
  }
}

export function sha256(parts: readonly (string | number | null)[]): string {
  return createHash('sha256')
    .update(parts.map((part) => (part === null ? '' : String(part))).join('␟'))
    .digest('hex');
}

/** An exact-to-the-cent identity. `detail` is written for a bookkeeper. */
export function assertion(
  id: string,
  label: string,
  expectedCents: number,
  actualCents: number,
  severity: 'fatal' | 'warn' = 'fatal',
  detail?: string,
): Assertion {
  const differenceCents = actualCents - expectedCents;
  const passed = differenceCents === 0;
  return {
    id,
    label,
    severity,
    passed,
    expectedCents,
    actualCents,
    differenceCents,
    detail:
      detail ??
      (passed
        ? `${label}: ${formatMoney(actualCents)} ties exactly.`
        : `${label}: expected ${formatMoney(expectedCents)}, the rows add to ${formatMoney(actualCents)} (off by ${formatMoney(differenceCents)}).`),
  };
}

/** Rows keyed by normalized header, with the header row located by required tokens. */
export interface KeyedRow {
  readonly rowIndex: number;
  readonly cells: readonly string[];
  get(key: string): string;
  has(key: string): boolean;
}

export function keyedRows(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  resolve: (headerKey: string) => string | null,
): { rows: KeyedRow[]; columns: Map<string, number>; unmapped: string[] } {
  const columns = new Map<string, number>();
  const unmapped: string[] = [];
  header.forEach((name, index) => {
    const canonical = resolve(headerKey(name));
    if (canonical === null) {
      if (name.trim() !== '') unmapped.push(name);
      return;
    }
    if (!columns.has(canonical)) columns.set(canonical, index);
  });
  return {
    columns,
    unmapped,
    rows: rows.map((cells, rowIndex) => ({
      rowIndex,
      cells,
      get: (key: string) => {
        const index = columns.get(key);
        return index === undefined ? '' : (cells[index] ?? '').trim();
      },
      has: (key: string) => columns.has(key),
    })),
  };
}

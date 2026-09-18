import { today } from '@/lib/dates';
import { parseMoney } from '@/lib/money';

/** The first year Sooz has books for; the year picker starts here. */
export const FIRST_1099_YEAR = 2025;

/**
 * Year and threshold from the query string. The year defaults to last year
 * until the 1099 filing deadline has passed (January 31), then to this year;
 * the threshold is null — the statutory default — unless one was typed.
 */
export function read1099Params(params: Record<string, string | string[] | undefined>): {
  year: number;
  thresholdCents: number | null;
  thresholdText: string;
} {
  const now = today();
  const currentYear = Number(now.slice(0, 4));
  const defaultYear = now.slice(5) <= '01-31' ? currentYear - 1 : currentYear;
  const rawYear = typeof params.year === 'string' ? Number(params.year) : NaN;
  const year =
    Number.isInteger(rawYear) && rawYear >= FIRST_1099_YEAR && rawYear <= currentYear ? rawYear : defaultYear;

  const thresholdText = typeof params.threshold === 'string' ? params.threshold.trim() : '';
  let thresholdCents: number | null = null;
  if (thresholdText !== '') {
    try {
      const cents = parseMoney(thresholdText);
      thresholdCents = cents >= 0 ? cents : null;
    } catch {
      thresholdCents = null;
    }
  }
  return { year, thresholdCents, thresholdText: thresholdCents === null ? '' : thresholdText };
}

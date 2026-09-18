/**
 * Deduction reason codes: the distributor's vocabulary, mapped once to how each
 * code is booked (docs/formats/distributor-deductions.md §7.4 and §9).
 *
 * Codes are namespaced by the source that issued them — `KEHE:C` (case cuts)
 * and `X12:01` (pricing error) and `UNFI:01` (shortage) are different things —
 * and seeded by supabase/migrations/0036_seed_deduction_reason_codes.sql.
 *
 * Resolution never guesses. A code resolves by exact match within its source,
 * then by the documented UNFI code patterns (`UOI0826`, `MCB20260801A`,
 * `LCBOL(4471882)`, `01CNDM`…), then by the X12 element-426 list, then by the
 * line's own type (a repayment is a recovery, a terms discount is an
 * early-payment discount). Anything left is unmapped: it posts to suspense and
 * is surfaced for a human.
 */

import { eq } from 'drizzle-orm';

import { type DeductionTreatment, accounts, deductionReasonCodes } from '@/db/schema';
import type { RemittanceLineType, RemittanceSource } from '@/lib/importers/remittance';

import type { LedgerDb } from './common';

export interface ReasonCodeInfo {
  /** Namespaced key: `KEHE:H`. */
  code: string;
  sourceSystem: string;
  sourceCode: string | null;
  label: string;
  category: string;
  treatment: DeductionTreatment;
  accountId: string | null;
  accountCode: string | null;
  /** Days from the deduction date the distributor allows a dispute; 0 when not applicable. */
  windowDays: number;
  isTradeSpend: boolean;
}

export type ReasonCodeBook = ReadonlyMap<string, ReasonCodeInfo>;

export async function loadReasonCodes(tx: LedgerDb): Promise<ReasonCodeBook> {
  const rows = await tx
    .select({
      code: deductionReasonCodes.code,
      sourceSystem: deductionReasonCodes.sourceSystem,
      sourceCode: deductionReasonCodes.sourceCode,
      label: deductionReasonCodes.label,
      category: deductionReasonCodes.category,
      treatment: deductionReasonCodes.defaultTreatment,
      accountId: deductionReasonCodes.defaultAccountId,
      accountCode: accounts.code,
      windowDays: deductionReasonCodes.disputeWindowDays,
      isTradeSpend: deductionReasonCodes.isTradeSpend,
    })
    .from(deductionReasonCodes)
    .leftJoin(accounts, eq(accounts.id, deductionReasonCodes.defaultAccountId))
    .where(eq(deductionReasonCodes.active, true));
  return new Map(rows.map((row) => [row.code, row]));
}

export type ResolvedVia = 'exact' | 'pattern' | 'x12' | 'line_type';

export interface ResolvedReason {
  info: ReasonCodeInfo;
  via: ResolvedVia;
}

/** UNFI string codes carry a date, PO or DC inside them (§9.3). Order matters: LCBOL and LCPV before LCP. */
const UNFI_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^MCB\d{6,8}[ACE]?$/, 'MCB'],
  [/^UOI\d{4}$/, 'UOI'],
  [/^\d{2}CNDM/, 'CNDM'],
  [/^CNDM/, 'CNDM'],
  [/^LCBOL/, 'LCBOL'],
  [/^LCPV/, 'LCPV'],
  [/^LCP/, 'LCP'],
  [/^AVL/, 'AVL'],
  [/^W&M/, 'W&M FINE'],
  [/^ASN/, 'ASN COMPLIANCE'],
  [/^ROUTING/, 'ROUTING FINE'],
  [/^LABEL/, 'LABEL FINE'],
];

function key(source: string, code: string): string {
  return `${source}:${code}`;
}

/**
 * The reason code a remittance line maps to, or null when nothing in the book
 * fits. `verbatim` is the code as printed (upper-cased); `lineType` is the
 * line's §2.4 type.
 */
export function resolveReasonCode(
  book: ReasonCodeBook,
  source: RemittanceSource,
  verbatim: string | null,
  lineType: RemittanceLineType,
): ResolvedReason | null {
  if (verbatim !== null) {
    const code = verbatim.trim().toUpperCase();
    const exact = book.get(key(source, code));
    if (exact) return { info: exact, via: 'exact' };

    if (source === 'UNFI') {
      for (const [pattern, target] of UNFI_PATTERNS) {
        if (pattern.test(code)) {
          const info = book.get(key('UNFI', target));
          if (info) return { info, via: 'pattern' };
        }
      }
      // Numeric families (§9.3): 10–12 promotional, 30 and above compliance.
      if (/^\d{2}$/.test(code) && Number(code) >= 30) {
        const info = book.get(key('UNFI', '30'));
        if (info) return { info, via: 'pattern' };
      }
    }

    const x12 = book.get(key('X12', code));
    if (x12 && /^[0-9A-Z]{2}$/.test(code)) return { info: x12, via: 'x12' };
  }

  const fallback =
    lineType === 'REPAYMENT' || lineType === 'CREDIT'
      ? book.get(key('GEN', 'RECOVERY'))
      : lineType === 'DISCOUNT'
        ? book.get(key('GEN', 'EPD'))
        : undefined;
  return fallback ? { info: fallback, via: 'line_type' } : null;
}

/** Looks a namespaced code up; accepts `KEHE:H` or a bare GEN code such as `SHORTAGE`. */
export function reasonCodeByKey(book: ReasonCodeBook, code: string): ReasonCodeInfo | null {
  const trimmed = code.trim().toUpperCase();
  return book.get(trimmed) ?? book.get(key('GEN', trimmed)) ?? null;
}

/** Treatments that leave the deduction sitting in Deductions Receivable (1210). */
export const RECEIVABLE_TREATMENTS: ReadonlySet<DeductionTreatment> = new Set<DeductionTreatment>(['dispute', 'suspense']);

/** Treatments that are trade spend charged against revenue. */
export const TRADE_SPEND_TREATMENTS: ReadonlySet<DeductionTreatment> = new Set<DeductionTreatment>([
  'accrual',
  'contra_revenue',
]);

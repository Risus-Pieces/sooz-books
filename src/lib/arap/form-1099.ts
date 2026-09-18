/**
 * 1099-NEC preparation: what each vendor was paid in a calendar year, which of
 * it is reportable, and whether the paperwork is in order.
 *
 * Two kinds of payment count:
 *   - bill payments, through the AP sub-ledger, where `is_1099_reportable` says
 *     whether it was a card payment (never reportable: the card network files a
 *     1099-K for it);
 *   - direct payments — a bank line booked straight to an expense with the
 *     vendor tagged, which is how most of a small company's contractor payments
 *     arrive. These are read from the ledger: money that left a bank or cash
 *     account in an entry tagged with exactly one vendor. Money that left a
 *     credit card is excluded for the same 1099-K reason.
 * Voided bill payments count for nothing; a reversed direct payment nets out
 * through its reversal entry.
 *
 * THRESHOLD. The 1099-NEC threshold was $600 through payments made in 2025.
 * The One Big Beautiful Bill Act (Pub. L. 119-21, 2025) raised it to $2,000 for
 * payments made after 31 December 2025, indexed for inflation after 2026. The
 * default follows the statute by year; pass `thresholdCents` to override it
 * (for example to file voluntarily at the old $600 line).
 */

import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import type { VendorType } from '@/db/schema';

import type { LedgerDb } from './common';
import { invalidInput } from './errors';

/** The statutory 1099-NEC reporting threshold for payments made in `year`, in cents. */
export function form1099NecThresholdCents(year: number): number {
  return year >= 2026 ? 200_000 : 60_000;
}

/** Vendor types whose work is usually a service by a non-corporate payee. */
const LIKELY_1099_TYPES: ReadonlySet<VendorType> = new Set(['professional', 'broker']);
/** Default accounts that mean "we pay this vendor for services". */
const SERVICE_SUBTYPES: ReadonlySet<string> = new Set(['professional_fees', 'research_development', 'payroll']);

export type Form1099Status =
  /** Flagged, over the threshold, W-9 on file: file a 1099-NEC. */
  | 'file'
  /** Flagged and over the threshold, but no W-9: collect one before January 31. */
  | 'needs_w9'
  /** Flagged, under the threshold: nothing to file. */
  | 'below_threshold'
  /** Not flagged, but looks like a contractor and was paid over the threshold: review the flag. */
  | 'review_flag';

export interface Form1099Row {
  vendorId: string;
  vendorName: string;
  legalName: string | null;
  vendorType: VendorType;
  is1099: boolean;
  w9OnFile: boolean;
  w9ReceivedAt: string | null;
  taxIdLast4: string | null;
  /** Reportable payments through bill payments. */
  billPaymentCents: number;
  /** Reportable payments booked directly from a bank or cash account. */
  directPaymentCents: number;
  /** billPaymentCents + directPaymentCents. */
  reportableCents: number;
  /** Paid by card (either path), shown for reference and excluded from the total. */
  cardPaymentCents: number;
  meetsThreshold: boolean;
  status: Form1099Status;
}

export interface Form1099Report {
  year: number;
  thresholdCents: number;
  /** Vendors flagged is_1099, with anything paid in the year. */
  vendors: Form1099Row[];
  /** Unflagged vendors that look like contractors and were paid in the year. */
  candidates: Form1099Row[];
  warnings: string[];
}

interface Row1099 extends Record<string, unknown> {
  vendor_id: string;
  name: string;
  legal_name: string | null;
  vendor_type: VendorType;
  is_1099: boolean;
  w9_on_file: boolean;
  w9_received_at: string | null;
  tax_id_last4: string | null;
  default_subtype: string | null;
  bill_cents: string | number;
  direct_cents: string | number;
  card_cents: string | number;
}

function paymentsSql(from: string, to: string) {
  return sql`
    with voided as (
      select distinct r.reverses_id as entry_id
        from journal_entries r
       where r.reverses_id is not null and r.status = 'posted'
    ),
    bp as (
      select p.vendor_id,
             sum(p.amount_cents) filter (where p.is_1099_reportable) as reportable,
             sum(p.amount_cents) filter (where not p.is_1099_reportable) as card
        from bill_payments p
       where p.journal_entry_id is not null
         and p.payment_date between ${from}::date and ${to}::date
         and not exists (select 1 from voided v where v.entry_id = p.journal_entry_id)
       group by p.vendor_id
    ),
    tagged as (
      -- Entries tagged with exactly one vendor, other than the AP sub-ledger's own
      -- documents (counted above, or not payments at all) and reversals of them.
      select e.id as entry_id, min(l.vendor_id::text)::uuid as vendor_id
        from journal_entries e
        join journal_lines l on l.entry_id = e.id
        left join journal_entries o on o.id = e.reverses_id
       where e.status = 'posted'
         and e.entry_date between ${from}::date and ${to}::date
         and e.source_type not in ('bill', 'bill_payment', 'vendor_credit', 'invoice', 'receipt', 'credit_memo')
         and coalesce(o.source_type, '') not in ('bill', 'bill_payment', 'vendor_credit')
         and l.vendor_id is not null
       group by e.id
      having count(distinct l.vendor_id) = 1
    ),
    direct as (
      select t.vendor_id,
             sum(l.credit_cents - l.debit_cents)
               filter (where coalesce(a.subtype, '') in ('bank', 'cash')) as reportable,
             sum(l.credit_cents - l.debit_cents)
               filter (where coalesce(a.subtype, '') = 'credit_card') as card
        from tagged t
        join journal_lines l on l.entry_id = t.entry_id
        join accounts a on a.id = l.account_id
       group by t.vendor_id
    )
    select v.id as vendor_id, v.name, v.legal_name, v.vendor_type, v.is_1099, v.w9_on_file,
           v.w9_received_at::text as w9_received_at, v.tax_id_last4,
           da.subtype as default_subtype,
           coalesce(bp.reportable, 0) as bill_cents,
           coalesce(d.reportable, 0) as direct_cents,
           coalesce(bp.card, 0) + coalesce(d.card, 0) as card_cents
      from vendors v
      left join accounts da on da.id = v.default_expense_account_id
      left join bp on bp.vendor_id = v.id
      left join direct d on d.vendor_id = v.id
     where v.is_1099
        or coalesce(bp.reportable, 0) <> 0
        or coalesce(d.reportable, 0) <> 0
     order by v.name
  `;
}

export interface Form1099Options {
  /** Overrides the statutory threshold for the year. */
  thresholdCents?: number;
}

/** 1099-NEC workpaper for one calendar year. */
export async function form1099Report(
  year: number,
  options: Form1099Options = {},
  exec: LedgerDb = db,
): Promise<Form1099Report> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw invalidInput(`${String(year)} is not a tax year.`);
  const thresholdCents = options.thresholdCents ?? form1099NecThresholdCents(year);
  if (!Number.isSafeInteger(thresholdCents) || thresholdCents < 0) throw invalidInput('The threshold must be whole cents.');

  const from = `${String(year)}-01-01`;
  const to = `${String(year)}-12-31`;
  const rows = await exec.execute<Row1099>(paymentsSql(from, to));

  const vendors: Form1099Row[] = [];
  const candidates: Form1099Row[] = [];
  for (const r of rows) {
    const billPaymentCents = Number(r.bill_cents);
    const directPaymentCents = Number(r.direct_cents);
    const reportableCents = billPaymentCents + directPaymentCents;
    const meetsThreshold = reportableCents >= thresholdCents && reportableCents > 0;
    const base = {
      vendorId: r.vendor_id,
      vendorName: r.name,
      legalName: r.legal_name,
      vendorType: r.vendor_type,
      is1099: r.is_1099,
      w9OnFile: r.w9_on_file,
      w9ReceivedAt: r.w9_received_at,
      taxIdLast4: r.tax_id_last4,
      billPaymentCents,
      directPaymentCents,
      reportableCents,
      cardPaymentCents: Number(r.card_cents),
      meetsThreshold,
    };
    if (r.is_1099) {
      const status: Form1099Status = !meetsThreshold ? 'below_threshold' : r.w9_on_file ? 'file' : 'needs_w9';
      vendors.push({ ...base, status });
    } else if (
      reportableCents > 0 &&
      (LIKELY_1099_TYPES.has(r.vendor_type) || SERVICE_SUBTYPES.has(r.default_subtype ?? ''))
    ) {
      candidates.push({ ...base, status: 'review_flag' });
    }
  }

  const warnings: string[] = [];
  if (year > 2026 && options.thresholdCents === undefined) {
    warnings.push(
      `The $2,000 threshold is indexed for inflation after 2026; confirm the ${String(year)} figure before filing.`,
    );
  }
  for (const v of vendors) {
    if (v.status === 'needs_w9') warnings.push(`${v.vendorName}: over the threshold with no W-9 on file.`);
  }
  return { year, thresholdCents, vendors, candidates, warnings };
}

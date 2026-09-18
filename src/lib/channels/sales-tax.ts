/**
 * Sales tax: what was charged, what Sooz owes, and paying it.
 *
 * `sales_tax_entries` is the register. Every invoice and every channel settlement that
 * carries tax writes to it, tagged with the state and with whether a marketplace
 * facilitator collected and remitted it. The `sales_tax_liability` view sums the register
 * by state and month and splits what Sooz owes from what a marketplace already paid —
 * facilitator tax is reported (states ask for marketplace sales on the return) but never
 * owed, and never sits in 2200.
 *
 * Filing a return freezes the entries it reported (migration 0031); paying it posts
 * Dr 2200 Sales Tax Payable / Cr the bank, through `postJournalEntry`.
 */

import { and, asc, eq, gte, inArray, isNull, lte, sql as sqlTag } from 'drizzle-orm';

import {
  accounts,
  customers,
  invoiceLines,
  invoices,
  journalEntries,
  journalLines,
  salesTaxEntries,
  salesTaxFilings,
  salesTaxLiability as salesTaxLiabilityView,
  type SalesTaxFiling,
} from '@/db/schema';
import { type CalendarDate, isCalendarDate, today } from '@/lib/dates';
import { isUniqueViolation } from '@/lib/db-errors';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';
import { formatMoney, sumCents } from '@/lib/money';

import { type ChannelCtx, inChannelTx } from './context';
import { ChannelError } from './errors';
import { isStateCode, stateFromTaxName } from './states';

/**
 * Where Sooz Beverage LLC sells in person: Houston, Texas. A Square settlement names no
 * state, and an in-person sale is sourced to where it happens, so Square tax is Texas tax
 * unless the caller says otherwise (an out-of-state market, say).
 */
export const HOME_STATE = 'TX';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(field: string, value: string): void {
  if (!UUID.test(value)) throw new ChannelError('invalid_input', `${field} is not a valid id.`);
}

function requireDate(field: string, value: string): void {
  if (!isCalendarDate(value)) throw new ChannelError('invalid_input', `${field} must be a YYYY-MM-DD date.`);
}

/** A state from a code or a name; `null` when the text names no US state. */
export function normalizeState(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const upper = trimmed.toUpperCase();
  if (isStateCode(upper)) return upper;
  return stateFromTaxName(trimmed);
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

/** One tax line of a settlement, as `./post` hands it over. */
export interface SettlementTaxLine {
  readonly facilitator: boolean;
  /** For facilitator tax: only the `collected` half is reportable; `withheld` is the remittance. */
  readonly side: 'collected' | 'withheld' | null;
  readonly amountCents: number;
  /** The state the source names, if any. */
  readonly state: string | null;
  readonly regime: 'us_state' | 'foreign' | 'unknown' | null;
  readonly taxableCents: number | null;
  readonly label: string;
}

export interface SettlementTaxInput {
  readonly payoutImportId: string;
  readonly channelId: string;
  readonly date: CalendarDate;
  readonly lines: readonly SettlementTaxLine[];
  /** The settlement's net sales, the taxable base when no line states its own. */
  readonly netSalesCents: number;
  /** The state for tax lines whose source names none. */
  readonly defaultState: string | null;
}

export interface SettlementTaxResult {
  readonly entriesWritten: number;
  /** Facilitator tax the register could not hold because the source names no state. */
  readonly facilitatorUnrecordedCents: number;
  /** Non-US tax: posted to 2200, reported on no state return. */
  readonly foreignTaxCents: number;
}

/**
 * Writes a settlement's tax to the register, inside the posting transaction.
 *
 * @throws {ChannelError} `tax_state_unknown` when Sooz collected tax the source names no
 *   state for and no default was given — a liability with no state cannot be filed.
 */
export async function recordSettlementTax(tx: LedgerDb, input: SettlementTaxInput): Promise<SettlementTaxResult> {
  const groups = new Map<string, { state: string; facilitator: boolean; tax: number; taxable: number | null; labels: Set<string> }>();
  let facilitatorUnrecorded = 0;
  let foreign = 0;

  for (const line of input.lines) {
    if (line.facilitator && line.side === 'withheld') continue;
    if (line.regime === 'foreign') {
      if (!line.facilitator) foreign += line.amountCents;
      continue;
    }
    const state = normalizeState(line.state) ?? input.defaultState;
    if (state === null) {
      if (line.facilitator) {
        facilitatorUnrecorded += line.amountCents;
        continue;
      }
      throw new ChannelError(
        'tax_state_unknown',
        `This settlement carries ${formatMoney(line.amountCents)} of sales tax Sooz collected ("${line.label}") and the file does not say which state it belongs to.`,
        'Post it again naming the state the sales were made in.',
      );
    }
    const key = `${state}|${line.facilitator}`;
    const group = groups.get(key) ?? { state, facilitator: line.facilitator, tax: 0, taxable: null, labels: new Set<string>() };
    group.tax += line.amountCents;
    if (line.taxableCents !== null) group.taxable = (group.taxable ?? 0) + line.taxableCents;
    group.labels.add(line.label);
    groups.set(key, group);
  }

  const rows = [...groups.values()].filter((group) => group.tax !== 0 || (group.taxable ?? 0) !== 0);
  // A single group with no stated base is the whole settlement's sales (a Square payout).
  const soleBase = rows.length === 1 && rows[0].taxable === null ? input.netSalesCents : 0;
  if (rows.length > 0) {
    await tx.insert(salesTaxEntries).values(
      rows.map((group) => ({
        sourceType: 'payout' as const,
        sourceId: input.payoutImportId,
        taxDate: input.date,
        state: group.state,
        jurisdiction: [...group.labels].join('; ').slice(0, 500),
        channelId: input.channelId,
        taxableCents: group.taxable ?? soleBase,
        exemptCents: 0,
        taxCents: group.tax,
        facilitatorRemitted: group.facilitator,
      })),
    );
  }
  return { entriesWritten: rows.length, facilitatorUnrecordedCents: facilitatorUnrecorded, foreignTaxCents: foreign };
}

/** Removes a settlement's register entries when its posting is reversed. Refused once any is filed. */
export async function removeSettlementTax(tx: LedgerDb, payoutImportId: string): Promise<number> {
  const existing = await tx
    .select({ id: salesTaxEntries.id, filingId: salesTaxEntries.filingId })
    .from(salesTaxEntries)
    .where(and(eq(salesTaxEntries.sourceType, 'payout'), eq(salesTaxEntries.sourceId, payoutImportId)));
  if (existing.some((row) => row.filingId !== null)) {
    throw new ChannelError(
      'filed',
      'This settlement’s sales tax has already been reported on a filed return, so its posting cannot be undone. Amend the return first.',
    );
  }
  if (existing.length === 0) return 0;
  await tx.delete(salesTaxEntries).where(inArray(salesTaxEntries.id, existing.map((row) => row.id)));
  return existing.length;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface RecordInvoiceTaxOptions {
  /** The state the sale is sourced to, when the customer's address does not say. */
  readonly state?: string;
  /** Date for an adjusting entry when the original period is already filed. Defaults to today. */
  readonly asOf?: CalendarDate;
}

export interface RecordInvoiceTaxResult {
  readonly invoiceId: string;
  readonly state: string | null;
  readonly action: 'recorded' | 'unchanged' | 'replaced' | 'adjusted' | 'removed' | 'skipped';
  readonly taxCents: number;
  readonly taxableCents: number;
  readonly exemptCents: number;
  /** Why nothing was written, when `action` is `skipped`. */
  readonly reason: string | null;
}

function addressState(address: unknown): string | null {
  if (address === null || typeof address !== 'object') return null;
  const record = address as Record<string, unknown>;
  for (const key of ['state', 'province', 'region', 'state_code', 'provinceCode', 'province_code']) {
    const value = record[key];
    if (typeof value === 'string') {
      const state = normalizeState(value);
      if (state !== null) return state;
    }
  }
  return null;
}

/**
 * Brings the register in line with an invoice: an issued invoice records its tax, taxable
 * and exempt sales under the customer's state; a voided or draft one records none. Safe to
 * call again after any change — it writes only the difference.
 *
 * While the entries are unfiled they are replaced outright. Once a return has reported
 * them they are frozen, and the difference is written as a new entry dated `asOf`.
 *
 * The AR engine calls this after issuing or voiding an invoice, inside the same transaction
 * when it passes `ctx.tx`.
 *
 * @throws {ChannelError} `not_found`; `tax_state_unknown` when the invoice carries tax and
 *   neither the customer's addresses nor `options.state` name a state.
 */
export async function recordInvoiceTax(
  invoiceId: string,
  ctx: ChannelCtx,
  options: RecordInvoiceTaxOptions = {},
): Promise<RecordInvoiceTaxResult> {
  requireUuid('invoiceId', invoiceId);
  if (options.asOf !== undefined) requireDate('asOf', options.asOf);
  return inChannelTx(ctx, async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
    if (invoice === undefined) throw new ChannelError('not_found', 'That invoice does not exist.');
    const [customer] = await tx
      .select({ shipping: customers.shippingAddress, billing: customers.billingAddress })
      .from(customers)
      .where(eq(customers.id, invoice.customerId));
    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id))
      .orderBy(asc(invoiceLines.lineNo));

    const live = invoice.status !== 'draft' && invoice.status !== 'void';
    const taxable = live ? sumCents(lines.filter((l) => l.taxCents > 0).map((l) => l.amountCents - l.discountCents)) : 0;
    const exempt = live ? sumCents(lines.filter((l) => l.taxCents <= 0).map((l) => l.amountCents - l.discountCents)) : 0;
    const tax = live ? invoice.taxCents : 0;

    const explicit = options.state === undefined ? null : normalizeState(options.state);
    if (options.state !== undefined && explicit === null) {
      throw new ChannelError('invalid_input', `"${options.state}" is not a US state.`);
    }
    const state = explicit ?? addressState(customer?.shipping) ?? addressState(customer?.billing);

    const existing = await tx
      .select()
      .from(salesTaxEntries)
      .where(and(eq(salesTaxEntries.sourceType, 'invoice'), eq(salesTaxEntries.sourceId, invoice.id)));
    const had = {
      tax: sumCents(existing.map((e) => e.taxCents)),
      taxable: sumCents(existing.map((e) => e.taxableCents)),
      exempt: sumCents(existing.map((e) => e.exemptCents)),
    };
    const result = (action: RecordInvoiceTaxResult['action'], reason: string | null = null): RecordInvoiceTaxResult => ({
      invoiceId: invoice.id,
      state,
      action,
      taxCents: tax,
      taxableCents: taxable,
      exemptCents: exempt,
      reason,
    });

    if (had.tax === tax && had.taxable === taxable && had.exempt === exempt) {
      // With nothing recorded, equal sums mean the invoice has nothing to report either.
      return existing.length > 0 ? result('unchanged') : result('skipped', 'The invoice carries no sales to report.');
    }

    const targetState = state ?? existing[0]?.state ?? null;
    if (targetState === null) {
      if (tax === 0) return result('skipped', 'No state is known for this customer and the invoice carries no tax.');
      throw new ChannelError(
        'tax_state_unknown',
        `Invoice ${invoice.invoiceNo} carries ${formatMoney(tax)} of sales tax, and neither the customer's shipping nor billing address names a state.`,
        "Add the customer's address, or record the tax naming the state.",
      );
    }

    const filed = existing.some((e) => e.filingId !== null);
    if (!filed) {
      if (existing.length > 0) {
        await tx.delete(salesTaxEntries).where(inArray(salesTaxEntries.id, existing.map((e) => e.id)));
      }
      if (!live || (tax === 0 && taxable === 0 && exempt === 0)) return result(existing.length > 0 ? 'removed' : 'skipped');
      await tx.insert(salesTaxEntries).values({
        sourceType: 'invoice',
        sourceId: invoice.id,
        taxDate: invoice.invoiceDate,
        state: targetState,
        channelId: invoice.channelId,
        customerId: invoice.customerId,
        taxableCents: taxable,
        exemptCents: exempt,
        taxCents: tax,
        facilitatorRemitted: false,
      });
      return result(existing.length > 0 ? 'replaced' : 'recorded');
    }

    // A return already reported these; record only the change, on today's (or asOf's) date.
    await tx.insert(salesTaxEntries).values({
      sourceType: 'invoice',
      sourceId: invoice.id,
      taxDate: options.asOf ?? today(),
      state: targetState,
      jurisdiction: `Adjustment to invoice ${invoice.invoiceNo} after filing`,
      channelId: invoice.channelId,
      customerId: invoice.customerId,
      taxableCents: taxable - had.taxable,
      exemptCents: exempt - had.exempt,
      taxCents: tax - had.tax,
      facilitatorRemitted: false,
    });
    return result('adjusted');
  });
}

// ---------------------------------------------------------------------------
// Liability
// ---------------------------------------------------------------------------

export interface LiabilityRow {
  readonly state: string;
  /** First day of the month. */
  readonly period: CalendarDate;
  readonly taxableCents: number;
  readonly taxCents: number;
  /** Collected and remitted by a marketplace facilitator: reported, never owed. */
  readonly facilitatorCents: number;
  /** What Sooz owes the state for the month. */
  readonly owedCents: number;
  /** The part of `owedCents` no filed return has reported yet. */
  readonly unfiledOwedCents: number;
}

export interface LiabilityReport {
  readonly rows: readonly LiabilityRow[];
  readonly totals: { readonly taxCents: number; readonly facilitatorCents: number; readonly owedCents: number; readonly unfiledOwedCents: number };
  /** Credit balance of 2200 Sales Tax Payable in the posted ledger, as of `to`. */
  readonly ledgerPayableCents: number;
  /**
   * What the register says is still owed — unfiled, plus filed but unpaid — against 2200.
   * Non-zero means tax posted without a register entry (non-US tax, a manual entry) or the
   * reverse, and is worth a look before filing.
   */
  readonly registerOwedCents: number;
  readonly differenceCents: number;
}

export interface LiabilityFilter {
  readonly from?: CalendarDate;
  readonly to?: CalendarDate;
  readonly state?: string;
}

/** Sales tax by state and month, from the `sales_tax_liability` view, with the ledger beside it. */
export async function salesTaxLiability(filter: LiabilityFilter = {}, exec?: LedgerDb): Promise<LiabilityReport> {
  if (filter.from !== undefined) requireDate('from', filter.from);
  if (filter.to !== undefined) requireDate('to', filter.to);
  const db = exec ?? (await import('@/db/client')).db;
  const state = filter.state === undefined ? undefined : normalizeState(filter.state) ?? filter.state;

  const viewRows = await db
    .select()
    .from(salesTaxLiabilityView)
    .where(
      and(
        filter.from === undefined ? undefined : gte(salesTaxLiabilityView.period, sqlTag`date_trunc('month', ${filter.from}::date)::date`),
        filter.to === undefined ? undefined : lte(salesTaxLiabilityView.period, filter.to),
        state === undefined ? undefined : eq(salesTaxLiabilityView.state, state),
      ),
    )
    .orderBy(asc(salesTaxLiabilityView.period), asc(salesTaxLiabilityView.state));

  const unfiled = await db
    .select({
      state: salesTaxEntries.state,
      period: sqlTag<string>`date_trunc('month', ${salesTaxEntries.taxDate})::date::text`,
      owed: sqlTag<string>`coalesce(sum(${salesTaxEntries.taxCents}), 0)::text`,
    })
    .from(salesTaxEntries)
    .where(and(isNull(salesTaxEntries.filingId), eq(salesTaxEntries.facilitatorRemitted, false)))
    .groupBy(salesTaxEntries.state, sqlTag`date_trunc('month', ${salesTaxEntries.taxDate})`);
  const unfiledBy = new Map(unfiled.map((row) => [`${row.state}|${row.period}`, Number(row.owed)]));

  const rows: LiabilityRow[] = viewRows.map((row) => ({
    state: row.state,
    period: row.period,
    taxableCents: Number(row.taxableCents),
    taxCents: Number(row.taxCents),
    facilitatorCents: Number(row.facilitatorCents),
    owedCents: Number(row.owedCents),
    unfiledOwedCents: unfiledBy.get(`${row.state}|${row.period}`) ?? 0,
  }));

  const asOf = filter.to ?? '9999-12-31';
  const [ledger] = await db
    .select({ balance: sqlTag<string>`coalesce(sum(${journalLines.creditCents}) - sum(${journalLines.debitCents}), 0)::text` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(accounts.code, ACCOUNTS.SALES_TAX_PAYABLE), eq(journalEntries.status, 'posted'), lte(journalEntries.entryDate, asOf)));

  const [register] = await db
    .select({
      owed: sqlTag<string>`coalesce(sum(${salesTaxEntries.taxCents}), 0)::text`,
    })
    .from(salesTaxEntries)
    .leftJoin(salesTaxFilings, eq(salesTaxFilings.id, salesTaxEntries.filingId))
    .where(
      and(
        eq(salesTaxEntries.facilitatorRemitted, false),
        lte(salesTaxEntries.taxDate, asOf),
        sqlTag`(${salesTaxEntries.filingId} is null or ${salesTaxFilings.journalEntryId} is null)`,
      ),
    );

  const ledgerPayable = Number(ledger?.balance ?? '0');
  const registerOwed = Number(register?.owed ?? '0');
  return {
    rows,
    totals: {
      taxCents: sumCents(rows.map((r) => r.taxCents)),
      facilitatorCents: sumCents(rows.map((r) => r.facilitatorCents)),
      owedCents: sumCents(rows.map((r) => r.owedCents)),
      unfiledOwedCents: sumCents(rows.map((r) => r.unfiledOwedCents)),
    },
    ledgerPayableCents: ledgerPayable,
    registerOwedCents: registerOwed,
    differenceCents: ledgerPayable - registerOwed,
  };
}

// ---------------------------------------------------------------------------
// Filing and paying
// ---------------------------------------------------------------------------

export interface FileReturnInput {
  readonly state: string;
  readonly periodStart: CalendarDate;
  readonly periodEnd: CalendarDate;
  readonly confirmation?: string;
  readonly notes?: string;
}

export interface FiledReturn {
  readonly filing: SalesTaxFiling;
  readonly entriesReported: number;
  /** Marketplace sales on the return: reported, deducted, not owed. */
  readonly facilitatorSalesCents: number;
}

/**
 * Files a return: every unfiled register entry for the state and period is reported on it
 * and frozen. Gross sales include marketplace-facilitator sales, which states ask for;
 * taxable sales and tax due exclude them. A period with no sales files as a zero return,
 * which most states still require.
 *
 * @throws {ChannelError} `already_filed` for a second return on the same state and period.
 */
export async function fileSalesTaxReturn(input: FileReturnInput, ctx: ChannelCtx): Promise<FiledReturn> {
  const state = normalizeState(input.state);
  if (state === null) throw new ChannelError('invalid_input', `"${input.state}" is not a US state.`);
  requireDate('periodStart', input.periodStart);
  requireDate('periodEnd', input.periodEnd);
  if (input.periodEnd < input.periodStart) throw new ChannelError('invalid_input', 'The period ends before it starts.');

  return inChannelTx(ctx, async (tx) => {
    const entries = await tx
      .select()
      .from(salesTaxEntries)
      .where(
        and(
          eq(salesTaxEntries.state, state),
          isNull(salesTaxEntries.filingId),
          gte(salesTaxEntries.taxDate, input.periodStart),
          lte(salesTaxEntries.taxDate, input.periodEnd),
        ),
      )
      .for('update');

    const owed = entries.filter((e) => !e.facilitatorRemitted);
    const facilitator = entries.filter((e) => e.facilitatorRemitted);
    let filing: SalesTaxFiling;
    try {
      [filing] = await tx
        .insert(salesTaxFilings)
        .values({
          state,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          grossSalesCents: sumCents(entries.map((e) => e.taxableCents + e.exemptCents)),
          taxableCents: sumCents(owed.map((e) => e.taxableCents)),
          taxDueCents: sumCents(owed.map((e) => e.taxCents)),
          taxPaidCents: 0,
          filedAt: new Date(),
          confirmation: input.confirmation?.trim() || null,
          notes: input.notes?.trim() || null,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error, 'sales_tax_filings_state_period_start_period_end_key')) {
        throw new ChannelError('already_filed', `A ${state} return for ${input.periodStart} – ${input.periodEnd} has already been filed.`);
      }
      throw error;
    }

    if (entries.length > 0) {
      await tx
        .update(salesTaxEntries)
        .set({ filingId: filing.id })
        .where(inArray(salesTaxEntries.id, entries.map((e) => e.id)));
    }
    return {
      filing,
      entriesReported: entries.length,
      facilitatorSalesCents: sumCents(facilitator.map((e) => e.taxableCents + e.exemptCents)),
    };
  });
}

export interface PayReturnInput {
  readonly filingId: string;
  /** The GL account of the bank account the payment left from (`accounts.id`, a bank account). */
  readonly bankAccountId: string;
  readonly date: CalendarDate;
  readonly amountCents: number;
  /** A timely-filing discount the state lets the filer keep (Texas: 0.5%). Other income. */
  readonly discountCents?: number;
}

export interface PaidReturn {
  readonly filing: SalesTaxFiling;
  readonly entryId: string;
  readonly entryNo: number;
}

/**
 * Pays a filed return: Dr 2200 Sales Tax Payable for the tax due, Cr the bank for the
 * payment, and Cr 7020 Miscellaneous Income for any timely-filing discount kept.
 *
 * @throws {ChannelError} `not_found`, `already_paid`, `payment_mismatch` (payment plus
 *   discount is not the tax due), `not_a_bank_account`.
 */
export async function paySalesTax(input: PayReturnInput, ctx: ChannelCtx): Promise<PaidReturn> {
  requireUuid('filingId', input.filingId);
  requireUuid('bankAccountId', input.bankAccountId);
  requireDate('date', input.date);
  const discount = input.discountCents ?? 0;
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0 || !Number.isSafeInteger(discount) || discount < 0) {
    throw new ChannelError('invalid_input', 'The payment and discount must be whole, non-negative cents.');
  }

  return inChannelTx(ctx, async (tx) => {
    const [filing] = await tx.select().from(salesTaxFilings).where(eq(salesTaxFilings.id, input.filingId)).for('update');
    if (filing === undefined) throw new ChannelError('not_found', 'That sales tax filing does not exist.');
    if (filing.journalEntryId !== null) {
      throw new ChannelError('already_paid', `The ${filing.state} return for ${filing.periodStart} – ${filing.periodEnd} has already been paid.`);
    }
    if (filing.taxDueCents <= 0) {
      throw new ChannelError('invalid_input', `The ${filing.state} return for ${filing.periodStart} – ${filing.periodEnd} has no tax due.`);
    }
    if (input.amountCents + discount !== filing.taxDueCents) {
      throw new ChannelError(
        'payment_mismatch',
        `The return shows ${formatMoney(filing.taxDueCents)} due; a payment of ${formatMoney(input.amountCents)}${discount > 0 ? ` plus a ${formatMoney(discount)} discount` : ''} does not settle it.`,
        'Pay the amount due, or record the timely-filing discount the state allows. Penalties and interest are a separate entry.',
      );
    }
    const [bank] = await tx
      .select({ id: accounts.id, isBank: accounts.isBank, type: accounts.type, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.id, input.bankAccountId));
    if (bank === undefined || !bank.isBank || bank.type !== 'asset') {
      throw new ChannelError('not_a_bank_account', 'Sales tax must be paid from a bank account.');
    }

    const period = `${filing.state} sales tax ${filing.periodStart} – ${filing.periodEnd}`;
    const posted = await postJournalEntry(
      {
        date: input.date,
        memo: `Sales tax payment — ${period}`,
        sourceType: 'sales_tax',
        sourceId: filing.id,
        lines: [
          { accountCode: ACCOUNTS.SALES_TAX_PAYABLE, debitCents: filing.taxDueCents, memo: period },
          ...(input.amountCents > 0 ? [{ accountId: bank.id, creditCents: input.amountCents, memo: period }] : []),
          ...(discount > 0 ? [{ accountCode: ACCOUNTS.MISC_INCOME, creditCents: discount, memo: `Timely filing discount — ${period}` }] : []),
        ],
      },
      { userId: ctx.userId, tx },
    );

    const [updated] = await tx
      .update(salesTaxFilings)
      .set({ taxPaidCents: input.amountCents, paidAt: input.date, journalEntryId: posted.entryId })
      .where(eq(salesTaxFilings.id, filing.id))
      .returning();
    return { filing: updated, entryId: posted.entryId, entryNo: posted.entryNo };
  });
}

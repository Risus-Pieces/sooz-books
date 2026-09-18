/**
 * Matching bank lines to open invoices and bills.
 *
 * `matchCandidates` proposes what a statement line could be: money in against
 * open invoices, money out against open bills. First every single document
 * whose open balance is exactly the amount; then combinations of one party's
 * documents that add up to it exactly, drawn from documents due within five
 * banking days of the line (a customer paying three invoices in one ACH, or one
 * check covering a vendor's two bills). Candidates are ranked: an exact single
 * match beats a combination, a party the line names beats a stranger, and a due
 * date close to the bank date beats a distant one.
 *
 * `applyMatch` is the human saying "yes, that one". In one transaction it
 * records the receipt or bill payment (dated the bank date, into or out of the
 * bank account the line belongs to), applies it, and marks the bank line
 *
 *     status = 'matched', matched_type = 'receipt' | 'bill_payment',
 *     matched_id = the receipt or payment, journal_entry_id = its entry
 *
 * A bank line with `journal_entry_id` set is already in the ledger. The banking
 * engine's own posting path must treat it as posted and never book it again;
 * this module refuses to match a line that already has an entry.
 */

import { eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { type PaymentMethod, bankAccounts, bankTransactions, bills, invoices } from '@/db/schema';
import type { CalendarDate } from '@/lib/dates';
import { sumCents } from '@/lib/money';

import { payBills } from './bill-payments';
import { businessDaysBetween } from './business-days';
import { type ArapContext, type LedgerDb, requireUuid, runArap } from './common';
import { ArapError, invalidInput, invalidState, notFound } from './errors';
import { recordReceipt } from './receipts';
import { billOpenBalance, invoiceOpenBalance } from './settlement';

/** How far a document's due date may sit from the bank date to join a combination. */
export const MATCH_WINDOW_BUSINESS_DAYS = 5;

export interface MatchDocument {
  kind: 'invoice' | 'bill';
  id: string;
  docNo: string;
  partyId: string;
  partyName: string;
  docDate: CalendarDate;
  dueDate: CalendarDate;
  balanceCents: number;
  /** Banking days from the due date to the bank date; positive when paid late. */
  businessDaysFromDue: number;
}

export interface MatchCandidate {
  kind: 'exact' | 'combination';
  documents: MatchDocument[];
  totalCents: number;
  /** Higher is better. Only meaningful for ordering. */
  score: number;
  /** Why this candidate was proposed, in words a reviewer can check. */
  reasons: string[];
}

export interface BankLineSummary {
  id: string;
  txnDate: CalendarDate;
  description: string;
  amountCents: number;
  status: string;
  journalEntryId: string | null;
}

export interface MatchCandidates {
  bankTransaction: BankLineSummary;
  direction: 'inflow' | 'outflow';
  /** Why nothing can be matched to this line, when that is the case. */
  blockedReason: string | null;
  candidates: MatchCandidate[];
}

// ---------------------------------------------------------------------------
// Subset sum
// ---------------------------------------------------------------------------

export interface SubsetOptions {
  minSize?: number;
  maxSize?: number;
  maxResults?: number;
  /** Search nodes to visit before giving up; bounds the worst case. */
  maxNodes?: number;
}

/**
 * Index sets of `amounts` (all positive cents) summing exactly to `target`.
 * Depth-first over the amounts in descending order, pruned by the running sum
 * and by what the remaining amounts could still add. Returns at most
 * `maxResults` sets, smallest first.
 */
export function findSubsets(amounts: readonly number[], target: number, options: SubsetOptions = {}): number[][] {
  const minSize = options.minSize ?? 2;
  const maxSize = options.maxSize ?? 6;
  const maxResults = options.maxResults ?? 5;
  let budget = options.maxNodes ?? 200_000;
  if (target <= 0) return [];

  const order = amounts
    .map((amount, index) => ({ amount, index }))
    .filter((x) => x.amount > 0 && x.amount <= target)
    .sort((a, b) => b.amount - a.amount || a.index - b.index);
  const suffix = new Array<number>(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + order[i].amount;

  const results: number[][] = [];
  const chosen: number[] = [];
  const walk = (start: number, remaining: number): void => {
    if (budget <= 0 || results.length >= maxResults * 4) return;
    budget -= 1;
    if (remaining === 0) {
      if (chosen.length >= minSize) results.push(chosen.map((i) => order[i].index).sort((a, b) => a - b));
      return;
    }
    if (chosen.length >= maxSize || suffix[start] < remaining) return;
    for (let i = start; i < order.length; i += 1) {
      const amount = order[i].amount;
      if (amount > remaining) continue;
      chosen.push(i);
      walk(i + 1, remaining - amount);
      chosen.pop();
      if (budget <= 0) return;
    }
  };
  walk(0, target);

  return results.sort((a, b) => a.length - b.length).slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

interface OpenDocRow extends Record<string, unknown> {
  id: string;
  doc_no: string;
  party_id: string;
  party_name: string;
  doc_date: string;
  due_date: string;
  balance_cents: string | number;
  party_hint: boolean;
}

async function loadBankLine(exec: LedgerDb, bankTransactionId: string) {
  const [line] = await exec
    .select({
      id: bankTransactions.id,
      bankAccountId: bankTransactions.bankAccountId,
      txnDate: bankTransactions.txnDate,
      description: bankTransactions.description,
      descriptionNormalized: bankTransactions.descriptionNormalized,
      amountCents: bankTransactions.amountCents,
      reference: bankTransactions.reference,
      status: bankTransactions.status,
      journalEntryId: bankTransactions.journalEntryId,
      suggestedCustomerId: bankTransactions.suggestedCustomerId,
      suggestedVendorId: bankTransactions.suggestedVendorId,
    })
    .from(bankTransactions)
    .where(eq(bankTransactions.id, bankTransactionId));
  return line;
}

type BankLine = NonNullable<Awaited<ReturnType<typeof loadBankLine>>>;

/** Why a bank line cannot be matched, or null when it can. */
export function matchBlockedReason(line: Pick<BankLine, 'status' | 'journalEntryId'>): string | null {
  if (line.journalEntryId !== null) return 'This bank line is already posted to the ledger.';
  if (line.status === 'matched') return 'This bank line is already matched.';
  if (line.status === 'transfer') return 'This bank line is one side of a transfer between our own accounts.';
  if (line.status === 'excluded') return 'This bank line is excluded from the books.';
  return null;
}

function openInvoicesSql(line: BankLine) {
  return sql`
    select i.id, i.invoice_no as doc_no, i.customer_id as party_id, c.name as party_name,
           i.invoice_date::text as doc_date, i.due_date::text as due_date,
           (i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents) as balance_cents,
           (c.id = ${line.suggestedCustomerId}::uuid
             or (length(normalize_description(c.name)) >= 3
                 and position(normalize_description(c.name) in ${line.descriptionNormalized}) > 0)
             or (c.display_name is not null and length(normalize_description(c.display_name)) >= 3
                 and position(normalize_description(c.display_name) in ${line.descriptionNormalized}) > 0)
           ) as party_hint
      from invoices i
      join customers c on c.id = i.customer_id
     where i.status in ('open', 'partial')
       and i.invoice_date <= ${line.txnDate}
       and (i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents) > 0
     order by i.due_date, i.invoice_no
     limit 1000
  `;
}

function openBillsSql(line: BankLine) {
  return sql`
    select b.id, b.bill_no as doc_no, b.vendor_id as party_id, v.name as party_name,
           b.bill_date::text as doc_date, b.due_date::text as due_date,
           (b.total_cents - b.paid_cents - b.credited_cents) as balance_cents,
           (v.id = ${line.suggestedVendorId}::uuid
             or (length(normalize_description(v.name)) >= 3
                 and position(normalize_description(v.name) in ${line.descriptionNormalized}) > 0)
             or exists (
               select 1 from vendor_aliases va
                where va.vendor_id = v.id
                  and length(va.alias_normalized) >= 3
                  and position(va.alias_normalized in ${line.descriptionNormalized}) > 0)
           ) as party_hint
      from bills b
      join vendors v on v.id = b.vendor_id
     where b.status in ('open', 'partial')
       and b.bill_date <= ${line.txnDate}
       and (b.total_cents - b.paid_cents - b.credited_cents) > 0
     order by b.due_date, b.bill_no
     limit 1000
  `;
}

export interface MatchOptions {
  limit?: number;
}

/** Ranked proposals for what `bankTransactionId` pays. Read-only. */
export async function matchCandidates(
  bankTransactionId: string,
  options: MatchOptions = {},
  exec: LedgerDb = db,
): Promise<MatchCandidates> {
  requireUuid('bankTransactionId', bankTransactionId);
  const line = await loadBankLine(exec, bankTransactionId);
  if (line === undefined) throw notFound('Bank transaction', bankTransactionId);

  const direction = line.amountCents > 0 ? 'inflow' : 'outflow';
  const summary: BankLineSummary = {
    id: line.id,
    txnDate: line.txnDate,
    description: line.description,
    amountCents: line.amountCents,
    status: line.status,
    journalEntryId: line.journalEntryId,
  };
  const blockedReason = matchBlockedReason(line);
  if (blockedReason !== null) return { bankTransaction: summary, direction, blockedReason, candidates: [] };

  const target = Math.abs(line.amountCents);
  const kind = direction === 'inflow' ? 'invoice' : 'bill';
  const rows = await exec.execute<OpenDocRow>(direction === 'inflow' ? openInvoicesSql(line) : openBillsSql(line));
  const docs = rows.map((r) => ({
    doc: {
      kind,
      id: r.id,
      docNo: r.doc_no,
      partyId: r.party_id,
      partyName: r.party_name,
      docDate: r.doc_date,
      dueDate: r.due_date,
      balanceCents: Number(r.balance_cents),
      businessDaysFromDue: businessDaysBetween(r.due_date, line.txnDate),
    } satisfies MatchDocument,
    hint: r.party_hint === true,
  }));

  return {
    bankTransaction: summary,
    direction,
    blockedReason: null,
    candidates: rankCandidates(docs, target, options.limit ?? 10),
  };
}

/** Builds and orders candidates from open documents. Pure; exported for tests. */
export function rankCandidates(
  docs: readonly { doc: MatchDocument; hint: boolean }[],
  targetCents: number,
  limit: number,
): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  const noun = (d: MatchDocument): string => (d.kind === 'invoice' ? 'invoice' : 'bill');
  const timing = (days: number): string =>
    days === 0 ? 'due the same day' : days > 0 ? `${days} banking days after due` : `${-days} banking days before due`;

  for (const { doc, hint } of docs) {
    if (doc.balanceCents !== targetCents) continue;
    const reasons = [`Open balance of ${noun(doc)} ${doc.docNo} equals the amount exactly`, timing(doc.businessDaysFromDue)];
    if (hint) reasons.push(`The bank description names ${doc.partyName}`);
    candidates.push({
      kind: 'exact',
      documents: [doc],
      totalCents: targetCents,
      score: 100 + (hint ? 30 : 0) - Math.min(Math.abs(doc.businessDaysFromDue), 30),
      reasons,
    });
  }

  const byParty = new Map<string, { doc: MatchDocument; hint: boolean }[]>();
  for (const entry of docs) {
    if (Math.abs(entry.doc.businessDaysFromDue) > MATCH_WINDOW_BUSINESS_DAYS) continue;
    const list = byParty.get(entry.doc.partyId) ?? [];
    list.push(entry);
    byParty.set(entry.doc.partyId, list);
  }
  for (const pool of byParty.values()) {
    if (pool.length < 2) continue;
    const pick = pool.slice(0, 30);
    for (const subset of findSubsets(
      pick.map((p) => p.doc.balanceCents),
      targetCents,
    )) {
      const chosen = subset.map((i) => pick[i]);
      const documents = chosen.map((c) => c.doc);
      const hint = chosen.some((c) => c.hint);
      const spread = Math.max(...documents.map((d) => Math.abs(d.businessDaysFromDue)));
      const reasons = [
        `${documents.length} of ${documents[0].partyName}'s open ${noun(documents[0])}s add up to the amount exactly`,
        `all due within ${MATCH_WINDOW_BUSINESS_DAYS} banking days of the bank date`,
      ];
      if (hint) reasons.push(`The bank description names ${documents[0].partyName}`);
      candidates.push({
        kind: 'combination',
        documents,
        totalCents: sumCents(documents.map((d) => d.balanceCents)),
        score: 70 + (hint ? 30 : 0) - 3 * (documents.length - 2) - spread,
        reasons,
      });
    }
  }

  return candidates
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.documents.length - b.documents.length ||
        a.documents[0].dueDate.localeCompare(b.documents[0].dueDate) ||
        a.documents[0].docNo.localeCompare(b.documents[0].docNo),
    )
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Applying a match
// ---------------------------------------------------------------------------

export interface ApplyMatchInput {
  bankTransactionId: string;
  /** The invoices (money in) or bills (money out) this line pays. Amounts default to each open balance. */
  documents: readonly { id: string; amountCents?: number }[];
  method?: PaymentMethod;
  memo?: string;
}

export interface AppliedMatch {
  matchedType: 'receipt' | 'bill_payment';
  /** The receipt or bill payment created. */
  matchedId: string;
  documentNo: string;
  entryId: string;
  /** Money on the line not applied to any document: a customer credit or a vendor prepayment. */
  unappliedCents: number;
}

/**
 * Turns a bank line into the receipt or bill payment it is, applied to the
 * chosen documents, and links the line to it so it is never posted twice.
 */
export async function applyMatch(input: ApplyMatchInput, ctx: ArapContext): Promise<AppliedMatch> {
  requireUuid('bankTransactionId', input.bankTransactionId);
  if (input.documents.length === 0) throw invalidInput('Choose at least one document to match.');
  const ids = input.documents.map((d) => requireUuid('document id', d.id));
  if (new Set(ids).size !== ids.length) throw invalidInput('The same document is chosen twice.');

  return runArap(ctx, async (tx) => {
    // The lock is what stops two reviewers matching the same line at once.
    const [locked] = await tx
      .select({ id: bankTransactions.id })
      .from(bankTransactions)
      .where(eq(bankTransactions.id, input.bankTransactionId))
      .for('update');
    if (locked === undefined) throw notFound('Bank transaction', input.bankTransactionId);
    const line = await loadBankLine(tx, input.bankTransactionId);
    if (line === undefined) throw notFound('Bank transaction', input.bankTransactionId);
    const blocked = matchBlockedReason(line);
    if (blocked !== null) throw new ArapError('already_posted', blocked);

    const [account] = await tx
      .select({ accountId: bankAccounts.accountId, kind: bankAccounts.kind })
      .from(bankAccounts)
      .where(eq(bankAccounts.id, line.bankAccountId));
    if (account === undefined) throw invalidState('The bank line belongs to no bank account.');

    const amount = Math.abs(line.amountCents);
    const reference = line.reference ?? line.description;
    const memo = input.memo ?? `Bank: ${line.description}`;
    let result: AppliedMatch;

    if (line.amountCents > 0) {
      const rows = await tx.select().from(invoices).where(inArray(invoices.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const customers = new Set(rows.map((r) => r.customerId));
      if (rows.length !== ids.length) throw notFound('Invoice', ids.find((id) => !byId.has(id)) ?? ids[0]);
      if (customers.size !== 1) {
        throw new ArapError('party_mismatch', 'One deposit pays one customer; the chosen invoices belong to several.');
      }
      const applications = input.documents.map((d) => {
        const invoice = byId.get(d.id);
        const open = invoice === undefined ? 0 : invoiceOpenBalance(invoice);
        return { invoiceId: d.id, amountCents: d.amountCents ?? open };
      });
      const { receipt, entryId, unappliedCents } = await recordReceipt(
        {
          customerId: rows[0].customerId,
          receiptDate: line.txnDate,
          amountCents: amount,
          method: input.method ?? 'ach',
          reference,
          memo,
          depositAccountId: account.accountId,
          applications,
          bankTransactionId: line.id,
        },
        { userId: ctx.userId, tx },
      );
      result = { matchedType: 'receipt', matchedId: receipt.id, documentNo: receipt.receiptNo, entryId, unappliedCents };
    } else {
      const rows = await tx.select().from(bills).where(inArray(bills.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const vendorIds = new Set(rows.map((r) => r.vendorId));
      if (rows.length !== ids.length) throw notFound('Bill', ids.find((id) => !byId.has(id)) ?? ids[0]);
      if (vendorIds.size !== 1) {
        throw new ArapError('party_mismatch', 'One payment pays one vendor; the chosen bills belong to several.');
      }
      const applications = input.documents.map((d) => {
        const bill = byId.get(d.id);
        const open = bill === undefined ? 0 : billOpenBalance(bill);
        return { billId: d.id, amountCents: d.amountCents ?? open };
      });
      const method: PaymentMethod = input.method ?? (account.kind === 'credit_card' ? 'card' : 'ach');
      const { payment, entryId, unappliedCents } = await payBills(
        {
          vendorId: rows[0].vendorId,
          paymentDate: line.txnDate,
          amountCents: amount,
          paymentAccountId: account.accountId,
          method,
          reference,
          memo,
          applications,
          bankTransactionId: line.id,
        },
        { userId: ctx.userId, tx },
      );
      result = { matchedType: 'bill_payment', matchedId: payment.id, documentNo: payment.paymentNo, entryId, unappliedCents };
    }

    await tx
      .update(bankTransactions)
      .set({
        status: 'matched',
        matchedType: result.matchedType,
        matchedId: result.matchedId,
        journalEntryId: result.entryId,
        reviewedBy: ctx.userId,
        reviewedAt: sql`now()`,
      })
      .where(eq(bankTransactions.id, line.id));

    return result;
  });
}

/**
 * The journal lines a report reads, on either accounting basis.
 *
 * Accrual basis is `journal_lines` as posted. Cash basis is the same ledger
 * restated so that income and expense land when money moves, and it is built
 * here as one derived table with the shape of `journal_lines`, so every report
 * — trial balance, P&L, balance sheet, general ledger — reads the same restated
 * lines and a cash-basis trial balance still balances.
 *
 * THE RESTATEMENT
 *
 * 1. Receivables and payables. An entry that moves a control account (AR or AP)
 *    is restated through the sub-ledger's application records:
 *      - each receipt, bill payment, credit memo, vendor credit or deduction
 *        applied to an invoice or a bill has the part of its control-account leg
 *        that the application covers replaced by that document's own lines —
 *        revenue, discounts, shipping, sales tax, expense, inventory — pro rata,
 *        so a paid invoice is revenue on the day it is paid;
 *      - money received or paid that is applied to nothing stays on the control
 *        account (a customer's credit, a vendor prepayment): it moved, and there
 *        is no document to say what it was for;
 *      - the unapplied part of a document that moves no money — an invoice or a
 *        bill nobody has paid, a credit memo not yet applied — is left out until
 *        it is applied, the whole entry scaled down so it still balances.
 *    A reversal is restated through the entry it reverses, so it mirrors that
 *    entry's restatement exactly.
 *
 * 2. Accruals. An entry that moves no money, touches no AR or AP, and books an
 *    accrued liability, a prepayment, deferred revenue, a customer deposit or
 *    another receivable is an accrual. One that has been reversed is left out
 *    together with its reversal. One settled by a payment instead is shown when
 *    it was booked: the payment then sits against the accrual account and carries
 *    nothing that ties it to the expense, so leaving the accrual out would drop
 *    the expense from the cash basis altogether.
 *
 * 3. Everything else is taken as posted: bank and card transactions, sales that
 *    settle through a channel clearing account (the customer has paid; the
 *    processor holds the money), inventory, cost of goods sold, depreciation.
 *
 * Proportional amounts are split by cumulative rounding — each line takes
 * round(A·(its weights so far)/W) less round(A·(the weights before it)/W) — so the
 * parts are whole cents and always sum to exactly the amount being split.
 */

import { type SQL, sql } from 'drizzle-orm';

import type { AccountingBasis } from './balances';

/** Accounts that hold money, or money collected on the business's behalf. */
export const CASH_SUBTYPES = [
  'bank',
  'cash',
  'undeposited_funds',
  'clearing',
  'credit_card',
] as const;

/** Balances that exist only because the books are kept on an accrual basis. */
export const ACCRUAL_SUBTYPES = [
  'accrued_liability',
  'prepaid',
  'deferred_revenue',
  'customer_deposit',
  'other_receivable',
] as const;

/** Sources that raise, rather than pay, a receivable or payable. */
export const DOCUMENT_SOURCE_TYPES = [
  'invoice',
  'bill',
  'credit_memo',
  'vendor_credit',
  'deduction',
] as const;

function textList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

const ACCRUAL_LINES: SQL = sql`(
  select l.id::text as line_key,
         l.entry_id,
         l.line_no::bigint as line_no,
         l.account_id,
         l.debit_cents,
         l.credit_cents,
         l.channel_id,
         l.product_id,
         l.customer_id,
         l.vendor_id,
         l.memo
    from journal_lines l
)`;

/**
 * Replacement lines are numbered after the entry's own, so a register lists an
 * entry's posted lines first and what the restatement put in their place last.
 */
const REPLACEMENT_LINE_BASE = 1_000_000;

const CASH_LINES: SQL = sql`(
  with recursive
  cb_account as (
    select a.id,
           a.is_control,
           (a.is_bank or coalesce(a.subtype, '') in (${textList(CASH_SUBTYPES)})) as is_cash,
           (not a.is_control and coalesce(a.subtype, '') in (${textList(ACCRUAL_SUBTYPES)})) as is_accrual
      from accounts a
  ),
  cb_entry as (
    select l.entry_id,
           e.reverses_id,
           coalesce(sum(l.debit_cents - l.credit_cents) filter (where ca.is_control), 0) as control_net,
           bool_or(ca.is_control) as has_control,
           bool_or(ca.is_cash) as has_cash,
           bool_or(ca.is_accrual) as has_accrual
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join cb_account ca on ca.id = l.account_id
     group by l.entry_id, e.reverses_id
    having bool_or(ca.is_control or ca.is_accrual)
  ),
  cb_chain (entry_id, current_id, next_id) as (
    select ce.entry_id, ce.entry_id, ce.reverses_id
      from cb_entry ce
     where ce.has_control
    union all
    select ch.entry_id, e.id, e.reverses_id
      from cb_chain ch
      join journal_entries e on e.id = ch.next_id
  ),
  cb_root as (
    select ch.entry_id, ch.current_id as root_id, e.source_type as root_source
      from cb_chain ch
      join journal_entries e on e.id = ch.current_id
     where ch.next_id is null
  ),
  cb_link (settler_id, document_id, amount) as (
    select r.journal_entry_id, i.journal_entry_id, ra.amount_cents + ra.discount_cents
      from receipt_applications ra
      join receipts r on r.id = ra.receipt_id
      join invoices i on i.id = ra.invoice_id
    union all
    select bp.journal_entry_id, b.journal_entry_id, bpa.amount_cents + bpa.discount_cents
      from bill_payment_applications bpa
      join bill_payments bp on bp.id = bpa.payment_id
      join bills b on b.id = bpa.bill_id
    union all
    select cm.journal_entry_id, i.journal_entry_id, cma.amount_cents
      from credit_memo_applications cma
      join credit_memos cm on cm.id = cma.credit_memo_id
      join invoices i on i.id = cma.invoice_id
    union all
    select vc.journal_entry_id, b.journal_entry_id, vca.amount_cents
      from vendor_credit_applications vca
      join vendor_credits vc on vc.id = vca.credit_id
      join bills b on b.id = vca.bill_id
    union all
    select d.journal_entry_id, i.journal_entry_id, d.amount_cents
      from deductions d
      join invoices i on i.id = d.invoice_id
  ),
  -- What each control-moving entry settles, through the entry at the root of its reversal chain.
  cb_application as (
    select ce.entry_id, ce.control_net, lk.document_id, sum(lk.amount) as amount
      from cb_entry ce
      join cb_root rt on rt.entry_id = ce.entry_id
      join cb_link lk on lk.settler_id = rt.root_id
      join cb_entry doc
        on doc.entry_id = lk.document_id and doc.has_control and doc.control_net <> 0
     where ce.has_control
       and ce.control_net <> 0
       and lk.document_id <> rt.root_id
     group by ce.entry_id, ce.control_net, lk.document_id
  ),
  -- Applications can never settle more than the entry's own control leg; if the records claim
  -- more, the leg is shared between them in proportion.
  cb_settled as (
    select a.entry_id,
           a.document_id,
           a.control_net,
           (case
              when sum(a.amount) over entry_apps <= abs(a.control_net) then a.amount
              else round(abs(a.control_net)::numeric * sum(a.amount) over running
                         / sum(a.amount) over entry_apps)
                 - round(abs(a.control_net)::numeric * (sum(a.amount) over running - a.amount)
                         / sum(a.amount) over entry_apps)
            end)::bigint as settled
      from cb_application a
    window entry_apps as (partition by a.entry_id),
           running as (partition by a.entry_id order by a.document_id rows unbounded preceding)
  ),
  cb_restated as (
    select ce.entry_id,
           ce.control_net,
           coalesce(s.settled, 0)::bigint as settled,
           -- A document that itself moved money is a payment as far as that money goes.
           (rt.root_source in (${textList(DOCUMENT_SOURCE_TYPES)}) and not ce.has_cash) as is_document
      from cb_entry ce
      join cb_root rt on rt.entry_id = ce.entry_id
      left join (
        select entry_id, sum(settled) as settled from cb_settled group by entry_id
      ) s on s.entry_id = ce.entry_id
     where ce.has_control
       and ce.control_net <> 0
  ),
  cb_reversed_accrual as (
    select ce.entry_id
      from cb_entry ce
     where not ce.has_control
       and not ce.has_cash
       and ce.has_accrual
       and ce.reverses_id is null
       and exists (
         select 1 from journal_entries r where r.reverses_id = ce.entry_id and r.status = 'posted'
       )
  ),
  cb_left_out as (
    select entry_id from cb_reversed_accrual
    union
    select r.id
      from journal_entries r
      join cb_reversed_accrual o on o.entry_id = r.reverses_id
     where r.status = 'posted'
  )
  select l.id::text as line_key,
         l.entry_id,
         l.line_no::bigint as line_no,
         l.account_id,
         l.debit_cents,
         l.credit_cents,
         l.channel_id,
         l.product_id,
         l.customer_id,
         l.vendor_id,
         l.memo
    from journal_lines l
   where not exists (select 1 from cb_restated r where r.entry_id = l.entry_id)
     and not exists (select 1 from cb_left_out o where o.entry_id = l.entry_id)
  union all
  select own.line_key,
         own.entry_id,
         own.line_no,
         own.account_id,
         greatest(own.amount, 0),
         greatest(-own.amount, 0),
         own.channel_id,
         own.product_id,
         own.customer_id,
         own.vendor_id,
         own.memo
    from (
      select l.id::text as line_key,
             l.entry_id,
             l.line_no::bigint as line_no,
             l.account_id,
             l.channel_id,
             l.product_id,
             l.customer_id,
             l.vendor_id,
             l.memo,
             (case
                -- A document's receivable or payable leg is replaced in full by what it settled.
                when ca.is_control and r.is_document then 0
                -- A payment's unapplied remainder stays on the control account.
                when ca.is_control then
                  round((sum(l.debit_cents - l.credit_cents) over own_side)::numeric
                        * (abs(r.control_net) - r.settled) / abs(r.control_net))
                  - round((sum(l.debit_cents - l.credit_cents) over own_side
                           - (l.debit_cents - l.credit_cents))::numeric
                          * (abs(r.control_net) - r.settled) / abs(r.control_net))
                -- A document counts only as far as it has been applied.
                when r.is_document then
                  round((sum(l.debit_cents - l.credit_cents) over own_side)::numeric
                        * r.settled / abs(r.control_net))
                  - round((sum(l.debit_cents - l.credit_cents) over own_side
                           - (l.debit_cents - l.credit_cents))::numeric
                          * r.settled / abs(r.control_net))
                -- The money a payment moved is what it moved.
                else l.debit_cents - l.credit_cents
              end)::bigint as amount
        from journal_lines l
        join cb_restated r on r.entry_id = l.entry_id
        join cb_account ca on ca.id = l.account_id
      window own_side as (
        partition by l.entry_id, ca.is_control order by l.line_no rows unbounded preceding
      )
    ) own
   where own.amount <> 0
  union all
  select rep.line_key,
         rep.entry_id,
         rep.line_no,
         rep.account_id,
         greatest(rep.amount, 0),
         greatest(-rep.amount, 0),
         rep.channel_id,
         rep.product_id,
         rep.customer_id,
         rep.vendor_id,
         rep.memo
    from (
      select s.entry_id::text || ':' || dl.id::text as line_key,
             s.entry_id,
             (${REPLACEMENT_LINE_BASE}
               + row_number() over (partition by s.entry_id order by s.document_id, dl.line_no))::bigint
               as line_no,
             dl.account_id,
             dl.channel_id,
             dl.product_id,
             dl.customer_id,
             dl.vendor_id,
             dl.memo,
             -- The settled share of each of the document's own lines, signed so the parts sum to
             -- exactly the control-account amount they stand in for.
             (round((sign(s.control_net) * s.settled)::numeric
                    * (sum(dl.debit_cents - dl.credit_cents) over doc_side) / (-doc.control_net))
              - round((sign(s.control_net) * s.settled)::numeric
                      * (sum(dl.debit_cents - dl.credit_cents) over doc_side
                         - (dl.debit_cents - dl.credit_cents)) / (-doc.control_net)))::bigint
               as amount
        from cb_settled s
        join cb_entry doc on doc.entry_id = s.document_id
        join journal_lines dl on dl.entry_id = s.document_id
        join cb_account da on da.id = dl.account_id and not da.is_control
      window doc_side as (
        partition by s.entry_id, s.document_id order by dl.line_no rows unbounded preceding
      )
    ) rep
   where rep.amount <> 0
)`;

/**
 * A derived table, to be written as `from ${basisLinesSql(basis)} l`, with the
 * columns line_key (unique; stands in for `id`), entry_id, line_no (orders the
 * lines within an entry), account_id, debit_cents, credit_cents, channel_id,
 * product_id, customer_id, vendor_id and memo. Only lines of posted entries are meaningful;
 * callers join `journal_entries` and filter on `status = 'posted'` as they
 * always have.
 */
export function basisLinesSql(basis: AccountingBasis): SQL {
  return basis === 'cash' ? CASH_LINES : ACCRUAL_LINES;
}

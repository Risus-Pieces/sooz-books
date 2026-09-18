-- ---------------------------------------------------------------------------
-- 0014 — bank intake corrections
--
-- 1. A bank-labelled "transfer" from an account that is not the company's is
--    outside money, not an internal transfer.
--
--    Relay writes `Receive-transfer` for money from *any* Relay account. The
--    importer used to write every such row with status `transfer`, which takes it
--    out of the review queue; for a row whose counterparty is not one of the
--    company's accounts there is no other leg for the ledger to post against, so
--    the inflow would never reach the books. The importer now writes `transfer`
--    only when the other leg was found or the named account is the company's
--    (src/lib/banking/import.ts, `isInternalTransfer`).
--
--    This puts back into the review queue the rows the old rule already wrote:
--    status `transfer`, never paired, never reviewed, posted or reconciled, whose
--    stored reasoning names a counterparty account that is not in `bank_accounts`.
--    In the live data that is exactly one row: 2026-04-30 +$4.55 "TRANSFER" on
--    ••9726 from #3474.
--
-- 2. Square is a payout provider.
--
--    Square settlements are Sooz's only revenue source. `payout_imports` could not
--    record one: the enum had shopify, amazon, faire, stripe, paypal and other.
--    `other` would make Square share a (provider, external_id) uniqueness space
--    with every future unnamed processor. The label is appended, so the existing
--    labels keep their order (src/db/schema/channels.ts declares the same list).
--    Adding an enum label inside a transaction is allowed; it is not used here.
-- ---------------------------------------------------------------------------

update bank_transactions bt
   set status = 'unreviewed',
       suggestion_confidence = 0.300,
       suggestion_reasoning =
         'The bank labelled this a transfer, but not between the company''s own accounts: '
         || 'the counterparty account #' || substring(bt.suggestion_reasoning from 'counterparty account #([0-9]+)')
         || ' is not one of the company''s bank accounts, so this is money '
         || case when bt.amount_cents > 0 then 'from' else 'to' end
         || ' outside the company and needs a human to classify it. '
         || '(Reset from status transfer by migration 0014.)'
 where bt.status = 'transfer'
   and bt.transfer_pair_id is null
   and bt.reviewed_at is null
   and bt.journal_entry_id is null
   and bt.reconciliation_id is null
   and bt.suggestion_reasoning ~ 'counterparty account #[0-9]+'
   and not exists (
         select 1
           from bank_accounts ba
          where ba.mask = substring(bt.suggestion_reasoning from 'counterparty account #([0-9]+)')
       );

alter type payout_provider add value if not exists 'square';

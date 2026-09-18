/**
 * Which journal entries the ledger screen may reverse on its own.
 *
 * Most entries are raised by a module that keeps its own record of them: a bank
 * row points at the entry it posted, a receipt at its receipt entry, a Square
 * settlement at its settlement entry, a COGS batch at its relief. Reversing one
 * of those from the ledger would undo the money while the module's record still
 * says "posted" — the bank row would sit in the Posted tab forever, the invoice
 * would stay paid. So those entries are corrected only through the module that
 * owns them, which reverses the entry and updates its own record in the same
 * transaction.
 *
 * The entries below have no such record (or, for opening balances, one that
 * already treats a reversed entry as "not posted"), so the ledger may reverse
 * them directly. The database enforces the same list (0041): a reversal of any
 * other entry must be made by the owning module.
 *
 * Pure: safe to import from client components.
 */

/** Source types the ledger screen may reverse without the owning module. */
export const LEDGER_REVERSIBLE_SOURCES: readonly string[] = Object.freeze([
  'manual',
  'recurring',
  'opening_balance',
  'inventory',
]);

export interface SourceOwner {
  /** The part of the product that owns the entry. */
  module: string;
  /** Where, in words, the owner undoes it. */
  howToUndo: string;
}

const OWNERS: Readonly<Record<string, SourceOwner>> = Object.freeze({
  bank: { module: 'Banking', howToUndo: 'unpost it from the Posted tab of the bank review queue' },
  payout: { module: 'Channels', howToUndo: 'unpost the settlement from Channels' },
  invoice: { module: 'Sales', howToUndo: 'void the invoice' },
  receipt: { module: 'Sales', howToUndo: 'void the receipt' },
  credit_memo: { module: 'Sales', howToUndo: 'void the credit memo' },
  bill: { module: 'Purchases', howToUndo: 'void the bill' },
  bill_payment: { module: 'Purchases', howToUndo: 'void the bill payment' },
  vendor_credit: { module: 'Purchases', howToUndo: 'void the vendor credit' },
  cogs: { module: 'Inventory', howToUndo: 'reverse the COGS batch' },
  landed_cost: { module: 'Inventory', howToUndo: 'reopen the production run' },
  deduction: { module: 'Trade', howToUndo: 'correct the deduction in Trade' },
  accrual: { module: 'Trade', howToUndo: 'release the accrual in Trade' },
  sales_tax: { module: 'Sales tax', howToUndo: 'correct the sales tax filing' },
});

/** Whether the ledger screen may reverse an entry of this source type itself. */
export function isLedgerReversible(sourceType: string): boolean {
  return LEDGER_REVERSIBLE_SOURCES.includes(sourceType);
}

/** Who owns an entry of this source type; a generic owner for one not listed. */
export function sourceOwner(sourceType: string): SourceOwner {
  return (
    OWNERS[sourceType] ?? {
      module: 'the module that posted it',
      howToUndo: 'undo it from the document that raised it',
    }
  );
}

/** The sentence the UI shows when the ledger refuses to reverse an owned entry. */
export function ownedEntryMessage(entryNo: number | null, sourceType: string): string {
  const owner = sourceOwner(sourceType);
  const which = entryNo === null ? 'This entry' : `Entry #${entryNo}`;
  return (
    `${which} belongs to ${owner.module}. To undo it, ${owner.howToUndo}, ` +
    `so its record and the ledger change together.`
  );
}

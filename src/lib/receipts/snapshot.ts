import type { CardSnapshot } from './interpret';
import type { Payer } from './payers';
import type { ProposalView } from './types';

/** A card as the model is shown it: plain data, with the payer by name. */
export function cardSnapshot(view: ProposalView, payers: readonly Payer[]): CardSnapshot {
  return {
    vendorName: view.vendorName,
    date: view.date,
    totalCents: view.totalCents,
    payerName: payers.find((p) => p.userId === view.payerId)?.name ?? null,
    lines: view.lines.map((line) => ({
      description: line.description,
      cents: line.cents,
      accountLabel: line.accountLabel,
    })),
  };
}

/**
 * Sooz Books — internal transfers and card refunds.
 *
 * Both things this module finds share one property: **they are not income and they
 * are not expense.** Money moving between two of the company's own accounts is a
 * balance-sheet shuffle, and a card refund is an expense coming back, not revenue
 * arriving. Left to the naive reading of a statement — "positive amount, therefore
 * income" — either one inflates the P&L with money the company never earned.
 *
 * Two detectors, in order of how much they can be trusted:
 *
 *   1. **The bank said so.** Relay labels internal movements `Spend-transfer` and
 *      `Receive-transfer`. That label is evidence no heuristic can match, so it is
 *      used first and pairs found this way carry `autoApplicable: true`.
 *   2. **The shape says so.** Equal magnitude, opposite sign, two different accounts
 *      of the same company, dates within a window. This is what every other bank
 *      needs, and it is a guess: a $50 payment to a supplier on the same day a
 *      customer pays $50 has exactly this shape. Pairs found this way are
 *      **proposed and never auto-applied**.
 *
 * Nothing here writes. `transfer_pair_id` is set by the caller, on both sides, once
 * a human — or an unambiguous bank label — has approved it.
 */

import { daysBetween } from '@/lib/dates';

import { normalizeDescription } from './normalize';
import type { CategorizableTxn } from './rules';

/** A transaction that can be pointed at: pairing needs identity on both sides. */
export interface IdentifiedTxn extends CategorizableTxn {
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Bank labels
// ---------------------------------------------------------------------------

/** Source transaction types that mean "money left for another account of ours". */
const OUTBOUND_TRANSFER_TYPES: ReadonlySet<string> = new Set([
  'spend-transfer',
  'transfer-out',
  'internal transfer out',
]);

/** Source transaction types that mean "money arrived from another account of ours". */
const INBOUND_TRANSFER_TYPES: ReadonlySet<string> = new Set([
  'receive-transfer',
  'transfer-in',
  'internal transfer in',
]);

export type TransferSide = 'out' | 'in';

/**
 * The side the source's own type label claims, or null when the source did not
 * label this row as an internal transfer.
 *
 * The label is trusted over the amount's sign; a bank that disagrees with itself is
 * a fact worth surfacing rather than papering over, and the pairing step checks
 * the signs independently.
 */
export function labelledTransferSide(txn: CategorizableTxn): TransferSide | null {
  const type = (txn.type ?? '').trim().toLowerCase();
  if (type === '') return null;
  if (OUTBOUND_TRANSFER_TYPES.has(type)) return 'out';
  if (INBOUND_TRANSFER_TYPES.has(type)) return 'in';
  return null;
}

export function isLabelledTransfer(txn: CategorizableTxn): boolean {
  return labelledTransferSide(txn) !== null;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type TransferBasis = 'bank_labelled' | 'amount_and_date';

export interface TransferPair {
  readonly outgoing: IdentifiedTxn;
  readonly incoming: IdentifiedTxn;
  /** The absolute amount moved, in cents. */
  readonly amountCents: number;
  readonly basis: TransferBasis;
  readonly confidence: number;
  /**
   * True only when the bank itself labelled both sides. An `amount_and_date` pair
   * is a proposal: the caller shows it and waits.
   */
  readonly autoApplicable: boolean;
  readonly evidence: readonly string[];
}

export type UnpairedReason = 'no_counterpart' | 'counterpart_outside_window';

/** A row the bank called a transfer, for which no other side turned up. */
export interface UnpairedTransfer {
  readonly txn: IdentifiedTxn;
  readonly side: TransferSide;
  readonly reason: UnpairedReason;
  /**
   * True when the row names a counterparty account and it is **not** one of the
   * company's own (`bankAccountMasks` was supplied and does not contain it). Relay
   * labels a transfer from any Relay account `Receive-transfer`, including one that
   * belongs to somebody else: that money came from outside the company and is not
   * an internal transfer at all.
   */
  readonly counterpartyOutsideCompany: boolean;
  readonly evidence: readonly string[];
}

export interface CardRefund {
  readonly txn: IdentifiedTxn;
  /** Absolute amount refunded, in cents. */
  readonly amountCents: number;
  /** The charge this reverses, when one could be found. */
  readonly original: IdentifiedTxn | null;
  readonly confidence: number;
  readonly evidence: readonly string[];
}

export interface TransferDetection {
  readonly pairs: readonly TransferPair[];
  readonly unpaired: readonly UnpairedTransfer[];
  readonly cardRefunds: readonly CardRefund[];
  /** txn id → the pair it belongs to. */
  readonly pairByTxnId: ReadonlyMap<string, TransferPair>;
  /** txn id → the unpaired bank-labelled transfer it is. */
  readonly unpairedByTxnId: ReadonlyMap<string, UnpairedTransfer>;
  /** txn id → the card refund it is. */
  readonly cardRefundByTxnId: ReadonlyMap<string, CardRefund>;
}

export interface TransferOptions {
  /** How far apart the two sides of a transfer may be dated. */
  readonly windowDays?: number;
  /** How far back to look for the charge a card refund reverses. */
  readonly refundLookbackDays?: number;
  /** What marks a reference as a card transaction. */
  readonly cardReferencePattern?: RegExp;
  /** bank account id → statement mask, used as corroborating evidence when known. */
  readonly bankAccountMasks?: ReadonlyMap<string, string | null>;
  /** Transactions already carrying a `transfer_pair_id`; never re-paired. */
  readonly alreadyPairedTxnIds?: ReadonlySet<string>;
  /**
   * Whether to run the amount-and-date guess on rows the bank did not label.
   *
   * Left unset it decides for itself: if *any* row in the batch carries a transfer
   * label, the source is one that labels transfers, and guessing at the rest would
   * only manufacture false pairs out of a supplier payment and a customer deposit
   * that happen to be the same size. Sources that never label — most bank CSVs —
   * get the fallback automatically.
   */
  readonly inferUnlabelled?: boolean;
}

const DEFAULT_WINDOW_DAYS = 3;
const DEFAULT_REFUND_LOOKBACK_DAYS = 90;
/** Relay writes `Corporate Card - 1892 (Business Card)`; other banks just say "card". */
const DEFAULT_CARD_REFERENCE = /\bcard\b/i;

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

function absDays(a: string, b: string): number {
  return Math.abs(daysBetween(a, b));
}

function maskOf(
  txn: IdentifiedTxn,
  masks: ReadonlyMap<string, string | null> | undefined,
): string | null {
  return masks?.get(txn.bankAccountId) ?? null;
}

/** Does each side's stated counterparty account point at the other's account? */
function masksCorroborate(
  a: IdentifiedTxn,
  b: IdentifiedTxn,
  masks: ReadonlyMap<string, string | null> | undefined,
): boolean {
  const aMask = maskOf(a, masks);
  const bMask = maskOf(b, masks);
  if (aMask === null || bMask === null) return false;
  const aClaims = (a.counterpartyMask ?? '').trim();
  const bClaims = (b.counterpartyMask ?? '').trim();
  return aClaims === bMask && bClaims === aMask;
}

function scoreLabelledPair(
  outgoing: IdentifiedTxn,
  incoming: IdentifiedTxn,
  masks: ReadonlyMap<string, string | null> | undefined,
): { confidence: number; evidence: string[] } {
  const evidence: string[] = [
    `both sides are labelled by the bank (${outgoing.type ?? '?'} / ${incoming.type ?? '?'})`,
    `equal and opposite amounts (${outgoing.amountCents} / ${incoming.amountCents} cents)`,
    'different bank accounts of the same company',
  ];
  let confidence = 0.9;

  const apart = absDays(outgoing.txnDate, incoming.txnDate);
  if (apart === 0) {
    confidence += 0.05;
    evidence.push(`same date (${outgoing.txnDate})`);
  } else {
    evidence.push(`${apart} day(s) apart (${outgoing.txnDate} / ${incoming.txnDate})`);
  }

  if (masksCorroborate(outgoing, incoming, masks)) {
    confidence += 0.04;
    evidence.push(
      `each side names the other's account (#${outgoing.counterpartyMask} / #${incoming.counterpartyMask})`,
    );
  }

  return { confidence: Math.min(0.99, Number(confidence.toFixed(3))), evidence };
}

function scoreHeuristicPair(
  outgoing: IdentifiedTxn,
  incoming: IdentifiedTxn,
  windowDays: number,
): { confidence: number; evidence: string[] } {
  const apart = absDays(outgoing.txnDate, incoming.txnDate);
  const confidence = Number(Math.max(0.5, 0.75 - 0.05 * apart).toFixed(3));
  return {
    confidence,
    evidence: [
      'neither side is labelled a transfer by the bank — this pairing is a proposal',
      `equal and opposite amounts (${outgoing.amountCents} / ${incoming.amountCents} cents)`,
      'different bank accounts of the same company',
      `${apart} day(s) apart, within the ${windowDays}-day window`,
    ],
  };
}

/**
 * Finds internal transfer pairs and card refunds across one batch of transactions.
 *
 * The batch should be every transaction in scope — both sides of a transfer are
 * usually in different files, so an importer that only ever hands this function one
 * account's rows will never pair anything.
 */
export function detectTransfers(
  txns: readonly IdentifiedTxn[],
  options: TransferOptions = {},
): TransferDetection {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const masks = options.bankAccountMasks;
  const alreadyPaired = options.alreadyPairedTxnIds ?? new Set<string>();

  const claimed = new Set<string>(alreadyPaired);
  const pairs: TransferPair[] = [];
  const unpaired: UnpairedTransfer[] = [];

  // Stable ordering: date then id, so the same batch always pairs the same way.
  const ordered = [...txns].sort(
    (a, b) => a.txnDate.localeCompare(b.txnDate) || a.id.localeCompare(b.id),
  );

  function findCounterpart(
    source: IdentifiedTxn,
    pool: readonly IdentifiedTxn[],
  ): IdentifiedTxn | null {
    let best: IdentifiedTxn | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of pool) {
      if (claimed.has(candidate.id)) continue;
      if (candidate.id === source.id) continue;
      if (candidate.bankAccountId === source.bankAccountId) continue;
      if (Math.abs(candidate.amountCents) !== Math.abs(source.amountCents)) continue;
      if (Math.sign(candidate.amountCents) === Math.sign(source.amountCents)) continue;
      const distance = absDays(source.txnDate, candidate.txnDate);
      if (distance > windowDays) continue;
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  // ---- 1. bank-labelled transfers -----------------------------------------
  const labelledOut = ordered.filter((txn) => labelledTransferSide(txn) === 'out');
  const labelledIn = ordered.filter((txn) => labelledTransferSide(txn) === 'in');

  for (const outgoing of labelledOut) {
    if (claimed.has(outgoing.id)) continue;
    const incoming = findCounterpart(outgoing, labelledIn);
    if (incoming === null) continue;
    claimed.add(outgoing.id);
    claimed.add(incoming.id);
    const { confidence, evidence } = scoreLabelledPair(outgoing, incoming, masks);
    pairs.push({
      outgoing,
      incoming,
      amountCents: Math.abs(outgoing.amountCents),
      basis: 'bank_labelled',
      confidence,
      autoApplicable: true,
      evidence,
    });
  }

  const companyMasks = new Set(
    [...(masks?.values() ?? [])]
      .map((mask) => (mask ?? '').trim())
      .filter((mask) => mask !== ''),
  );

  for (const txn of [...labelledOut, ...labelledIn]) {
    if (claimed.has(txn.id)) continue;
    const side = labelledTransferSide(txn);
    if (side === null) continue;
    const evidence = [
      `the bank labelled this row ${JSON.stringify(txn.type ?? '')}, but no matching row is in this batch`,
    ];
    const claimedMask = (txn.counterpartyMask ?? '').trim();
    const counterpartyOutsideCompany =
      claimedMask !== '' && companyMasks.size > 0 && !companyMasks.has(claimedMask);
    if (claimedMask !== '') {
      evidence.push(
        counterpartyOutsideCompany
          ? `the row names counterparty account #${claimedMask}, which is not one of the company's bank accounts`
          : `the row names counterparty account #${claimedMask}`,
      );
    }
    unpaired.push({ txn, side, reason: 'no_counterpart', counterpartyOutsideCompany, evidence });
  }

  // ---- 2. generic fallback for banks that do not label ---------------------
  const sourceLabelsTransfers = labelledOut.length > 0 || labelledIn.length > 0;
  const inferUnlabelled = options.inferUnlabelled ?? !sourceLabelsTransfers;

  if (inferUnlabelled) {
    const unlabelled = ordered.filter((txn) => labelledTransferSide(txn) === null);
    const unlabelledOut = unlabelled.filter((txn) => txn.amountCents < 0);
    const unlabelledIn = unlabelled.filter((txn) => txn.amountCents > 0);

    for (const outgoing of unlabelledOut) {
      if (claimed.has(outgoing.id)) continue;
      const incoming = findCounterpart(outgoing, unlabelledIn);
      if (incoming === null) continue;
      claimed.add(outgoing.id);
      claimed.add(incoming.id);
      const { confidence, evidence } = scoreHeuristicPair(outgoing, incoming, windowDays);
      pairs.push({
        outgoing,
        incoming,
        amountCents: Math.abs(outgoing.amountCents),
        basis: 'amount_and_date',
        confidence,
        autoApplicable: false,
        evidence,
      });
    }
  }

  const cardRefunds = detectCardRefunds(ordered, options);

  const pairByTxnId = new Map<string, TransferPair>();
  for (const pair of pairs) {
    pairByTxnId.set(pair.outgoing.id, pair);
    pairByTxnId.set(pair.incoming.id, pair);
  }
  const unpairedByTxnId = new Map<string, UnpairedTransfer>(
    unpaired.map((entry) => [entry.txn.id, entry]),
  );
  const cardRefundByTxnId = new Map<string, CardRefund>(
    cardRefunds.map((refund) => [refund.txn.id, refund]),
  );

  return { pairs, unpaired, cardRefunds, pairByTxnId, unpairedByTxnId, cardRefundByTxnId };
}

// ---------------------------------------------------------------------------
// Card refunds
// ---------------------------------------------------------------------------

/**
 * Finds money arriving on a card, which is an expense reversal rather than income.
 *
 * A rule keyed on "the transaction type is Receive" cannot tell these apart from a
 * customer deposit; the card marker in the reference is what distinguishes them.
 * The original charge is looked for by payee and equal magnitude, nearest first,
 * within the lookback window — and a refund with no original found is still
 * reported, because "this is a refund and I could not find what it reverses" is the
 * thing a bookkeeper needs to be told.
 */
export function detectCardRefunds(
  txns: readonly IdentifiedTxn[],
  options: TransferOptions = {},
): readonly CardRefund[] {
  const pattern = options.cardReferencePattern ?? DEFAULT_CARD_REFERENCE;
  const lookback = options.refundLookbackDays ?? DEFAULT_REFUND_LOOKBACK_DAYS;

  const ordered = [...txns].sort(
    (a, b) => a.txnDate.localeCompare(b.txnDate) || a.id.localeCompare(b.id),
  );
  const charges = ordered.filter((txn) => txn.amountCents < 0 && !isLabelledTransfer(txn));
  const consumed = new Set<string>();
  const refunds: CardRefund[] = [];

  for (const txn of ordered) {
    if (txn.amountCents <= 0) continue;
    if (isLabelledTransfer(txn)) continue;
    const reference = txn.reference ?? '';
    if (reference === '' || !pattern.test(reference)) continue;

    const payeeKey = normalizeDescription(txn.payee);
    const magnitude = Math.abs(txn.amountCents);

    let original: IdentifiedTxn | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const charge of charges) {
      if (consumed.has(charge.id)) continue;
      if (Math.abs(charge.amountCents) !== magnitude) continue;
      if (normalizeDescription(charge.payee) !== payeeKey) continue;
      // Refunds follow their charge; a "charge" dated after the refund is a
      // different purchase that happens to cost the same.
      const distance = daysBetween(charge.txnDate, txn.txnDate);
      if (distance < 0 || distance > lookback) continue;
      if (distance < bestDistance) {
        original = charge;
        bestDistance = distance;
      }
    }

    const evidence = [
      `money in on a card reference (${JSON.stringify(reference)}) — an expense reversal, not income`,
    ];
    let confidence = 0.8;
    if (original !== null) {
      consumed.add(original.id);
      evidence.push(
        `reverses the ${original.txnDate} charge of ${original.amountCents} cents to the same payee, ${bestDistance} day(s) earlier`,
      );
      confidence = bestDistance === 0 ? 0.95 : 0.9;
    } else {
      evidence.push(
        `no charge of ${magnitude} cents to this payee in the previous ${lookback} days — the original needs to be found by hand`,
      );
    }

    refunds.push({ txn, amountCents: magnitude, original, confidence, evidence });
  }

  return refunds;
}

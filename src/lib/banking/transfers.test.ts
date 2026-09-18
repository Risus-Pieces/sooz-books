import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';

import { parseDateInput } from '@/lib/dates';
import { parseMoney } from '@/lib/money';

import {
  detectCardRefunds,
  detectTransfers,
  isLabelledTransfer,
  labelledTransferSide,
  type IdentifiedTxn,
} from './transfers';

// ---------------------------------------------------------------------------
// The real statements
// ---------------------------------------------------------------------------

const RELAY_DIR = fileURLToPath(new URL('../../../data/statements/relay', import.meta.url));

interface RelayRow {
  readonly Date: string;
  readonly Payee: string;
  readonly 'Account #': string;
  readonly 'Transaction Type': string;
  readonly Description: string;
  readonly Reference: string;
  readonly Status: string;
  readonly Amount: string;
}

function loadRelayTxns(): IdentifiedTxn[] {
  if (!existsSync(RELAY_DIR)) return [];
  const out: IdentifiedTxn[] = [];
  for (const file of readdirSync(RELAY_DIR).filter((f) => f.endsWith('.csv')).sort()) {
    const mask = /#(\d{4})/.exec(file)?.[1] ?? 'unknown';
    const parsed = Papa.parse<RelayRow>(readFileSync(`${RELAY_DIR}/${file}`, 'utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    parsed.data.forEach((row, index) => {
      if (!row.Date) return;
      out.push({
        id: `${file}#${index}`,
        bankAccountId: `acct-${mask}`,
        txnDate: parseDateInput(row.Date),
        payee: row.Payee === '' ? null : row.Payee,
        description: row.Description === '' ? null : row.Description,
        reference: row.Reference === '' ? null : row.Reference,
        type: row['Transaction Type'],
        amountCents: parseMoney(row.Amount),
        status: row.Status,
        counterpartyMask: row['Account #'] === '' ? null : row['Account #'],
      });
    });
  }
  return out;
}

const RELAY_TXNS = loadRelayTxns();

/** bank account id → statement mask, as the importer would supply it. */
const MASKS = new Map<string, string | null>([
  ['acct-9726', '9726'],
  ['acct-9727', '9727'],
  ['acct-9972', '9972'],
  ['acct-9973', '9973'],
]);

function find(date: string, amountCents: number): IdentifiedTxn {
  const hit = RELAY_TXNS.find((t) => t.txnDate === date && t.amountCents === amountCents);
  if (hit === undefined) throw new Error(`no real transaction on ${date} for ${amountCents} cents`);
  return hit;
}

// ---------------------------------------------------------------------------
// Bank labels
// ---------------------------------------------------------------------------

describe('bank transfer labels', () => {
  it('reads the Relay labels', () => {
    expect(labelledTransferSide({ ...base(), type: 'Spend-transfer' })).toBe('out');
    expect(labelledTransferSide({ ...base(), type: 'Receive-transfer' })).toBe('in');
    expect(labelledTransferSide({ ...base(), type: 'receive-transfer' })).toBe('in');
    expect(labelledTransferSide({ ...base(), type: 'Spend' })).toBeNull();
    expect(labelledTransferSide({ ...base(), type: 'Receive' })).toBeNull();
    expect(labelledTransferSide({ ...base(), type: null })).toBeNull();
    expect(isLabelledTransfer({ ...base(), type: 'Spend-transfer' })).toBe(true);
  });
});

function base(overrides: Partial<IdentifiedTxn> = {}): IdentifiedTxn {
  return {
    id: 'x',
    bankAccountId: 'acct-9726',
    txnDate: '2026-05-14',
    payee: 'Someone',
    description: null,
    reference: null,
    type: 'Spend',
    amountCents: -5000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The real transfers
// ---------------------------------------------------------------------------

describe('real Relay transfers', () => {
  it('has the statement fixtures on disk', () => {
    expect(existsSync(RELAY_DIR), `real Relay statements are missing from ${RELAY_DIR}`).toBe(true);
    expect(RELAY_TXNS).toHaveLength(110);
  });

  it('pairs the 2026-05-14 Owner’s Comp / Operating Expenses transfer', () => {
    const detection = detectTransfers(RELAY_TXNS, { bankAccountMasks: MASKS });
    expect(detection.pairs).toHaveLength(1);
    const pair = detection.pairs[0];

    expect(pair.basis).toBe('bank_labelled');
    expect(pair.autoApplicable).toBe(true);
    expect(pair.amountCents).toBe(5000);
    expect(pair.outgoing.txnDate).toBe('2026-05-14');
    expect(pair.outgoing.bankAccountId).toBe('acct-9973');
    expect(pair.outgoing.payee).toBe('Operating Expenses');
    expect(pair.outgoing.type).toBe('Spend-transfer');
    expect(pair.outgoing.amountCents).toBe(-5000);
    expect(pair.incoming.txnDate).toBe('2026-05-14');
    expect(pair.incoming.bankAccountId).toBe('acct-9726');
    expect(pair.incoming.payee).toBe("Owner's Comp");
    expect(pair.incoming.type).toBe('Receive-transfer');
    expect(pair.incoming.amountCents).toBe(5000);

    // Same day, and each side names the other's account: as certain as it gets.
    expect(pair.confidence).toBe(0.99);
    expect(pair.evidence.join(' | ')).toMatch(/each side names the other's account/);

    expect(detection.pairByTxnId.get(pair.outgoing.id)).toBe(pair);
    expect(detection.pairByTxnId.get(pair.incoming.id)).toBe(pair);
  });

  it('scores the same pair lower when the account masks are not supplied', () => {
    const detection = detectTransfers(RELAY_TXNS);
    expect(detection.pairs).toHaveLength(1);
    expect(detection.pairs[0].confidence).toBe(0.95);
  });

  it('reports the 2026-04-30 +4.55 transfer as labelled but unpairable', () => {
    const detection = detectTransfers(RELAY_TXNS, { bankAccountMasks: MASKS });
    expect(detection.unpaired).toHaveLength(1);
    const orphan = detection.unpaired[0];

    expect(orphan.txn.txnDate).toBe('2026-04-30');
    expect(orphan.txn.amountCents).toBe(455);
    expect(orphan.txn.payee).toBeNull();
    expect(orphan.txn.type).toBe('Receive-transfer');
    expect(orphan.side).toBe('in');
    expect(orphan.reason).toBe('no_counterpart');
    // #3474 is not one of the four Relay accounts, so the other side is not in
    // this data at all — exactly the case a human has to resolve.
    expect(orphan.evidence.join(' | ')).toMatch(/#3474, which is not one of the company's bank accounts/);
    // So it is outside money, not an internal transfer: it must never be written as one.
    expect(orphan.counterpartyOutsideCompany).toBe(true);
    expect(detection.unpairedByTxnId.get(orphan.txn.id)).toBe(orphan);
  });

  it('cannot tell outside money from an unimported leg when no masks are supplied', () => {
    const orphan = detectTransfers(RELAY_TXNS).unpaired[0];
    expect(orphan.counterpartyOutsideCompany).toBe(false);
  });

  it('proposes nothing else: Relay labels its transfers, so nothing is guessed', () => {
    const detection = detectTransfers(RELAY_TXNS, { bankAccountMasks: MASKS });
    expect(detection.pairs.filter((p) => p.basis === 'amount_and_date')).toHaveLength(0);
    expect(detection.pairs.every((p) => p.autoApplicable)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real card refunds
// ---------------------------------------------------------------------------

describe('real card refunds', () => {
  it('finds all three Amazon refunds and none of the other deposits', () => {
    const detection = detectTransfers(RELAY_TXNS, { bankAccountMasks: MASKS });
    const refunds = [...detection.cardRefunds].sort((a, b) =>
      a.txn.txnDate.localeCompare(b.txn.txnDate),
    );

    expect(refunds.map((r) => [r.txn.txnDate, r.amountCents])).toEqual([
      ['2026-02-08', 3831],
      ['2026-04-26', 607],
      ['2026-07-20', 1499],
    ]);
    expect(refunds.every((r) => r.txn.payee === 'Amazon')).toBe(true);

    // Nothing else that came in is a refund: the Square payouts, the ACH pulls
    // from the owner's personal accounts and the returned Google ACH all carry
    // references with no card in them.
    const deposits = RELAY_TXNS.filter((t) => t.amountCents > 0);
    expect(deposits.length).toBeGreaterThan(refunds.length);
    for (const refund of refunds) expect(refund.txn.reference).toMatch(/Corporate Card/);
  });

  it('ties the 2026-02-08 +38.31 refund to the 2026-02-03 charge', () => {
    const detection = detectTransfers(RELAY_TXNS);
    const refund = detection.cardRefundByTxnId.get(find('2026-02-08', 3831).id);
    expect(refund).toBeDefined();
    expect(refund?.original?.txnDate).toBe('2026-02-03');
    expect(refund?.original?.amountCents).toBe(-3831);
    expect(refund?.confidence).toBe(0.9);
    expect(refund?.evidence.join(' | ')).toMatch(/expense reversal, not income/);
  });

  it('ties the 2026-07-20 +14.99 refund to the same-day charge, not the February one', () => {
    const detection = detectTransfers(RELAY_TXNS);
    const refund = detection.cardRefundByTxnId.get(find('2026-07-20', 1499).id);
    expect(refund?.original?.txnDate).toBe('2026-07-20');
    expect(refund?.original?.amountCents).toBe(-1499);
    // A $14.99 Amazon charge also exists on 2026-02-02, 169 days earlier — well
    // outside the 90-day lookback, and further away in any case.
    expect(refund?.confidence).toBe(0.95);
  });

  it('reports the 2026-04-26 +6.07 refund with no original found', () => {
    const detection = detectTransfers(RELAY_TXNS);
    const refund = detection.cardRefundByTxnId.get(find('2026-04-26', 607).id);
    expect(refund).toBeDefined();
    expect(refund?.original).toBeNull();
    expect(refund?.confidence).toBe(0.8);
    expect(refund?.evidence.join(' | ')).toMatch(/needs to be found by hand/);
    expect(RELAY_TXNS.filter((t) => t.amountCents === -607)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The generic fallback, for banks that do not label transfers
// ---------------------------------------------------------------------------

describe('generic transfer inference', () => {
  const chase = (overrides: Partial<IdentifiedTxn>): IdentifiedTxn => ({
    ...base({ type: 'DEBIT', reference: null }),
    ...overrides,
  });

  it('pairs equal, opposite amounts across two accounts inside the window', () => {
    const out = chase({ id: 'a', bankAccountId: 'bank-1', txnDate: '2026-03-01', amountCents: -25000 });
    const into = chase({ id: 'b', bankAccountId: 'bank-2', txnDate: '2026-03-03', amountCents: 25000 });
    const detection = detectTransfers([out, into]);

    expect(detection.pairs).toHaveLength(1);
    const pair = detection.pairs[0];
    expect(pair.basis).toBe('amount_and_date');
    expect(pair.outgoing.id).toBe('a');
    expect(pair.incoming.id).toBe('b');
    expect(pair.confidence).toBe(0.65);
    // A guess is proposed, never applied.
    expect(pair.autoApplicable).toBe(false);
    expect(pair.evidence.join(' | ')).toMatch(/proposal/);
  });

  it('respects the window', () => {
    const out = chase({ id: 'a', bankAccountId: 'bank-1', txnDate: '2026-03-01', amountCents: -25000 });
    const into = chase({ id: 'b', bankAccountId: 'bank-2', txnDate: '2026-03-05', amountCents: 25000 });
    expect(detectTransfers([out, into]).pairs).toHaveLength(0);
    expect(detectTransfers([out, into], { windowDays: 4 }).pairs).toHaveLength(1);
  });

  it('never pairs two rows on the same bank account', () => {
    const out = chase({ id: 'a', bankAccountId: 'bank-1', txnDate: '2026-03-01', amountCents: -1000 });
    const into = chase({ id: 'b', bankAccountId: 'bank-1', txnDate: '2026-03-01', amountCents: 1000 });
    expect(detectTransfers([out, into]).pairs).toHaveLength(0);
  });

  it('never re-pairs a transaction that already has a pair', () => {
    const out = chase({ id: 'a', bankAccountId: 'bank-1', txnDate: '2026-03-01', amountCents: -1000 });
    const into = chase({ id: 'b', bankAccountId: 'bank-2', txnDate: '2026-03-01', amountCents: 1000 });
    const detection = detectTransfers([out, into], {
      alreadyPairedTxnIds: new Set(['b']),
    });
    expect(detection.pairs).toHaveLength(0);
  });

  it('claims each side once, choosing the nearest date', () => {
    const out = chase({ id: 'out', bankAccountId: 'bank-1', txnDate: '2026-03-02', amountCents: -1000 });
    const far = chase({ id: 'far', bankAccountId: 'bank-2', txnDate: '2026-03-04', amountCents: 1000 });
    const near = chase({ id: 'near', bankAccountId: 'bank-2', txnDate: '2026-03-02', amountCents: 1000 });
    const detection = detectTransfers([out, far, near]);
    expect(detection.pairs).toHaveLength(1);
    expect(detection.pairs[0].incoming.id).toBe('near');
  });

  it('stays out of the way when the source labels its own transfers', () => {
    // A supplier payment and a customer deposit of the same size, two days apart,
    // on two accounts. On a source that labels transfers this is emphatically not
    // one, and guessing would take $250 out of both revenue and expense.
    const spend = base({ id: 'spend', bankAccountId: 'bank-1', txnDate: '2026-03-01', amountCents: -25000, type: 'Spend' });
    const receive = base({ id: 'receive', bankAccountId: 'bank-2', txnDate: '2026-03-02', amountCents: 25000, type: 'Receive' });
    const labelled = base({ id: 'labelled', bankAccountId: 'bank-1', txnDate: '2026-03-09', amountCents: -100, type: 'Spend-transfer' });

    expect(detectTransfers([spend, receive, labelled]).pairs).toHaveLength(0);
    // …but the same rows from a source that never labels do get the guess.
    expect(detectTransfers([spend, receive]).pairs).toHaveLength(1);
    // …and it can always be forced either way.
    expect(detectTransfers([spend, receive, labelled], { inferUnlabelled: true }).pairs).toHaveLength(1);
    expect(detectTransfers([spend, receive], { inferUnlabelled: false }).pairs).toHaveLength(0);
  });

  it('reports a labelled transfer whose other side never arrived', () => {
    const lonely = base({ id: 'lonely', type: 'Spend-transfer', counterpartyMask: '4321' });
    const detection = detectTransfers([lonely]);
    expect(detection.pairs).toHaveLength(0);
    expect(detection.unpaired).toHaveLength(1);
    expect(detection.unpaired[0].side).toBe('out');
    expect(detection.unpaired[0].evidence.join(' | ')).toMatch(/#4321/);
  });
});

// ---------------------------------------------------------------------------
// Card refund detection, in isolation
// ---------------------------------------------------------------------------

describe('detectCardRefunds', () => {
  const card = 'Corporate Card - 1892 (Business Card)';

  it('ignores money in that did not arrive on a card', () => {
    const deposit = base({ id: 'd', amountCents: 16167, type: 'Receive', reference: 'SQ260126' });
    expect(detectCardRefunds([deposit])).toHaveLength(0);
  });

  it('ignores an internal transfer, however it arrived', () => {
    const transfer = base({ id: 't', amountCents: 5000, type: 'Receive-transfer', reference: card });
    expect(detectCardRefunds([transfer])).toHaveLength(0);
  });

  it('will not treat a later charge as the original', () => {
    const refund = base({ id: 'r', txnDate: '2026-03-01', amountCents: 2000, type: 'Receive', reference: card, payee: 'Target' });
    const later = base({ id: 'c', txnDate: '2026-03-05', amountCents: -2000, type: 'Spend', reference: card, payee: 'Target' });
    const [found] = detectCardRefunds([refund, later]);
    expect(found.original).toBeNull();
  });

  it('will not cross payees', () => {
    const refund = base({ id: 'r', txnDate: '2026-03-05', amountCents: 2000, type: 'Receive', reference: card, payee: 'Target' });
    const other = base({ id: 'c', txnDate: '2026-03-01', amountCents: -2000, type: 'Spend', reference: card, payee: 'Walmart' });
    expect(detectCardRefunds([refund, other])[0].original).toBeNull();
  });

  it('honours the lookback window', () => {
    const refund = base({ id: 'r', txnDate: '2026-06-01', amountCents: 2000, type: 'Receive', reference: card, payee: 'Target' });
    const old = base({ id: 'c', txnDate: '2026-01-01', amountCents: -2000, type: 'Spend', reference: card, payee: 'Target' });
    expect(detectCardRefunds([refund, old])[0].original).toBeNull();
    expect(detectCardRefunds([refund, old], { refundLookbackDays: 200 })[0].original?.id).toBe('c');
  });

  it('does not hand the same charge to two refunds', () => {
    const charge = base({ id: 'c', txnDate: '2026-03-01', amountCents: -2000, type: 'Spend', reference: card, payee: 'Target' });
    const first = base({ id: 'r1', txnDate: '2026-03-02', amountCents: 2000, type: 'Receive', reference: card, payee: 'Target' });
    const second = base({ id: 'r2', txnDate: '2026-03-03', amountCents: 2000, type: 'Receive', reference: card, payee: 'Target' });
    const refunds = detectCardRefunds([charge, first, second]);
    expect(refunds).toHaveLength(2);
    expect(refunds[0].original?.id).toBe('c');
    expect(refunds[1].original).toBeNull();
  });
});

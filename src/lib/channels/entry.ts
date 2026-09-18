/**
 * The journal entry a settlement posts, built from its lines. Pure — no database — so the
 * rules can be tested line by line; `./post` loads the lines and posts what this returns.
 */

import type { PayoutLineType } from '@/db/schema';
import type { DraftLine } from '@/lib/ledger/post';
import { formatMoney, sumCents } from '@/lib/money';

import { type AccountContext, type SettlementRole, accountForRole, clearingAccountFor, roleOfLine } from './accounts';
import { ChannelError } from './errors';

/** The pieces of a stored payout line the entry is built from. */
export interface EntryLineInput {
  readonly lineNo: number;
  readonly lineType: PayoutLineType;
  readonly amountCents: number;
  readonly description: string | null;
  /** `payout_lines.raw.accountRole`, when the importer recorded one. */
  readonly recordedRole: string | null;
}

export interface PayoutEntryPlan {
  /** Journal lines, one debit and/or one credit per account, clearing first. */
  readonly lines: readonly (DraftLine & { accountCode: string })[];
  readonly clearingAccountCode: string;
  /** What clearing is debited (positive) or credited (negative). */
  readonly clearingCents: number;
  /** Payout line number → the account code it posted to; `null` for facilitator tax. */
  readonly lineAccounts: ReadonlyMap<number, string | null>;
  /** Facilitator tax in the settlement, collected and withheld; never posted. */
  readonly facilitatorGrossCents: number;
  /** Lines routed to 7900 Ask My Accountant, which a human must reclassify. */
  readonly suspenseCents: number;
}

/**
 * The entry a settlement posts, from its lines. Pure: no database, so the rules can be
 * tested line by line.
 *
 * A positive line (money the channel owes Sooz) credits its account; a negative line debits
 * it. Debits and credits on one account are kept apart rather than netted, so gross sales
 * and a refund, or a fee and its reversal, stay visible. Clearing takes the net.
 *
 * @throws {ChannelError} `facilitator_not_netted` when facilitator tax does not net to zero;
 *   `unmapped_line` for a line with no account; `no_lines` when nothing would post.
 */
export function buildPayoutEntry(
  lines: readonly EntryLineInput[],
  ctx: AccountContext & { readonly channelId: string | null; readonly memo: string },
): PayoutEntryPlan {
  const clearing = clearingAccountFor(ctx);
  const lineAccounts = new Map<number, string | null>();
  const sides = new Map<string, { debit: number; credit: number; labels: Set<string> }>();
  let facilitatorNet = 0;
  let facilitatorGross = 0;
  let suspense = 0;

  for (const line of lines) {
    const role: SettlementRole = roleOfLine(line.lineType, line.recordedRole);
    const code = accountForRole(role, ctx);
    lineAccounts.set(line.lineNo, code);
    if (code === null) {
      facilitatorNet += line.amountCents;
      facilitatorGross += Math.abs(line.amountCents);
      continue;
    }
    if (line.amountCents === 0) continue;
    if (role === 'ask_my_accountant') suspense += line.amountCents;
    const side = sides.get(code) ?? { debit: 0, credit: 0, labels: new Set<string>() };
    if (line.amountCents > 0) side.credit += line.amountCents;
    else side.debit += -line.amountCents;
    if (line.description !== null) side.labels.add(line.description);
    sides.set(code, side);
  }

  if (facilitatorNet !== 0) {
    throw new ChannelError(
      'facilitator_not_netted',
      `Marketplace-facilitator tax in this settlement does not net to zero (${formatMoney(facilitatorNet)} left over). Facilitator tax is the marketplace's to remit and never posts, so the difference must be explained before the settlement can post.`,
      'Find the order whose tax was collected but not withheld (or the reverse) and recode that line as sales tax Sooz collected, naming its state.',
    );
  }

  const net = sumCents(lines.map((line) => line.amountCents));
  const journal: (DraftLine & { accountCode: string })[] = [];
  if (net !== 0) {
    journal.push({
      accountCode: clearing,
      ...(net > 0 ? { debitCents: net } : { creditCents: -net }),
      memo: ctx.memo,
      channelId: ctx.channelId,
    });
  }
  for (const [code, side] of sides) {
    const memo = [...side.labels].join('; ').slice(0, 480) || ctx.memo;
    if (side.debit > 0) journal.push({ accountCode: code, debitCents: side.debit, memo, channelId: ctx.channelId });
    if (side.credit > 0) journal.push({ accountCode: code, creditCents: side.credit, memo, channelId: ctx.channelId });
  }
  if (journal.length < 2) {
    throw new ChannelError('no_lines', 'This settlement has nothing to post: every line is zero or facilitator tax.');
  }

  return {
    lines: journal,
    clearingAccountCode: clearing,
    clearingCents: net,
    lineAccounts,
    facilitatorGrossCents: facilitatorGross,
    suspenseCents: suspense,
  };
}

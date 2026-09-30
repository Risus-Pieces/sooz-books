import { z } from 'zod';

import { type VendorIndex, resolveVendor } from '@/lib/banking/vendors';
import { type CalendarDate, isCalendarDate } from '@/lib/dates';
import { formatMoney, parseMoney, sumCents } from '@/lib/money';

import type { Payer } from './payers';
import { recomputeWarnings } from './propose';
import type { ProposalLine, ReceiptWarning } from './types';

/**
 * Everything a member can change about a card. The model produces these from a typed message;
 * the Paid by menu produces them directly. Either way, `applyEdit` is the only thing that acts on
 * one, and it can refuse.
 */
export const editSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('set_account'),
    line: z
      .union([z.number().int().min(1), z.literal('all')])
      .describe('The 1-based line number as shown on the card (the first line is 1), or "all".'),
    accountCode: z.string().describe('One code from the list of accounts you were given.'),
  }),
  z.object({
    kind: z.literal('set_payer'),
    who: z.string().describe('A member’s first name, name, email or id, as the message gave it.'),
  }),
  z.object({
    kind: z.literal('set_date'),
    date: z.string().describe('The purchase date as YYYY-MM-DD.'),
  }),
  z.object({
    kind: z.literal('set_vendor'),
    name: z.string().describe('The vendor’s name.'),
  }),
  z.object({
    kind: z.literal('split'),
    parts: z
      .array(
        z.object({
          description: z.string(),
          amount: z.string().describe('A plain decimal amount like "30.00". The parts must add up to the receipt total.'),
          accountCode: z.string(),
        }),
      )
      .min(2)
      .max(10),
  }),
  z.object({ kind: z.literal('skip') }),
]);

export type Edit = z.infer<typeof editSchema>;

/** The part of a proposal that edits can change, as plain data. */
export interface EditableProposal {
  vendorId: string | null;
  vendorName: string | null;
  date: CalendarDate | null;
  totalCents: number | null;
  payerId: string | null;
  lines: ProposalLine[];
  warnings: ReceiptWarning[];
}

export interface EditContext {
  allowed: ReadonlyArray<{ id: string; code: string; name: string }>;
  payers: readonly Payer[];
  vendorIndex: VendorIndex;
  today: CalendarDate;
}

export type EditResult =
  | { ok: true; state: EditableProposal; note: string }
  | { ok: true; skip: true; note: string }
  | { ok: false; message: string };

const refuse = (message: string): EditResult => ({ ok: false, message });

/** Applies a patch, then works the warnings out again so an edit that fixes a problem clears it. */
function next(state: EditableProposal, patch: Partial<EditableProposal>, ctx: EditContext, note: string): EditResult {
  const merged = { ...state, ...patch };
  return { ok: true, state: { ...merged, warnings: recomputeWarnings(state.warnings, merged, ctx.today) }, note };
}

const quoted = (text: string): string => `“${text}”`;

export function applyEdit(state: EditableProposal, edit: Edit, ctx: EditContext): EditResult {
  switch (edit.kind) {
    case 'skip':
      return { ok: true, skip: true, note: 'Skipped. It will not be posted.' };

    case 'set_account': {
      const account = ctx.allowed.find((a) => a.code === edit.accountCode.trim());
      if (account === undefined) return refuse(`${quoted(edit.accountCode)} is not an account a receipt can post to.`);
      if (state.lines.length === 0) return refuse('There is nothing on this receipt to move.');
      if (edit.line !== 'all' && edit.line > state.lines.length) {
        return refuse(`There is no line ${edit.line}; this receipt has ${state.lines.length}.`);
      }
      const lines = state.lines.map((line, i) =>
        edit.line === 'all' || edit.line === i + 1 ? { ...line, accountId: account.id } : line,
      );
      const what = edit.line === 'all' ? 'Every line' : quoted(state.lines[edit.line - 1].description);
      return next(state, { lines }, ctx, `${what} moved to ${account.name} (${account.code}).`);
    }

    case 'set_payer': {
      const who = edit.who.trim().toLowerCase();
      if (who.length < 2) return refuse('Say which member paid.');
      const matches = ctx.payers.filter(
        (p) => p.userId === edit.who.trim() || p.name.toLowerCase().includes(who) || p.email.toLowerCase().includes(who),
      );
      if (matches.length === 0) {
        const names = ctx.payers.map((p) => p.name);
        const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
        return refuse(`No member matches ${quoted(edit.who.trim())}. The members are ${list}.`);
      }
      if (matches.length > 1) return refuse(`More than one member matches ${quoted(edit.who.trim())}. Use a fuller name.`);
      return next(state, { payerId: matches[0].userId }, ctx, `Paid by ${matches[0].name}.`);
    }

    case 'set_date': {
      const date = edit.date.trim();
      if (!isCalendarDate(date)) return refuse('Dates must be real calendar dates like 2026-09-15.');
      return next(state, { date }, ctx, `Date set to ${date}.`);
    }

    case 'set_vendor': {
      const name = edit.name.trim();
      if (name === '') return refuse('A vendor needs a name.');
      const match = resolveVendor(name, ctx.vendorIndex);
      if (match !== null) {
        return next(state, { vendorId: match.vendorId, vendorName: match.vendorName }, ctx, `Vendor is ${match.vendorName}.`);
      }
      return next(state, { vendorId: null, vendorName: name }, ctx, `Vendor set to ${name}, a new vendor created when you post.`);
    }

    case 'split': {
      if (state.totalCents === null) return refuse('This receipt has no total to split.');
      const lines: ProposalLine[] = [];
      for (const [i, part] of edit.parts.entries()) {
        const account = ctx.allowed.find((a) => a.code === part.accountCode.trim());
        if (account === undefined) {
          return refuse(`Part ${i + 1}: ${quoted(part.accountCode)} is not an account a receipt can post to.`);
        }
        let cents: number;
        try {
          cents = parseMoney(part.amount);
        } catch {
          return refuse(`Part ${i + 1}: ${quoted(part.amount)} is not an amount.`);
        }
        lines.push({ description: part.description.trim() || 'Part', cents, accountId: account.id });
      }
      const total = sumCents(lines.map((l) => l.cents));
      if (total !== state.totalCents) {
        return refuse(`The parts add up to ${formatMoney(total)}, but the receipt total is ${formatMoney(state.totalCents)}.`);
      }
      return next(state, { lines }, ctx, `Split into ${lines.length} lines.`);
    }
  }
}

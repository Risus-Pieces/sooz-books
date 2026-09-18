/**
 * Sooz Books — the prompt the AI categorization layer sends.
 *
 * This file is deliberately pure: it takes plain data in and returns two strings.
 * No network, no database, no environment. `ai-prompt.test.ts` can therefore assert
 * the exact wording of the guardrails that keep this company's books honest, and a
 * change to the prompt shows up as a test diff rather than as a surprise in the
 * review queue three imports later.
 *
 * What goes into the prompt is as important as what does not.
 *
 * **In:** the chart of accounts the model is allowed to choose from, the vendors the
 * owner has already configured with their usual account, the facts about the company
 * that change the answer, and — per transaction — date, payee, cleaned payee,
 * reference, amount and direction.
 *
 * **Out, on purpose:**
 *   - **Account balances.** `PromptTxn` has no field for the statement's running
 *     balance, so no caller can send one by accident. What the company is worth is
 *     not needed to code a $17.95 card charge and is not the model's business.
 *   - **Other transactions' categorizations.** The vendor defaults are configuration
 *     the owner wrote down; the ledger's history is not sent. The deterministic
 *     pipeline in `suggest.ts` already owns history, and it runs first.
 *   - **The founder.** Relay writes `- Sent By <name>` and `- Initiated By <name>`
 *     onto some descriptors; `cleanPayee` strips those into their own fields and this
 *     module never renders them. The payee itself is sent verbatim, because that is
 *     the evidence, but nothing identifying is added to it.
 *   - **Bank and control accounts.** They are filtered out of the offered chart
 *     entirely, so the model is not tempted to propose the other side of the bank
 *     entry or to post into AR/AP behind the subledgers' backs. `ai-suggest.ts`
 *     discards them again on the way back; a guardrail stated once is a suggestion.
 */

import { formatMoneyPlain } from '@/lib/money';
import type { CalendarDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One account as the prompt presents it.
 *
 * Structural on purpose: a row out of the `accounts` table satisfies it, and so does
 * a literal in a test. `postable` is "nothing may post to a rollup" — the caller
 * computes it, because only the caller knows which accounts have children.
 */
export interface PromptAccount {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  /** `asset` | `liability` | `equity` | `revenue` | `expense`. */
  readonly type: string;
  readonly subtype: string | null;
  /** False for a rollup — a report header with children that nothing posts to. */
  readonly postable: boolean;
  /** Reconciled against an external statement feed. Never proposed. */
  readonly isBank: boolean;
  /** A subledger control account (AR, AP). Never proposed. */
  readonly isControl: boolean;
  readonly active: boolean;
}

/** A vendor the owner has already configured, and what it usually means. */
export interface PromptVendor {
  readonly name: string;
  /** The vendor's `default_expense_account_id`, resolved to a code. */
  readonly defaultAccountCode: string | null;
  /** `vendors.notes`, verbatim. Carries the owner's own caveats. */
  readonly notes: string | null;
  /** Other spellings the bank uses for this vendor. */
  readonly aliases?: readonly string[];
}

/**
 * One transaction, in the only shape the prompt will render.
 *
 * `amountCents` is signed from the company's point of view, like everywhere else in
 * this module: positive is money in, negative is money out. The prompt shows the
 * direction as a word and the amount as an unsigned figure, because "out 17.95"
 * survives a model's paraphrase better than "-17.95" does.
 */
export interface PromptTxn {
  /** The id the model must echo back. `NormalizedTxn.rowIndex`. */
  readonly rowId: number;
  readonly date: CalendarDate | '';
  /** The bank's own payee text, verbatim. */
  readonly payee: string;
  /** `cleanPayee(payee).name` — processor prefixes and reference digits removed. */
  readonly cleanedPayee: string;
  readonly reference: string | null;
  /** Integer cents, signed. Positive is money in. */
  readonly amountCents: number;
}

/** The facts about this company that change what an account means. */
export interface CompanyContext {
  readonly name: string;
  /** One fact per line, rendered as a bulleted list. */
  readonly facts: readonly string[];
}

/**
 * Sooz Beverage LLC as the nine months of Relay statements describe it.
 *
 * Every line here is a fact the statements or the owner established, and every line
 * changes an answer. The member-contribution line is the one that matters most: the
 * personal-account ACH pulls are larger than every Square deposit combined, and a
 * model that reads them as sales overstates revenue roughly tenfold.
 */
export const SOOZ_COMPANY_CONTEXT: CompanyContext = Object.freeze({
  name: 'Sooz Beverage LLC',
  facts: Object.freeze([
    'Pre-launch CPG beverage brand. The founder is formulating the product with a consultant. There is no co-packer production, no distributor, no Shopify store, no Amazon seller account and no Faire account yet.',
    'Money arriving as an ACH pull from the founder’s personal bank is a member contribution — equity, never revenue. Booking one as income would overstate revenue roughly tenfold.',
    'Ingredients and packaging are capitalized to inventory when bought, not expensed. Ingredient purchases go to 1320 Raw Ingredients and packaging, labels and bottles to 1330 Packaging Materials. The COGS accounts are relieved later, when product is sold.',
    'Revenue so far is small Square deposits from direct and market sales, referenced SQ followed by a six-digit date (SQ260126).',
    'Spend is ingredients, packaging, formulation consulting, advertising and shipping.',
    'The company banks with Relay and has four accounts there; it also uses a corporate card that settles through the same statements.',
  ] as const),
} as const);

export interface BuildPromptOptions {
  readonly accounts: readonly PromptAccount[];
  readonly vendors?: readonly PromptVendor[];
  readonly company?: CompanyContext;
  /** Echoed into the prompt so the model calibrates against the floor it is judged by. */
  readonly confidenceFloor?: number;
}

/** A system prompt and a user prompt, ready for `generateObject`. */
export interface SuggestPrompt {
  readonly system: string;
  readonly user: string;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The section headings, in order. Exported so the tests assert structure, not prose. */
export const PROMPT_SECTIONS = Object.freeze([
  '# Your job',
  '# The company',
  '# Accounts you may choose from',
  '# Vendors the owner has already configured',
  '# Rules you must follow',
  '# How to answer',
] as const);

export const TXN_TABLE_HEADER =
  'row_id | date | payee | cleaned_payee | reference | direction | amount_usd';

/**
 * The table is pipe-delimited, so a literal pipe inside a payee would invent a
 * column. Banks do emit them (`ACH | RETURN`), so they become a slash.
 */
function cell(value: string | null): string {
  const text = (value ?? '').replace(/[|\r\n]+/g, ' / ').replace(/\s+/g, ' ').trim();
  return text === '' ? '-' : text;
}

function renderAccount(account: PromptAccount): string {
  const description = (account.description ?? '').replace(/\s+/g, ' ').trim();
  return description === ''
    ? `${account.code} — ${account.name}`
    : `${account.code} — ${account.name} — ${description}`;
}

function renderVendor(vendor: PromptVendor): string {
  const parts = [vendor.name];
  parts.push(
    vendor.defaultAccountCode === null
      ? 'no default account — decide from the evidence'
      : `usually ${vendor.defaultAccountCode}`,
  );
  const aliases = (vendor.aliases ?? []).filter((a) => a.trim() !== '' && a !== vendor.name);
  if (aliases.length > 0) parts.push(`also appears as ${aliases.join(', ')}`);
  const notes = (vendor.notes ?? '').replace(/\s+/g, ' ').trim();
  if (notes !== '') parts.push(notes);
  return `- ${parts.join(' — ')}`;
}

function renderTxn(txn: PromptTxn): string {
  const direction = txn.amountCents >= 0 ? 'in' : 'out';
  const amount = formatMoneyPlain(Math.abs(txn.amountCents));
  return [
    String(txn.rowId),
    cell(txn.date === '' ? null : txn.date),
    cell(txn.payee),
    cell(txn.cleanedPayee),
    cell(txn.reference),
    direction,
    amount,
  ].join(' | ');
}

/**
 * Which accounts the model is offered.
 *
 * Inactive accounts, rollups, bank accounts and control accounts are all removed
 * before the list is written. Offering an account the answer may never be is an
 * invitation; the filter is the first of the two places this is enforced.
 */
/**
 * A channel or processor clearing account (Square, Shopify, Amazon, Faire, processor).
 * Posted only by settlement importers and deterministic payout rules, never by a guess.
 */
export function isClearingAccount(account: Pick<PromptAccount, 'subtype'>): boolean {
  return account.subtype === 'clearing';
}

export function selectableAccounts(
  accounts: readonly PromptAccount[],
): readonly PromptAccount[] {
  return accounts
    .filter((a) => a.active && a.postable && !a.isBank && !a.isControl && !isClearingAccount(a))
    .slice()
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * Builds the two prompts.
 *
 * Pure. Given the same arguments it returns the same strings, which is what makes the
 * guardrail wording testable without a network call.
 */
export function buildSuggestPrompt(
  txns: readonly PromptTxn[],
  options: BuildPromptOptions,
): SuggestPrompt {
  const company = options.company ?? SOOZ_COMPANY_CONTEXT;
  const floor = options.confidenceFloor ?? 0.6;
  const chart = selectableAccounts(options.accounts);
  const vendors = (options.vendors ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [];

  lines.push(PROMPT_SECTIONS[0]);
  lines.push(
    `You are a bookkeeper for ${company.name}. You are given bank and card transactions that the deterministic import rules could not categorize on their own. For each one, propose the single account from the chart below that it should be coded to.`,
  );
  lines.push(
    'Nothing you propose is posted to the ledger. A human reviews every suggestion before it becomes a journal entry, so an honest "I am not sure" is more useful than a confident guess.',
  );
  lines.push('');

  lines.push(PROMPT_SECTIONS[1]);
  for (const fact of company.facts) lines.push(`- ${fact}`);
  lines.push('');

  lines.push(PROMPT_SECTIONS[2]);
  lines.push('Format: code — name — description. Choose one of these codes and nothing else.');
  for (const account of chart) lines.push(renderAccount(account));
  lines.push('');

  lines.push(PROMPT_SECTIONS[3]);
  if (vendors.length === 0) {
    lines.push('None configured.');
  } else {
    lines.push(
      'The account a vendor "usually" maps to is the owner’s configuration, not a rule. Follow the evidence when it disagrees, and say so in your reasoning.',
    );
    for (const vendor of vendors) lines.push(renderVendor(vendor));
  }
  lines.push('');

  lines.push(PROMPT_SECTIONS[4]);
  lines.push(
    '1. Use only a code from the list above. An account that is not on the list is discarded, and the transaction goes to a human with no suggestion at all.',
  );
  lines.push(
    '2. Never propose a bank account, a credit card account, a control account (Accounts Receivable, Accounts Payable) or a clearing account (Square, Shopify, Amazon, Faire, processor clearing). They are deliberately absent from the list. Bank movements are posted by the import, the receivables and payables subledgers own their control accounts, and only settlement imports post to clearing. A refund or credit arriving on the company card reverses an earlier charge: propose the same account that charge would use, so the two net to zero.',
  );
  lines.push(
    '3. Money pulled in from the founder’s personal bank account is a member contribution to equity. It is never revenue, and it is never other income.',
  );
  lines.push(
    '4. Ingredients and packaging bought for production are capitalized to inventory (1320, 1330). Do not send them to a cost-of-goods-sold account; COGS is relieved when the product sells, which has not happened yet.',
  );
  lines.push(
    '5. Some payees are mixed use — a general marketplace, a big-box store, a restaurant — and a single charge could be a business purchase or a personal one. The owner’s policy for these is to default to a business account: propose the most plausible business account for a pre-launch beverage company in formulation, using the amount, the date and the vendor notes (small lab and bench supplies to Formulation & Bench Work, a clear ingredient to Raw Ingredients, bottles and labels to Packaging, office goods to Office Supplies, meals to Meals). Always set needsHuman to true for these, give an honest confidence, and name the likeliest alternative in your reasoning. The owner re-tags personal purchases to Owner Draws at review.',
  );
  lines.push(
    '6. Propose Owner Draws (3020) only when the evidence clearly points to a personal purchase. For a mixed-use payee with no such evidence, follow rule 5.',
  );
  lines.push(
    '7. Propose 7900 Ask My Accountant only when the payee itself is unintelligible and no account is a defensible fit. It is not the answer for a mixed-use payee; those follow rule 5.',
  );
  lines.push('');

  lines.push(PROMPT_SECTIONS[5]);
  lines.push('Return one entry per transaction you can answer for, each with:');
  lines.push('- rowIndex: the row_id from the table, copied exactly. This is how your answer is matched back to the transaction, so it must never be guessed or renumbered.');
  lines.push('- accountCode: a code from the chart above.');
  lines.push('- vendorName: the vendor this payee is, from the configured list, or null if it is not one of them.');
  lines.push('- confidence: 0 to 1, your own honest probability that this coding survives review.');
  lines.push('- reasoning: one sentence, naming the evidence you used.');
  lines.push(
    `- needsHuman: true when a person should look at this before it posts. Anything below ${floor} confidence is treated as needing a human regardless of what you set.`,
  );
  lines.push(
    'Answer every transaction. Express uncertainty through a low confidence and needsHuman, never by leaving a row out: a missing row reaches the bookkeeper with no suggestion at all, and a flagged best guess with its alternative named is what saves their time. Nothing you propose posts without a human approving it.',
  );

  const user = [
    `# Transactions to categorize (${txns.length})`,
    '',
    TXN_TABLE_HEADER,
    ...txns.map(renderTxn),
  ].join('\n');

  return { system: lines.join('\n'), user };
}

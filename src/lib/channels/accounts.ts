/**
 * Where each piece of a channel settlement lands in the ledger.
 *
 * Every account is named through `ACCOUNTS`; this file only decides which one. The
 * decisions, in one place so they can be read and argued with:
 *
 *   - **Gross sales** credit the channel's own revenue account. Revenue is never net.
 *   - **Discounts, coupons and promotions** debit 4575; **refunds, returns, chargebacks and
 *     damage clawbacks** debit 4585. Both are contra-revenue, above gross margin.
 *   - **Processing, referral and commission fees** debit 5540, **fulfillment and storage**
 *     5530 (Amazon FBA) or 5550 / 5520 elsewhere, **outbound shipping** 5510. All sit in the
 *     5500 block, below gross margin. Referral fees are a cost of access to the channel,
 *     not a price concession to a customer, so they are not contra-revenue (4570).
 *   - **Sales tax the channel collected for Sooz** credits 2200. **Marketplace-facilitator
 *     tax never touches 2200**: the marketplace collects and remits it, so it is dropped
 *     from the entry entirely. The collected and withheld halves net to zero inside one
 *     settlement, which `buildPayoutEntry` asserts before anything posts.
 *   - **Reimbursements** (Amazon paying for inventory it lost) credit 7020 — other income,
 *     never sales. **Reserves** held back by a channel sit in 1230 as a receivable.
 *   - **Anything unrecognised** goes to 7900 Ask My Accountant, never dropped, never guessed.
 */

import type { PayoutLineType, PayoutProvider } from '@/db/schema';
import {
  ACCOUNTS,
  CHANNEL_CLEARING_ACCOUNT,
  CHANNEL_REVENUE_ACCOUNT,
  type AccountCode,
  type ChannelCode,
} from '@/lib/ledger/coa';

import { ChannelError } from './errors';

/** The settlement providers this module posts. */
export const SETTLEMENT_PROVIDERS = ['square', 'shopify', 'amazon', 'faire'] as const;
export type SettlementProvider = (typeof SETTLEMENT_PROVIDERS)[number];

export function isSettlementProvider(value: string): value is SettlementProvider {
  return (SETTLEMENT_PROVIDERS as readonly string[]).includes(value);
}

export const PROVIDER_LABEL: Readonly<Record<PayoutProvider, string>> = Object.freeze({
  square: 'Square',
  shopify: 'Shopify',
  amazon: 'Amazon',
  faire: 'Faire',
  stripe: 'Stripe',
  paypal: 'PayPal',
  other: 'Other',
});

/** The channel a provider's settlements are filed under (`channels.code`). */
export const PROVIDER_CHANNEL: Readonly<Record<SettlementProvider, ChannelCode>> = Object.freeze({
  // Square is the processor for direct and market sales; migration 0011 files it under DTC.
  square: 'DTC',
  shopify: 'DTC',
  amazon: 'AMAZON',
  faire: 'WHOLESALE',
});

/** Where a provider's settlement waits for its bank deposit. */
export const PROVIDER_CLEARING_ACCOUNT: Readonly<Record<SettlementProvider, AccountCode>> = Object.freeze({
  square: ACCOUNTS.CLEARING_SQUARE,
  shopify: ACCOUNTS.CLEARING_SHOPIFY,
  amazon: ACCOUNTS.CLEARING_AMAZON,
  faire: ACCOUNTS.CLEARING_FAIRE,
});

/** Where a provider's gross sales are recognized. */
export const PROVIDER_REVENUE_ACCOUNT: Readonly<Record<SettlementProvider, AccountCode>> = Object.freeze({
  square: ACCOUNTS.SALES_SQUARE,
  shopify: ACCOUNTS.SALES_DTC,
  amazon: ACCOUNTS.SALES_AMAZON,
  faire: ACCOUNTS.SALES_WHOLESALE,
});

/**
 * The semantic account a settlement line posts to. Stored on `payout_lines.raw.accountRole`
 * by every importer, so the posting phase never has to re-derive it from text.
 */
export const SETTLEMENT_ROLES = [
  'channel_sales',
  'liquidation_sales',
  'shipping_income',
  'other_sales_income',
  'gift_card_liability',
  'discounts_promotions',
  'returns_allowances',
  'sales_tax_payable',
  'facilitator_tax',
  'selling_fees',
  'payment_processing_fees',
  'fulfillment_fees',
  'storage_fees',
  'outbound_shipping',
  'platform_fees',
  'software_subscriptions',
  'advertising',
  'reimbursement_income',
  'reserve_receivable',
  'ask_my_accountant',
] as const;
export type SettlementRole = (typeof SETTLEMENT_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(SETTLEMENT_ROLES);

/**
 * The Square importer (`@/lib/importers/square`) predates this vocabulary and writes its
 * own role names; they are read here rather than rewritten there.
 */
const SQUARE_ROLE_ALIASES: Readonly<Record<string, SettlementRole>> = Object.freeze({
  square_sales: 'channel_sales',
  other_sales_income: 'other_sales_income',
  gift_card_liability: 'gift_card_liability',
  sales_tax_payable: 'sales_tax_payable',
  returns_and_allowances: 'returns_allowances',
  coupons_and_promotions: 'discounts_promotions',
  payment_processing_fees: 'payment_processing_fees',
  ask_my_accountant: 'ask_my_accountant',
});

/** The role a line type implies when the importer recorded none. */
export const LINE_TYPE_ROLE: Readonly<Record<PayoutLineType, SettlementRole>> = Object.freeze({
  gross_sales: 'channel_sales',
  shipping_income: 'shipping_income',
  tip: 'other_sales_income',
  gift_card: 'gift_card_liability',
  discount: 'discounts_promotions',
  coupon: 'discounts_promotions',
  promotion_rebate: 'discounts_promotions',
  refund: 'returns_allowances',
  chargeback: 'returns_allowances',
  chargeback_reversal: 'returns_allowances',
  sales_tax_collected: 'sales_tax_payable',
  facilitator_tax: 'facilitator_tax',
  referral_fee: 'selling_fees',
  processing_fee: 'payment_processing_fees',
  fulfillment_fee: 'fulfillment_fees',
  storage_fee: 'storage_fees',
  shipping_cost: 'outbound_shipping',
  advertising: 'advertising',
  subscription_fee: 'platform_fees',
  reimbursement: 'reimbursement_income',
  adjustment: 'ask_my_accountant',
  reserve_held: 'reserve_receivable',
  reserve_released: 'reserve_receivable',
  other: 'ask_my_accountant',
});

/**
 * The role a stored line carries: the importer's own, when it recorded a recognisable one,
 * else the one its line type implies. A facilitator-tax line is always facilitator tax,
 * whatever role text rides along with it — that is the rule that keeps it out of 2200.
 */
export function roleOfLine(lineType: PayoutLineType, recorded: string | null | undefined): SettlementRole {
  if (lineType === 'facilitator_tax') return 'facilitator_tax';
  if (recorded !== null && recorded !== undefined) {
    if (ROLE_SET.has(recorded)) return recorded as SettlementRole;
    const alias = SQUARE_ROLE_ALIASES[recorded];
    if (alias !== undefined) return alias;
  }
  return LINE_TYPE_ROLE[lineType];
}

export interface AccountContext {
  readonly provider: PayoutProvider;
  /** `channels.code` of the payout's channel, for providers without a fixed revenue account. */
  readonly channelCode: string | null;
}

function channelCodeOf(ctx: AccountContext): ChannelCode | null {
  const code = ctx.channelCode;
  return code !== null && code in CHANNEL_REVENUE_ACCOUNT ? (code as ChannelCode) : null;
}

/** The clearing account a payout posts against. */
export function clearingAccountFor(ctx: AccountContext): AccountCode {
  if (isSettlementProvider(ctx.provider)) return PROVIDER_CLEARING_ACCOUNT[ctx.provider];
  if (ctx.provider === 'stripe' || ctx.provider === 'paypal') return ACCOUNTS.CLEARING_PROCESSOR;
  const channel = channelCodeOf(ctx);
  const clearing = channel === null ? null : CHANNEL_CLEARING_ACCOUNT[channel];
  if (clearing === null) {
    throw new ChannelError(
      'unmapped_line',
      `No clearing account is defined for ${PROVIDER_LABEL[ctx.provider]} settlements on channel ${ctx.channelCode ?? '(none)'}.`,
    );
  }
  return clearing;
}

function revenueAccountFor(ctx: AccountContext): AccountCode {
  if (isSettlementProvider(ctx.provider)) return PROVIDER_REVENUE_ACCOUNT[ctx.provider];
  const channel = channelCodeOf(ctx);
  if (channel === null) {
    throw new ChannelError(
      'unmapped_line',
      `No revenue account is defined for ${PROVIDER_LABEL[ctx.provider]} settlements on channel ${ctx.channelCode ?? '(none)'}.`,
    );
  }
  return CHANNEL_REVENUE_ACCOUNT[channel];
}

/**
 * The account a role posts to, or `null` for facilitator tax, which never posts.
 *
 * @throws {ChannelError} `unmapped_line` for advertising outside Amazon: no other channel
 *   deducts ad spend from a settlement today, and guessing a marketing account would hide it.
 */
export function accountForRole(role: SettlementRole, ctx: AccountContext): AccountCode | null {
  const amazon = ctx.provider === 'amazon';
  switch (role) {
    case 'channel_sales':
      return revenueAccountFor(ctx);
    case 'liquidation_sales':
      // Liquidated stock is not branded sales at our price; keep it out of the channel line.
      return ACCOUNTS.OTHER_SALES_INCOME;
    case 'shipping_income':
      return ACCOUNTS.SHIPPING_INCOME;
    case 'other_sales_income':
      return ACCOUNTS.OTHER_SALES_INCOME;
    case 'gift_card_liability':
      return ACCOUNTS.GIFT_CARD_LIABILITY;
    case 'discounts_promotions':
      return ACCOUNTS.COUPONS_AND_PROMOS;
    case 'returns_allowances':
      return ACCOUNTS.RETURNS_AND_ALLOWANCES;
    case 'sales_tax_payable':
      return ACCOUNTS.SALES_TAX_PAYABLE;
    case 'facilitator_tax':
      return null;
    case 'selling_fees':
    case 'payment_processing_fees':
      return ACCOUNTS.PAYMENT_PROCESSING_FEES;
    case 'fulfillment_fees':
      return amazon ? ACCOUNTS.FBA_FEES : ACCOUNTS.PICK_PACK_FEES;
    case 'storage_fees':
      return amazon ? ACCOUNTS.FBA_FEES : ACCOUNTS.WAREHOUSE_3PL_FEES;
    case 'outbound_shipping':
      return ACCOUNTS.OUTBOUND_FREIGHT;
    case 'platform_fees':
      return ACCOUNTS.ECOMMERCE_PLATFORM_FEES;
    case 'software_subscriptions':
      return ACCOUNTS.SOFTWARE;
    case 'advertising':
      if (amazon) return ACCOUNTS.ADS_AMAZON;
      throw new ChannelError(
        'unmapped_line',
        `A ${PROVIDER_LABEL[ctx.provider]} settlement carries advertising, which no account is mapped for. Recode the line before posting.`,
      );
    case 'reimbursement_income':
      return ACCOUNTS.MISC_INCOME;
    case 'reserve_receivable':
      return ACCOUNTS.OTHER_RECEIVABLES;
    case 'ask_my_accountant':
      return ACCOUNTS.ASK_MY_ACCOUNTANT;
  }
}

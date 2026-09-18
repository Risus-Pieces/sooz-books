/**
 * Sooz Books — chart of accounts.
 *
 * This file is the single source of truth. `supabase/migrations/0003_seed_chart_of_accounts.sql`
 * is generated from `COA_SEED` / `CHANNELS` below; `coa.test.ts` proves the live `accounts`
 * table still matches this list field for field.
 *
 * Numbering: 1000 assets, 2000 liabilities, 3000 equity, 4000 revenue, 4500 contra-revenue,
 * 5000 COGS, 5500 fulfillment & selling, 6000 operating expense, 7000 other income & expense.
 *
 * Two conventions worth knowing before you add an account:
 *   - A rollup (an account with children) is a report header. Nothing posts to it; `isPostable`
 *     is how application code checks that.
 *   - `isBank` means "reconciled against an external statement feed", so company credit cards
 *     carry it too even though they are liabilities.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

/**
 * Report grouping key. Coarser than the account code and stable across renumbering:
 * balance sheet and P&L sections are built from this, never from code ranges.
 */
export type AccountSubtype =
  | 'cash'
  | 'bank'
  | 'undeposited_funds'
  | 'clearing'
  | 'accounts_receivable'
  | 'other_receivable'
  | 'contra_asset'
  | 'inventory'
  | 'prepaid'
  | 'deposit'
  | 'fixed_asset'
  | 'accounts_payable'
  | 'credit_card'
  | 'accrued_liability'
  | 'tax_payable'
  | 'customer_deposit'
  | 'deferred_revenue'
  | 'debt'
  | 'other_liability'
  | 'equity'
  | 'contra_equity'
  | 'retained_earnings'
  | 'opening_balance'
  | 'sales'
  | 'shipping_income'
  | 'other_revenue'
  | 'contra_revenue'
  | 'cogs'
  | 'fulfillment'
  | 'operating_expense'
  | 'marketing'
  | 'payroll'
  | 'research_development'
  | 'professional_fees'
  | 'occupancy'
  | 'technology'
  | 'general_admin'
  | 'compliance'
  | 'depreciation'
  | 'other_expense'
  | 'income_tax'
  | 'suspense';

export const CHANNEL_CODES = ['DTC', 'AMAZON', 'DISTRIBUTOR', 'WHOLESALE', 'FOODSERVICE'] as const;
export type ChannelCode = (typeof CHANNEL_CODES)[number];

export interface ChannelSeed {
  readonly code: ChannelCode;
  readonly name: string;
  readonly sortOrder: number;
}

export const CHANNELS: readonly ChannelSeed[] = Object.freeze([
  { code: 'DTC', name: 'DTC (Shopify)', sortOrder: 10 },
  { code: 'AMAZON', name: 'Amazon', sortOrder: 20 },
  { code: 'DISTRIBUTOR', name: 'Distributor (UNFI / KeHE)', sortOrder: 30 },
  { code: 'WHOLESALE', name: 'Wholesale (Faire & Direct)', sortOrder: 40 },
  { code: 'FOODSERVICE', name: 'Foodservice & Restaurants', sortOrder: 50 },
] as const satisfies readonly ChannelSeed[]);

export interface AccountSeed {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype: AccountSubtype;
  readonly parentCode: string | null;
  readonly isBank: boolean;
  readonly isControl: boolean;
  readonly clearingForChannel: ChannelCode | null;
  readonly description: string;
}

interface AccountFlags {
  readonly isBank?: boolean;
  readonly isControl?: boolean;
  readonly clearingForChannel?: ChannelCode;
}

function acct(
  code: string,
  name: string,
  type: AccountType,
  subtype: AccountSubtype,
  parentCode: string | null,
  description: string,
  flags: AccountFlags = {},
): AccountSeed {
  return Object.freeze({
    code,
    name,
    type,
    subtype,
    parentCode,
    isBank: flags.isBank ?? false,
    isControl: flags.isControl ?? false,
    clearingForChannel: flags.clearingForChannel ?? null,
    description,
  });
}

const ROLLUP = 'Rollup only - do not post.';

export const COA_SEED: readonly AccountSeed[] = Object.freeze([
  // -------------------------------------------------------------------------
  // 1000 — Assets
  // -------------------------------------------------------------------------
  acct('1000', 'Cash & Bank', 'asset', 'cash', null,
    `${ROLLUP} Every account that holds the company's own cash.`),
  acct('1010', 'Operating Checking', 'asset', 'bank', '1000',
    'Main business checking account: channel payouts land here and vendor payments leave from here.',
    { isBank: true }),
  acct('1020', 'Savings & Tax Reserve', 'asset', 'bank', '1000',
    'Interest-bearing reserve for cash set aside for sales tax, income tax and production deposits.',
    { isBank: true }),
  acct('1030', 'Petty Cash', 'asset', 'cash', '1000',
    'Physical cash carried for demos and markets; reconciled by counting the box, not by a feed.'),
  acct('1040', 'Undeposited Funds', 'asset', 'undeposited_funds', '1000',
    'Checks and cash received but not yet taken to the bank; clears when the deposit posts.'),

  acct('1100', 'Channel Clearing', 'asset', 'clearing', null,
    `${ROLLUP} Money earned on a channel but not yet in the bank.`),
  acct('1110', 'Shopify Clearing', 'asset', 'clearing', '1100',
    'Holds Shopify orders between the sale being recorded and the payout hitting the bank; the balance is the pending payout.',
    { clearingForChannel: 'DTC' }),
  acct('1120', 'Amazon Clearing', 'asset', 'clearing', '1100',
    'Holds Amazon sales, fees and reserves between the sale and the disbursement; the balance is the unreleased Amazon balance.',
    { clearingForChannel: 'AMAZON' }),
  acct('1130', 'Faire Clearing', 'asset', 'clearing', '1100',
    'Holds Faire orders between the sale and the payout; the balance is what Faire still owes us.',
    { clearingForChannel: 'WHOLESALE' }),
  acct('1140', 'Payment Processor Clearing', 'asset', 'clearing', '1100',
    'Card and ACH payments taken outside Shopify (Stripe, PayPal, Square) between capture and deposit.'),
  acct('1150', 'Square Clearing', 'asset', 'clearing', '1100',
    'Holds a Square payout between the sale being recorded and the cash landing in Relay. Should be zero once the matching Square settlement is imported.',
    { clearingForChannel: 'DTC' }),

  acct('1200', 'Accounts Receivable', 'asset', 'accounts_receivable', null,
    'Control account for customer invoices. Only the invoicing and cash-receipt modules post here, never a manual entry.',
    { isControl: true }),
  acct('1210', 'Deductions Receivable', 'asset', 'other_receivable', null,
    'Distributor deductions we are disputing. Move a deduction here when we intend to recover it; clear it when repaid or written off to 4590.'),
  acct('1220', 'Allowance for Doubtful Accounts', 'asset', 'contra_asset', null,
    'Contra-asset estimate of invoices we do not expect to collect; the offset of 6910 Bad Debt Expense.'),
  acct('1230', 'Vendor & Other Receivables', 'asset', 'other_receivable', null,
    'Amounts owed to us that are not customer invoices: co-man credits, insurance claims, vendor rebates.'),

  acct('1300', 'Inventory', 'asset', 'inventory', null,
    `${ROLLUP} Total inventory at landed cost.`),
  acct('1310', 'Finished Goods', 'asset', 'inventory', '1300',
    'Sellable cases at landed cost wherever they sit (3PL, FBA, in our name at the co-man).'),
  acct('1320', 'Raw Ingredients', 'asset', 'inventory', '1300',
    'Ingredients bought for production and not yet run, including ingredients held at the co-man in our name.'),
  acct('1330', 'Packaging Materials', 'asset', 'inventory', '1300',
    'Films, cartons, labels, jars and shippers held for production.'),
  acct('1340', 'Goods in Transit', 'asset', 'inventory', '1300',
    'Product paid for and shipped but not yet received at the destination warehouse; clears on receipt.'),
  acct('1390', 'Inventory Reserve', 'asset', 'contra_asset', '1300',
    'Contra-asset reserve for short-dated, slow-moving or damaged stock; raise the reserve rather than writing down individual lots.'),

  acct('1400', 'Prepaid Expenses & Other Assets', 'asset', 'prepaid', null,
    `${ROLLUP} Cash already spent that is not yet an expense.`),
  acct('1410', 'Prepaid Expenses', 'asset', 'prepaid', '1400',
    'Costs paid up front and consumed over time (annual software, booth space, retainers); amortize monthly to the expense account.'),
  acct('1420', 'Prepaid Insurance', 'asset', 'prepaid', '1400',
    'Insurance premiums paid in advance; release to 6530 over the policy term.'),
  acct('1430', 'Security Deposits', 'asset', 'deposit', '1400',
    'Refundable deposits held by landlords, utilities or 3PLs. Not an expense.'),
  acct('1440', 'Vendor Deposits & Co-Man Prepayments', 'asset', 'deposit', '1400',
    'Cash advanced to a co-manufacturer or supplier before production; relieve when the goods are received.'),

  acct('1500', 'Fixed Assets', 'asset', 'fixed_asset', null,
    `${ROLLUP} Capitalized assets at cost.`),
  acct('1510', 'Machinery & Equipment', 'asset', 'fixed_asset', '1500',
    'Production and warehouse equipment above the capitalization threshold.'),
  acct('1520', 'Furniture & Fixtures', 'asset', 'fixed_asset', '1500',
    'Capitalized office furniture and reusable trade-show fixtures.'),
  acct('1530', 'Computers & Capitalized Software', 'asset', 'fixed_asset', '1500',
    'Capitalized computers and purchased software; routine SaaS goes to 6610.'),
  acct('1540', 'Leasehold Improvements', 'asset', 'fixed_asset', '1500',
    'Build-out of leased space; amortize over the shorter of the lease term and useful life.'),
  acct('1550', 'Molds, Tooling & Dies', 'asset', 'fixed_asset', '1500',
    'Tooling we own and paid for at a co-man or packaging supplier.'),
  acct('1590', 'Accumulated Depreciation', 'asset', 'contra_asset', '1500',
    'Contra-asset holding all depreciation booked to date; the offset of 6900.'),

  // -------------------------------------------------------------------------
  // 2000 — Liabilities
  // -------------------------------------------------------------------------
  acct('2000', 'Accounts Payable', 'liability', 'accounts_payable', null,
    'Control account for vendor bills. Only the bills and bill-payment modules post here, never a manual entry.',
    { isControl: true }),

  acct('2050', 'Credit Cards', 'liability', 'credit_card', null,
    `${ROLLUP} All company card balances.`),
  acct('2051', 'Business Credit Card - Operations', 'liability', 'credit_card', '2050',
    'Card used for production, freight, supplies and travel; reconcile to the monthly statement.',
    { isBank: true }),
  acct('2052', 'Business Credit Card - Marketing', 'liability', 'credit_card', '2050',
    'Card used for ad platforms and agencies; reconcile to the monthly statement.',
    { isBank: true }),

  acct('2100', 'Accrued Liabilities', 'liability', 'accrued_liability', null,
    `${ROLLUP} Costs incurred in the period that have not been billed to us yet.`),
  acct('2110', 'Accrued Expenses', 'liability', 'accrued_liability', '2100',
    'General period-end accrual for costs incurred with no bill yet; reverse when the bill arrives.'),
  acct('2120', 'Accrued Trade Spend', 'liability', 'accrued_liability', '2100',
    'Promotions, billbacks, scan downs and slotting earned by the retailer but not yet deducted or invoiced. The most important CPG accrual: fund it when the promotion runs, relieve it when the deduction lands.'),
  acct('2130', 'Accrued Freight', 'liability', 'accrued_liability', '2100',
    'Freight moved in the period whose carrier invoice has not arrived.'),
  acct('2140', 'Accrued Payroll & PTO', 'liability', 'accrued_liability', '2100',
    'Wages earned and vacation accrued through period end but not yet paid.'),
  acct('2150', 'Accrued Broker Commissions', 'liability', 'accrued_liability', '2100',
    'Broker commissions earned on shipped orders and not yet invoiced.'),
  acct('2160', 'Accrued Co-Packer Costs', 'liability', 'accrued_liability', '2100',
    'Production runs completed at the co-man with no invoice yet.'),

  acct('2200', 'Sales Tax Payable', 'liability', 'tax_payable', null,
    'Sales tax we collected and owe to the states. Tax a marketplace collects and remits never lands here.'),
  acct('2210', 'Payroll Tax Payable', 'liability', 'tax_payable', null,
    'Employee withholdings and employer taxes owed to agencies between payroll and remittance.'),
  acct('2220', 'Gift Card & Store Credit Liability', 'liability', 'other_liability', null,
    'Unredeemed gift cards and store credit; revenue is recognized when they are redeemed.'),
  acct('2300', 'Customer Deposits', 'liability', 'customer_deposit', null,
    'Cash taken before shipment (foodservice prepayments, pre-orders); becomes revenue when the order ships.'),
  acct('2310', 'Deferred Revenue', 'liability', 'deferred_revenue', null,
    'Amounts billed or collected for product or services not yet delivered, including subscription periods not yet shipped.'),

  acct('2500', 'Notes & Loans Payable', 'liability', 'debt', null,
    `${ROLLUP} Everything the company has borrowed.`),
  acct('2510', 'Line of Credit', 'liability', 'debt', '2500',
    'Drawn balance on the revolving working-capital line.'),
  acct('2520', 'Loans Payable - Current Portion', 'liability', 'debt', '2500',
    'Principal on term or SBA loans due within twelve months.'),
  acct('2530', 'Loans Payable - Long Term', 'liability', 'debt', '2500',
    'Principal on term or SBA loans due beyond twelve months.'),
  acct('2540', 'Revenue-Based Financing', 'liability', 'debt', '2500',
    'Outstanding balance on merchant cash advance or revenue-share financing; the fee portion goes to 7120.'),
  acct('2550', 'Shareholder & Founder Loans', 'liability', 'debt', '2500',
    'Money lent to the company by an owner. Repaying it is not a distribution.'),
  acct('2560', 'Accrued Interest Payable', 'liability', 'debt', '2500',
    'Interest incurred but not yet paid on any borrowing.'),
  acct('2570', 'SAFE & Convertible Notes', 'liability', 'debt', '2500',
    'Outstanding SAFEs and convertible notes; confirm the classification with the CPA at each year end.'),

  // -------------------------------------------------------------------------
  // 3000 — Equity
  // -------------------------------------------------------------------------
  acct('3000', 'Common Stock', 'equity', 'equity', null,
    'Par value of issued shares, or member capital contributions for an LLC.'),
  acct('3015', 'Member Contributions', 'equity', 'equity', '3000',
    'Money the founder puts into the business from personal funds. Relay shows these as ACH Pulls from Chase College Checking and BofA Advantage SafeBalance. Not revenue.'),
  acct('3010', 'Additional Paid-In Capital', 'equity', 'equity', null,
    'Amounts investors paid above par in priced rounds, and SAFE balances once converted.'),
  acct('3020', 'Owner Draws & Distributions', 'equity', 'contra_equity', null,
    'Contra-equity for cash taken out by owners. Never an expense.'),
  acct('3900', 'Retained Earnings', 'equity', 'retained_earnings', null,
    'Cumulative prior-year profit and loss; the year-end close rolls net income here.'),
  acct('3990', 'Opening Balance Equity', 'equity', 'opening_balance', null,
    'Temporary offset for balances migrated from QuickBooks. Must be cleared to 3900 once the conversion is reconciled.'),

  // -------------------------------------------------------------------------
  // 4000 — Revenue
  // -------------------------------------------------------------------------
  acct('4000', 'Gross Revenue', 'revenue', 'sales', null,
    `${ROLLUP} Gross sales before any contra-revenue.`),
  acct('4010', 'DTC Sales (Shopify)', 'revenue', 'sales', '4000',
    'Gross product revenue from the Shopify store at the price charged, before discounts and processing fees.'),
  acct('4015', 'Direct & Market Sales (Square)', 'revenue', 'sales', '4000',
    'In-person and direct sales taken through Square: markets, events, sampling, direct invoices.'),
  acct('4020', 'Amazon Sales', 'revenue', 'sales', '4000',
    'Gross product revenue from Amazon orders at the price charged, before referral and FBA fees.'),
  acct('4030', 'Distributor Sales (UNFI / KeHE)', 'revenue', 'sales', '4000',
    'Gross invoiced revenue to distributors at list or delivered price, before off-invoice allowances and deductions.'),
  acct('4040', 'Wholesale Sales (Faire & Direct)', 'revenue', 'sales', '4000',
    'Gross invoiced revenue to independent retailers, whether the order came through Faire or direct.'),
  acct('4050', 'Foodservice Sales', 'revenue', 'sales', '4000',
    'Gross invoiced revenue to restaurants, cafes and foodservice distributors.'),
  acct('4060', 'Shipping Income', 'revenue', 'shipping_income', '4000',
    'Shipping and handling charged to customers; the cost side sits in 5510.'),
  acct('4090', 'Other Sales Income', 'revenue', 'other_revenue', '4000',
    'Operating revenue that is not our own branded product: co-packing for others, private label, pallet and sample sales.'),

  acct('4500', 'Contra Revenue', 'revenue', 'contra_revenue', null,
    `${ROLLUP} Everything deducted from gross sales to reach net sales.`),
  acct('4510', 'Trade Discounts & Off-Invoice Allowances', 'revenue', 'contra_revenue', '4500',
    'Discounts taken directly on the customer invoice, including everyday and promotional off-invoice allowances.'),
  acct('4520', 'Billbacks & Manufacturer Chargebacks (MCB)', 'revenue', 'contra_revenue', '4500',
    'Promotions billed back to us after the fact by a distributor or retailer; accrue to 2120 when the promotion runs.'),
  acct('4530', 'Scan Downs & Temporary Price Reductions', 'revenue', 'contra_revenue', '4500',
    'Per-unit funding for retail price reductions, charged on units scanned at the register.'),
  acct('4540', 'Slotting Fees & Free Fill', 'revenue', 'contra_revenue', '4500',
    'One-time payments or free opening product given to win shelf space at a new retailer.'),
  acct('4550', 'Spoilage & Unsaleables Allowance', 'revenue', 'contra_revenue', '4500',
    'Percentage allowances retailers deduct for damaged or expired product, whether or not the product comes back.'),
  acct('4560', 'Distributor Fees', 'revenue', 'contra_revenue', '4500',
    'Distributor administrative charges: new item, EDI, warehouse, MCB handling, catalog and turnover fees.'),
  acct('4570', 'Marketplace Referral & Commission Fees', 'revenue', 'contra_revenue', '4500',
    'Amazon referral fees and Faire commissions. Treated as contra revenue because they are a price concession on the sale, not a fulfillment cost.'),
  acct('4575', 'Coupons & Promotional Discounts', 'revenue', 'contra_revenue', '4500',
    'Coupon redemptions, discount codes and site-wide promotions on our own channels.'),
  acct('4580', 'Early Payment Discounts', 'revenue', 'contra_revenue', '4500',
    'Discounts customers take for paying early, such as 2% 10 net 30.'),
  acct('4585', 'Returns & Allowances', 'revenue', 'contra_revenue', '4500',
    'Credit issued for returned or refused product, and negotiated allowances that are not a named promotion.'),
  acct('4590', 'Unauthorized Deductions Written Off', 'revenue', 'contra_revenue', '4500',
    'Deductions we disputed and gave up recovering; clears the balance out of 1210.'),

  // -------------------------------------------------------------------------
  // 5000 — Cost of goods sold
  // -------------------------------------------------------------------------
  acct('5000', 'Cost of Goods Sold', 'expense', 'cogs', null,
    `${ROLLUP} Costs that make gross margin. Fulfillment costs belong in 5500.`),
  acct('5010', 'Product Cost - Co-Manufacturing', 'expense', 'cogs', '5000',
    'Tolling and conversion fees charged by the co-man to turn ingredients into finished cases.'),
  acct('5015', 'Ingredients & Raw Materials', 'expense', 'cogs', '5000',
    'Ingredient cost relieved from inventory when product is sold.'),
  acct('5020', 'Packaging', 'expense', 'cogs', '5000',
    'Packaging cost relieved from inventory when product is sold.'),
  acct('5030', 'Freight In', 'expense', 'cogs', '5000',
    'Inbound freight moving ingredients, packaging and finished goods into inventory; capitalize into landed cost where the lot is known.'),
  acct('5040', 'Inbound Duty, Tariffs & Customs', 'expense', 'cogs', '5000',
    'Duty, tariffs and customs brokerage on imported ingredients or packaging.'),
  acct('5050', 'Co-Man Overrun / Underrun Variance', 'expense', 'cogs', '5000',
    'Difference between the standard cost of a production run and what the co-man actually yielded and billed.'),
  acct('5060', 'Inventory Write-offs & Spoilage', 'expense', 'cogs', '5000',
    'Expired, damaged or destroyed inventory written off, and true-ups of the 1390 reserve.'),
  acct('5070', 'Samples & Demo Product', 'expense', 'cogs', '5000',
    'Finished goods given away for demos, sales samples and influencer seeding, relieved from inventory at cost.'),

  acct('5500', 'Fulfillment & Selling Costs', 'expense', 'fulfillment', null,
    `${ROLLUP} Cost of getting product to the customer. Deliberately excluded from gross margin.`),
  acct('5510', 'Outbound Freight & Shipping', 'expense', 'fulfillment', '5500',
    'Parcel and LTL cost to ship orders to customers, distributors and Amazon fulfillment centers.'),
  acct('5520', '3PL & Warehouse Fees', 'expense', 'fulfillment', '5500',
    'Storage, receiving, handling and account fees charged by the 3PL or public warehouse.'),
  acct('5530', 'FBA Fulfillment Fees', 'expense', 'fulfillment', '5500',
    'Amazon pick, pack, weight-handling, storage, removal and long-term storage fees.'),
  acct('5540', 'Payment Processing Fees', 'expense', 'fulfillment', '5500',
    'Card and ACH processing fees from Shopify Payments, Stripe and PayPal. Marketplace commissions go to 4570.'),
  acct('5550', 'Pick & Pack Fees', 'expense', 'fulfillment', '5500',
    'Per-order and per-unit pick and pack charges where the 3PL bills them separately from storage.'),
  acct('5560', 'Shipping Supplies', 'expense', 'fulfillment', '5500',
    'Boxes, mailers, void fill, ice packs and shipping labels consumed fulfilling orders.'),

  // -------------------------------------------------------------------------
  // 6000 — Operating expenses
  // -------------------------------------------------------------------------
  acct('6000', 'Operating Expenses', 'expense', 'operating_expense', null,
    `${ROLLUP} Everything below the fulfillment line.`),

  acct('6100', 'Marketing & Advertising', 'expense', 'marketing', '6000',
    `${ROLLUP} All demand generation and trade marketing.`),
  acct('6110', 'Amazon Advertising', 'expense', 'marketing', '6100',
    'Sponsored Products, Brands and Display spend billed by Amazon Ads.'),
  acct('6120', 'Meta & Google Ads', 'expense', 'marketing', '6100',
    'Paid social and search spend, including TikTok, Pinterest and programmatic buys.'),
  acct('6130', 'Influencer & Affiliate', 'expense', 'marketing', '6100',
    'Creator fees, UGC licensing and affiliate commissions. Product given away goes to 5070.'),
  acct('6140', 'Trade Shows & Events', 'expense', 'marketing', '6100',
    'Booth space, freight, build-out and staffing for Expo West, Fancy Food and similar shows.'),
  acct('6150', 'Broker Commissions', 'expense', 'marketing', '6100',
    'Commissions paid to retail and foodservice brokers on shipped sales.'),
  acct('6160', 'Sampling & Demos', 'expense', 'marketing', '6100',
    'In-store demo labor, demo agency fees and sampling programs. The product itself goes to 5070.'),
  acct('6170', 'Agency & Creative Services', 'expense', 'marketing', '6100',
    'Retainers and project fees for creative, media buying, photography and video.'),
  acct('6190', 'Public Relations', 'expense', 'marketing', '6100',
    'PR agency retainers, press kits and media outreach.'),

  acct('6200', 'Payroll & Benefits', 'expense', 'payroll', '6000',
    `${ROLLUP} Total cost of the team.`),
  acct('6210', 'Salaries & Wages', 'expense', 'payroll', '6200',
    'Gross wages for W-2 employees, including bonuses and sales commissions.'),
  acct('6220', 'Contract Labor & Consultants', 'expense', 'payroll', '6200',
    'Payments to 1099 contractors and fractional staff.'),
  acct('6230', 'Payroll Taxes', 'expense', 'payroll', '6200',
    'Employer share of FICA, FUTA and state unemployment.'),
  acct('6240', 'Employee Benefits & Insurance', 'expense', 'payroll', '6200',
    'Health, dental, vision, workers compensation and retirement match.'),
  acct('6250', 'Payroll Processing Fees', 'expense', 'payroll', '6200',
    'Fees charged by the payroll or PEO provider.'),
  acct('6260', 'Training & Development', 'expense', 'payroll', '6200',
    'Courses, certifications and conference registrations for the team.'),

  acct('6300', 'Research & Product Development', 'expense', 'research_development', '6000',
    `${ROLLUP} Work on products that are not yet selling.`),
  acct('6310', 'Formulation & Bench Work', 'expense', 'research_development', '6300',
    'R&D kitchen time, food scientist fees and ingredient trials for products not yet launched.'),
  acct('6320', 'Product Testing & Lab Fees', 'expense', 'research_development', '6300',
    'Nutritional panels, shelf-life studies, pathogen and residue testing.'),
  acct('6330', 'Package & Label Design', 'expense', 'research_development', '6300',
    'Structural and graphic design for packaging, including label compliance review.'),
  acct('6340', 'Pilot & Trial Runs', 'expense', 'research_development', '6300',
    'Trial production runs whose output is not sellable inventory.'),

  acct('6400', 'Professional Fees', 'expense', 'professional_fees', '6000',
    `${ROLLUP} Outside expertise billed by the hour or on retainer.`),
  acct('6410', 'Accounting & Bookkeeping', 'expense', 'professional_fees', '6400',
    'Outside accountants, bookkeepers and tax preparation.'),
  acct('6420', 'Legal', 'expense', 'professional_fees', '6400',
    'Attorney fees for contracts, financing, trademarks and disputes.'),
  acct('6430', 'Consulting & Advisory', 'expense', 'professional_fees', '6400',
    'Fractional CFO, supply chain, retail strategy and other advisors.'),

  acct('6500', 'Occupancy & Insurance', 'expense', 'occupancy', '6000',
    `${ROLLUP} Cost of the space we occupy and the risk we insure.`),
  acct('6510', 'Rent & Occupancy', 'expense', 'occupancy', '6500',
    'Office, kitchen and storage rent, common area charges and parking.'),
  acct('6520', 'Utilities', 'expense', 'occupancy', '6500',
    'Electricity, gas, water, internet and phone for company space.'),
  acct('6530', 'Business Insurance', 'expense', 'occupancy', '6500',
    'General liability, product liability, property, cargo, D&O and umbrella premiums.'),
  acct('6540', 'Repairs & Maintenance', 'expense', 'occupancy', '6500',
    'Upkeep of company space and equipment that is not capitalized.'),

  acct('6600', 'Technology & Software', 'expense', 'technology', '6000',
    `${ROLLUP} Tools the business runs on.`),
  acct('6610', 'Software & SaaS Subscriptions', 'expense', 'technology', '6600',
    'Recurring software: accounting, ERP, email and SMS platforms, analytics and design tools.'),
  acct('6620', 'E-commerce Platform Fees', 'expense', 'technology', '6600',
    'Shopify plan and app subscriptions, Faire membership and marketplace subscription fees.'),
  acct('6630', 'IT & Equipment', 'expense', 'technology', '6600',
    'Computers, phones and peripherals under the capitalization threshold, plus IT support.'),

  acct('6700', 'General & Administrative', 'expense', 'general_admin', '6000',
    `${ROLLUP} Running the company day to day.`),
  acct('6710', 'Bank & Merchant Fees', 'expense', 'general_admin', '6700',
    'Bank account fees, wire fees and card annual fees. Customer payment processing goes to 5540.'),
  acct('6720', 'Travel', 'expense', 'general_admin', '6700',
    'Airfare, lodging, rental cars and mileage for business travel.'),
  acct('6730', 'Meals & Entertainment', 'expense', 'general_admin', '6700',
    'Business meals with customers, vendors and the team; note the attendees in the memo for the tax split.'),
  acct('6740', 'Office Supplies & Postage', 'expense', 'general_admin', '6700',
    'Consumable office supplies, printing and business mail.'),
  acct('6750', 'Dues & Subscriptions', 'expense', 'general_admin', '6700',
    'Industry associations, trade publications and syndicated data subscriptions.'),

  acct('6800', 'Licensing & Compliance', 'expense', 'compliance', '6000',
    `${ROLLUP} The cost of being allowed to sell food.`),
  acct('6810', 'Food Safety & Certification', 'expense', 'compliance', '6800',
    'SQF and GFSI audits, third-party inspections, HACCP plan reviews and recall plan requirements.'),
  acct('6820', 'FDA & Regulatory', 'expense', 'compliance', '6800',
    'FDA facility registration, FCE and SID filings, label and claim review, prior notice fees.'),
  acct('6830', 'Organic & Non-GMO Certification', 'expense', 'compliance', '6800',
    'Annual certifier fees and inspections for organic, Non-GMO Project, kosher and gluten-free marks.'),
  acct('6840', 'State Registrations & Licenses', 'expense', 'compliance', '6800',
    'Secretary of state registrations, resale and food handler permits, franchise and annual report filings.'),
  acct('6850', 'Trademarks & Intellectual Property', 'expense', 'compliance', '6800',
    'Trademark filing, renewal and watch service fees.'),

  acct('6900', 'Depreciation & Amortization', 'expense', 'depreciation', '6000',
    'Periodic depreciation of fixed assets and amortization of leasehold improvements; credits 1590.'),
  acct('6910', 'Bad Debt Expense', 'expense', 'general_admin', '6000',
    'Customer invoices judged uncollectible, and changes to the 1220 allowance.'),
  acct('6990', 'Other Operating Expense', 'expense', 'general_admin', '6000',
    'Operating cost that genuinely fits nowhere else. If it recurs, open an account for it.'),

  // -------------------------------------------------------------------------
  // 7000 — Other income and expense
  // -------------------------------------------------------------------------
  acct('7000', 'Other Income', 'revenue', 'other_revenue', null,
    `${ROLLUP} Income from outside normal operations.`),
  acct('7010', 'Interest Income', 'revenue', 'other_revenue', '7000',
    'Interest earned on bank and reserve balances.'),
  acct('7020', 'Miscellaneous Income', 'revenue', 'other_revenue', '7000',
    'Grants, insurance and legal settlements, and rebates not tied to a specific purchase.'),

  acct('7100', 'Other Expense', 'expense', 'other_expense', null,
    `${ROLLUP} Cost from outside normal operations.`),
  acct('7110', 'Interest Expense', 'expense', 'other_expense', '7100',
    'Interest on loans, the line of credit and shareholder notes.'),
  acct('7120', 'Financing & Loan Fees', 'expense', 'other_expense', '7100',
    'Origination fees, factoring fees and the fee portion of merchant cash advances.'),
  acct('7130', 'Foreign Exchange Gain or Loss', 'expense', 'other_expense', '7100',
    'Realized and unrealized currency differences on foreign vendor payments; a gain posts here as a credit.'),
  acct('7140', 'Gain or Loss on Asset Disposal', 'expense', 'other_expense', '7100',
    'Difference between proceeds and net book value when a fixed asset is sold or scrapped.'),

  acct('7200', 'Income Tax Expense', 'expense', 'income_tax', null,
    'Federal, state and franchise income taxes. Sales tax is never an expense.'),
  acct('7900', 'Ask My Accountant', 'expense', 'suspense', null,
    'Holding account for transactions nobody could classify. Must be empty before a period is closed.'),
] as const satisfies readonly AccountSeed[]);

/**
 * Semantic name -> account code. Application code references accounts through this map only;
 * a bare code string in a module outside this file is a bug.
 *
 * The test suite proves this map is a bijection with `COA_SEED`, so every account is reachable
 * by name and every name resolves to a real account.
 */
export const ACCOUNTS = Object.freeze({
  // Cash and bank
  CASH_AND_BANK: '1000',
  OPERATING_CHECKING: '1010',
  SAVINGS_RESERVE: '1020',
  PETTY_CASH: '1030',
  UNDEPOSITED_FUNDS: '1040',

  // Channel clearing
  CLEARING: '1100',
  CLEARING_SHOPIFY: '1110',
  CLEARING_AMAZON: '1120',
  CLEARING_FAIRE: '1130',
  CLEARING_PROCESSOR: '1140',
  CLEARING_SQUARE: '1150',

  // Receivables
  AR: '1200',
  DEDUCTIONS_RECEIVABLE: '1210',
  ALLOWANCE_DOUBTFUL_ACCOUNTS: '1220',
  OTHER_RECEIVABLES: '1230',

  // Inventory
  INVENTORY: '1300',
  INVENTORY_FINISHED: '1310',
  INVENTORY_INGREDIENTS: '1320',
  INVENTORY_PACKAGING: '1330',
  INVENTORY_IN_TRANSIT: '1340',
  INVENTORY_RESERVE: '1390',

  // Prepaid and other assets
  PREPAID_AND_OTHER_ASSETS: '1400',
  PREPAID_EXPENSES: '1410',
  PREPAID_INSURANCE: '1420',
  SECURITY_DEPOSITS: '1430',
  VENDOR_DEPOSITS: '1440',

  // Fixed assets
  FIXED_ASSETS: '1500',
  EQUIPMENT: '1510',
  FURNITURE_FIXTURES: '1520',
  COMPUTERS: '1530',
  LEASEHOLD_IMPROVEMENTS: '1540',
  TOOLING_AND_MOLDS: '1550',
  ACCUMULATED_DEPRECIATION: '1590',

  // Payables and accruals
  AP: '2000',
  CREDIT_CARDS: '2050',
  CREDIT_CARD_OPERATIONS: '2051',
  CREDIT_CARD_MARKETING: '2052',
  ACCRUED_LIABILITIES: '2100',
  ACCRUED_EXPENSES: '2110',
  ACCRUED_TRADE_SPEND: '2120',
  ACCRUED_FREIGHT: '2130',
  ACCRUED_PAYROLL: '2140',
  ACCRUED_BROKER_COMMISSIONS: '2150',
  ACCRUED_COMAN_COSTS: '2160',

  // Other liabilities
  SALES_TAX_PAYABLE: '2200',
  PAYROLL_TAX_PAYABLE: '2210',
  GIFT_CARD_LIABILITY: '2220',
  CUSTOMER_DEPOSITS: '2300',
  DEFERRED_REVENUE: '2310',

  // Debt
  NOTES_PAYABLE: '2500',
  LINE_OF_CREDIT: '2510',
  LOANS_CURRENT: '2520',
  LOANS_LONG_TERM: '2530',
  REVENUE_BASED_FINANCING: '2540',
  SHAREHOLDER_LOANS: '2550',
  ACCRUED_INTEREST: '2560',
  SAFE_AND_CONVERTIBLE_NOTES: '2570',

  // Equity
  COMMON_STOCK: '3000',
  PAID_IN_CAPITAL: '3010',
  MEMBER_CONTRIBUTIONS: '3015',
  OWNER_DRAWS: '3020',
  RETAINED_EARNINGS: '3900',
  OPENING_BALANCE_EQUITY: '3990',

  // Revenue
  GROSS_REVENUE: '4000',
  SALES_DTC: '4010',
  SALES_SQUARE: '4015',
  SALES_AMAZON: '4020',
  SALES_DISTRIBUTOR: '4030',
  SALES_WHOLESALE: '4040',
  SALES_FOODSERVICE: '4050',
  SHIPPING_INCOME: '4060',
  OTHER_SALES_INCOME: '4090',

  // Contra revenue
  CONTRA_REVENUE: '4500',
  TRADE_OFF_INVOICE: '4510',
  TRADE_BILLBACK: '4520',
  TRADE_SCAN_DOWN: '4530',
  TRADE_SLOTTING: '4540',
  TRADE_SPOILAGE_ALLOWANCE: '4550',
  DISTRIBUTOR_FEES: '4560',
  MARKETPLACE_FEES: '4570',
  COUPONS_AND_PROMOS: '4575',
  EARLY_PAYMENT_DISCOUNTS: '4580',
  RETURNS_AND_ALLOWANCES: '4585',
  UNAUTHORIZED_DEDUCTIONS: '4590',

  // Cost of goods sold
  COGS: '5000',
  COGS_PRODUCT: '5010',
  COGS_INGREDIENTS: '5015',
  COGS_PACKAGING: '5020',
  COGS_FREIGHT_IN: '5030',
  COGS_DUTY: '5040',
  COGS_COMAN_VARIANCE: '5050',
  COGS_WRITE_OFF: '5060',
  COGS_SAMPLES: '5070',

  // Fulfillment and selling
  FULFILLMENT: '5500',
  OUTBOUND_FREIGHT: '5510',
  WAREHOUSE_3PL_FEES: '5520',
  FBA_FEES: '5530',
  PAYMENT_PROCESSING_FEES: '5540',
  PICK_PACK_FEES: '5550',
  SHIPPING_SUPPLIES: '5560',

  // Operating expenses
  OPEX: '6000',
  MARKETING: '6100',
  ADS_AMAZON: '6110',
  ADS_META_GOOGLE: '6120',
  INFLUENCER_AFFILIATE: '6130',
  TRADE_SHOWS: '6140',
  BROKER_COMMISSIONS: '6150',
  SAMPLING_DEMOS: '6160',
  AGENCY_CREATIVE: '6170',
  PUBLIC_RELATIONS: '6190',

  PAYROLL: '6200',
  SALARIES_WAGES: '6210',
  CONTRACT_LABOR: '6220',
  PAYROLL_TAXES: '6230',
  EMPLOYEE_BENEFITS: '6240',
  PAYROLL_FEES: '6250',
  TRAINING: '6260',

  RESEARCH_DEVELOPMENT: '6300',
  FORMULATION: '6310',
  LAB_TESTING: '6320',
  PACKAGE_DESIGN: '6330',
  PILOT_RUNS: '6340',

  PROFESSIONAL_FEES: '6400',
  ACCOUNTING_FEES: '6410',
  LEGAL_FEES: '6420',
  CONSULTING_FEES: '6430',

  OCCUPANCY: '6500',
  RENT: '6510',
  UTILITIES: '6520',
  BUSINESS_INSURANCE: '6530',
  REPAIRS_MAINTENANCE: '6540',

  TECHNOLOGY: '6600',
  SOFTWARE: '6610',
  ECOMMERCE_PLATFORM_FEES: '6620',
  IT_EQUIPMENT: '6630',

  GENERAL_ADMIN: '6700',
  BANK_FEES: '6710',
  TRAVEL: '6720',
  MEALS: '6730',
  OFFICE_SUPPLIES: '6740',
  DUES_SUBSCRIPTIONS: '6750',

  COMPLIANCE: '6800',
  FOOD_SAFETY: '6810',
  FDA_REGULATORY: '6820',
  ORGANIC_CERTIFICATION: '6830',
  STATE_REGISTRATIONS: '6840',
  TRADEMARKS: '6850',

  DEPRECIATION: '6900',
  BAD_DEBT: '6910',
  MISC_OPERATING_EXPENSE: '6990',

  // Other income and expense
  OTHER_INCOME: '7000',
  INTEREST_INCOME: '7010',
  MISC_INCOME: '7020',
  OTHER_EXPENSE: '7100',
  INTEREST_EXPENSE: '7110',
  FINANCING_FEES: '7120',
  FX_GAIN_LOSS: '7130',
  ASSET_DISPOSAL: '7140',
  INCOME_TAX: '7200',
  ASK_MY_ACCOUNTANT: '7900',
} as const);

export type AccountKey = keyof typeof ACCOUNTS;
export type AccountCode = (typeof ACCOUNTS)[AccountKey];

/** Where a sale on this channel is recognized. */
export const CHANNEL_REVENUE_ACCOUNT: Readonly<Record<ChannelCode, AccountCode>> = Object.freeze({
  DTC: ACCOUNTS.SALES_DTC,
  AMAZON: ACCOUNTS.SALES_AMAZON,
  DISTRIBUTOR: ACCOUNTS.SALES_DISTRIBUTOR,
  WHOLESALE: ACCOUNTS.SALES_WHOLESALE,
  FOODSERVICE: ACCOUNTS.SALES_FOODSERVICE,
});

/**
 * Where a sale on this channel waits for cash. Distributor and foodservice orders are invoiced,
 * so they sit in AR rather than a settlement clearing account, and the lookup is null.
 */
export const CHANNEL_CLEARING_ACCOUNT: Readonly<Record<ChannelCode, AccountCode | null>> =
  Object.freeze({
    DTC: ACCOUNTS.CLEARING_SHOPIFY,
    AMAZON: ACCOUNTS.CLEARING_AMAZON,
    DISTRIBUTOR: null,
    WHOLESALE: ACCOUNTS.CLEARING_FAIRE,
    FOODSERVICE: null,
  });

const BY_CODE: ReadonlyMap<string, AccountSeed> = new Map(COA_SEED.map((a) => [a.code, a]));

const CHILDREN: ReadonlyMap<string, readonly AccountSeed[]> = COA_SEED.reduce((map, a) => {
  if (a.parentCode !== null) {
    const siblings = map.get(a.parentCode);
    if (siblings) siblings.push(a);
    else map.set(a.parentCode, [a]);
  }
  return map;
}, new Map<string, AccountSeed[]>());

export function accountByCode(code: string): AccountSeed | undefined {
  return BY_CODE.get(code);
}

/** Resolve a code that must exist; throws rather than letting an unknown code reach the ledger. */
export function requireAccount(code: string): AccountSeed {
  const account = BY_CODE.get(code);
  if (!account) throw new Error(`Unknown account code: ${code}`);
  return account;
}

export function childrenOf(code: string): readonly AccountSeed[] {
  return CHILDREN.get(code) ?? [];
}

/** A rollup is a report header: it has children and nothing posts to it. */
export function isRollup(code: string): boolean {
  return CHILDREN.has(code);
}

export function isPostable(code: string): boolean {
  return BY_CODE.has(code) && !CHILDREN.has(code);
}

/** Contra-revenue accounts, in code order: gross revenue less these is net sales. */
export const CONTRA_REVENUE_CODES: readonly string[] = Object.freeze(
  childrenOf(ACCOUNTS.CONTRA_REVENUE).map((a) => a.code),
);

export function isContraRevenue(code: string): boolean {
  return accountByCode(code)?.subtype === 'contra_revenue';
}

/** Accounts reconciled against an external bank or card statement. */
export const BANK_ACCOUNT_CODES: readonly string[] = Object.freeze(
  COA_SEED.filter((a) => a.isBank).map((a) => a.code),
);

-- Sooz Books — the deduction reason-code vocabulary.
--
-- Source: docs/formats/distributor-deductions.md §7.4, §7.5 and §9 (the reason-code
-- reference table), seeded idempotently: re-running this file updates labels,
-- treatments, accounts and windows in place and never duplicates a code.
--
-- Key: code = '<SOURCE>:<verbatim code>'. `source_code` is the code as the
-- distributor prints it. `default_treatment` is §9's default_disposition:
--   accrual            charge Accrued Trade Spend (2120) when an accrual exists,
--                      otherwise the contra-revenue account
--   contra_revenue     valid trade spend or a distributor fee, straight to contra revenue
--   dispute            a claim: Deductions Receivable (1210) until proven
--   billing_correction a real billing error: reduces gross sales, not trade spend
--   expense            a distinct service bought at fair value (operating expense)
--   recovery           money given back: credits Deductions Receivable, never revenue
--   suspense           cannot be classified without a human: held in 1210 as open
--
-- UNFI codes are MEDIUM confidence (§0): a seed, not a closed set. Anything that
-- does not resolve lands in suspense and is surfaced; it is never guessed.

-- The audit trigger names each row by its `id`, and audit_log.row_id is not null.
-- deduction_reason_codes (natural key `code`) and promotion_products (composite
-- key) had no `id`, so every insert into either was refused by the audit trigger.
-- A surrogate id gives the audit trail something to point at; the natural keys stay.
alter table deduction_reason_codes
  add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists deduction_reason_codes_id_idx on deduction_reason_codes (id);
alter table promotion_products
  add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists promotion_products_id_idx on promotion_products (id);

with seed (source_system, source_code, label, category, treatment, account_code, window_days, is_trade_spend, notes) as (
  values
  -- -------------------------------------------------------------------------
  -- Source-independent vocabulary (manual deductions and fallbacks)
  -- -------------------------------------------------------------------------
  ('GEN', 'MCB',        'Manufacturer chargeback (MCB)',            'promo',      'accrual',            '4520', 180, true,  'Trade spend when it matches a signed deal sheet inside the promo window; dispute when duplicated or outside it.'),
  ('GEN', 'OI',         'Off-invoice allowance',                    'promo',      'accrual',            '4510', 90,  true,  'Usually already in the invoice price; a second off-invoice deduction is a duplicate to dispute.'),
  ('GEN', 'SCAN',       'Scan-down / scan allowance',               'promo',      'accrual',            '4530', 180, true,  'Billed on retail scan data; dispute when scans exceed shipments.'),
  ('GEN', 'BILLBACK',   'Billback',                                 'promo',      'accrual',            '4520', 60,  true,  'A promotion invoiced after the fact.'),
  ('GEN', 'TPR',        'Temporary price reduction',                'promo',      'accrual',            '4530', 90,  true,  null),
  ('GEN', 'AD',         'Ad / promotional fee',                     'promo',      'accrual',            '4575', 90,  true,  'Advertising expense only with a distinct service at fair value.'),
  ('GEN', 'SLOTTING',   'Slotting',                                 'listing',    'contra_revenue',     '4540', 180, true,  null),
  ('GEN', 'FREEFILL',   'Free fill',                                'listing',    'contra_revenue',     '4540', 180, true,  'Value the cases at our price, not the distributor''s list price.'),
  ('GEN', 'NEWITEM',    'New item / intro allowance',               'listing',    'contra_revenue',     '4540', 180, true,  'Disputable when charged per store instead of per DC.'),
  ('GEN', 'SPOILS',     'Spoils / unsaleables allowance',           'condition',  'contra_revenue',     '4550', 365, true,  'Contracted fairshare rate; dispute beyond the policy rate.'),
  ('GEN', 'SHORTAGE',   'Shortage / OS&D / case cuts',              'correction', 'dispute',            '1210', 60,  false, 'Signed BOL + POD is decisive. Valid only as a billing correction to gross sales.'),
  ('GEN', 'PRICING',    'Pricing discrepancy',                      'correction', 'dispute',            '1210', 60,  false, 'Resolved with the PO and the signed deal sheet.'),
  ('GEN', 'UNAUTH',     'Unauthorized deduction',                   'correction', 'dispute',            '1210', 60,  false, 'No matching agreement, PO or claim document.'),
  ('GEN', 'DUPLICATE',  'Duplicate deduction',                      'correction', 'dispute',            '1210', 60,  false, null),
  ('GEN', 'POSTAUDIT',  'Post-audit claim',                         'correction', 'dispute',            '1210', 30,  false, 'PRGX / SAS / SASIF. Often only days to research; keep backup three years.'),
  ('GEN', 'FREIGHT',    'Freight allowance',                        'freight',    'contra_revenue',     '4510', 90,  true,  'An allowance off price, not freight services purchased.'),
  ('GEN', 'FINE',       'Fill-rate / OTIF / compliance fine',       'fine',       'contra_revenue',     '4560', 60,  false, 'Consideration payable to a customer; dispute with routing and ASN records.'),
  ('GEN', 'ADMINFEE',   'Distributor admin / service fee',          'fee',        'contra_revenue',     '4560', 90,  true,  null),
  ('GEN', 'EPD',        'Early-payment discount',                   'terms',      'contra_revenue',     '4580', 60,  true,  '2% 10 net 30; disputable when taken outside the window.'),
  ('GEN', 'RECOVERY',   'Repayment of a disputed deduction',        'recovery',   'recovery',           '1210', null, false, 'Never revenue.'),

  -- -------------------------------------------------------------------------
  -- X12 element 426 — Adjustment Reason Code (§9.1, authoritative)
  -- -------------------------------------------------------------------------
  ('X12', '01', 'Pricing error',                                     'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '02', 'Allowance/charge error',                            'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '03', 'Extension error',                                   'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '04', 'Item not accepted - damaged',                       'condition',  'dispute',            '1210', 90,  false, null),
  ('X12', '05', 'Item not accepted - quality',                       'condition',  'dispute',            '1210', 90,  false, null),
  ('X12', '06', 'Quantity contested',                                'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '07', 'Incorrect product',                                 'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '08', 'Substitute product',                                'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '09', 'Terms of sale error',                               'terms',      'dispute',            '1210', 90,  false, null),
  ('X12', '10', 'Pallet/container charge error',                     'fine',       'dispute',            '1210', 90,  false, null),
  ('X12', '11', 'Returns - damage',                                  'condition',  'contra_revenue',     '4585', 90,  true,  null),
  ('X12', '12', 'Returns - quality',                                 'condition',  'contra_revenue',     '4585', 90,  true,  null),
  ('X12', '13', 'Returns - dating',                                  'condition',  'contra_revenue',     '4585', 90,  true,  null),
  ('X12', '14', 'Returns - promotion',                               'promo',      'contra_revenue',     '4520', 90,  true,  null),
  ('X12', '15', 'Returns - recall',                                  'condition',  'contra_revenue',     '4585', 90,  true,  null),
  ('X12', '16', 'Non-invoice related allowance/charge',              'promo',      'accrual',            '4520', 90,  true,  null),
  ('X12', '17', 'Required data missing',                             'fine',       'dispute',            '1210', 90,  false, null),
  ('X12', '19', 'Duplicate billing',                                 'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '22', 'Weight error',                                      'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '23', 'Special charge not authorized',                     'fine',       'dispute',            '1210', 90,  false, null),
  ('X12', '24', 'Incorrect discount',                                'terms',      'dispute',            '1210', 90,  false, null),
  ('X12', '25', 'Item not accepted',                                 'condition',  'dispute',            '1210', 90,  false, null),
  ('X12', '26', 'Invoice cancelled',                                 'correction', 'billing_correction', '4030', 90,  false, 'A billing correction to gross sales, not trade spend.'),
  ('X12', '27', 'Product transfers subject to charge back',          'promo',      'contra_revenue',     '4520', 90,  true,  null),
  ('X12', '28', 'Rebated shipments',                                 'promo',      'contra_revenue',     '4520', 90,  true,  null),
  ('X12', '29', 'Fee incorrect',                                     'fee',        'dispute',            '1210', 90,  false, null),
  ('X12', '43', 'Missing discount',                                  'terms',      'contra_revenue',     '4580', 90,  true,  null),
  ('X12', '44', 'Required documents missing',                        'fine',       'dispute',            '1210', 90,  false, null),
  ('X12', '45', 'Stale bill over 180 days old',                      'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '48', 'Service charge',                                    'fee',        'contra_revenue',     '4560', 90,  true,  null),
  ('X12', '49', 'Processing charge',                                 'fee',        'contra_revenue',     '4560', 90,  true,  null),
  ('X12', '52', 'Credit for previous overpayment',                   'recovery',   'recovery',           '1210', null, false, null),
  ('X12', '53', 'Remittance for previous underpayment',              'recovery',   'recovery',           '1210', null, false, null),
  ('X12', '54', 'Freight deducted',                                  'freight',    'contra_revenue',     '4510', 90,  true,  null),
  ('X12', '55', 'Tax deducted',                                      'correction', 'suspense',           null,   90,  false, 'Almost always a bottle deposit, not sales tax. Review.'),
  ('X12', '56', 'Advertising allowance taken',                       'promo',      'accrual',            '4575', 90,  true,  null),
  ('X12', '57', 'Volume discount taken',                             'promo',      'accrual',            '4510', 90,  true,  null),
  ('X12', '59', 'Item not received (shortage)',                      'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '60', 'No open item on file',                              'correction', 'suspense',           null,   90,  false, null),
  ('X12', '61', 'No open order on file',                             'correction', 'suspense',           null,   90,  false, null),
  ('X12', '62', 'Material/item description error',                  'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', '63', 'Customer paid invoice previously disputed',         'recovery',   'recovery',           '1210', null, false, null),
  ('X12', 'D8', 'Count and recount allowance',                       'condition',  'contra_revenue',     '4550', 90,  true,  null),
  ('X12', 'D9', 'Store stock price protection',                      'promo',      'contra_revenue',     '4510', 90,  true,  null),
  ('X12', 'E1', 'Recoupment',                                        'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', 'E2', 'Covered by debit memo',                             'correction', 'suspense',           null,   90,  false, null),
  ('X12', 'E3', 'Withholding',                                       'correction', 'dispute',            '1210', 90,  false, null),
  ('X12', 'E4', 'Warehouse stock price protection',                  'promo',      'contra_revenue',     '4510', 90,  true,  null),
  ('X12', 'E5', 'Invoice price protection',                          'promo',      'contra_revenue',     '4510', 90,  true,  null),
  ('X12', 'ZZ', 'Mutually defined',                                  'unknown',    'suspense',           null,   90,  false, null),

  -- -------------------------------------------------------------------------
  -- KeHE invoice/deduction prefixes (§9.2). K-Solve window: 180 days.
  -- -------------------------------------------------------------------------
  ('KEHE', 'IA',   'KeHE invoice adjustments (MCB admin fee)',       'fee',        'contra_revenue',     '4560', 180, true,  '8% of the MCB, minimum $65 per DC; do not "correct" the minimum.'),
  ('KEHE', 'IAA',  'Intro allowance',                                'listing',    'contra_revenue',     '4540', 180, true,  null),
  ('KEHE', 'I',    'New item set up',                                'listing',    'contra_revenue',     '4540', 180, true,  null),
  ('KEHE', 'S',    'Slotting',                                       'listing',    'contra_revenue',     '4540', 180, true,  null),
  ('KEHE', 'SS',   'Shaws slotting',                                 'listing',    'contra_revenue',     '4540', 180, true,  null),
  ('KEHE', 'MS',   'Meijers slotting',                               'listing',    'contra_revenue',     '4540', 180, true,  null),
  ('KEHE', 'P',    'Placement (retailer-required)',                  'listing',    'contra_revenue',     '4540', 180, true,  null),
  ('KEHE', 'PL',   'Placement',                                      'listing',    'contra_revenue',     '4540', 180, true,  null),
  ('KEHE', 'IP',   'Placement (independent)',                        'listing',    'contra_revenue',     '4540', 180, true,  null),
  ('KEHE', 'NP',   'Placement (natural store)',                      'listing',    'contra_revenue',     '4540', 180, true,  null),
  ('KEHE', 'H',    'Promotion (broad) - MCB / billback',             'promo',      'accrual',            '4520', 180, true,  null),
  ('KEHE', 'HN',   'New season promo / billback',                    'promo',      'accrual',            '4520', 180, true,  null),
  ('KEHE', 'TG',   'Special deal promotion',                         'promo',      'accrual',            '4520', 180, true,  null),
  ('KEHE', 'SH',   'Show promotion',                                 'promo',      'accrual',            '4520', 180, true,  null),
  ('KEHE', 'PG',   'Promotion overflow',                             'promo',      'accrual',            '4520', 180, true,  null),
  ('KEHE', 'N',    'Scans',                                          'promo',      'accrual',            '4530', 180, true,  null),
  ('KEHE', 'NN',   'Scans',                                          'promo',      'accrual',            '4530', 180, true,  null),
  ('KEHE', 'SN',   'Scans',                                          'promo',      'accrual',            '4530', 180, true,  null),
  ('KEHE', 'MN',   'Scans',                                          'promo',      'accrual',            '4530', 180, true,  null),
  ('KEHE', 'KN',   'Scans',                                          'promo',      'accrual',            '4530', 180, true,  null),
  ('KEHE', 'SWN',  'Scans',                                          'promo',      'accrual',            '4530', 180, true,  null),
  ('KEHE', 'BL',   'Scans',                                          'promo',      'accrual',            '4530', 180, true,  null),
  ('KEHE', 'CVSN', 'Scans (CVS)',                                    'promo',      'accrual',            '4530', 180, true,  null),
  ('KEHE', 'FTN',  'Scans',                                          'promo',      'accrual',            '4530', 180, true,  null),
  ('KEHE', 'AD',   'Advertising',                                    'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'CA',   'Advertising / ad package',                       'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'KA',   'Advertising / ad package',                       'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'AA',   'Advertising / ad package',                       'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'AN',   'Advertising / ad package',                       'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'D',    'Demo',                                           'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'DB',   'Demo',                                           'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'MM',   'Demo',                                           'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'Y',    'Display',                                        'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'ML',   'Meijers display allowance',                      'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'U',    'Coupon',                                         'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'UH',   'Coupon',                                         'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'SC',   'Coupon',                                         'promo',      'accrual',            '4575', 180, true,  null),
  ('KEHE', 'K',    'SPIF',                                           'promo',      'contra_revenue',     '4575', 180, true,  null),
  ('KEHE', 'M',    'Samples',                                        'promo',      'contra_revenue',     '4575', 180, true,  null),
  ('KEHE', 'R',    'Resets',                                         'promo',      'contra_revenue',     '4575', 180, true,  null),
  ('KEHE', 'F',    'Food show',                                      'promo',      'contra_revenue',     '4575', 180, true,  null),
  ('KEHE', 'Z',    'Sales meeting',                                  'promo',      'contra_revenue',     '4575', 180, true,  null),
  ('KEHE', 'J',    'Warehouse billback',                             'promo',      'accrual',            '4520', 180, true,  null),
  ('KEHE', 'ME',   'Meijers EDLP',                                   'promo',      'accrual',            '4510', 180, true,  null),
  ('KEHE', 'XPP',  'Price protection',                               'promo',      'contra_revenue',     '4510', 180, true,  null),
  ('KEHE', 'RDF',  'Retail discount',                                'promo',      'contra_revenue',     '4510', 180, true,  null),
  ('KEHE', 'MK',   'Mark down credits',                              'promo',      'contra_revenue',     '4510', 180, true,  null),
  ('KEHE', 'G',    'Damages or spoils',                              'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'CS',   'Customer spoilage allowance',                    'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'Q',    'Out of date credits',                            'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'QM',   'Warehouse credits - SALV1',                      'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'QT',   'Warehouse credits - SALV2',                      'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'GP',   'Retailer reclamation (Publix)',                  'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'HB',   'Retailer reclamation (HEB)',                     'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'JW',   'Retailer reclamation (Jewel)',                   'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'SV',   'Retailer reclamation (Supervalu)',               'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'SW',   'Retailer reclamation (Shaws)',                   'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'WG',   'Walmart spoils',                                 'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'L',    'Recall',                                         'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'MD',   'Mfg discontinued',                               'condition',  'contra_revenue',     '4550', 180, true,  null),
  ('KEHE', 'C',    'Case cuts (shortage)',                           'correction', 'dispute',            '1210', 180, false, 'Signed BOL and POD decide it. Answer a UDR at the dock within ~48 hours.'),
  ('KEHE', 'KC',   'KeHE audit - product short / price change',      'correction', 'dispute',            '1210', 180, false, null),
  ('KEHE', 'KP',   'Short on deal',                                  'correction', 'dispute',            '1210', 180, false, null),
  ('KEHE', 'MGP',  'OI audit - movement greater than purchase',      'correction', 'dispute',            '1210', 180, false, null),
  ('KEHE', 'ALB',  'Retailer / chain audit',                         'correction', 'dispute',            '1210', 180, false, null),
  ('KEHE', 'MX',   'Retailer / chain audit',                         'correction', 'dispute',            '1210', 180, false, null),
  ('KEHE', 'RR',   'Retailer / chain audit',                         'correction', 'dispute',            '1210', 180, false, null),
  ('KEHE', 'E',    'Fine',                                           'fine',       'contra_revenue',     '4560', 180, false, 'Configurable to fulfillment fees.'),
  ('KEHE', 'SLF',  'Service level fine',                             'fine',       'contra_revenue',     '4560', 180, false, 'Configurable to fulfillment fees.'),
  ('KEHE', 'FF',   'Freight allowance',                              'freight',    'contra_revenue',     '4510', 180, true,  '$0.25-$0.40 per pound; weight-driven, never a percentage.'),
  ('KEHE', 'BF',   'Broker fee',                                     'fee',        'expense',            '6150', 180, false, null),
  ('KEHE', 'MA',   'KeHE Connect BI allowance (2%)',                 'fee',        'contra_revenue',     '4560', 180, true,  'The strongest candidate for a distinct service; reclassify to an expense account if the owner elects.'),
  ('KEHE', 'PF',   'Publication listing fee',                        'fee',        'contra_revenue',     '4540', 180, true,  null),
  ('KEHE', 'AG',   'Gladson imaging',                                'fee',        'expense',            '6990', 180, false, null),
  ('KEHE', 'IX',   'IX-ONE imaging',                                 'fee',        'expense',            '6990', 180, false, null),
  ('KEHE', 'BD',   'Bottle deposit',                                 'other',      'suspense',           null,   180, false, 'A container deposit liability, not sales tax. Review.'),
  ('KEHE', 'RM',   'Vendor return',                                  'condition',  'contra_revenue',     '4585', 180, true,  'Reverse inventory/COGS separately when product comes back.'),
  ('KEHE', 'V',    'Vendor return',                                  'condition',  'contra_revenue',     '4585', 180, true,  null),
  ('KEHE', 'VR',   'Vendor return',                                  'condition',  'contra_revenue',     '4585', 180, true,  null),
  ('KEHE', 'W',    'Direct ship',                                    'other',      'suspense',           null,   180, false, null),
  ('KEHE', 'RP',   'Repayment',                                      'recovery',   'recovery',           '1210', null, false, 'Credits Deductions Receivable; never revenue.'),
  ('KEHE', 'PB',   'Dispute win / payback',                          'recovery',   'recovery',           '1210', null, false, null),
  ('KEHE', 'PP',   'Prepayment / reversal',                          'other',      'suspense',           null,   180, false, 'Net the prepayment against its reversal; never two revenue events.'),

  -- -------------------------------------------------------------------------
  -- DPI (§9.2 tail)
  -- -------------------------------------------------------------------------
  ('DPI', 'DED',   'AEA program / marketing / spoils / freight / OI allowances', 'promo', 'accrual',    '4520', 90,  true,  null),
  ('DPI', 'CLANW', 'DPI Northwest',                                  'other',      'suspense',           null,   90,  false, 'Route to the DPI sub-ledger.'),
  ('DPI', 'CLAWE', 'DPI West',                                       'other',      'suspense',           null,   90,  false, 'Route to the DPI sub-ledger.'),
  ('DPI', 'CLARM', 'DPI Rocky Mountain',                             'other',      'suspense',           null,   90,  false, 'Route to the DPI sub-ledger.'),

  -- -------------------------------------------------------------------------
  -- UNFI (§9.3, MEDIUM confidence). Dispute Center: file within 30-60 days;
  -- adjustments older than 12 months are denied.
  -- -------------------------------------------------------------------------
  ('UNFI', '01',    'Shortages',                                     'correction', 'dispute',            '1210', 60,  false, null),
  ('UNFI', '02',    'Pricing discrepancies',                         'correction', 'dispute',            '1210', 60,  false, null),
  ('UNFI', '05',    'Unsaleables and damages',                       'condition',  'contra_revenue',     '4550', 365, true,  null),
  ('UNFI', '10',    'Advertising and promotional charges',           'promo',      'accrual',            '4520', 60,  true,  null),
  ('UNFI', '11',    'Advertising and promotional charges',           'promo',      'accrual',            '4520', 60,  true,  null),
  ('UNFI', '12',    'Advertising and promotional charges',           'promo',      'accrual',            '4520', 60,  true,  null),
  ('UNFI', '30',    'Compliance and logistics fees (30+)',           'fine',       'contra_revenue',     '4560', 60,  false, null),
  ('UNFI', 'MCB',   'Manufacturer chargeback (West)',                'promo',      'accrual',            '4520', 60,  true,  'MCB(yyyymmdd) + A/C/E tag.'),
  ('UNFI', 'UOI',   'Billback tied to promotional activity (East)',  'promo',      'accrual',            '4520', 60,  true,  'UOI(mmyy). Unauthorized when no signed deal exists.'),
  ('UNFI', 'OI',    'Off-invoice allowance',                         'promo',      'accrual',            '4510', 60,  true,  null),
  ('UNFI', 'OIA',   'Off-invoice allowance',                         'promo',      'accrual',            '4510', 60,  true,  null),
  ('UNFI', 'CBPB',  'Chargeback payback',                            'recovery',   'recovery',           '1210', null, false, null),
  ('UNFI', 'CNDM',  'Concealed damage by DC',                        'condition',  'contra_revenue',     '4550', 365, true,  '[DC#]CNDM(mmmyy).'),
  ('UNFI', 'LCPV',  'Pallet build standard failure',                 'fine',       'contra_revenue',     '4560', 60,  false, null),
  ('UNFI', 'LCP',   'Pallet placard / labeling miss',                'fine',       'contra_revenue',     '4560', 60,  false, null),
  ('UNFI', 'LCBOL', 'Incomplete BOL or packing slip',                'fine',       'contra_revenue',     '4560', 60,  false, null),
  ('UNFI', 'AVL',   'Late delivery (> 30 min past appointment)',     'fine',       'contra_revenue',     '4560', 60,  false, null),
  ('UNFI', 'W&M FINE',       'Weights-and-measures fine',            'fine',       'contra_revenue',     '4560', 60,  false, null),
  ('UNFI', 'ASN COMPLIANCE', 'ASN/EDI accuracy fine',                'fine',       'contra_revenue',     '4560', 60,  false, null),
  ('UNFI', 'ROUTING FINE',   'Shipped outside routing requirements', 'fine',       'contra_revenue',     '4560', 60,  false, null),
  ('UNFI', 'LABEL FINE',     'Pallet/case labeling failure',         'fine',       'contra_revenue',     '4560', 60,  false, null),
  ('UNFI', 'SSA',   'Simplified Supplier Approach fee (2.5%)',       'fee',        'contra_revenue',     '4560', 365, true,  'One consolidated monthly deduction per region from 1 Feb 2026.'),
  ('UNFI', '111',   'Quantity/pricing chargeback (-111 suffix)',     'correction', 'dispute',            '1210', 60,  false, null),
  ('UNFI', 'PB',    'Dispute win',                                   'recovery',   'recovery',           '1210', null, false, null),
  ('UNFI', 'PP',    'Prepayment / reversal',                         'other',      'suspense',           null,   60,  false, null)
)
insert into deduction_reason_codes as rc
  (code, label, category, default_treatment, default_account_id, dispute_window_days,
   typically_valid, notes, active, source_system, source_code, is_trade_spend)
select s.source_system || ':' || s.source_code,
       s.label,
       s.category,
       s.treatment::deduction_treatment,
       a.id,
       coalesce(s.window_days, 0),
       s.treatment not in ('dispute', 'suspense'),
       s.notes,
       true,
       s.source_system,
       s.source_code,
       s.is_trade_spend
  from seed s
  left join accounts a on a.code = s.account_code
on conflict (code) do update
   set label               = excluded.label,
       category            = excluded.category,
       default_treatment   = excluded.default_treatment,
       default_account_id  = excluded.default_account_id,
       dispute_window_days = excluded.dispute_window_days,
       typically_valid     = excluded.typically_valid,
       notes               = excluded.notes,
       source_system       = excluded.source_system,
       source_code         = excluded.source_code,
       is_trade_spend      = excluded.is_trade_spend;

-- Every seeded account code must have resolved; a typo would silently leave a
-- code with no account and send its deductions to suspense.
do $$
declare missing int;
begin
  select count(*) into missing
    from deduction_reason_codes
   where default_account_id is null
     and default_treatment not in ('suspense');
  if missing > 0 then
    raise exception 'deduction_reason_codes: % codes have no default account', missing;
  end if;
end $$;

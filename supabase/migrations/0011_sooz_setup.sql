-- Sooz Books — company setup derived from nine months of real Relay statements
-- (Jan–Sep 2026, accounts #9726 #9727 #9972 #9973, 110 transactions, balance chain verified).
--
-- Sooz Beverage LLC is pre-launch: formulating with a consultant, buying ingredients and
-- packaging, selling small volumes through Square, and funded by member contributions from
-- the founder's personal accounts. The setup below reflects that, not a hypothetical brand.

-- ---------------------------------------------------------------------------
-- Accounts the seeded chart of accounts did not anticipate
-- ---------------------------------------------------------------------------
insert into accounts (code, name, type, subtype, parent_id, is_bank, description) values
  ('3015', 'Member Contributions', 'equity', 'equity',
    (select id from accounts where code = '3000'), false,
    'Money the founder puts into the business from personal funds. Relay shows these as ACH Pulls from Chase College Checking and BofA Advantage SafeBalance. Not revenue.'),
  ('1150', 'Square Clearing', 'asset', 'clearing',
    (select id from accounts where code = '1100'), false,
    'Holds a Square payout between the sale being recorded and the cash landing in Relay. Should be zero once the matching Square settlement is imported.'),
  ('4015', 'Direct & Market Sales (Square)', 'revenue', 'sales',
    (select id from accounts where code = '4000'), false,
    'In-person and direct sales taken through Square: markets, events, sampling, direct invoices.'),
  ('1011', 'Relay — Operating Expenses ••9726', 'asset', 'bank',
    (select id from accounts where code = '1000'), true,
    'The main Relay account. All card spend (Corporate Card 1892 and virtual card 8796) settles here.'),
  ('1012', 'Relay — ••9727', 'asset', 'bank',
    (select id from accounts where code = '1000'), true,
    'Relay envelope account. No activity through September 2026; rename once it is used.'),
  ('1013', 'Relay — ••9972', 'asset', 'bank',
    (select id from accounts where code = '1000'), true,
    'Relay envelope account. No activity through September 2026; rename once it is used.'),
  ('1014', 'Relay — Owner''s Comp ••9973', 'asset', 'bank',
    (select id from accounts where code = '1000'), true,
    'Relay envelope account used for owner compensation.')
on conflict (code) do update set
  name = excluded.name, type = excluded.type, subtype = excluded.subtype,
  parent_id = excluded.parent_id, is_bank = excluded.is_bank, description = excluded.description;

-- Square is the payment processor for direct sales; point the clearing account at DTC.
update accounts set clearing_for_channel_id = (select id from channels where code = 'DTC')
 where code = '1150';

-- ---------------------------------------------------------------------------
-- Bank accounts. Opening balances are derived from the statements themselves:
-- the earliest row's Balance minus its Amount is the balance the account carried in.
-- ---------------------------------------------------------------------------
insert into bank_accounts (account_id, name, institution, kind, mask, statement_sign,
                           opening_balance_cents, opening_date) values
  ((select id from accounts where code = '1011'), 'Relay — Operating Expenses', 'Relay', 'checking', '9726', 1, 100000, '2026-01-14'),
  ((select id from accounts where code = '1012'), 'Relay — ••9727',             'Relay', 'checking', '9727', 1,      0, '2026-01-01'),
  ((select id from accounts where code = '1013'), 'Relay — ••9972',             'Relay', 'checking', '9972', 1,      0, '2026-01-01'),
  ((select id from accounts where code = '1014'), 'Relay — Owner''s Comp',      'Relay', 'checking', '9973', 1,      0, '2026-01-01')
on conflict (account_id) do update set
  name = excluded.name, institution = excluded.institution, mask = excluded.mask,
  opening_balance_cents = excluded.opening_balance_cents, opening_date = excluded.opening_date;

-- ---------------------------------------------------------------------------
-- The Relay import profile. Relay's format is stable across all 36 observed files,
-- so this is seeded rather than discovered on first import.
-- ---------------------------------------------------------------------------
insert into import_profiles (
  name, bank_account_id, file_type, delimiter, encoding, skip_rows, header_row,
  date_column, date_format, description_columns, counterparty_column,
  mode, amount_column, balance_column, reference_column, type_column,
  invert_sign, skip_row_rules, detected_from_filename)
select 'Relay CSV', ba.id, 'csv', ',', 'utf-8', 0, 0,
       'Date', 'M/D/YYYY', array['Payee'], 'Payee',
       'signed', 'Amount', 'Balance', 'Reference', 'Transaction Type',
       false,
       -- A RETURNED row is a bounced ACH: it never moved money and must not post.
       -- It is kept and flagged rather than dropped, so the balance chain still validates.
       '[{"field":"Status","op":"exact","value":"RETURNED","action":"flag","reason":"Returned ACH — did not settle"}]'::jsonb,
       '^Relay( \(Partial\))? \d{4}-\d{2}-01 #(\d{4})\.csv$'
  from bank_accounts ba
 where ba.mask in ('9726', '9727', '9972', '9973')
on conflict do nothing;

update bank_accounts ba
   set default_profile_id = ip.id
  from import_profiles ip
 where ip.bank_account_id = ba.id and ip.name = 'Relay CSV';

-- ---------------------------------------------------------------------------
-- Vendor aliases: the same merchant appears under several spellings on a statement
-- (GOOGLE / Google, FedEx / FEDEX533300619, Meta Store / "SP+AFF * META STORE -").
-- Matching goes through the normalized alias, never the raw payee string.
-- ---------------------------------------------------------------------------
create table if not exists vendor_aliases (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references vendors (id) on delete cascade,
  alias       text not null,
  alias_normalized text generated always as (normalize_description(alias)) stored,
  source      text not null default 'manual',   -- manual | learned
  created_at  timestamptz not null default now(),
  unique (vendor_id, alias)
);
create index vendor_alias_norm_idx on vendor_aliases (alias_normalized);
alter table vendor_aliases enable row level security;

-- ---------------------------------------------------------------------------
-- Vendors actually seen in the statements
-- ---------------------------------------------------------------------------
insert into vendors (name, vendor_type, default_expense_account_id, notes) values
  ('Blue Pacific Flavors',        'ingredients', (select id from accounts where code='1320'), 'Flavor house. Purchases come in on POs (SOOZ-2026-001).'),
  ('Jedwards International',      'ingredients', (select id from accounts where code='1320'), 'Oils and specialty ingredients. Purchases on POs.'),
  ('Lab Alley',                   'ingredients', (select id from accounts where code='1320'), 'Lab-grade chemicals and ingredients.'),
  ('AMCO Proteins',               'ingredients', (select id from accounts where code='1320'), 'Protein supplier — instant micellar casein.'),
  ('Ingredi',                     'ingredients', (select id from accounts where code='1320'), 'Bulk food ingredient distributor.'),
  ('Puriva Nutrition',            'ingredients', (select id from accounts where code='1320'), null),
  ('Bulk Supplements',            'ingredients', (select id from accounts where code='1320'), null),
  ('Kalustyan''s',                'ingredients', (select id from accounts where code='1320'), 'Specialty spices and ingredients.'),
  ('Nature''s Flavors',           'ingredients', (select id from accounts where code='1320'), null),
  ('Flavor Jungle',               'ingredients', (select id from accounts where code='1320'), null),
  ('Box Nutra',                   'ingredients', (select id from accounts where code='1320'), null),
  ('Brandmydispo',                'packaging',   (select id from accounts where code='1330'), 'Custom packaging and bottles.'),
  ('Online Labels',               'packaging',   (select id from accounts where code='1330'), 'Label stock.'),
  ('Pak-Man Packaging',           'packaging',   (select id from accounts where code='1330'), null),
  ('Sticker Swan',                'packaging',   (select id from accounts where code='1330'), 'Custom stickers and labels.'),
  ('Andrew Firestone',            'professional',(select id from accounts where code='6310'), 'Beverage formulation consultant. 1099 candidate — confirm W-9.'),
  ('Meta',                        'marketing',   (select id from accounts where code='6120'), 'Meta advertising. Recurring ~$53.31.'),
  ('Google',                      'marketing',   (select id from accounts where code='6120'), 'Verify each charge: Ads vs Workspace subscription.'),
  ('Fiverr',                      'marketing',   (select id from accounts where code='6170'), 'Freelance creative work.'),
  ('FedEx',                       'freight',     (select id from accounts where code='5510'), 'Use Freight-In (5030) when the shipment is inbound on a PO.'),
  ('Relay',                       'other',       (select id from accounts where code='6710'), 'Business banking platform. Banking fees.'),
  ('Square',                      'other',       (select id from accounts where code='5540'), 'Payment processor for direct and market sales.'),
  ('Amazon',                      'other',       null,                                        'Ambiguous by design: lab supplies, packaging, office goods and personal purchases all land here. Never auto-categorize.'),
  ('Target',                      'other',       (select id from accounts where code='6740'), null),
  ('Walmart',                     'other',       (select id from accounts where code='6740'), null),
  ('Dollar Tree',                 'other',       (select id from accounts where code='6740'), null),
  ('Michaels',                    'other',       (select id from accounts where code='6740'), null),
  ('Dave''s Hot Chicken',         'other',       (select id from accounts where code='6730'), null),
  ('eBay',                        'other',       (select id from accounts where code='6740'), null),
  ('BuildASoil',                  'other',       (select id from accounts where code='6740'), null),
  ('xAI (Grok)',                  'software',    (select id from accounts where code='6610'), null),
  ('Rice University',             'other',       (select id from accounts where code='6720'), 'Parking and campus payments.')
on conflict do nothing;

insert into vendor_aliases (vendor_id, alias, source)
select v.id, a.alias, 'manual' from (values
  ('Blue Pacific Flavors',   'Blue Pacific Flavors'),
  ('Jedwards International', 'Jedwards International Inc.'),
  ('Lab Alley',              'LAB ALLEY LLC'),
  ('AMCO Proteins',          'AMCO'),
  ('Ingredi',                'INGREDI COMPANY LLC'),
  ('Puriva Nutrition',       'SP PURIVA NUTRITION'),
  ('Bulk Supplements',       'Bulk Supplement'),
  ('Kalustyan''s',           'Kalustyan''s'),
  ('Nature''s Flavors',      'SP NATURES FLAVORS'),
  ('Flavor Jungle',          'SP FLAVOR JUNGLE'),
  ('Box Nutra',              'Box Nutra'),
  ('Brandmydispo',           'Brandmydispo'),
  ('Online Labels',          'Online Labels LLC'),
  ('Pak-Man Packaging',      'PAK-MAN PACKAGING AND S'),
  ('Sticker Swan',           'SP STICKER SWAN'),
  ('Andrew Firestone',       'Andrew Firestone'),
  ('Andrew Firestone',       'FIRESTONE CONSUL'),
  ('Meta',                   'Meta Store'),
  ('Meta',                   'SP+AFF * META STORE -'),
  ('Google',                 'GOOGLE'),
  ('Google',                 'Google'),
  ('Fiverr',                 'Fiverr'),
  ('FedEx',                  'FedEx'),
  ('FedEx',                  'FEDEX533300619'),
  ('Relay',                  'Relay'),
  ('Square',                 'Square Inc'),
  ('Amazon',                 'Amazon'),
  ('Target',                 'Target'),
  ('Walmart',                'Walmart'),
  ('Dollar Tree',            'Dollar Tree'),
  ('Michaels',               'Michaels'),
  ('Dave''s Hot Chicken',    'DAVESHOTCHICKEN'),
  ('eBay',                   'eBay O*22-14335-69339'),
  ('BuildASoil',             'SP BUILDASOIL'),
  ('xAI (Grok)',             'Grok'),
  ('Rice University',        'RICE UNIVERSITY'),
  ('Rice University',        'Rice Parking')
) as a(vendor_name, alias)
  join vendors v on v.name = a.vendor_name
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Categorization rules, in priority order. Only the three unambiguous ones
-- auto-post; everything else pre-fills the review queue for a human to approve.
-- ---------------------------------------------------------------------------
insert into categorization_rules (name, priority, conditions, direction, account_id, vendor_id, auto_post)
values
  -- 10s: deterministic, safe to post without review
  ('Relay banking fees', 10,
   '[{"field":"payee","op":"exact","value":"Relay"},{"field":"reference","op":"contains","value":"Banking Fees"}]',
   'out', (select id from accounts where code='6710'), (select id from vendors where name='Relay'), true),

  ('Square payout to clearing', 11,
   '[{"field":"payee","op":"contains","value":"Square"},{"field":"reference","op":"regex","value":"^SQ[0-9]{6}$"}]',
   'in', (select id from accounts where code='1150'), (select id from vendors where name='Square'), true),

  ('Member contribution — Chase College', 12,
   '[{"field":"payee","op":"contains","value":"CHASE COLLEGE"},{"field":"reference","op":"exact","value":"ACH Pull"}]',
   'in', (select id from accounts where code='3015'), null, true),

  ('Member contribution — BofA SafeBalance', 13,
   '[{"field":"payee","op":"contains","value":"SafeBalance"},{"field":"reference","op":"exact","value":"ACH Pull"}]',
   'in', (select id from accounts where code='3015'), null, true),

  -- 20s: ingredients capitalize to inventory (confirmed treatment)
  ('Ingredients — Blue Pacific Flavors', 20, '[{"field":"payee","op":"contains","value":"Blue Pacific"}]', 'out', (select id from accounts where code='1320'), (select id from vendors where name='Blue Pacific Flavors'), false),
  ('Ingredients — Jedwards',             21, '[{"field":"payee","op":"contains","value":"Jedwards"}]',     'out', (select id from accounts where code='1320'), (select id from vendors where name='Jedwards International'), false),
  ('Ingredients — Lab Alley',            22, '[{"field":"payee","op":"contains","value":"LAB ALLEY"}]',    'out', (select id from accounts where code='1320'), (select id from vendors where name='Lab Alley'), false),
  ('Ingredients — AMCO',                 23, '[{"field":"payee","op":"exact","value":"AMCO"}]',            'out', (select id from accounts where code='1320'), (select id from vendors where name='AMCO Proteins'), false),
  ('Ingredients — Ingredi',              24, '[{"field":"payee","op":"contains","value":"INGREDI"}]',      'out', (select id from accounts where code='1320'), (select id from vendors where name='Ingredi'), false),
  ('Ingredients — Puriva',               25, '[{"field":"payee","op":"contains","value":"PURIVA"}]',       'out', (select id from accounts where code='1320'), (select id from vendors where name='Puriva Nutrition'), false),
  ('Ingredients — Bulk Supplements',     26, '[{"field":"payee","op":"contains","value":"Bulk Supplement"}]','out', (select id from accounts where code='1320'), (select id from vendors where name='Bulk Supplements'), false),
  ('Ingredients — Kalustyan''s',         27, '[{"field":"payee","op":"contains","value":"Kalustyan"}]',    'out', (select id from accounts where code='1320'), (select id from vendors where name='Kalustyan''s'), false),
  ('Ingredients — Nature''s Flavors',    28, '[{"field":"payee","op":"contains","value":"NATURES FLAVORS"}]','out', (select id from accounts where code='1320'), (select id from vendors where name='Nature''s Flavors'), false),
  ('Ingredients — Flavor Jungle',        29, '[{"field":"payee","op":"contains","value":"FLAVOR JUNGLE"}]','out', (select id from accounts where code='1320'), (select id from vendors where name='Flavor Jungle'), false),
  ('Ingredients — Box Nutra',            30, '[{"field":"payee","op":"contains","value":"Box Nutra"}]',    'out', (select id from accounts where code='1320'), (select id from vendors where name='Box Nutra'), false),

  -- 30s: packaging capitalizes to inventory
  ('Packaging — Brandmydispo',      31, '[{"field":"payee","op":"contains","value":"Brandmydispo"}]',  'out', (select id from accounts where code='1330'), (select id from vendors where name='Brandmydispo'), false),
  ('Packaging — Online Labels',     32, '[{"field":"payee","op":"contains","value":"Online Labels"}]', 'out', (select id from accounts where code='1330'), (select id from vendors where name='Online Labels'), false),
  ('Packaging — Pak-Man',           33, '[{"field":"payee","op":"contains","value":"PAK-MAN"}]',       'out', (select id from accounts where code='1330'), (select id from vendors where name='Pak-Man Packaging'), false),
  ('Packaging — Sticker Swan',      34, '[{"field":"payee","op":"contains","value":"STICKER SWAN"}]',  'out', (select id from accounts where code='1330'), (select id from vendors where name='Sticker Swan'), false),

  -- 40s: formulation and creative
  ('Formulation — Firestone', 40, '[{"field":"payee","op":"contains","value":"FIRESTONE"}]',        'out', (select id from accounts where code='6310'), (select id from vendors where name='Andrew Firestone'), false),
  ('Formulation — Andrew Firestone', 41, '[{"field":"payee","op":"contains","value":"Andrew Firestone"}]', 'out', (select id from accounts where code='6310'), (select id from vendors where name='Andrew Firestone'), false),
  ('Creative — Fiverr',       42, '[{"field":"payee","op":"contains","value":"Fiverr"}]',           'out', (select id from accounts where code='6170'), (select id from vendors where name='Fiverr'), false),

  -- 50s: marketing, software, freight
  ('Advertising — Meta',   50, '[{"field":"payee","op":"contains","value":"META STORE"}]', 'out', (select id from accounts where code='6120'), (select id from vendors where name='Meta'), false),
  ('Advertising — Google', 51, '[{"field":"payee","op":"contains","value":"GOOGLE"}]',     'out', (select id from accounts where code='6120'), (select id from vendors where name='Google'), false),
  ('Software — Grok',      52, '[{"field":"payee","op":"contains","value":"Grok"}]',       'out', (select id from accounts where code='6610'), (select id from vendors where name='xAI (Grok)'), false),
  ('Freight — FedEx',      53, '[{"field":"payee","op":"contains","value":"FEDEX"}]',      'out', (select id from accounts where code='5510'), (select id from vendors where name='FedEx'), false),
  ('Freight — FedEx (mixed case)', 54, '[{"field":"payee","op":"contains","value":"FedEx"}]', 'out', (select id from accounts where code='5510'), (select id from vendors where name='FedEx'), false),

  -- 60s: mixed-use. Defaulted to a business account per the owner's instruction, but never
  -- auto-posted — these are exactly the charges that need a human glance each month.
  ('Meals — Dave''s Hot Chicken', 60, '[{"field":"payee","op":"contains","value":"DAVESHOTCHICKEN"}]', 'out', (select id from accounts where code='6730'), (select id from vendors where name='Dave''s Hot Chicken'), false),
  ('Supplies — Target',      61, '[{"field":"payee","op":"exact","value":"Target"}]',      'out', (select id from accounts where code='6740'), (select id from vendors where name='Target'), false),
  ('Supplies — Walmart',     62, '[{"field":"payee","op":"exact","value":"Walmart"}]',     'out', (select id from accounts where code='6740'), (select id from vendors where name='Walmart'), false),
  ('Supplies — Dollar Tree', 63, '[{"field":"payee","op":"contains","value":"Dollar Tree"}]','out', (select id from accounts where code='6740'), (select id from vendors where name='Dollar Tree'), false),
  ('Supplies — Michaels',    64, '[{"field":"payee","op":"exact","value":"Michaels"}]',    'out', (select id from accounts where code='6740'), (select id from vendors where name='Michaels'), false),
  ('Supplies — eBay',        65, '[{"field":"payee","op":"contains","value":"eBay"}]',     'out', (select id from accounts where code='6740'), (select id from vendors where name='eBay'), false),
  ('Supplies — BuildASoil',  66, '[{"field":"payee","op":"contains","value":"BUILDASOIL"}]','out', (select id from accounts where code='6740'), (select id from vendors where name='BuildASoil'), false),
  ('Travel — Rice Parking',  67, '[{"field":"payee","op":"contains","value":"Rice Parking"}]','out', (select id from accounts where code='6720'), (select id from vendors where name='Rice University'), false),

  -- 70s: card refunds are expense reversals, not income. Matched on the card reference so a
  -- genuine deposit is never caught by this.
  ('Card refund — needs original', 70,
   '[{"field":"reference","op":"contains","value":"Corporate Card"}]', 'in',
   (select id from accounts where code='7900'), null, false),

  -- 90s: Amazon last and deliberately vague. 37 charges covering lab supplies, packaging,
  -- office goods and personal purchases — a confident rule here would be actively harmful.
  ('Amazon — always review', 90, '[{"field":"payee","op":"exact","value":"Amazon"}]', 'any',
   (select id from accounts where code='7900'), (select id from vendors where name='Amazon'), false)
on conflict do nothing;

select attach_audit('vendor_aliases');

grant all privileges on all tables in schema public to sooz_app;
grant all privileges on all sequences in schema public to sooz_app;

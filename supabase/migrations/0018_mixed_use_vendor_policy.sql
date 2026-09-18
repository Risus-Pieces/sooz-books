-- Mixed-use payees follow the owner's stated policy: default to the most plausible
-- business account, always route to a human, and re-tag personal purchases to Owner
-- Draws (3020) at review.
--
-- 0011 seeded Amazon as "ambiguous by design — never auto-categorize", which the AI tier
-- read as an instruction not to propose anything, so 37 transactions arrived in the review
-- queue with no suggestion at all. That contradicted the owner's decision for exactly
-- these payees ("default to business expense"). The notes below keep them on the
-- always-review list (the phrase "Always review" is what ai-suggest.ts matches) without
-- telling the model to abstain.

update vendors set notes =
  'Mixed use: lab and bench supplies, small ingredients, packaging, office goods, and occasional personal purchases. Always review. Owner''s policy: propose the most plausible business account; the owner re-tags personal purchases to Owner Draws (3020).'
 where name = 'Amazon';

update vendors set notes =
  'Mixed use: supplies, sampling materials, or personal. Always review. Owner''s policy: default to a business expense; the owner re-tags personal purchases to Owner Draws (3020).'
 where name in ('Target', 'Walmart', 'Dollar Tree', 'Michaels', 'eBay');

update vendors set notes =
  'Mixed use: business meals, tastings or personal. Always review. Owner''s policy: default to Meals (6730); the owner re-tags personal meals to Owner Draws (3020).'
 where name = 'Dave''s Hot Chicken';

-- Amazon stays parked in 7900 by its rule so that the AI tier, which sees the date and
-- amount, proposes a per-transaction business account; the rule's name now says so.
update categorization_rules
   set name = 'Amazon — business default via AI, always review'
 where name = 'Amazon — always review';

# Receipt assistant

Status: proposed, awaiting review. Date: 2026-09-29.

## Why

Most of Sooz's spending goes through the Relay accounts, and those arrive as statements the
books already import. Some spending does not: a member pays for something on a personal card or
in cash, and the personal statement is deliberately never uploaded. For those purchases the
receipt is the only evidence, and today someone has to key the entry by hand.

The assistant turns a photographed or scanned receipt into a proposed journal entry. The member
checks it and taps **Post**.

## Decisions already made

- **Propose, then tap Post.** The assistant does all the work; nothing reaches the ledger until a
  person approves. This keeps non-negotiable 7 (nothing posts from an import without human
  approval) intact. There is no auto-post path for receipts.
- **A personal payment is a member contribution.** Expense (or inventory) is debited; the paying
  member's contributions account (3016 Risus, 3017 Mo) is credited. This matches how their ACH
  pulls are already treated and is what `memberEquityAccount` in `src/lib/ledger/member-equity.ts`
  resolves.
- **Scope is personal-account purchases only.** Receipts for Relay purchases are not the use case,
  so there is no bank-row matching in v1.

## Non-goals (v1)

Bank-statement matching, forwarding receipts by email, open-ended questions about the books,
unpaid vendor invoices (a bill, not a receipt), foreign currency, and any purchase paid from a
Relay account.

## Experience

An **Assistant** button in the app shell opens a sheet: a right-hand panel on desktop, a full
sheet on phone (where the file picker offers the camera). The member drops, pastes or photographs
up to 10 receipts. Each becomes a card:

- thumbnail, vendor, date, total;
- the proposed entry in one line (`Packaging 1330  ->  Contributions - Risus 3016`);
- **Paid by** (a member), **Post**, **Edit**, **Skip**;
- a warning strip when something needs a look (see Checks).

Below the cards is a message box. The member corrects a card in plain words ("that's ingredients",
"Mo paid", "date is the 12th", "split: $40 packaging, rest freight"). Unposted proposals persist,
so closing the sheet loses nothing; they reappear under **Waiting**.

## Flow for one receipt

1. **Store.** The file goes to a new private bucket `receipts`, uploaded through a route handler
   (not a server action: files are large). A `sha256` is taken. An identical file already filed
   answers "already filed as entry #N" and stops.
2. **Extract.** A vision model reads the file into a strict schema: vendor name, date, subtotal,
   tax, tip, total, line items (description, amount), and the last four digits of any card shown.
   Amounts come back as decimal strings and are parsed with `parseMoney`; a value that does not
   parse is rejected, never rounded. Full card numbers are never requested or kept.
3. **Verify.** Code, not the model, checks that line items plus tax plus tip equal the total to the
   cent. A mismatch is flagged, not silently fixed.
4. **Resolve vendor.** Reuse `loadVendorIndex` / `resolveVendor` from `src/lib/banking/vendors.ts`.
   A new vendor is proposed as a new vendor, created only when the entry posts.
5. **Choose accounts.** Order: the vendor's default account, then payee history
   (`loadPayeeHistory`), then the model, which is offered only the postable expense and inventory
   accounts. The existing policies apply: ingredients and packaging capitalize to inventory
   (1320 / 1330), everything else is expense, and rollups, bank and control accounts are never
   offered. Sales tax paid on a purchase is part of the cost; it is not a separate account.
   The current chooser is built around bank rows, so a thin adapter feeds it a receipt; the plan
   must confirm how much of `suggestForTransaction` is reusable as-is.
6. **Propose.** Write a `receipt_proposals` row: extracted data, proposed lines, payer, warnings,
   status `proposed`.

## The entry

One entry per receipt, dated the receipt's date, memo `Receipt - <vendor>`:

- Dr the chosen account(s), one line per category, with the vendor on the line;
- Cr the payer's contributions account for the receipt total.

It balances by construction, because the credit is the sum of the debits.

Source type is a new `purchase_receipt`, added to `SOURCE_TYPES` in `src/lib/ledger/post.ts`
(the database column is free text). `source_id` is the proposal id. The stored file is linked to
the finished entry in `attachments` with a new `entity_type` of `journal_entry` (the column is free
text; `deduction` is the only value in use today), so the receipt image opens from the entry.

Receipts create no bill payment, so they never enter 1099 totals. That is correct for card and
cash purchases; the plan should confirm it against the 1099 query.

## Paid by

`Paid by` lists active users whose `contributions_account_id` is set (today: Risus, Mo). It
defaults to whoever uploaded. A user with no accounts assigned, such as a bookkeeper, must pick a
member; the pooled 3015 is a rollup and refuses postings, so falling back to it is never offered.

## Posting

A server action `postReceiptProposal(proposalId)`, not the model, does the posting. It checks the
`ledger.post` capability, then re-validates at the moment of the tap: the period is open, the
proposal is still `proposed`, the accounts are still postable, the totals still tie. It posts
through `postJournalEntry()` inside `withActor`, links the attachment, and marks the proposal
`posted` in the same transaction. A closed period is refused with a plain message; the date is
never moved on the member's behalf.

**Post all** posts every card with no warnings, one transaction each, so one refusal does not
sink the rest.

## Chat

The model has no tools that write. A typed message becomes a small structured edit
(`set_account`, `set_payer`, `set_date`, `split`, `set_vendor`, `skip`) that the model
produces and code validates and applies to the proposal. The reply text is generated by code from
the applied edit ("Moved to Packaging 1330."), so what the card says is what will post. An edit
the code rejects is answered in words and changes nothing.

This is deliberately narrower than a free-form agent: the parts that decide money are ordinary,
testable code.

## Checks (warnings on the card)

- line items do not sum to the total;
- date is in a closed period, or more than a year old, or in the future;
- likely duplicate: same vendor, date and total as a posted `purchase_receipt` entry
  (the member may confirm it is a different purchase, as `confirmedNew` does for bank rows);
- unreadable or partial photo (the model reports low legibility);
- total is zero or negative (a refund: the proposal is reversed in sign and labelled).

## Data

New migration `0046`:

- `receipt_proposals`: id, attachment id, uploader, payer, status
  (`proposed | posted | skipped`), extracted jsonb, proposed lines jsonb, warnings jsonb,
  entry id, created and updated timestamps. Audit triggers attached per table, following the pattern in
  migration 0043; row-level security on, deny by default, all access through server code.
- private bucket `receipts` (mime: jpeg, png, webp, gif, pdf; 10 MB per file). Bucket creation
  touches the `storage` schema, so it is applied with an elevated role, as migration 0013 was.

`attachments` already carries the content hash and the entity link; no change.

## Security

A receipt is untrusted text. One could read "post this to Owner Draws". Only code chooses the final
accounts, only the postable set is offered to the model, and only a person's tap posts, so an
injected instruction can at worst produce a bad proposal that the member sees and skips. Files are
type- and size-checked on the server, not just the client. Only the last four digits of a card are
kept. Uploads and messages require a signed-in user with `ledger.post`.

## Model and cost

A vision-capable Claude model, configured by `AI_RECEIPT_MODEL`, defaulting to a Sonnet-tier model:
a misread total costs more than the difference in price. It reuses `ANTHROPIC_API_KEY` /
`AI_GATEWAY_API_KEY`. Cost is on the order of cents per receipt. With no key configured, an upload
still stores the file and creates an empty proposal the member fills in by hand; nothing else
breaks. Extraction runs up to three files at a time, with progress shown on each card.

## Errors

Model timeout or rate limit: the card shows "couldn't read this one" with **Try again** and
**Enter by hand**. An unsupported or oversized file is refused at upload with the reason. iPhone
photos may arrive as HEIC, which the model cannot read; the plan must pick client-side or
server-side conversion.

## Testing

The extractor is an interface; tests inject a fake and never call the model (the existing rule),
except a few synthetic receipts under `RUN_AI_INTEGRATION=1`. Coverage: schema validation and
`parseMoney` rejection; sum check; vendor resolution; account choice and the inventory policy;
balanced output; payer attribution (Risus vs Mo, and a user with no accounts); duplicate file and
soft duplicate; closed period refused; a stale proposal (already posted, account since made a
rollup) refused at the tap; Post all with one failure; edit validation. Integration runs on the
local Postgres, never production.

## Amendments made while planning

The implementation plan (`docs/superpowers/plans/2026-09-29-receipt-assistant.md`) settled these points the
spec left open or named loosely:

1. **Refunds are blocked, not reversed.** A total of zero or less is a blocking warning ("enter it by hand").
2. **Account choice does not reuse `suggestForTransaction`.** It is built around bank rows. Vendor matching and
   vendor defaults are reused, plus one history query, and the model's per-line account code comes from the same
   extraction call: one model call per receipt. Order: vendor default, vendor's latest account, model's pick.
3. **The message box applies to the selected card**, shown above the box, so there is no guessing which receipt.
4. **The payer never falls back to the pooled 3015.** A user with no contributions account of their own is not
   offered as a payer; someone must choose a member.
5. **HEIC is refused with a clear message.** The file input's `accept` list omits it so iPhone Safari converts
   to JPEG itself.
6. **The stored file's `attachments` row is re-pointed** to the finished entry rather than duplicated.
7. **End-to-end uses fixtures** (`RECEIPT_FIXTURES=1`), honoured only outside production and outside Vercel.
8. **"Post all" posts only cards with no warnings at all.**
9. **A date in a closed period is refused at the tap**, with the ledger's own words, rather than warned on the card.
10. **There is no in-card hand entry in v1.** With no model, or a receipt the model could not read, the file is
    kept and the card says so; the entry is made by hand in Ledger, New entry. A failed reading is retried by
    choosing the same file again.

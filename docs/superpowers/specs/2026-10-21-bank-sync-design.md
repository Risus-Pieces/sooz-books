# Nightly bank sync and scoped keys — design

Status: approved in conversation 2026-10-21. Mo asked for a fully automated mode; the owner (Risus) approved this
narrower version ("ok do whatever you need to do"). Choices marked **(my call)** were the builder's.

## Why

Mo's nightly agent can only draft entries for approval: every write needs a live yes in chat, a stage expires in
15 minutes, and his sign-in does not survive the night. He asked for (1) auto-posting of sure matches, (2) bank
lines imported through the connector — he reads Relay through Plaid — and (3) a token that needs no nightly sign-in.

## What is built instead, and why

| Asked | Built | Why the difference |
|---|---|---|
| Auto-post "sure matches" | The existing owner-approved **auto-post rules** run after every sync, and a connector tool `run_auto_post_rules` runs them on demand. | "Sure" means "matches a rule an owner approved in the app", never "a model is confident". Rules are created and marked auto-post only in the app. |
| Import bank lines through the connector | **The app pulls from Plaid itself**, nightly, through the existing import pipeline. A connector tool `sync_bank_feeds` runs the same sync on demand. | Data an agent pushes in is whatever the agent says it is; combined with auto-post rules, made-up lines could post unseen. Pulling straight from Plaid keeps the bank as the source. |
| A long-lived token for Mo's login | A **scoped key**: named, revocable, shown once, stored as a hash, limited to reading the books, syncing, running the auto-post rules, and **staging** changes that wait up to 36 hours. | Mo's full Owner login unattended overnight could post anything. A key that can prepare but never confirm cannot post to the wrong account on its own. |

Non-negotiable 7 holds unchanged: nothing posts from an import without a person, except through a rule an owner
marked `auto_post`.

## Goals

- Every night, every connected Relay account pulls new posted transactions from Plaid into the review queue,
  de-duplicated, with rules and AI suggestions applied exactly as a CSV import would.
- The owner-approved auto-post rules then post what they match. Everything else waits in the review queue,
  which never expires.
- Mo's agent can, with a key and no sign-in: read the books and the queue, start a sync, run the auto-post rules, and
  stage changes for Mo to confirm later. Stages made with a key last 36 hours (his agent runs at 5 a.m.; a person's own
  stages still last 15 minutes). `list_staged` shows a person everything waiting, with each preview.
- Everything the sync and a key do is attributable: the audit log records who and through what.

## Non-goals

- Creating rules or marking them auto-post through the connector or a key.
- A key that can confirm (commit) anything. Confirming is always the person, signed in.
- Credit cards, Plaid accounts other than the mapped Relay ones, investment data.
- Pending transactions (only posted ones are imported; a pending line can still change amount or vanish).

## How it is built

### Plaid connection
- Env: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox` | `production`), `PLAID_TOKEN_KEY` (32 random
  bytes, base64; encrypts access tokens at rest with AES-256-GCM). Without the first two the feature is dormant
  and Settings says so.
- Settings → Bank feeds (owner, `settings.manage`): **Connect Relay** opens Plaid Link in the browser. The
  person signs in to Relay inside Plaid's own window; the app never sees bank credentials. On success the app
  exchanges the public token, stores the item with its access token encrypted, and lists Plaid's accounts.
- Each Plaid account is mapped to an existing bank account by its last four digits (proposed automatically,
  confirmed by the owner). **Sync starts the day after the latest transaction already in the books for that
  account (my call)**, so the CSV history and the Plaid feed never overlap and cannot double-count.
- Disconnect removes the item at Plaid and stops syncing.
- Plaid calls use `fetch` against Plaid's REST API, not the SDK (my call): five endpoints, typed, mockable.

### Sync
- `/transactions/sync` with a stored cursor, looped until `has_more` is false. Only `added` transactions on mapped
  accounts, not pending, on or after the account's start date.
- Each account's new lines become one import batch through a **Plaid importer** (`delivery: 'api'`) feeding the
  existing `previewImport` → `commitImport`. So de-duplication, transfer pairing, refunds, rules and AI suggestions
  are the same code a CSV upload runs. The Plaid `transaction_id` is the row's external id and the base of its
  fingerprint, so a re-sync never duplicates a row. The raw lines are archived like an uploaded file.
- Money: Plaid amounts are positive for money out of the account; converted through `parseMoney` from the decimal
  string, sign flipped. No floating-point arithmetic.
- `modified` and `removed` transactions are not applied automatically; they are reported (and noted on the row if
  it exists) for a person to look at **(my call)**.
- The cursor is saved only after the batch commits, so a failed night retries cleanly.

### Nightly run
- A Vercel cron calls `/api/cron/bank-sync` once a night (`CRON_SECRET`). It syncs every connected item, then runs
  `postAutoPostMatches` for the synced bank accounts. The actor is the owner who connected the item.

### Scoped keys
- Table `api_keys`: name, owner user, sha256 of the token, a short visible prefix, scopes, created/last used/revoked.
  Token: `sbk_` + 32 random bytes, shown once.
- Created and revoked in Settings by an owner (`users.manage`). A key acts as the user who made it, intersected
  with its scopes: `read`, `bank.sync`, `bank.autopost`, `stage` (all four by default).
- `/mcp` accepts a key as a bearer token, checked against its hash without calling the auth server. A key's server
  registers only the tools its scopes allow and never `commit_staged`; `commitStaged` also refuses a key caller
  (defence in depth). A key's stages record `key:<name>` as their client and expire after 36 hours.
- Audit: `audit_log` gains a `via` column, filled from a transaction setting, so every row a key's call writes
  says `key:<name>` and every row the cron writes says `cron:bank-sync`.

## Testing
- Plaid client mocked. Importer: sign, cents, pending skipped, start date honoured, fingerprint stable.
- Sync: cursor saved only on success, re-sync idempotent, unmapped accounts ignored, overlap with CSV history impossible.
- Auto-post after sync posts only rule matches; a non-auto-post rule's match waits.
- Keys: hash only stored, revoked/unknown refused, scopes enforced (no stage/commit tools, and refused if called).
- Cron route: wrong or missing secret refused.
- Not verifiable without Mo's Plaid keys and a Relay sign-in in Plaid Link: a real sync.

## Decisions after the first draft (2026-10-21)

- Mo's agent replied asking for unattended commits instead. The owner chose this design (option 1) and the reply to
  Mo explained why: an unattended Owner login removes the only check against posting to the wrong account, changes
  non-negotiable 7 for both members, and entries written straight from Plaid would bypass the bank queue and could be
  booked twice.
- Mo's actual constraint, relayed by the owner: his sync runs at 5 a.m. and notifies him of what it prepares, so the
  15-minute stage window was the blocker, not approval itself. Hence keys may stage with a 36-hour window, and
  `list_staged` exists, while confirming stays with the signed-in person. **(my call)**

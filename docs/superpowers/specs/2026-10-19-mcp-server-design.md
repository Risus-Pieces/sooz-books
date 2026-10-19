# Sooz Books MCP server — design

Status: approved in conversation 2026-10-19 (owner opted out of further questions and said "start building").
Choices marked **(my call)** were made by the builder, not by the owner.

## Why

The owner wants to work in the books by talking to Claude: bring in a bank statement, go through the
transactions, enter a journal entry, read a report — without switching to the app. Other people with
access to the software should be able to do the same, each as themselves.

## Goals

- A **remote MCP server** at `https://sooz-books.vercel.app/mcp`. Each person adds that URL to Claude as a
  connector once, signs in with their normal Sooz Books login, and it works from Claude on the Mac, the
  phone and the website.
- Claude acts **as the person who signed in**: their role limits what it can do (`can(role, capability)`),
  and the audit trail names them.
- **Claude never posts anything without a staged, shown, single-use proposal** (see below). The owner's one
  stated anti-goal is "posting entries to the wrong account without asking me".
- Everything goes through the same `src/lib` functions the app uses, so the database invariants (balance,
  immutability, closed periods, audit log) apply unchanged.

## Non-goals (v1)

- Closing or re-opening periods, reversing or deleting posted entries, changing roles/invites. These stay in
  the app. **(my call)**
- Creating or editing rules. A rule can be marked `auto_post`, which would let a later import post without any
  review; that must stay a deliberate act in the app. **(my call)**
- Receipts: the in-app Receipt assistant already covers them. **(my call)**
- Uploading a bank statement. A remote connector cannot open a file on the person's computer, so the file's contents would have to be retyped through the model, which is slow and unreliable for a statement. The file is dropped into the app's existing Import screen; Claude takes over from the review queue. **(my call)**
- A way to approve in the app instead of in the chat. The owner said approval happens in the chat.

## Anti-goals

- A model-driven path to `journal_lines` that skips the show-then-confirm step.
- Acting on instructions that arrive inside bank descriptions, vendor names, memos. All such text is returned
  fenced and labelled as untrusted data.

## How it is built

### Transport
`src/app/mcp/route.ts` — Streamable HTTP, stateless (a fresh `McpServer` per request), JSON responses, Node
runtime. Built on the official `@modelcontextprotocol/sdk` (`WebStandardStreamableHTTPServerTransport`). **(my call)**

### Sign-in
Supabase Auth's built-in **OAuth 2.1 server** (beta) is the authorization server: it already speaks PKCE,
dynamic client registration and refresh tokens, which is what Claude's connector flow needs, and it signs
people in with the accounts they already have. We write only the resource-server side:

- `GET /.well-known/oauth-protected-resource` (RFC 9728) names Supabase as the authorization server.
- `/oauth/consent` shows who is asking and lets the signed-in person Approve or Deny; `/oauth/decision`
  records it. Both reuse the existing login (`/login?next=…`).
- `/mcp` requires `Authorization: Bearer <token>`. The token is checked with `supabase.auth.getUser(token)`
  (authoritative, handles revocation), then joined to an **active** `app_users` row for the role. Only a
  token **issued to a connected app** (it carries a `client_id`) is accepted, so an ordinary browser session
  token does not work here. A deactivated account gets `403`. Anything else is `401` with a `WWW-Authenticate: Bearer resource_metadata=…` header so the client starts sign-in.
- `src/proxy.ts` lets `/mcp`, `/oauth/…` metadata through without a browser session (they do their own auth);
  `/oauth/consent` still requires one.

One-time owner setup in the Supabase dashboard (Authentication → OAuth Server): enable it, set the
authorization path to `/oauth/consent`, enable dynamic client registration; Site URL must be the production
URL. This cannot be done from code here and is not verified until it is done.

### Reading
All read tools check a capability and return compact text. Anything that came from outside the books (bank
descriptions, payees, memos, vendor names) sits inside a `<untrusted-data>` fence.

| Tool | Capability | Does |
|---|---|---|
| `whoami` | any | name, role, what this connection may do |
| `list_accounts` | `reports.view` | chart of accounts (ids, codes, types, rollup flag) |
| `run_report` | `reports.view` | trial balance, P&L, balance sheet, cash flow, general ledger; cash or accrual |
| `list_journal_entries` / `get_journal_entry` | `reports.view` | recent entries; one entry with lines |
| `list_bank_accounts` | `bank.import` | accounts with counts waiting |
| `review_queue` | `bank.import` | waiting transactions with the suggested account, source, confidence, flags |

### Writing: stage, show, confirm
Every change to the books is two tool calls.

1. `stage_*` validates the request exactly as posting would, **writes nothing to the ledger**, stores a row in
   `mcp_stagings` (owner = the signed-in user, kind, payload, the computed preview, 15-minute expiry) and
   returns the preview: dates, amounts, vendor, and the **named accounts debited and credited**, plus a
   `stage_id`.
2. `commit_staged(stage_id)` posts **only what was staged**. It refuses an unknown, expired, already-used or
   someone-else's stage, re-checks the capability, and marks the row used in the same transaction as the post
   (single use). It never accepts new account ids or amounts.

So Claude cannot post something other than what it showed, cannot post twice, and cannot post without a stage
— even if a bank description tries to talk it into it. Claude's own tool-permission prompt is the second
guard; the owner is advised never to "always allow" `commit_staged`.

Stage kinds in v1:

| Tool | Capability | Posts via |
|---|---|---|
| `stage_bank_decisions` (up to 50 transactions: accept to an account, mark personal, or exclude) | `bank.approve` | `approveMany` / `markPersonal` / `excludeTransactions` |
| `stage_journal_entry` | `ledger.post` | `postJournalEntry` (source `manual`) |
| `stage_new_account` | `settings.manage` | `createAccount` |

When Claude is unsure of an account it must ask; the tool descriptions say so, and `stage_bank_decisions`
requires an explicit `accountId` for every accept (it does not silently fall back to the suggestion). **(my call)**

### Auditing
Entries are written inside `withActor(user.id)`, so `audit_log` names the person. `mcp_stagings` additionally
keeps who staged and committed what and when, and the OAuth client id from the token.

## Testing
- Unit/integration against the throwaway local Postgres (`withRollback`): staging lifecycle (expiry, reuse,
  another user's stage, capability loss), each stage kind's preview and commit, read tools' capability gates.
- Route test: no token → 401 with the discovery header; bad token → 401; deactivated user → 401; a valid
  token (verifier injected) lists the tools.
- Not verifiable without the owner's dashboard step and a real Claude client: the end-to-end connector sign-in.

## After the security review (2026-10-19)

An independent adversarial review tried to break the design. The stage/commit core held under concurrency,
replay, cross-user and expiry attacks. It found, and this branch fixed:

- What posted could differ from what was previewed (vendor, memo, customer, channel re-derived from a
  suggestion at commit time). The stage now stores the fully resolved choice and commit passes all of it.
- `confirm_different_transaction` silently switched the duplicate guard off. It is now honoured only when the
  guard actually fired, shown as a `DUPLICATE WARNING` in the preview, and not stored otherwise.
- A stage the person turned down stayed confirmable. Staging the same rows again voids the old stage, and
  `cancel_staged` withdraws one.
- New-account previews hid `subtype` and `description`; both are shown, `subtype` is limited to a safe list,
  and descriptions are fenced.
- Error text containing bank text, and report memos, reached the model unfenced; the fence also missed
  differently-spelled closing tags. Errors are fenced, every `<`/`>` inside fenced text is neutralised, and
  reports carry the untrusted-data note.
- Any valid session token worked at `/mcp`. Only tokens issued to a connected app (with a `client_id`) work now.
- With dynamic client registration on, an attacker could register a client named "Claude" and phish a consent.
  The consent screen and the decision route now complete a connection only to `claude.ai`, `claude.com` or
  loopback (Claude Code).
- Smaller: exact-match `/mcp` in the proxy, a `Sec-Fetch-Site` check on the decision route, `maxDuration`.

### Known limits (not fixed here)

1. **The server cannot tell a person's "yes" from a model that stages and commits in one turn.** The design
   puts approval in the chat, so the human check is Claude's own tool-permission prompt, and that prompt shows
   only a stage id. A model steered by injected text could stage and commit a bad entry. Everything above
   makes that harder (fencing, one-time stages, the role limits) but does not make it impossible. The
   real fix is approval outside the chat: a pending-approvals page in the app that a stage links to, at least
   for journal entries, new accounts and large batches. Offered to the owner as a follow-up; it changes the
   workflow they chose, so it is their decision.
2. The `bank-statements` storage bucket grants any `authenticated` JWT read/write (migration 0013). That
   predates this work and applies to every signed-in user, but a connector token is such a JWT. Worth
   scoping to the app's own server access.
3. No screen yet to list or revoke connected apps; revoke in the Supabase dashboard.
4. `client_id` as the claim name in Supabase OAuth access tokens is taken from Supabase's documentation and is
   not verified against a live token. If a real connection is refused with "not valid", check this first.

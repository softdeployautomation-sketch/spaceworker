# TASK_159 — Support tickets

Status: **PHASE 1 SHIPPED — backend only.** Models, migration, service layer and the
six authenticated API routes are live. **No UI and no email**: nothing renders a
ticket to a human yet, and nothing mails anyone. This document remains the scope of
record; §9 below records exactly what shipped.
Companion to `PLAN_TASK_158_WALLET_BALANCE.md` (wallet) and
`PLAN_TASK_157_PLATFORM_DOMAINS.md` (user domains).

This document exists so the next agent does not have to re-derive the shape, and
so the two systems that share a boundary — tickets and wallet — are designed
against each other rather than colliding after the fact.

---

## 1. Why this exists, and why now

Every TASK_157 domain question arrives at an admin as free text: "my domain
isn't showing up", "nameservers haven't propagated", "which plan was that on?".
Today that means a DM, a scroll through logs, and a `cuid` pasted from
somewhere. The manual cost scales with the number of paying users, and the
failure mode is the worst kind: a question nobody answers because nobody
noticed it arrived.

Two things force the design now rather than later:

1. **Domains made questions answerable by lookup.** Before TASK_157 there was
   no per-user domain to point at. Now there is, so a ticket can carry a real
   `userDomainId` and an admin can see the domain row, its Cloudflare status,
   and its ownership without leaving the ticket. That link is the entire value
   of the feature, and it is only possible because TASK_157 shipped first.

2. **Wallet makes "what did they pay for" a lookup too.** Once a balance ledger
   exists, "can you refund this / why is their balance negative" becomes a
   ledger read instead of a reconstruction from `Payment` rows.

---

## 2. Non-negotiables (these are the requirements, not the nice-to-haves)

### 2.1 A ticket may never hold a credential

This is the rule the whole feature is designed around. Ticket bodies are
user-supplied text that gets rendered in an admin UI, emailed, exported, and
eventually searched. The moment a ticket body is allowed to contain a raw
token, the platform has built a paste-target for its own secrets.

Concrete consequences:

- No ticket field is ever a token, even transiently. Domain attachment is by
  **id reference only** (`userDomainId`), resolved server-side.
- Attachments, if ever added, are scanned on write; the design assumes a
  customer will one day paste a `.env`.
- Ticket text is not a place to paste a domain's Cloudflare API token. If a
  user needs to give us a credential, that is a different flow with its own
  audit trail.
- The user-visible composer **redacts on paste**. Cheap, and it catches the
  common accident before the data lands.

### 2.2 Ownership is enforced in the database/API, not the UI

Same rule as TASK_157. A user may read and reply to their own tickets and no
others. The id must never be read from the request body as proof of ownership;
resolve the caller from the session and filter on `userId`.

### 2.3 Append-only message log

Replies append. There is no edit and no delete on a ticket message. Support
history that can be rewritten is not history. If a message is genuinely wrong,
the correction is a new message.

### 2.4 No credential is shown to a non-admin, including via a ticket

Trivial to state, easy to break: the admin ticket view must not render any
credential that the surrounding admin UI already has access to.

---

## 3. Data model (proposed — not written)

Three models, deliberately not two and not one.

### 3.1 `SupportTicket`

```
id            cuid
userId        String        -> User.id        NOT NULL
status        String        "open" | "resolved"   default "open"
subject       String        NOT NULL
category      String?       "domain" | "billing" | "account" | "other"
priority      String?       "low" | "normal" | "high"
domainRefId   String?       -> UserDomain.id   see 3.3
createdAt     DateTime      default now
updatedAt     DateTime      @updatedAt
resolvedAt    DateTime?
```

Indexes: `[userId, createdAt]`, `[status, createdAt]`.

`status` is deliberately a string, matching `NotificationLog.outcome` and the
`Payment`-family conventions already in this schema — not a Postgres enum. An
enum would need a migration to add "waiting_on_customer", and that state is
inevitable.

### 3.2 `SupportMessage`

```
id         cuid
ticketId   String  -> SupportTicket.id  NOT NULL
authorRole String  "user" | "admin"      NOT NULL
authorId   String?                       nullable; admin identity for audit
body       String  NOT NULL
createdAt  DateTime  default now
```

Index: `[ticketId, createdAt]`.

`authorId` is nullable on purpose: an admin replying from a personal account
should not become a hard dependency on that `User` row existing forever.

### 3.3 Domain attachment: an id reference, never a copy

`domainRefId` points at `UserDomain.id`. The admin ticket view joins to get
apex, status, and owner. It does **not** copy the apex into the ticket, because
a copied apex goes stale the moment the domain is removed and then tells an
admin something false.

Constraint: the referenced domain must belong to the ticket's user. Enforce in
the write path, same as the admin domain-add route's `userId` guard.

---

## 4. API surface (proposed)

### User side

| Route | Method | Notes |
|---|---|---|
| `/api/support/tickets` | GET | caller's own tickets, newest first |
| `/api/support/tickets` | POST | create; optional `domainRefId` |
| `/api/support/tickets/[id]` | GET | one ticket + messages; 404 (not 403) for another user's |
| `/api/support/tickets/[id]/messages` | POST | user reply; append-only |

### Admin side

| Route | Method | Notes |
|---|---|---|
| `/api/admin/support/tickets` | GET | queue; filter `status`, `category`, `priority` |
| `/api/admin/support/tickets/[id]` | PATCH | resolve / reopen / reprioritise |
| `/api/admin/support/tickets/[id]/messages` | POST | admin reply |

The 404-not-403 rule on the user route is the one to get right. A 403 confirms
"this id exists, and it is not yours", which is a free enumeration oracle over
other customers' support threads.

---

## 5. What to build first

Phase 1 is the smallest thing that removes the cost:

1. Models + migration.
2. User-side list/create/reply.
3. Admin queue + reply/resolve.

Explicitly **deferred**, because each is a project of its own and none is
required to answer "my domain isn't showing up":

- Attachments / file upload.
- Email sending of ticket notifications. (Tickets exist in the app first;
  notifying by email can follow. Getting this backwards means sending mail
  about tickets that do not exist yet.)
- SLA timers, assignment, macros, canned responses.
- Full-text search across message bodies.
- Public status page.

---

## 6. Boundaries with the other two systems

**With wallet (Task 158).** A billing ticket should be able to reference a
wallet entry id, so "refund this" is a lookup. The same rule as §3.3 applies:
reference by id, never copy an amount. A copied amount is a second source of
truth that will disagree with the ledger.

Deliberately **not** planned: letting a ticket perform a refund. Support staff
moving money through a text thread is how an immutable ledger stops being
immutable. Refunds stay an explicit, audited wallet action; the ticket
*references* it.

**With domains (Task 157).** `domainRefId` is the whole integration. A ticket
should be able to show the domain's Cloudflare status at read time, so the
admin sees "nameservers pending" next to the customer's claim, not a snapshot
from whenever the ticket was filed.

---

## 7. Open questions

1. **Does a resolved ticket reopen, or is it a new ticket?** Leaning: reopen
   if the last message is within N days, otherwise new. Not decided.
2. **Rate limiting on ticket creation**, and whether it differs from the
   general per-user send limits. Not decided.
3. **Do admins need a public-facing reply box**, or is every reply internal
   plus a separate "send" action? Leaning internal-plus-send, so drafting an
   answer never mails the customer by accident. Not decided.
4. **Retention.** How long message bodies are kept after resolution, and what
   happens on account deletion. Not decided, and it interacts with GDPR-style
   deletion elsewhere in the platform.

---

## 8. What "done" would mean

Stated in advance so the scope cannot quietly expand:

- A user can open a ticket about a domain they own, from the domain itself. ⏳ *backend done; no UI*
- An admin sees it in a queue with the domain's live status attached. ⏳ *backend done; no UI*
- The user and admin can reply to each other in a thread. ✅ **done**
- The admin can resolve it. ✅ **done**
- No credential appears anywhere in the flow. ✅ **done and enforced on write**

---

## 9. What shipped (Phase 1, backend)

Everything below is deployed and verified. The design decisions in §3.1/§3.3/§4 are
reproduced in the migration's own header comment, which is the better place to read
them — a later reader will hit the SQL before this document.

**Migration** `prisma/migrations/20261107000000_task159_support_tickets` — additive:
two new tables, three indexes, two FKs, three CHECKs. **No existing table is touched
and no existing row is rewritten.** Note it sorts to `20261107000000`, i.e. *after*
the Task 158 hosting migrations on the same box.

**Two tables, not one.** `SupportTicket` is the container (owner, status, subject,
the domain it is about); `SupportMessage` is an append-only turn. Flattening them
would put the ticket's status on every message row.

**The two FKs have opposite delete rules, on purpose:**

| FK | Rule | Why |
|---|---|---|
| `SupportTicket.userId` → `User.id` | `ON DELETE RESTRICT` | There is no account-deletion flow today, so this blocks nothing that exists. It guarantees support history cannot be destroyed as a *side effect* of removing a user: whoever builds deletion must decide explicitly rather than silently lose every message a customer ever sent. |
| `SupportMessage.ticketId` → `SupportTicket.id` | `ON DELETE CASCADE` | A message has no meaning without its ticket. This is containment, not retention: deleting a ticket must not leave orphaned bodies no UI can show and no user can erase. |

**A `CHECK` on `authorRole`, none on `status` — the asymmetry is deliberate.**
`authorRole` is a closed set (`user` \| `admin`) with exactly two writers and no
anticipated third value, and every reader branches on it to pick a bubble style, so
an unknown value has no correct rendering. `status` is a bare string so that
`waiting_on_customer` is an INSERT rather than a migration (§3.1); readers treat only
the exact value `resolved` as closed, so an unfamiliar status still needs attention
instead of silently dropping out of the admin queue.

**`domainRefId` is a soft reference (no FK)**, matching how `UserDomain.ownerUserId`
already works. A hard FK would make an admin unable to remove a stale domain while a
ticket still mentions it. "This domain must belong to this ticket's user" is enforced
in the **write path**, not by the schema. The attachment is an **id**, never a copied
apex — a copied apex is a second source of truth that goes stale.

**`walletRefId` exists and is unused** until the wallet ships, so the tickets/wallet
boundary (§6) is a visible column rather than a retrofit. It is an id and never an
amount.

**`resolvedAt` is server-derived.** Neither write path accepts it from a caller.

**Credential defence** is in `lib/support/redact.ts`, applied to subjects and bodies
**before storage** — so a credential-shaped paste is never persisted, rather than
stored-then-displayed-redacted. Pasting a Cloudflare token into a ticket is refused,
not quietly masked. The client-side paste-redact from §2.1 is *not* shipped: it is a
convenience, and refusing on write is the guarantee.

**Routes** (all authenticated; ownership always comes from the session, never the body):

| Route | |
|---|---|
| `GET/POST /api/support/tickets` | list own / create |
| `GET /api/support/tickets/[id]` | read own |
| `POST /api/support/tickets/[id]/messages` | reply as user — **reopens** a resolved ticket |
| `GET /api/admin/support/tickets` | queue |
| `GET /api/admin/support/tickets/[id]` | read any |
| `POST /api/admin/support/tickets/[id]/messages` | reply as admin — does **not** reopen |

A foreign ticket id and a nonexistent one both return an indistinguishable `404`, so
the API cannot be used to probe which ticket ids exist.

**Verification:** `tests/support-tickets.test.ts` → **30/30** (`npm run test:support`).
`npm run test:hosting` → **320/320**, unchanged. `npx tsc --noEmit` → 0, ESLint clean
on every touched file, `CI=true npm run build` → exit 0.

**Live proof, not just local tests.** Beyond the 30 unit tests, a disposable user was
created on production, drove the whole flow (create → list → user reply → admin reply →
resolve → reopen → queue), and was deleted in the same script. Confirmed live: a
credential-shaped subject is **rejected `422` and never stored** while ordinary prose is
accepted (no false positive); a **user** reply reopens a resolved ticket and clears
`resolvedAt`; an **admin** reply does not reopen it; a foreign ticket id and a
nonexistent one both return **`404`**. Leftover rows after cleanup: `0`.

**Migration was dry-run against a clone of production** (schema + the
`_prisma_migrations` ledger, 92 applied), not an empty database — replaying history
onto an empty DB fails at an unrelated old migration and proves nothing about this
one. All three indexes, both FKs (with their *opposite* delete rules) and all three
CHECKs were asserted structurally **and** behaviourally: a whitespace-only subject and
body are rejected, an unknown `authorRole` is rejected, an orphan ticket is refused,
`waiting_on_customer` is storable without a migration, deleting a ticket leaves no
orphan messages, and deleting a user with tickets is blocked. **19/19 passed.**
The rationale and the four ways that exercise can silently pass for the wrong reason
are in `SENIOR_HANDOFF.md` trap 27 — read it before writing another one.

### 9.1 Deferred, deliberately

- **UI of any kind.** No page renders a ticket. Until then the feature is reachable by
  `curl`, which is enough to prove the contract and useless to a customer. This is the
  first thing Phase 2 should build, in this order: user composer + thread, then the
  admin queue.
- **Email notifications.** Tickets exist before anything mails about them.
- **Attachments** — deferred in §5, and would inherit §2.1's scan-on-write rule.
- **Rate limiting on ticket creation** (§7.2) — still undecided.
- **SLA timers, assignment, macros, full-text search, public status page** — §5.
- **Refund actions from a ticket** — §6. A ticket references a wallet entry; it never
  moves money.

### 9.2 Open questions this phase answered by choosing

§7.1 (reopen vs. new ticket): a **user reply reopens** the ticket. An admin reply does
not reopen — so replying to a customer can never silently undo your own resolution.
§7.4 (retention) is untouched; the `RESTRICT` FK is what makes it a future *decision*
rather than an accident.
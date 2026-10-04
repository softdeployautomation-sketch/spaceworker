# TASK_159 — Support tickets: scope

Status: **SCOPE ONLY. NOTHING SHIPPED.** No model, no migration, no API, no UI.
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

- A user can open a ticket about a domain they own, from the domain itself.
- An admin sees it in a queue with the domain's live status attached.
- The user and admin can reply to each other in a thread.
- The admin can resolve it.
- No credential appears anywhere in the flow.
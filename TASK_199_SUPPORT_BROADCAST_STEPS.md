# TASK_199 — Broadcast support message (audience dropdown: everyone / per tier)

**Status:** PLANNED — created 2026-10-10 (before any code)
**Owner request:** "i need a general support message i can send that everyone gets, and put a dropdown so i can select different tiers, or everyone."

## Design decisions (made BEFORE code)

- **Where:** admin panel → Support tab (`SupportQueuePanel`), a "Broadcast" composer in the panel header — same notice/error machinery the panel already uses.
- **Audience options** (labels reuse `lib/plan-name.ts` semantics):
  - `everyone` — all users
  - `free` — tier 0/1/4 → "Free"
  - `xdevice` — tier 3 → "Premium XDevice"
  - `plus` — tier ≥ 5 → "Premium Plus"
  - Server derives tiers from the enum (never trust a client tier list).
- **Delivery:** per target user, post through the EXISTING message path (`find latest non-resolved ticket else create with subject "Announcement"` → `addAdminMessage`) so the badge/unread derivation, invoice binding and body validation behave exactly like every other admin message. Email each recipient via `notifyUserTicketReply` (the TASK_187 S2 contract: support messages email the user) — fire-and-forget per user, never fails the batch.
- **Route:** `POST /api/admin/support/broadcast` — `getAdminSession()` (403), zod schema `{ audience: enum, body: string 1..5000 }`, unknown keys rejected. Returns counts only (`{ audience, targeted, sent, failed }`) — never user ids/emails.
- **Safety caps:** audience resolution batched; one `addAdminMessage` per user inside try/catch so one bad thread cannot abort the batch; `failed` counted.

## Fix plan (slices → gates → commit each)

- **S1 — lib + route**
  - `lib/support/tickets.ts`: `broadcastAdminMessage({ audience, body, adminId })`.
  - `app/api/admin/support/broadcast/route.ts`.
  - Tests: new `tests/support-broadcast.test.ts` (audience→tier mapping, body validation, counts contract, admin guard, email-once-per-user wiring) + `package.json` script.

### 2026-10-10 07:25 — PROGRESS: S1 COMPLETE (lib + route + tests, gates green, committing now)

**Shipped:**
1. `lib/support/tickets.ts` — `BROADCAST_AUDIENCES` enum (`everyone|free|xdevice|plus`), pure `broadcastAudienceWhere()` (free=[0,1,4], xdevice=[3], plus=gte 5, everyone={}), `broadcastAdminMessage()` — resolves users, per-user find-open-thread-else-create "Announcement" → real `addAdminMessage`, counts `{audience,targeted,sent,failed}` with per-user try/catch (one bad thread never aborts the batch).
   - **Design deviation, recorded:** notify is INJECTED (`notify?` option) instead of imported — `lib/support-notify.ts` line 1 is `import "server-only"` which THROWS under plain-node tests (would break `support-tickets.test.ts`); the route passes `notifyUserTicketReply`, mirroring the admin-reply route pattern. Caught BEFORE tests ran.
2. `app/api/admin/support/broadcast/route.ts` — `requireAdminSession` (401) → zod `.strict()` `{audience: enum, body: string.trim().min(1).max(5000)}` (400) → `getAdminSession().sub` → counts-only JSON (no ids/emails ever). `trim()` before `min(1)` so whitespace-only is a 400, not N failures behind a 200 (caught by test 3).
3. `tests/support-broadcast.test.ts` — 12 tests, house require-hook (real route + REAL service, faked prisma/admin-auth/support-notify/next-server): server-derived tier filter, 401-writes-nothing, validation 400s, counts contract + PII-free serialization, per-audience targeting, exactly-one-email-per-sent-user, open-thread reuse + subject preserved, resolved-never-resurrected, batch-survives-one-bad-user, admin sub stamped.
4. `package.json` — `test:support-broadcast`.

**Gates (proof):** `test:support-broadcast` → **12/12** · `test:support` → **57/57** (tickets.ts unchanged behavior) · `tsc-errors:0` · `eslint:0`.

S2 = UI composer in SupportQueuePanel + static contract assertions → commit; S3 = shared deploy + live broadcast verify.

  - Gates: tsc 0 · eslint 0 new · suite green → commit + push.
- **S2 — UI** in `support-queue-panel.tsx`: Broadcast button → dropdown + textarea + Send → POST → notice shows `sent/failed` counts. Test: static contract assertions in `tests/support-broadcast.test.ts`.
  - Gates → commit + push.
- **S3 — deploy (shared build) + live verify**: real broadcast to a tiny audience (e.g. `free`) from the box → 1 message per user, badge lights, counts returned; then closeout record.

## PROGRESS

_(entries appended after every step — dated, with proof)_

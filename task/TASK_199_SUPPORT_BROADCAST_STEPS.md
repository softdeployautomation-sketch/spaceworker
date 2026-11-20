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
  - Gates: tsc 0 · eslint 0 new · suite green → commit + push.
- **S2 — UI** in `support-queue-panel.tsx`: Broadcast button → dropdown + textarea + Send → POST → notice shows `sent/failed` counts. Test: static contract assertions in `tests/support-broadcast.test.ts`.
  - Gates → commit + push.
- **S3 — deploy (shared build) + live verify**: real broadcast to a tiny audience (e.g. `free`) from the box → 1 message per user, badge lights, counts returned; then closeout record.

## PROGRESS

### 2026-10-10 07:25 — PROGRESS: S1 COMPLETE (lib + route + tests, gates green, committing now)

**Shipped:**
1. `lib/support/tickets.ts` — `BROADCAST_AUDIENCES` enum (`everyone|free|xdevice|plus`), pure `broadcastAudienceWhere()` (free=[0,1,4], xdevice=[3], plus=gte 5, everyone={}), `broadcastAdminMessage()` — resolves users, per-user find-open-thread-else-create "Announcement" → real `addAdminMessage`, counts `{audience,targeted,sent,failed}` with per-user try/catch (one bad thread never aborts the batch).
   - **Design deviation, recorded:** notify is INJECTED (`notify?` option) instead of imported — `lib/support-notify.ts` line 1 is `import "server-only"` which THROWS under plain-node tests (would break `support-tickets.test.ts`); the route passes `notifyUserTicketReply`, mirroring the admin-reply route pattern. Caught BEFORE tests ran.
2. `app/api/admin/support/broadcast/route.ts` — `requireAdminSession` (401) → zod `.strict()` `{audience: enum, body: string.trim().min(1).max(5000)}` (400) → `getAdminSession().sub` → counts-only JSON (no ids/emails ever). `trim()` before `min(1)` so whitespace-only is a 400, not N failures behind a 200 (caught by test 3).
3. `tests/support-broadcast.test.ts` — 12 tests, house require-hook (real route + REAL service, faked prisma/admin-auth/support-notify/next-server): server-derived tier filter, 401-writes-nothing, validation 400s, counts contract + PII-free serialization, per-audience targeting, exactly-one-email-per-sent-user, open-thread reuse + subject preserved, resolved-never-resurrected, batch-survives-one-bad-user, admin sub stamped.
4. `package.json` — `test:support-broadcast`.

**Gates (proof):** `test:support-broadcast` → **12/12** · `test:support` → **57/57** (tickets.ts unchanged behavior) · `tsc-errors:0` · `eslint:0`.

S2 = UI composer in SupportQueuePanel + static contract assertions → commit; S3 = shared deploy + live broadcast verify.


### 2026-10-10 08:05 — PROGRESS: S2 COMPLETE (broadcast composer UI + templates, gates green, committing now)

**Shipped:**
1. `components/admin/support-queue-panel.tsx` — "Broadcast" button in the Support header (next to "New ticket for a customer") → composer box with:
   - **Audience dropdown** (`everyone / free / xdevice / plus`) mirroring `BROADCAST_AUDIENCES` — the server 400s any other value;
   - **Template chips** (7, from `BROADCAST_TEMPLATES`) — one tap prefills the textarea (REPLACES deterministically, no append-merge);
   - textarea (maxLength 5000 = route cap), error line, "Send broadcast"/"Sending…" button.
   - `sendBroadcast()`: busy/empty guards · **`window.confirm` only for `everyone`** (that send emails every account) · POST `{audience, body}` → success line "Broadcast sent — N of M user(s)" via the panel's global notice (counts only, never who) · composer closes on success (no double-send).
   - `import type { BroadcastAudience }` from the server module — type-only, erased at compile time; prisma never reaches the client bundle.
2. `lib/support-templates.ts` — `BROADCAST_TEMPLATES` (pure data, client-safe): **maintenance_soon** (~1 hour window, per owner), **maintenance_done**, **vbs_link_down** (dead install link — "already-installed devices unaffected, we'll message when back", per owner), **agent_install_issue**, **new_device_pending**, **remote_control_issue**, **screenshots_down** (device-flavoured, per owner).
3. `tests/support-broadcast.test.ts` — +6 static tripwires (house pattern: source-text assertions, no render harness): panel posts the right route with `{audience, body}`; dropdown == exactly the server's four audiences; confirm gates specifically `everyone`; chips wired (`setBcastBody(tpl.body)`); templates well-formed (unique ids, non-empty, ≤5000, `maintenance_soon`+`vbs_link_down` pinned, "~1 hour" pinned); templates file import-safe (prisma/server-only).

**Two own-goals caught by the gates this step (recorded because they are the process working):**
- `await import("@/lib/support-templates")` in the test used the `@/` alias → whole file died under tsx (house pattern: `../lib/...` relative imports in tests). Fixed.
- "client-safe" assertion grepped the word `prisma` → false-failed on the file's header COMMENT naming prisma/schema.prisma. Tightened to import-statement patterns.

**Gates (proof):** `test:support-broadcast` → **18/18** (12 route + 6 UI-static) · `test:support` → **57/57** · `test:premium-request-static` → green (templates file touched) · `tsc-errors:0` · `eslint` (panel/templates/test) → **0**.

Next: S3 = shared deploy (these files + TASK_197/198 fixes not yet on the box) → restart → live smoke: admin cookie → POST broadcast `xdevice` with a test body → assert counts + badge on a real tier-3 thread → closeout.

### 2026-10-10 08:12 — PROGRESS: S3 STARTED (deploy of 197+198+199 to the VPS)

Deploy carries everything committed since the last box build (`YhbuDCGOP_JXN4smy7Lz2`, TASK_195 S4):
- TASK_197 invoice double-card fix (`app/api/admin/users/[id]/invoices/route.ts`, `lib/support/tickets.ts`, `tests/invoice-support-badge.test.ts`)
- TASK_198 quarantine-strip-during-free-period fix (`app/api/devices/route.ts`, tests)
- TASK_199 S1+S2 broadcast (lib/support/tickets.ts, NEW route `app/api/admin/support/broadcast/`, `support-queue-panel.tsx`, `lib/support-templates.ts`, tests)
No schema change → `prisma generate` only, no migrate. Plan: full-tree rsync app/lib/components/tests (parity method from T195 S4) → chown/generate/build w/ log → restart → 200 → md5 parity → live QA battery (expect 0 fail) → live broadcast smoke **audience=xdevice only** (deliberately NOT everyone — smallest blast radius) with a clearly-labelled test body → assert counts + DB rows → AFTER entry + commit.

### 2026-10-10 08:25 — PROGRESS: S3 COMPLETE (deployed + live-verified; broadcast smoke PASS; committing closeout)

**Deploy evidence:**
- rsync app/lib/components/tests → md5 parity **6/6 MATCH** (devices route, invoices route, tickets lib, templates, panel, broadcast route)
- build: `Compiled successfully in 25.4s` · `DONE:0` · new `BUILD_ID Bne_zR2vV88p0oQ3ixvq5` (was YhbuDCGOP_JXN4smy7Lz2) · service **active** · `/login` → **200**
- anon POST `/api/admin/support/broadcast` → **401** (guard live)

**Live broadcast smoke (audience=xdevice only — deliberately not everyone):** minted real admin session on the box (server-only stub + `PORT=3500` override; the `.env` PORT=3400 lie hit us AGAIN — recorded below) →
```
HTTP: 200
COUNTS: {"audience":"xdevice","targeted":3,"sent":3,"failed":0}
ROWS: 3  (all tier=3, author=admin)
 - subj="request"    (reused open thread)
 - subj="premium"    (reused open thread)
 - subj="Announcement" (fresh thread)
SMOKE: PASS
```
Perfect tier isolation (3/3 tier-3, zero other tiers), open-thread reuse + fresh-Announcement both exercised live — S1's contract proven end-to-end. Probe deleted from box.

**Post-deploy QA battery:** `32 probes — 30 pass, 1 warn (cosmetic ledger), 0 fail, 1 skip (VANTRA_URL)` — same healthy baseline as the pre-deploy run.

**Process notes (recorded):**
- The parallel ssh-verify raced the rsync once (`ls` before transfer landed) — md5 re-check passed; verify AFTER transfer next time.
- Probe needed THREE fixes to run under plain tsx: top-level await → `main()` (cjs), `server-only` stub for BOTH admin-auth and prisma, `PORT=3500` override. Pattern now proven for future live probes.
- Box `.env` line 42 has a stray `seed` token → `seed: command not found` on every `set -a; . ./.env` — cosmetic, but it pollutes probe output; noted, NOT fixed (no .env edits).

TASK_199 CLOSED pending owner UI check (Broadcast button + templates in admin → Support tab). 197 + 198 ride this same deploy — owner re-tests: invoice single-card, quarantine strip during free period.


_(entries appended after every step — dated, with proof)_

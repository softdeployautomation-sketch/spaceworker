# TASK_215 — Admin: surface public support requests + fix empty referral tree — STEPS

Owner: task agent. Branch: `agent/task-215-admin-support-referrals` @ `b9b5545` (off local main).
Commit policy §5: local commit only when instructed — **uncommitted at handoff**.

## BEFORE — 2026-10-16 (task agent)

### 1. Rescoped contract (user instructions, verbatim intent)
- **Bug 3 — referrals: DONE OUTSIDE THIS BRANCH.** The box was running a desynced bundle; the
  senior agent's redeploy fixed it and the user confirmed ("referral users list now shows").
  Local consistency was re-verified on this branch anyway: `app/api/admin/referrals/route.ts` maps
  EVERY user to `{user, link|null, url|null, referredCount: link ? … : 0}` — rows exist for users
  WITH links and 0 signups — and `components/admin/referrals-panel.tsx` renders `rows.map(...)`
  with `r.url ?? "—"` and a `referredCount` column; no filter/join drops link-holders. **No code
  change.**
- **Health 401 — EXCLUDED** (task §3 + user: "skip the admin health check task… removed from your
  task"). `lib/qa/battery.ts` is the senior agent's lane. **Not touched.**
- **Remaining scope: Bug 2 only** — public support requests must appear in the admin Support queue
  with open/validate/reply working (task lines 9–19).

### 2. Baseline gates (captured on this branch BEFORE any edit)
- `npx tsc --noEmit` → **exit 0** (`/tmp/t215-tsc-before.log`, `tsc=0`)
- `npx tsx --test tests/*.test.ts` → **1549 tests / 1548 pass / 0 fail / 1 skipped**
  (`/tmp/t215-tests-before.log`; the skip is the known DB-gated one)
- Tree: clean of MY tracked edits at branch point. NOTE: the checkout carries **another agent's
  uncommitted work** (referral-security lane: `prisma/schema.prisma`, `lib/referral.ts`,
  `app/api/auth/signup/route.ts`, `app/api/admin/referrals/route.ts`,
  `components/admin/referrals-panel.tsx`, `lib/qa/battery.ts`, `tests/qa-battery.test.ts`).
  Not mine, not committed by me, left untouched (PROMPT §3.1).

### 3. File-grounded findings (line numbers on `b9b5545` + the concurrent worktree)
- `app/api/support/public/route.ts` — anonymous clown/captcha form → creates `PublicMessage` +
  emails admin. No `SupportTicket` is created (and cannot be: tickets require a `userId`).
- `prisma/schema.prisma` → `model PublicMessage`: `id, name?, email?, message, isRead, createdAt`.
  `email` is **nullable** ⇒ option (a) (auto-create a ticket) can't even resolve the submitter by
  address. `SupportMessage.ticketId` is a **hard FK (CASCADE)** ⇒ a reply row cannot exist without
  a real ticket ⇒ replies must go by **email** (exactly the task's parenthetical).
- `lib/support/tickets.ts` — `listAdminTickets` (:687) reads `prisma.supportTicket` only;
  `getAdminTicket` (:722), `addAdminMessage` (:775), `updateAdminTicket` (:986) key on ticket ids.
- `SupportTicketDetailView.userId` is **optional** (:146) — the panel's invoice composer is gated
  on `detail.userId`, so omitting it cleanly hides the composer.
- `components/admin/support-queue-panel.tsx` — reads only id/subject/status/category/priority/
  createdAt/messageCount/lastMessageAt on rows and messages/domain/userEmail/userId on detail:
  a synthesized public view that carries all of these (userId absent) needs **zero panel changes**.
- `isRead` has **no reader or writer anywhere** today (grep: only the model + create-default) —
  safe to adopt as the queue's handled flag for public rows (no schema change allowed).

### 4. Plan — D1 (task option (b), least churn)
View-level merge in the SERVICE (one dispatch layer), zero public-route / panel / schema changes:
1. `lib/support/tickets.ts`: `PUBLIC_MESSAGE_ID_PREFIX = "public:"` + `isPublicMessageId()`;
   `toPublicTicketView()` — subject `Public: {name|anonymous}`, status `isRead ? resolved : open`
   (the only state column; `resolvedAt: null` — inventing a timestamp would poison reports),
   category/priority null, messageCount 1, unread false. Dispatch in all four admin functions:
   - `listAdminTickets` — merge `publicMessage.findMany` rows (skipped when a category/priority
     filter is active — publics can't match; status filter applies to the DERIVED status), re-sort
     by createdAt desc.
   - `getAdminTicket` — synthesize detail: one `user` message (the submission), `domain: null`,
     `userEmail` = captured address or absent, **no `userId`** (invoice composer hidden). Opening
     does NOT set isRead — Resolve stays explicit (same asymmetry as admin replies not reopening).
   - `updateAdminTicket` — Resolve ⇔ `isRead=true`, Reopen ⇔ false; category/priority/unknown
     status ⇒ honest 422.
   - `addAdminMessage` — reply = `validateBody` (same credential scan) then **email the captured
     address** via `sendEmail` (quoted original + reply; `eventType: "public_message_reply"`);
     no email captured ⇒ 422; email throws ⇒ 502 (nothing persisted either way); `invoiceId` ⇒ 422.
     The reply is NOT persisted (FK) — the queue thread keeps the submission; the email IS delivery.
2. `app/api/admin/support/tickets/[id]/messages/route.ts` — skip `notifyUserTicketReply` for
   `public:` ids (no account ⇒ no dashboard to open; the reply email is the delivery — a notify
   email would be a wrong CTA + a double send).
3. `tests/task-215-public-messages.test.ts` (new) — route-level harness (mirrors
   `tests/support-tickets.test.ts` Module._load fakes): merge/sort/filter, detail shape, resolve/
   reopen persistence, reply email capture + 422/502 paths, credential-scan reuse, notify skip.
4. `tests/support-tickets.test.ts` — add `publicMessage: { findMany: async () => [] }` to its fake
   prisma (the merged list now touches that delegate; the suite has no public rows).

## AFTER — 2026-10-16 (task agent)

### 1. What was implemented — D1, as planned in BEFORE §4 (6 files, uncommitted on `agent/task-215-admin-support-referrals`)

- **`lib/support/tickets.ts`** (M, now 1413 lines) — the whole D1 layer:
  - `:3` adds `import { sendEmail } from "@/lib/email"` (the reply path's delivery).
  - `:74–146` the TASK_215 block: `PUBLIC_MESSAGE_ID_PREFIX = "public:"` (cuids can't contain
    `:` ⇒ unforgeable), `isPublicMessageId()`, `publicMessageRowId()`, `toPublicTicketView()`
    (subject `Public: {name|anonymous}`; `isRead ? resolved : open`; `resolvedAt: null` — isRead
    carries no timestamp and inventing one would poison duration reports; `unread: false`).
  - `listAdminTickets` (`:788–806`) — merge `publicMessage.findMany({orderBy: createdAt desc})`,
    `.map(toPublicTicketView)`, status filter on the DERIVED status, slice skipped entirely (no
    read) when a category/priority filter is active, re-sorted merged desc by createdAt.
  - Dispatch lines: `getAdminTicket` `:819–820`, `addAdminMessage` `:877–878`,
    `updateAdminTicket` `:1086–1087`.
  - `:1126–1297` the helpers: `getPublicMessageDetail` (one `user` message; `domain: null`;
    `userEmail` present ONLY when captured; `userId` omitted ⇒ panel hides the invoice composer;
    no isRead write on read), `updatePublicMessageStatus` (open/resolved ⇔ isRead; category/
    priority/unknown status ⇒ honest 422 with codes `public_message_no_fields` /
    `public_message_unknown_status`; 404 on unknown id), `replyToPublicMessage` (`validateBody`
    first — the SAME credential scan as ticket bodies; `invoiceId` ⇒ 422; no captured email ⇒
    422 `public_message_no_email`; `sendEmail` with `eventType: "public_message_reply"`, quoted
    escaped original under a divider; send throws ⇒ 502 `public_message_reply_failed`; nothing
    persisted — impossible anyway, hard FK — NotificationLog from sendEmail is the audit trail),
    `publicReplyEmailHtml` (local `esc()`; no helper exists in `lib/email.ts`).
- **`app/api/admin/support/tickets/[id]/messages/route.ts`** (M) — `:5` adds `isPublicMessageId`
  to the existing import; `:58–62` the notify skip folded into the existing condition:
  `if (!parsed.invoiceId && !isPublicMessageId(id))` (a public reply already emailed the
  submitter; `notifyUserTicketReply` would be a wrong dashboard CTA + a double send).
- **`tests/task-215-public-messages.test.ts`** (NEW, 379 lines, **15 tests**) — route-level
  harness mirroring the proven `support-tickets.test.ts` Module._load pattern: queue merge +
  shape + `Public: anonymous` label + newest-first + status filter on derived status + category
  filter excludes-and-skips-read; detail shape (email present/absent, no userId, no write on
  read, 404); resolve/reopen persistence + category 422; reply: email captured+escaped+quoted,
  nothing persisted, notify NOT called, no-email 422, credential scan 422, invoice 422, send-
  failure 502.
- **Three sibling-suite loader fixes (discovered by the suite, not planned)** — the new
  `@/lib/email` import in `tickets.ts` poisoned every Module-loader graph that loads the real
  service: `lib/email.ts:1` imports `server-only`, which throws under plain node:
  - `tests/support-tickets.test.ts` `:433–444` — tickets.ts clause now also stubs
    `"@/lib/email" → { sendEmail: async () => {} }`; `:346–352` adds an empty (untraced)
    `publicMessage` delegate to its fake prisma.
  - `tests/support-broadcast.test.ts` `:236–245` — same email stub; `:86–90` empty
    `publicMessage` delegate on its fake prisma (its admin-queue test calls the real
    `listAdminTickets` directly).
  - `tests/premium-invoice.test.ts` `:372–375` — `adminInvoiceDeps()` gains
    `"@/lib/email": { sendEmail: async () => {} }` (the admin invoices route imports
    `postInvoiceNoticeToUser` from the service ⇒ same graph).
  Each stub is annotated `TASK_215` and changes no behaviour of those suites (never called).

### 2. Gates (post-edit, verbatim, on the EXACT final tree @ `f9a21c8` + my uncommitted files)

- `npx tsc --noEmit` → **exit 0, 0 `error TS`** (`/tmp/t215-tsc-verify.log`).
- `npx tsx --test tests/task-215-public-messages.test.ts` → **15/15** (`/tmp/t215-newtest.log`).
- `npx tsx --test tests/*.test.ts` → **1564 tests / 1563 pass / 0 fail / 1 skipped**
  (`/tmp/t215-tests-verify.log`). Arithmetic: 1549 baseline + 15 new = 1564 ⇒ zero regressions;
  the skip is the known DB-gated one. (Intermediate failure round during development: 14 fails,
  all the server-only ripple above — root-caused and fixed, not flaked around.)
- `npx eslint` on all 6 changed files → **0 problems, exit 0** (`/tmp/t215-lint.log`).

### 3. Decisions & deviations the verifier should know

- The notify skip is a widened condition, not an early return — same semantics, smaller diff.
- `sendEmail` is called directly from the service (matching `postInvoiceNoticeToUser`'s style);
  no new module was created.
- HEAD moved under me mid-task: the user committed the referral-security lane as **`f9a21c8`**
  on this branch (its files were already in the worktree when the BEFORE baseline ran, so the
  gates always covered them). No file overlap with mine.
- No commits by me (§5). Referral files and `lib/qa/battery.ts` untouched by me; health 401
  excluded per the user's rescoping (BEFORE §1).

### 4. File inventory (mine vs. the concurrent lane)

- **Mine (uncommitted):** `lib/support/tickets.ts`,
  `app/api/admin/support/tickets/[id]/messages/route.ts`, `tests/task-215-public-messages.test.ts`
  (new), `tests/support-tickets.test.ts`, `tests/support-broadcast.test.ts`,
  `tests/premium-invoice.test.ts`.
- **Committed as `f9a21c8` by the user (NOT mine):** `HOW_WE_MOVE_FAST.md`,
  `app/api/admin/referrals/route.ts`, `app/api/auth/signup/route.ts`,
  `components/admin/referrals-panel.tsx`, `lib/qa/battery.ts`, `lib/referral.ts`,
  `prisma/schema.prisma` + invite came-via migration, `tests/qa-battery.test.ts`.

## HANDOFF → VERIFICATION AGENT

1. Branch/commit: `agent/task-215-admin-support-referrals` @ `f9a21c8` + my 6 uncommitted files
   (§4). Commit only if instructed (PROMPT §5).
2. Rerun gates: `npx tsc --noEmit`; `npx tsx --test tests/*.test.ts` (expect 1564/0 fail/1 skip);
   `npx eslint lib/support/tickets.ts tests/task-215-public-messages.test.ts` (expect clean).
3. Live acceptance (needs deployed env + admin session + a public submission):
   - Submit the anonymous form (or insert a `PublicMessage` row) → admin Support queue shows a
     `Public: {name}` row, newest-first, status open.
   - Category/priority filter hides public rows; status=open/resolved filters them correctly.
   - Open it: one user message thread, captured email shown when present, no invoice composer.
   - Reply with an email address captured → 201, email delivered (quoted original), queue thread
     unchanged on reload (nothing persisted — by design), no dashboard notify email sent.
   - Reply to a no-email submission → 422 with the resolve-it message.
   - Resolve → row flips to resolved (persists); Reopen → back to open.
4. STOP triggers: any schema/migration request for this feature (hard no), any persisted reply
   row (impossible — FK), or a real `SupportTicket` created from a public message (out of scope
   per plan D1).

## FINAL

**TASK_215 DONE** — rescoped scope complete: Bug 2 (public support messages in the admin queue
with open/resolve/reply-by-email) implemented at the service VIEW layer with zero schema/route/
panel changes; Bug 3 verified done outside the branch; health 401 excluded per the user.
Gates: tsc 0 · suite 1564/1563 pass · 0 fail · eslint clean · 15 new tests. Uncommitted per §5.
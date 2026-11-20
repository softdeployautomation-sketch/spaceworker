# Task 94 — Telegram approval loop (P4)

**Status: ready. Depends on TASK_92 (schema) — parallel-safe with 93.**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY (P4).**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3 (as TASK_92).
- **`lib/telegram.ts`, `lib/notify.ts`, `app/api/telegram/webhook/route.ts`** — the existing Telegram plumbing this extends (bot webhook, chat linking via `telegramLinkToken`, per-user `notifyTelegram`/`telegramChatId`).
- **`prisma/schema.prisma` `AgentPendingAction`** — statuses `pending → approved/rejected/expired → executed` (Task 37 semantics; one-time execution).
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §PRIORITY P4, §CROSS-TRACK RULES 1 (gate is absolute and singular).

## Goal
Approve/reject/edit agent proposals from Telegram (phone) — no login needed; every tap audited.

## Deliverables
1. **Proposal → Telegram push**: when a pending action is created and the user has Telegram linked, send a rich message (plan summary, risk note, inline keyboard: Approve / Reject / Edit). Reuse `lib/notify.ts` fan-out conventions.
2. **Tokenized tap endpoints**: `app/api/agent/approve/[token]` style routes — signed, single-use, short-TTL (15 min), bound to the pendingActionId; Approve/Reject buttons hit these directly; Edit opens a tokenized minimal web form (edit payload fields → re-approve).
3. **Webhook extension**: handle callback-query updates in `app/api/telegram/webhook` (answer inline-button presses); idempotent — double-tap must not double-execute.
4. **Audit**: every button tap → `AgentActionAudit` (channel "telegram"); approval transitions follow Task 37 exactly (`approved` → `executed` once, ever).
5. Settings: "Approvals via Telegram" toggle (default off until linked); deep-link "Connect Telegram" already exists — reuse.

## Non-goals
Creating proposals (exists from Task 37/92); execution engines (device tools from 93; clone later); Vantra parity UI.

## Acceptance
- Real Telegram message on a test proposal; Approve executes the bound action exactly once (verify no re-execution on re-tap/network retry); Reject + Expire paths audited; unauthenticated/garbage tokens → 403/404, no state change; `tsc --noEmit` clean; §2 deploy verified live (curl + journalctl).

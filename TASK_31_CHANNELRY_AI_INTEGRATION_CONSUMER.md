# Task 31 — Consume the Channelry external-AI relay (admin config + connection test)

**Status: ready for Cline. The Channelry side is live and verified.** `POST /external/ai-chat` on `channelry-admin` (Cloudflare Worker, `https://channelry-admin.olowolabiakinwale.workers.dev`) is deployed and passed a real live-fire test on 2026-09-13 (plain completion + tool-calling call, both 200 with real Groq token-cost attribution). SpaceWorker is registered as a real external client:

- `client_id`: `spaceworker`
- `daily_cap_hundredths_cent`: `500000` ($50/day, admin-adjustable on the Channelry side without a redeploy)
- A real API key was issued at registration time — **the owner has this key already; ask for it rather than re-registering** (re-registering would need a new `client_id` since `spaceworker` is taken, or a key rotation via Channelry's admin panel, which invalidates the current key). Store it as a new env var, e.g. `CHANNELRY_AI_API_KEY`, in `.env`/`.env.example` — never commit the real value.

This task is SpaceWorker's own consuming side only — nothing on the Channelry Worker needs to change for this task.

## The contract (confirmed live, not just documented)

`POST https://channelry-admin.olowolabiakinwale.workers.dev/external/ai-chat`
Header: `Authorization: Bearer <CHANNELRY_AI_API_KEY>`

**Plain completion mode**:
```json
{ "system": "...", "user": "...", "max_tokens": 800, "temperature": 0.6, "category": "spaceworker_agent", "external_user_id": "<spaceworker user id>", "json_mode": false }
```
→ `{ "content": "...", "usage": { "mode": "plain", "cost_hundredths_cent": N, "used_today_hundredths_cent": N, "cap_hundredths_cent": 500000 } }`

**Tool-calling mode** (pass `tools`, optionally `messages` instead of `system`/`user`):
```json
{ "tools": [...], "messages": [{"role":"system","content":"..."},{"role":"user","content":"..."}], "external_user_id": "..." }
```
→ `{ "content": "...", "tool_calls": [...], "usage": {...} }`

Errors: `401` (bad/inactive key), `429` (over the client's own daily cap — check `used_hundredths_cent`/`cap_hundredths_cent` in the body), `403` (client deactivated), `502` (upstream Groq error — surface as a generic "AI service temporarily unavailable," don't leak the raw message to end users).

`external_user_id` is SpaceWorker's own opaque user id — Channelry attributes cost per-client only (SpaceWorker's own users aren't rows in Channelry's DB), so this field is what lets SpaceWorker later break down ITS OWN $50/day pool by its own user if it ever wants to (not required for correctness now, just don't hardcode/omit it).

## What to build here

### 1. Store the key + admin config UI

New env var `CHANNELRY_AI_API_KEY` (add to `lib/env.ts` + `.env.example`, same pattern as every other secret in this codebase). Add a small admin-panel section (or extend an existing "Services"/integrations tab in `app/admin/(protected)/admin-panel.tsx`) showing: whether the key is configured (boolean, never display the raw value), and a "Test connection" button that fires a trivial plain-completion call (e.g. `system: "Reply with exactly one word."`, `user: "test"`) and shows success/failure + the real `usage` block returned. This is the SpaceWorker-side mirror of what the doc originally asked for ("test the AI connection from there").

### 2. A thin server-side wrapper, not raw fetch calls scattered around

Add `lib/channelry-ai.ts` exporting a single function (e.g. `channelryAiChat(opts)`) that does the fetch, attaches the Bearer key from env, and returns a typed result — every future caller (the admin test button, and eventually the agent in Part B below) goes through this one place, matching this codebase's own established discipline (`lib/campaign-create.ts`, `lib/deliverability.ts` etc. are each "the one place" for their concern). Handle the 429/403/502 cases explicitly with clear error messages, not a generic throw.

### 3. The AI agent itself (Task 27 Part B, now unblocked)

This is the bigger piece this contract was built for — re-read `TASK_27_EXE_LICENSING_AND_AUTOMATIONS_AGENT_PLAN.md`'s "The AI agent" section (still accurate, just re-grounded here now that the transport is real):

- A chat-style panel on the Automations tab ("Ask the agent" next to "New automation").
- The agent's job is interpreting intent into parameters, not new backend capability — it calls SpaceWorker's own existing REST endpoints (`POST /api/jobs`, `POST /api/campaigns`, `GET /api/mailboxes`, etc.) via `channelryAiChat`'s tool-calling mode, passing SpaceWorker's own endpoint shapes as `tools`.
- **Confirmation gate before any job actually runs** — the agent proposes a plan (find/location terms, minResults, duration, estimated time) as a reviewable card; the user confirms or asks for changes before it calls `POST /api/jobs` for real. Same shape as Channelry's own "Agent Decider System" precedent (approval-gated tool calls), reimplemented in SpaceWorker's own codebase (its own DB row with a TTL is fine — no shared library across the two repos, per the original integration doc's own note).
- Once confirmed and the job finishes, the agent reports the outcome (leads found vs. requested, validation split) and, if mailboxes exist, offers the campaign-creation follow-up as its own separate confirmable step.

**Recommended split**: do items 1-2 first (small, no new product surface, just wiring) and verify the connection test genuinely works with the real key before starting item 3 (the actual agent), which is a substantially larger, multi-session piece of work on its own.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Item 1: the admin "Test connection" button must be run against the REAL key and REAL Channelry endpoint (not mocked) — confirm a real `usage.cost_hundredths_cent >= 1` comes back, the same bar Channelry's own live-fire test used.
- Item 3: the confirmation gate must be verified live — an agent-proposed job must NOT actually call `POST /api/jobs` until the human explicitly approves, checked by watching the Extract page's job list, not just trusting the code path.

## STATUS — handoff from Cline (2026-09-13)

### Items 1 & 2 — DONE and LIVE-VERIFIED against the real endpoint

- **`lib/env.ts` + `.env.example`** — added optional `CHANNELRY_AI_API_KEY` (fail-closed). The real key is in the local `.env` and the production VPS `.env` (owner-provided); never commit it.
- **`lib/channelry-ai.ts`** — the single thin wrapper: `channelryAiChat(opts)` (typed `{ content, tool_calls, usage }`), `channelryAiConfigured()`, `ChannelryAiError` with explicit codes for `401/403/429/502`/network/unconfigured. Bearer key from env only.
- **`app/api/admin/ai/route.ts`** — admin-gated `GET { configured }` + `POST` Test-connection (real trivial plain-completion).
- **`app/admin/(protected)/admin-panel.tsx`** — new **"AI"** tab (key-configured badge, "Test connection" button showing the real `usage` block; never displays the raw key).
- **Live test PASSED (not mocked):** via the wrapper against `https://channelry-admin.olowolabiakinwale.workers.dev/external/ai-chat`, reply `"Acknowledged"` with `usage: { mode:"plain", cost_hundredths_cent:1, used_today_hundredths_cent:1, cap_hundredths_cent:500000 }` — `cost_hundredths_cent >= 1` ✓.

### Item 3 — server-side COMPLETE (tsc-clean), UI + live verify OUTSTANDING

New DB models (schema + migration `20260913100000_add_agent_threads`, applied to the local dev DB):
- `AgentThread` (one per user), `AgentMessage` (chat turns, `toolCall` snapshot), `AgentPendingAction` (the approval-gate row: `kind` `"job"|"campaign"`, `status` `pending|approved|rejected|expired|executed`, `payload` JSON, `expiresAt` 1h TTL).

New files (all `tsc --noEmit` clean, `npm run build` clean, migration applied):
- **`lib/agent.ts`** — `runAgentTurn({userId, message})` routes through `channelryAiChat` tool-calling mode. Emits `propose_job`/`propose_campaign` → persists an `AgentPendingAction` (status `pending`, 1h TTL). **It NEVER creates a job/campaign.** Rich system prompt with grounded example find/location-term phrasing. `listThreadMessages`, `AGENT_PROPOSAL_TTL_MS`.
- **`lib/agent-executor.ts`** — the ONLY place a pending action becomes real: `approvePendingAction` (atomic `pending→approved→executed` claim; resets back to `pending` if execution throws), `executeJob` (via `buildSearchQueries` + `createSearchJob` — the exact path `POST /api/jobs` uses), `executeCampaign` (via `leadToRecipient` + `createCampaign`, valid-leads only, `pending_test_confirm` so the test-send gate still applies), and `executedActionStatus` (poll: job status + lead/valid/invalid/unchecked counts or campaign id).
- **`app/api/agent/route.ts`** — `GET` (thread messages + pending actions), `POST { message }` (runs a turn).
- **`app/api/agent/actions/[id]/route.ts`** — `PATCH { decision:"approve"|"reject" }` (approve is the ONLY job/campaign creation trigger), `GET` (outcome poll).

### Item 3 UI — DONE (tsc-clean + build-clean); LIVE VERIFY still outstanding

- **`app/dashboard/automations/page.tsx`** now has the **"Ask the agent"** chat panel as a right-hand column (plus an "Ask the agent" header button beside "New automation" that focuses the composer).
  - `GET /api/agent` on mount (folded into the single existing mount effect, so no new `setState-in-effect` lint error) renders message bubbles + any `pending` plan cards; mailbox count from `GET /api/mailboxes` drives the "No mailboxes" badge and the campaign-follow-up gating.
  - Composer `POST /api/agent {message}`, appends the assistant reply, and any returned `pendingAction` renders a reviewable card.
  - **Job plan card**: find terms / location terms / email domains (Badges), `min_results` target, `estimated_time_minutes`/`max_duration_minutes`, with **Confirm** (`PATCH /api/agent/actions/[id] {decision:"approve"}`) and **Reject**. On Confirm it starts polling `GET /api/agent/actions/[id]` (5s cadence, ≤20 shots, stops once the job leaves queued/running).
  - **Outcome card**: leads-found vs. requested (+%), valid/invalid/unchecked split. When the job is done and the user has ≥1 mailbox, a **"Plan a follow-up campaign"** button POSTs a message that prompts the agent's `propose_campaign`, surfacing a confirmable **kind:"campaign"** plan card.
  - **Campaign plan card**: name / subject / stripped-HTML body preview / search-job id, with Confirm + Reject; Confirm shows the created campaign id.
  - Matches the file's conventions (plain `useState`/`fetch`, `Button`/`Card`/`Badge`/`Spinner`/`Input` from `@/components/ui`, `useToast`, `useConfirm`). `npx tsc --noEmit` clean, `npm run build` clean.

### What the next agent must do (in order)

1. **LIVE-verify the confirmation gate** (the doc's explicit item-3 bar): with the real key + running server, have the agent propose a job, then check the Extract page's job list — it must be **empty until Approve is clicked**; only after Approve does the new SearchJob appear. Also exercise the campaign follow-up with a mailbox configured. (The UI panel above is built and compiles clean; this live run is the remaining bar.)
2. **`npm run build` + `npx tsc --noEmit`** must stay clean. Re-run `npx prune migrate deploy` on the prod DB on deploy (the local migrated fine).
   - `GET /api/agent` on load → render `messages` (user/agent bubbles) + any currently-`pending` plan card.
   - A message input → `POST /api/agent { message }`; append returned assistant `reply`.
   - When a `pendingAction` comes back, render a **reviewable plan card** for `kind:"job"`: find terms, location terms, minResults, estimated time (use `max_duration_minutes` / `estimated_time_minutes`), with **Confirm** (`PATCH .../actions/[id] {decision:"approve"}`) and **Reject** buttons. Then poll `GET .../actions/[id]` to show the outcome (leads found vs requested, valid/invalid split, and — if the user has mailboxes — a follow-up opportunity to plan a campaign as its own confirmable `kind:"campaign"` step).
   - Follow the file's existing conventions (plain `useState`/`fetch`, `Button`/`Card`/`Badge`/`useToast` from `@/components/ui`; note this file's lint is not `react-hooks`-clean baseline).
2. **Live-verify the confirmation gate** (the doc's explicit item-3 bar): with the real key + running server, have the agent propose a job, then check the Extract page's job list — it must be **empty until Approve is clicked**; only after Approve does the new SearchJob appear. Also exercise the campaign follow-up with a mailbox configured.
3. **`npm run build` + `npx tsc --noEmit`** must stay clean. Re-run `npx prisma migrate deploy` on the prod DB on deploy (the local migrated fine).

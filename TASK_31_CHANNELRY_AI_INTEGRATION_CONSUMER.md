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

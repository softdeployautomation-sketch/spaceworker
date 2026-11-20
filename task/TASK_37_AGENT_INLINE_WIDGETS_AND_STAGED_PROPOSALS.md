# Task 37 — Inline structured widgets in agent chat, and staged proposals in the normal lists

**Status: ready for Cline.** Two related refinements to the already-live "Ask the agent" panel (Task 31 item 3), grounded in live-testing feedback (2026-09-13) plus a quick competitive scan of how comparable tools (Instantly's Copilot/WARP Mode) solve the same problem.

## 1. Inline structured widgets — stop asking questions the user can't answer without leaving the chat

**Confirmed live**: when the agent needs a `search_job_id` to propose a campaign, it currently asks in **plain text** — "Could you let me know which lead-extraction job (its SearchJob ID)..." — which no user actually has memorized. The user then has to leave the chat, go find the right job in the Extract page, copy an internal id they've never seen, and come back. Same problem for "you don't have a lead source yet, go upload one first."

**The fix**: give the agent's turn result a way to say "I need a structured pick here," and have the chat panel render the SAME real component the rest of the app already uses for that exact choice — not a second, simplified widget, and never a raw text prompt for something with a finite, known set of options.

### New agent tools (`lib/agent.ts`, alongside the existing `propose_job`/`propose_campaign` in `AGENT_TOOLS`)

- `list_lead_sources` — the model calls this instead of asking in prose when it needs the user to pick a finished extraction/upload to build a campaign from. Server-side, this does NOT create an `AgentPendingAction` (nothing is being proposed yet) — it fetches the user's own lead sources (reuse the exact `GET /api/leads/selectable` data shape already built for the Campaigns picker, `PickerJob`/`PickerData` in `app/dashboard/campaigns/page.tsx`, don't re-derive it) and returns it as a new `inlineWidget` field on the turn result: `{ type: "lead_source_picker", jobs: PickerJob[] }`.
- `request_lead_upload` — the model calls this when the user has no usable lead source at all yet. Returns `{ type: "lead_upload" }` — no data needed, the widget IS the existing upload dropzone.
- `list_mailboxes` — same pattern for "which mailbox(es) should this campaign send from," reusing `GET /api/mailboxes`'s existing shape.

Extend `AgentTurnResult` (`lib/agent.ts`) with `inlineWidget: { type: "lead_source_picker"; jobs: PickerJob[] } | { type: "lead_upload" } | { type: "mailbox_picker"; mailboxes: MailboxOption[] } | null`. Persist it on the `AgentMessage` row the same way `toolCall` already is (a JSON snapshot), so reloading the chat still shows the widget rather than losing it.

### Frontend (`app/dashboard/automations/page.tsx`'s message renderer)

When an assistant message carries `inlineWidget`, render the matching REAL component inline in that message's bubble instead of (or alongside) its text:
- `lead_source_picker` → the exact dropdown markup/behavior from the Campaigns picker (`app/dashboard/campaigns/page.tsx`'s job `<select>`), just re-homed into a chat bubble. Selecting an option immediately composes and sends the next turn automatically (e.g. `"Use search job {id} ({label})"`) — the user picks, they don't type, they never leave the panel.
- `lead_upload` → the existing upload dropzone (`app/dashboard/extract/page.tsx`'s `uploadOpen` modal content, or a compact inline variant of it) posting to the same `POST /api/leads/upload`. On success, auto-send the next turn referencing the newly created job id, same as above.
- `mailbox_picker` → a checkbox list (reuse `GET /api/mailboxes`'s data), auto-sending the selection as the next turn.

**Also make the agent proactively smarter, not just reactively less annoying**: update `AGENT_SYSTEM_PROMPT` so the model calls `list_lead_sources`/`list_mailboxes` itself as soon as it realizes it needs one, rather than defaulting to a vague text question and waiting to be told these tools exist — the tools should be its first instinct for exactly this class of question, matching the whole point of `PROPOSE_JOB`/`PROPOSE_CAMPAIGN` already being tool calls instead of prose.

## 2. Agent proposals should show up where campaigns/automations normally live, not only in the chat transcript

**Research finding** (Instantly's Copilot + WARP Mode is the closest real comparable — see sources below): the pattern that's actually working in the market is NOT a "human mode vs. agent mode" toggle per campaign — it's that an agent's draft materializes as a completely normal object (Instantly's WARP Mode stages a full campaign "for launch" using the same campaign records a human-built one would use) and shows up in the SAME list a human's own work shows up in, just flagged as agent-authored. Separately, "Copilot Tasks" run scheduled/recurring in the background with a notification when something needs a decision — that's the "agent alongside, not chatting" mode being asked for here, and it already fits this app's existing `CampaignAutomation` model (Task 27 Part B) without inventing a second concept.

**Recommendation — don't build a mode switch.** Instead:
- An agent-proposed `AgentPendingAction` (job or campaign) that's currently sitting `pending` should ALSO surface as a row in the normal Automations list (and, once approved/executed, the resulting `SearchJob`/`EmailCampaign` already shows up in Extract/Campaigns exactly like a hand-built one — this already works today, no change needed there). Add a small "🤖 Proposed by agent — awaiting your review" badge/row so a user who never opens the chat panel still sees it and can Approve/Reject from the list they already check, not just from the chat.
- This means the Automations list becomes the single place either kind of automation (hand-built or agent-proposed) lives and gets reviewed — the chat is only ever needed for the INITIAL ask, never for ongoing oversight. This is the concrete shape of "agent alongside, not chatting."

## Explicitly out of scope for this pass

- A literal per-campaign "human vs. agent" toggle — deliberately not building this per the research above; the staged-proposal-in-the-normal-list pattern accomplishes the same goal without a parallel system.
- Fully autonomous execution of anything — every proposal still requires the same explicit approval click as today; this task only changes HOW the user answers the agent's clarifying questions and WHERE they see pending proposals, not the approval gate itself.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Ask the agent to plan a campaign with no search job id given — confirm it calls `list_lead_sources` and a real, clickable dropdown of the user's own lead sources appears inline in the chat, not a text question.
- Confirm picking an option (or completing an inline upload) auto-advances the conversation without the user typing anything.
- Confirm a pending agent proposal shows up in the Automations list with its badge, and can be approved/rejected from there without ever opening the chat panel.

Sources:
- [Instantly AI Copilot](https://instantly.ai/copilot)
- [Top 10 AI Sales Agent Cold Email Outreach Features (2026) — Lindy](https://www.lindy.ai/blog/ai-sales-agent-cold-email-outreach-features)

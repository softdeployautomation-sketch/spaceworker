# Task 38 — Connect the agent to the deliverability/pin/rotation loop

**Status: ready for Cline, after Task 37 lands and is reviewed.** Builds directly on Task 37's tool-calling infrastructure (`lib/agent.ts`, `lib/agent-executor.ts`, `AgentPendingAction`, the staged-proposal cards in the Automations list) and on Task 33's diagnostics/pin API primitives (`app/api/campaigns/[id]/run-diagnostics/route.ts`, `app/api/campaigns/[id]/deliverability-decision/route.ts`). Both are already live — this task is the wiring between them that TASK_33 §3 explicitly deferred: *"This is a note for whoever builds the agent-side orchestration on top of this task's API primitives... The calibration lives in the agent's own conversation logic, built separately."* This is that separate build.

## The ask, as given (2026-09-13, paraphrased across two messages)

> I think we are getting the rotation for the test wrong... as soon as any run turns green and inbox, that exact run gets sent to the next 50 contacts... you will have to give user consent to accept this changes... we must make the ai agent understand this steps and trigger messages and edit and make decisions and question users for email testing if user is not using the email set for testing, but if user is using the email I think the ai should be able to handle it and then ask when needed.

Resolved via AskUserQuestion the same day: **the agent should be more autonomous when the campaign is using the platform's verified seed mailbox (an objective, IMAP-confirmed signal), and more cautious/ask-first when the campaign is using a personal test-recipient override (a subjective, human-eyeballed signal)** — this is TASK_33 §3, word for word. That decision has never been implemented; the agent currently has zero connection to any campaign's deliverability state.

## What exists today that this task connects

- The agent (`lib/agent.ts`) only knows `propose_job`, `propose_campaign`, and Task 37's three widget tools (`list_lead_sources`, `request_lead_upload`, `list_mailboxes`). It has never read an `EmailCampaign` row.
- `deliverability-decision`'s five actions (`continue`, `switch_subject`, `add_edit_and_continue`, `pin_and_continue`, `stop`) and `run-diagnostics`'s isolation ladder are pure human-facing REST today — deliberately, per their own comments ("plain, human-and-agent-agnostic REST... the calibration lives in the agent's own conversation logic, not here").
- `lib/agent-executor.ts`'s `approvePendingAction` only knows how to execute `kind: "job"` and `kind: "campaign"`.

## 1. Extract the decision logic so both humans and the agent call the same code

`deliverability-decision`'s route currently has the `switch_subject`/`pin_and_continue` mutation logic inlined in the route handler. Pull each branch's DB-mutation core (not the request-parsing/auth wrapper) into exported functions in `lib/deliverability.ts` (which already owns `runTestSend`/`buildIsolationProbes`/`probeCampaignPlacement` — the established "one shared place" for this concern, same discipline as `lib/campaign-create.ts`):

- `applyPinAndContinue(campaignId, { subject, bodyHtml, fromAddress, pinCount })`
- `applySwitchSubject(campaignId, { fromInitialGate })` (returns the rotated subjects + resulting status, or throws on the "nothing to switch to" case — same 400 the route returns today)

The route (`deliverability-decision/route.ts`) becomes a thin wrapper: parse/auth/status-guard, then call the shared function. **No behavior change for the existing human flow** — this is a refactor, not a feature change, and must be verified as such (existing manual pin/switch-subject flows work identically before and after).

## 2. New agent tools (`lib/agent.ts`)

Add to `AGENT_TOOLS`, following Task 37's exact pattern (a tool either widgets, proposes, or now — new this task — sometimes just *executes and reports*, calibrated by mode):

- **`check_campaign_status`** — params: none. Returns an inline widget `{ type: "campaign_status_list", campaigns: [...] }` listing the user's own campaigns currently in `pending_test_confirm` or `paused_deliverability` (id, name, status, most recent `DeliverabilityCheck.landedIn`/`error`, whether it's on the seed mailbox or a `testRecipientOverride`). This is how the agent (and the user, via the chat) sees "where things are stuck" without leaving the panel — the direct answer to "we know the places the ai need to sit."
- **`run_diagnostics`** — params: `{ campaign_id: string, keys?: string[] }`. Server-side behavior is where the calibration lives:
  - If the campaign has **no** `testRecipientOverride` (seed-mailbox mode): execute the probes immediately in this same tool call (call the extracted diagnostics logic directly — no HTTP round-trip to itself, same discipline as `executeCampaign` calling `createCampaign` directly), and return the outcomes as part of this turn's reply (prose summary + an inline `{ type: "diagnostics_result", results: [...] }` widget). **No approval gate to RUN it** — per TASK_33 §3, an agent reading an objective IMAP-verified signal doesn't need permission just to look.
  - If the campaign **has** a `testRecipientOverride` (personal-inbox mode): do **not** run anything yet. Create an `AgentPendingAction` (`kind: "diagnostics"`, payload `{ campaignId, keys }`) and reply asking the user to confirm they're ready to check their own inbox for the resulting test emails — per TASK_33 §3's explicit instruction ("ask the user to confirm they'll check the resulting test email, rather than silently firing 4 emails at the user's inbox"). This is a genuine approval gate, not a widget.
- **`propose_pin`** — params: `{ campaign_id, subject, body_html, from_address?, pin_count? }`. **Always** creates an `AgentPendingAction` (`kind: "pin"`) regardless of mailbox mode — TASK_33 §2 is explicit that a pin "requires the same explicit human-approval click as everything else in this app's send path — never auto-apply a pin without it, even when the AI agent is the one proposing it." No calibration branch here; this is the one action that is never autonomous.
- **`propose_switch_subject`** — params: `{ campaign_id }`. Creates an `AgentPendingAction` (`kind: "switch_subject"`) — rotating a campaign's live subject is a real, visible action on a real campaign, so it goes through the same approval card as a pin, even on the seed mailbox. (Only *reading* diagnostics is autonomous per §3 — *changing* what a campaign sends never is, matching Task 37's own explicit out-of-scope note: "Fully autonomous execution of anything... every proposal still requires the same explicit approval click as today.")

Update `AGENT_SYSTEM_PROMPT` with a new numbered section (after the Task 37 "gathering what you need" section) teaching the model: when the user asks about a stuck/paused campaign, or after proposing a campaign, check `check_campaign_status`; when a campaign is `paused_deliverability` or `pending_test_confirm`, offer to `run_diagnostics`; once a probe comes back clean, recommend `propose_pin` for a batch of upcoming sends, explaining the tradeoff in one sentence before proposing it (mirrors the existing "surface your reasoning before your tool call" rule).

## 3. Extend the pending-action executor (`lib/agent-executor.ts`)

`AgentPendingAction.kind` grows three new values: `"pin"`, `"switch_subject"`, `"diagnostics"`. Extend `approvePendingAction`'s switch:

- `kind: "pin"` → call `applyPinAndContinue` (from item 1) with the payload; on success mark `executed`, store `executedCampaignId` (reuse the existing column — no new schema needed, a pin doesn't create a new object, it just needs *some* id to report back).
- `kind: "switch_subject"` → call `applySwitchSubject`; same executed/`executedCampaignId` bookkeeping.
- `kind: "diagnostics"` → actually run the probes now (this is the override-mode path from item 2, where running was gated behind approval); store the probe outcomes somewhere pollable — either reuse `payload` (merge results back in after execution, since nothing else reads payload after approval) or extend `AgentPendingAction` with a nullable `result Json?` column if that reads cleaner. Either is fine; pick whichever keeps `executedActionStatus` simplest.

Extend `ExecutedActionStatus`/`executedActionStatus` so the chat panel's existing poll-after-approve mechanism (already built for job/campaign) also works for these three kinds — same shape, just reporting a campaign's new status/pinnedOverride/subjects/diagnostics-results instead of a created id.

## 4. Frontend (`app/dashboard/automations/page.tsx`)

- Extend the inline-widget dispatcher (Task 37) with two new widget renderers: `campaign_status_list` (a compact list, each row clickable to send `"Run diagnostics on campaign {id}"`) and `diagnostics_result` (the same probe-checklist visual language as the campaign detail page's Task 33 UI — reuse, don't reinvent).
- Extend the plan-card renderer (`JobPlanDetails`/`CampaignPlanDetails`, both already rendered in the chat AND in the Task 37 staged-proposal list) with `PinPlanDetails`, `SwitchSubjectPlanDetails`, and `DiagnosticsPlanDetails` — each a small summary of what's being proposed (e.g. "Pin this subject/body for the next 50 sends"), so these three new proposal kinds show up correctly in both places Task 37 already built, not just the chat.
- The `diagnostics` pending-action card (override-mode confirm-to-run) should read as a confirmation, not a plan — its Confirm button should probably say "Yes, send the test emails" rather than the generic "Confirm" used for job/campaign/pin/switch, since approving here **starts sending real test emails to the user's own inbox** immediately, unlike every other approval in this app which stages something reviewable.

## Explicitly out of scope for this pass

- **Proactive/unprompted notifications** — the agent surfacing a stuck campaign on its own, without the user opening the chat panel or asking. This task only makes the agent *capable* of understanding and acting on deliverability state *once asked* (or once it naturally comes up while proposing a campaign). A background sweep that posts an unprompted system message into the thread when a campaign hits `paused_deliverability` is a real, separate piece of infrastructure (extending the existing `automations-sweep` internal cron) — earmark it as **Task 39** if wanted, don't fold it into this one.
- Any autonomy beyond what TASK_33 §3 already specified. Reading diagnostics on the seed mailbox is the ONE autonomous action; everything else (pin, switch, running diagnostics in override mode) keeps the explicit human click.
- Changing `deliverability-decision`'s `continue`/`stop`/`add_edit_and_continue` actions — not mentioned in the original ask, and `add_edit_and_continue` in particular requires a manually-authored draft the agent has no business inventing unprompted.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Refactor check: existing manual pin/switch-subject flows (Task 33/36's own verification steps) still behave identically — run them again post-refactor, not just a code read.
- Seed-mailbox campaign: ask the agent to check on a paused campaign, confirm `run_diagnostics` executes immediately with NO approval card, and its results render as a real widget.
- Override-mode campaign: ask the same, confirm the agent instead creates a `diagnostics` pending action asking for confirmation, and no test email sends until that's approved.
- Either mode: confirm `propose_pin` and `propose_switch_subject` ALWAYS create an approval card first — never auto-apply, matching TASK_33 §2's "no exceptions" rule, live-verified by watching the campaign's actual `pinnedOverride`/`subjects` in the DB, not just trusting the code path.

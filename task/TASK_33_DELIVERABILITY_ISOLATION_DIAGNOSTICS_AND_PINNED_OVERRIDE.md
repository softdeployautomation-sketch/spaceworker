# Task 33 — Isolation diagnostics (subject/body/from) and a temporary pinned-override window

**Status: ready for Cline, after Task 32 lands and is reviewed.** Blocked on the same files Task 32 touches (`lib/deliverability.ts`, `app/api/campaigns/[id]/test-send/route.ts`, `app/api/campaigns/[id]/deliverability-decision/route.ts`, `app/dashboard/campaigns/[id]/page.tsx`) — do not start until that's committed. This task is a refinement on top of Task 32's "test a draft, judge it, promote it" mechanism, not a replacement.

## The ask, as given (2026-09-13)

Today's automated retry ("It went to spam — try a different subject") only ever rotates the WHOLE subject to the next one in the list. The owner wants a genuine diagnostic ladder that isolates WHICH element (subject, body, or From address) is actually triggering spam filtering, and — once a combination tests green — a way to apply that exact proven combination to a run of upcoming sends immediately, overriding the normal per-batch rotation for that stretch, with explicit human (or agent, per the autonomy split below) consent before it takes effect. Explicitly optional: none of this should change what the fully manual/fully automatic default flows do today if a user never engages with it.

## 1. The isolation ladder — one variable at a time

Extend Task 32's "test an arbitrary draft" mechanism (the `test-send` route's optional `{subject, bodyHtml, from}` override) with a guided sequence instead of a single free-form edit box. Given the campaign's CURRENT active subject/body/from (index 0 of each rotation, or the legacy variant), offer four probes, each changing exactly one variable and holding the other two constant:

1. **Subject only** — next subject in the rotation (or a fresh one, if editing), same body, same From.
2. **Body only** — next body in the rotation (or a fresh one), same subject, same From.
3. **Empty-body diagnostic** — same subject, **body replaced with an empty string**, same From. This is a genuine diagnostic, not just another variant: if this STILL lands in spam, the subject (or the From address/sender reputation) is implicated, not body content — a body-content spam trigger cannot be blamed for a message that has no body. If this one comes back clean, it's strong evidence the ORIGINAL body was the trigger.
4. **From only** — next From address in the mailbox's `fromAddresses` rotation (Task 30 item 4), same subject, same body.

Run each probe through the exact same `runTestSend`/`test-send` route Task 32 already built (draft-content override, no persistence) — this is UI/orchestration on top of Task 32's primitive, not new send logic. Each probe writes its own `DeliverabilityCheck` row as normal (full audit trail of the whole diagnostic run).

**UI**: a "Run diagnostics" option alongside Task 32's single manual-edit box (both optional, neither required) — a small panel showing the 4 probes as a checklist, each with its own Run button and a landedIn badge once tested, so the user (or agent) can see at a glance which one(s) came back clean.

## 2. On any green result: propose a temporary pinned override, not a permanent promote

This is DIFFERENT from Task 32's "front-insert into the rotation forever" — the owner's ask here is narrower and temporary: "that exact run gets sent to the next 50 contacts... canceling the normal flow of changing subject after 10 sent." That's a request to LOCK the campaign onto one proven combination for a specific number of upcoming sends, suspending normal rotation for that stretch, not just nudging the rotation's priority order.

**New campaign state** (additive): `pinnedOverride: { subject, bodyHtml, fromAddress, remaining } | null` (a JSON column is fine — no need for a full new table). When set:
- The mail-queue drain, for THIS campaign, sends every recipient with the pinned subject/body/from instead of consulting `subjects[i%len]`/`bodies[i%len]`/`fromAddresses[i%len]` at all, decrementing `remaining` per send.
- Once `remaining` reaches 0, clear `pinnedOverride` (`null`) and resume the campaign's normal rotation exactly as before — this is a WINDOW, not a permanent change.
- The batch-gate deliverability probe (existing `batchSize`-driven check) still runs as normal during a pinned window — a pin doesn't turn off the safety check, it just decides what content that check (and the real sends) use.

**Consent flow**: extend `deliverability-decision`'s action set once more (or reuse `add_edit_and_continue` with an extra `pinCount` field — implementation's call which reads cleaner) — something like `{ action: "pin_and_continue", subject, bodyHtml, fromAddress, pinCount }`. `pinCount` defaults to the campaign's own `batchSize` if not specified ("the next batch" the owner referred to), clamped [1, 1000] like every other numeric knob in this app. This requires the same explicit human-approval click as everything else in this app's send path — never auto-apply a pin without it, even when the AI agent is the one proposing it (see the autonomy note below — autonomy affects how INSISTENTLY the agent recommends something and how much it front-loads, never whether the click happens).

**After the pin window ends**: also front-insert the pinned combination into the normal rotation (Task 32's mechanic) when the window completes successfully (no spam hits during the pinned stretch) — so the proven-good content keeps benefiting the campaign afterward too, not just for its pinned window. If a spam hit DOES occur during the pinned window, treat it exactly like today's batch-pause (`paused_deliverability`), clear the pin, and fall back to the normal decision box — a pin is a bet the user/agent made, not a bypass of the safety net.

## 3. Agent autonomy calibration (owner decision, 2026-09-13)

When the future agent (Task 31 item 3, already live) eventually drives this diagnostic loop itself:
- **Using the platform's default shared seed mailbox (automated IMAP-verified `landedIn`)**: the agent can be MORE autonomous — run the isolation ladder itself, since `landedIn` is an objective, machine-verifiable signal it can trust the same way a human would read it. It should still put a pin/promote decision in front of the human before it takes effect (per the consent rule above, no exceptions), but it doesn't need to ask permission just to RUN the diagnostic probes themselves.
- **Using a personal test-recipient override (no IMAP verification, "delivered" = SMTP-accepted only)**: the agent should check in with the human MORE — this mode's whole premise is that a human is the one actually confirming placement by eye, so an agent running probes unsupervised here is asking the human to trust a proxy for their own judgment that doesn't actually exist yet. Concretely: before running an isolation probe in override mode, the agent should ask the user to confirm they'll check the resulting test email, rather than silently firing 4 emails at the user's inbox and guessing from the (mostly uninformative, since it's not IMAP-verified) `landedIn:"unknown"` outcome alone.
- This is a note for whoever builds the agent-side orchestration on top of this task's API primitives — not something to hardcode into the two routes below (which stay plain, human-and-agent-agnostic REST endpoints, per Task 32's own "agent-ready decision point" principle). The routes don't know or care who's calling them; the calibration lives in the agent's own conversation logic, built separately.

## Explicitly out of scope

- Automatically deciding to run the diagnostic ladder without any trigger — it's opt-in, invoked either by a human clicking "Run diagnostics" or (later) the agent proposing it.
- Changing what happens when a user never touches any of this — the existing simple "switch_subject" single-rotation button stays exactly as it is today, for whoever prefers it.
- Persisting the diagnostic run's individual probe results anywhere beyond the normal `DeliverabilityCheck` audit rows already written per probe.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Run all 4 probes against a real mailbox/test recipient and confirm each one's `DeliverabilityCheck` row reflects exactly the combination that was actually tested (not the campaign's stored content).
- Confirm a pin window actually overrides rotation for exactly `pinCount` sends, then cleanly resumes normal rotation (verified live against real queue items' `resolvedSubject`/`resolvedBodyHtml`/`resolvedFromAddress`, not just by reading the code).
- Confirm a spam hit DURING a pinned window correctly clears the pin and falls back to `paused_deliverability`, rather than continuing to trust a pin that just failed.

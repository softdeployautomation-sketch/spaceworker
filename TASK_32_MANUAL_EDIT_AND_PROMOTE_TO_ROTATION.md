# Task 32 — Manually edit a test message, verify it, then promote it into the rotation

**Status: ready for Cline, after Task 30 is committed and merged.** Do not start this until Task 30's diff (currently in progress — do not touch `app/dashboard/campaigns/page.tsx`, `lib/deliverability.ts`, `lib/campaign-recipients.ts`, `lib/campaign-create.ts`, or the other files it's mid-editing) is committed, since this task extends the exact same test-send/decision surface.

## The ask, as given (2026-09-13)

When the automated deliverability flow isn't guessing a good enough fix (the existing "It went to spam — try a different subject" action just rotates to the NEXT subject already in the rotation, which may not exist or may not help), let the user manually author a replacement subject/body/from right there in the test-send UI, fire a real test with that draft content (without touching the saved campaign yet), and — if they judge the result good by eye — promote that draft into the campaign's actual subject/body rotation so it's used going forward, exactly like every other rotation entry. Explicitly optional — a user who never touches this keeps the fully automated flow untouched.

## Where this lives — both surfaces already share the same decision UI

Per `app/api/campaigns/[id]/deliverability-decision/route.ts`'s own doc comment, there are exactly two moments a human is asked to decide something: the initial test-send-confirm gate (`pending_test_confirm`) and a mid-send batch pause (`paused_deliverability`). Both already render the same 3-way box (`app/dashboard/campaigns/[id]/page.tsx`, "It's in the inbox" / "It went to spam — try a different subject" / stop-or-retry) and both already call the same route. This feature adds a 4th path through that same box: **"Manually edit and test"**.

## 1. Test an arbitrary draft without saving it

`POST /api/campaigns/[id]/test-send` (`app/api/campaigns/[id]/test-send/route.ts`) currently always tests the campaign's STORED content (`campaign.subjects[0]`/`bodies[0]`, or the first `CampaignVariant` for legacy campaigns — see lines 41-50). Extend it to accept an optional body:

```json
{ "subject": "...", "bodyHtml": "..." }
```

When present, build the probe `variant` from these values instead of the stored ones (skip the existing lines 41-50 entirely in that case) — everything else in the route (mailbox fan-out, override-recipient vs. seed-mailbox branching, staggering, the `DeliverabilityCheck` write) stays exactly as-is; only the CONTENT being tested changes. This is deliberately NOT persisted anywhere yet — it's a live probe of a draft, matching "trigger the message to send for test to see if... the subject rotation is not enough."

**Pre-fill source**: per the ask ("edit the last test message that was sent or one of the flow message"), pre-fill the edit form from whichever content the LAST test-send actually used — for a decoupled campaign that's simply `campaign.subjects[0]`/`campaign.bodies[0]` (index 0 is always what test-send and the batch probe use today), so no new tracking column is needed. For a legacy pair campaign, pre-fill from `campaign.variants[0]`.

## 2. Promote the tested draft into the rotation — as the PREFERRED entry, not just another one

Extend `POST /api/campaigns/[id]/deliverability-decision`'s existing action set with one more:

```json
{ "action": "add_edit_and_continue", "subject": "...", "bodyHtml": "..." }
```

Behavior, mirroring the existing `"continue"` and `"switch_subject"` branches exactly (same `fromInitialGate`/`fromBatchPause` split already in the route):
- **Insert at the FRONT of `campaign.subjects`/`campaign.bodies` (index 0), not appended at the end.** Owner's explicit refinement (2026-09-13): a human (or later, the agent) only reaches this action after judging a real test result good by eye — that's a stronger, more direct signal than an untested rotation entry, so it should be tried first going forward, not queued behind whatever was already there. Rotation is `i % length`, so front-insertion is what makes it "used preferentially" without adding any new field, weighting scheme, or a second code path to maintain — the very next batch (and the very next test-send) picks it up first, for free.
- This also gives you the "fallback if the others keep messing up" behavior the owner asked for, with no extra mechanism: if a later `switch_subject` rotates forward into an OLDER, unproven entry and that one fails too, the NEXT `switch_subject` cycles forward again and eventually wraps back around to this proven entry at some point in the rotation — good enough for v1. Don't build a separate "known-good" flag/table for this pass; it's not asked for and the front-insertion ordering already captures the intent. (If a future pass wants stronger pinning — e.g. always retry the proven entry immediately after ANY failure rather than waiting for wraparound — that's a bigger design conversation, not this task.)
- Creating those arrays from scratch if this is a legacy pair campaign with empty subjects/bodies — i.e. this action also naturally upgrades a legacy campaign into the decoupled rotation model, using its existing `CampaignVariant`'s subject/body as the second entry (after the new one, per the front-insertion rule above) so nothing already in flight is lost.
- Record a manual-override `DeliverabilityCheck` exactly like the existing `"continue"` branch does (lines 95-104) — this WAS a human-verified test, just with edited content, so the audit trail should say so (reuse the same `error: "Manually confirmed..."` message, or make it explicit that this was an edited-and-approved variant if easy).
- `fromInitialGate` → unlock straight to `"sending"` (same as today's `"continue"`).
- `fromBatchPause` → resume to `"sending"` (same as today's `"continue"`/`"switch_subject"` batch-pause branches).

## Why this exact shape matters beyond this task — it's the AI agent's future decision point

Owner's framing (2026-09-13, verbatim intent): this whole feature — draft a subject/body/from tweak, test it for real, judge the result, promote it if it works — is deliberately being built as **the exact spot the future AI agent (Task 31 item 3 / Task 27 Part B) will occupy** once it exists. After N failed/spam attempts on a campaign, the agent should be able to generate its own subject/body/from tweak and call through this SAME mechanism to test and (if good) promote it — no separate "AI version" of this feature, ever.

**What this means concretely for how you build it — non-negotiable, not a nice-to-have:**
- All the actual logic (testing a draft without saving it, judging `landedIn`/`outcome`, front-inserting on promotion) MUST live in the two API routes (`test-send` with the optional draft override, `deliverability-decision`'s new action), never in frontend-only code. The UI in section 3 below is just ONE caller of these two routes — a script, a cron job, or later an actual agent process must be able to drive the exact same flow by calling the same two endpoints with the same request shapes, with zero UI involved.
- Don't require anything from the human-facing UI (e.g., a confirm dialog, a specific button click sequence) to be true for the API calls to work — the routes' request/response contracts are the real interface; the UI is disposable.
- This does NOT mean building any agent logic in this task — there is no AI in Task 32. It means: build the plain, reusable REST surface first (exactly as scoped above), the same discipline that made Task 26 Piece 4's job/campaign creation endpoints trivially reusable by Task 27's agent-mapping table. When the agent is eventually built, dropping it onto this decision point should be a mapping exercise, not new backend work.
- One nuance worth recording for whoever builds the agent later (not something to decide now): the owner's framing implies this SPECIFIC decision (tweaking subject/body/from after a deliverability failure) is a reasonable candidate for the agent to eventually make autonomously, without a human confirmation click — a materially different risk tolerance than the "should this campaign send at all" decision, which stays human-gated per Task 27/31's confirmation-gate design. Don't build that autonomy now; just don't build anything into these two routes that would make it harder to grant later (e.g., don't assume a session/cookie-only caller — these routes already use normal API auth, which is already agent-compatible).

**"until the batch is exceeded for a new smtp"**: no new mechanism needed here — this is already exactly how the batch gate works today (`app/api/internal/mail-queue-drain/route.ts`'s per-campaign batch probe, `batchSize` recipients at a time). Once the new subject/body is appended to the rotation and the campaign resumes, the NEXT batch boundary re-probes exactly as it always does; the newly-added entry just participates in the existing `i % subjects.length` rotation like any other. Don't build anything extra for this — it falls out for free.

## 3. UI

In the 3-way decision box (`app/dashboard/campaigns/[id]/page.tsx`), add a 4th, clearly-secondary option — e.g. a small "Manually edit and test instead" toggle/link (not a fourth big button competing with the other three, since this is the least-common path) that expands into:
- Subject input, From-address select (if item 4's multi-from rotation from Task 30 is live, offer the campaign's configured From addresses; otherwise this field can be omitted for v1), body textarea — pre-filled per section 1 above.
- "Send test with this edit" button → calls the extended test-send route with the draft content, shows the result the same way the existing "Send test message" button already does (latest-check line, landedIn badge).
- Once a check comes back, the SAME 3-way choice reappears but now offers **"Use this edited version — add to rotation and go ahead"** (calls `deliverability-decision` with `action: "add_edit_and_continue"` and the draft content) alongside the existing spam/retry/stop options (which, if chosen, just discard the draft and fall back to the normal automated flow — nothing is promoted unless the user explicitly picks the promote action).

## Explicitly out of scope

- No history/versioning of past manual edits beyond what the `DeliverabilityCheck` audit row already captures.
- No limit on how many manually-added subjects/bodies a campaign can accumulate — same as the existing rotation, which has no cap either.
- This does not change anything about the fully-automated default path — a user who never opens "Manually edit and test" sees no behavior change at all.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Test with a real edited subject/body against a real test mailbox — confirm the probe uses the DRAFT content (not the stored campaign content) and that the campaign's stored `subjects`/`bodies` are untouched until `add_edit_and_continue` is actually clicked.
- Confirm promoting from a legacy pair campaign (empty `subjects`/`bodies`) correctly seeds the array with both the original variant's content and the new edit, not just the new edit alone (so nothing is silently dropped from an existing legacy campaign).
- Confirm the promoted entry lands at index 0 (not appended at the end) and that the very next test-send/batch actually uses it first — verified live, not just by reading the modulo math.
- Confirm both `test-send` (with the draft override) and `deliverability-decision` (with `add_edit_and_continue`) work as plain API calls with no browser/session-specific behavior beyond normal auth — e.g. via curl with the session cookie — since a future non-UI caller (an agent) needs to drive this identically.

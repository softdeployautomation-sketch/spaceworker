# Task 9 — Campaign Automations + Agent Chat Interface

**Status: SUPERSEDED 2026-09-12 — absorbed into `TASK_27_EXE_LICENSING_AND_AUTOMATIONS_AGENT_PLAN.md`'s Part B.** This doc's `CampaignAutomation`/`CampaignAutomationRun` model, trigger modes, hard gate, personal-lead-list source, and run-summary/drill-down design were all correct and are now folded wholesale into Task 27's Part B, reconciled against Task 26's actual shipped models (`SearchJob`/`Lead`/`EmailCampaign`/`EmailQueueItem`) and paired with a concrete AI-agent architecture. **Do not build from this doc directly — read Task 27 Part B instead.** Kept here only as the historical record of where this model originated.

**Original status line below, left unchanged for the record: planning only, nothing in this doc is built yet.** Written 2026-09-08 directly from the user's own description of the end-to-end automation flow. This is the concrete continuation of `PLAN.md`'s Addenda 2, 4, 5, and 6 — read those first; this doc does not re-derive what they already scoped (sender rotation, subject rotation, test-send-confirm, the template system, the Automation tab). It captures the **new** pieces from this request and restates the **hard dependency ordering** Addendum 4 already set, because today's session is literally step 1 of that ordering.

## Dependency ordering (unchanged from PLAN.md Addendum 4 — repeated here because it governs when this doc becomes buildable)

> "Lead extractor needs to work perfectly and senders need to work out perfectly for the campaign template automation to work." — not a soft preference, a stated hard dependency.

1. **Extraction worker solid** — real, in-progress work. Today's session fixed two confirmed bugs found from a live job report ("minimum was 30000, it said done after 16 leads"): `minResults`/`maxResults` were being silently clamped far below what was actually requested (500 / 50 respectively, with zero indication), and DuckDuckGo mode — the default engine — never paginated at all regardless of `pagesPerQuery`, so every query only ever saw page 1's ~25-30 results. Both fixed (`worker/automation.py`, `app/api/jobs/route.ts`, `app/dashboard/extract/page.tsx`), deployed, not yet re-verified against a real large job by the user. **Do not start building anything below until that re-verification happens and looks right** — the automation layer would otherwise be built on top of an extraction engine still being debugged, compounding two layers of bugs at once (Addendum 4's own stated risk).
2. **Mailbox/campaign send flow verified end-to-end** — per `README.md`'s own outstanding-verification list (referenced in Addendum 4, itself dated 2026-09-03): add a mailbox + test SMTP, create a campaign, queue sends, drain, confirm daily caps/jitter actually work against real data. Not confirmed done anywhere in this repo's history — **check this before step 3 below, don't assume it's fine because the code merged.**
3. **Only then**: the automation/template/agent layer described below.

## What's already built (don't re-build, build on top of)

- `Mailbox` — SMTP credentials (encrypted), daily send cap + counter, connection test status.
- `EmailCampaign` + `CampaignVariant` (subject/body pairs) + `EmailQueueItem` (assigns a mailbox AND a variant per recipient at queue-creation time, round-robin) — **this is already the sender-rotation + subject-rotation mechanism** the user described as "just like we have in the plan, for subject and SMTP rotation per sends." It exists in the schema; confirm it's actually wired into a real campaign-creation UI and the drain route before assuming the rotation itself is proven (see dependency step 2).
- `SearchJob.template` (`"lead" | "hr" | "plain"`) — the template-system foundation Addendum 5 called for.
- Test-send-confirm design (Addendum 2 §4) — fully speced (seed mailbox, IMAP poll, manual-confirm default, checkpoint deliverability monitoring as a should-have) but **not yet implemented** per Addendum 4's "no template schema, no `CampaignAutomation` model" closing note.

## New in this request, not yet covered by PLAN.md

### 1. Agent chat interface

"the end goal is to have an agent user can talk to make extractor work and talk to other apps."

A conversational entry point (chat UI, likely its own dashboard tab or a persistent panel) where the user describes what they want in plain language — e.g. "find 2,000 plumber leads in Texas and send them the intro campaign" — and the agent translates that into the underlying tool calls: create a `SearchJob` with the right template/params, then (once extraction finishes) hand off to a `CampaignAutomation` run using a specified or inferred template. "Talk to other apps" signals this shouldn't be architected as a single hardcoded intent-parser for extraction alone — the same agent should eventually be able to drive Mailboxes, Browser Profiles, Campaigns, and whatever future tools land in the Automation tab (Addendum 4's own "extensible, not a single hardcoded view" requirement for the Automation tab applies here too).

**Not scoped further in this doc** — needs its own design pass once steps 1-2 above are done: which model/provider, how tool-calling is wired to the existing internal APIs (`/api/jobs`, `/api/campaigns`, etc. — all already real HTTP endpoints an agent could call), how much autonomy vs. confirmation-gating it gets (the existing Channelry product's "Agent Decider System" — confirmation gates before any content/spend-affecting action executes — is a directly relevant prior pattern from this same account, worth reviewing before designing this one from scratch).

### 2. Automations: daily-scheduled or manually-triggered

"the plan is to be able to set automations that users can either set to run a daily or user can trigger manually and it does all the work."

This is Addendum 4's `CampaignAutomation` record, made concrete with two trigger modes:
- **Manual**: user clicks "Run now" — the automation executes once, immediately.
- **Daily**: the automation reruns on a schedule (once per day) without the user re-triggering it — needs a `scheduleEnabled: Boolean` + `scheduleHour` (or similar) on `CampaignAutomation`, plus a systemd timer (matching this repo's existing convention — the dispatcher and mail-queue-drain already run this way, see `PLAN.md`'s Task 2/4 notes) that checks for automations due to run and enqueues them, rather than a long-lived in-process scheduler.

**Hard gate, confirmed by the user**: an automation cannot run — daily or manual — unless a campaign AND at least one SMTP mailbox are already configured for it. Enforce this at creation time (don't let a user save/schedule an automation missing either), not just at run time.

### 3. Full automation flow, step by step (as described)

1. **Extract** — the automation runs a `SearchJob` using the user's saved Find/Location/etc. parameters for this automation (or, per the personal-leads-entry point below, skips this step entirely if the user supplied their own list).
2. **Campaign template selection** — the user picks from a library of campaign templates (Addendum 4's template system: "a lot of template and campaign flows to come," starting with the one described "mass ads" flow: test-send-confirm + subject/sender rotation). Templates should include both the existing manual "build your own" campaign flow AND fully pre-built "automated templates" a user can select without configuring subject/body/rotation themselves — i.e., two tiers: (a) a from-scratch campaign a user assembles from their own mailboxes/variants, (b) a ready-made template that just needs lead volume + which mailboxes to rotate through.
3. **Send behavior** — exactly Addendum 2 §4 and Addendum 6's already-specced rotation (sender + subject, round-robin across the run).
4. **Test-send-confirm, always** — per this request's explicit "it confirms the email delivers with the first test sending before going ahead always." This reads as a stronger requirement than Addendum 2 §4's original "manual-confirm is the default, but a proven mailbox can skip it in fully-automated mode" — **confirm with the user whether "always" means literally no fully-automated skip option even for a track-recorded mailbox**, since that's a real behavior difference from what's already specced, not an implementation detail to assume either way.
5. **Send** — real campaign send via the existing (once step-2-verified) queue-drain mechanism.
6. **Run summary** — see below.

### 4. Personal leads entry (explicitly not yet built — user's own words: "havent made possible yet")

An automation (or a standalone campaign) should be able to use a **user-supplied lead list** instead of, or in addition to, a fresh extraction. Concretely:
- CSV upload of an existing lead list (email + arbitrary merge-variable columns — same shape Addendum 2 §4 already calls for on the recipient side of a campaign).
- This needs its own ingestion path distinct from `SearchJob`/`Lead` (which are extraction-produced) — likely a new `PersonalLeadList` (or similar) model, or, if the shapes are close enough, an `origin: "extracted" | "uploaded"` discriminator on the existing `Lead`-adjacent recipient model. Decide the exact shape during implementation; not designed further here.
- The run-summary UI (below) needs to reflect which source a given run actually used, since "how many emails extracted" doesn't apply to a personal-list run the same way.

### 5. Run summary + drill-down (new UI surface)

Per the request: "shows how long it took and how many emails extracted and if user added a personal leads entry... and it shows how many emails was sent, and users can see more details, and then shows the final summary."

A completed (or in-progress) automation run needs:
- **Duration** — wall-clock time for the extraction phase, the send phase, and total.
- **Leads extracted** — count, only meaningful for an extraction-sourced run (see personal-leads-entry above).
- **Emails sent** — count, plus (ideally, reusing what `Mailbox`/`EmailQueueItem` already track) a breakdown by mailbox/variant so the rotation is visible, not just a single total.
- **Source indicator** — extracted vs. personal-list, per above.
- **Drill-down / "see more details"** — a detail view per run (likely `/dashboard/automation/[id]` or similar, alongside Addendum 4's Automation tab list view) showing the underlying `SearchJob` (if any) and the `EmailCampaign`/queue items it drove, not just the summary numbers.
- **Final summary** — a completion state shown once the run finishes (in the Automation tab's list, and probably worth a notification given this mirrors Channelry's own "step-by-step progress + completion" pattern already proven on that product).

This needs a `CampaignAutomationRun` (one row per execution of a `CampaignAutomation`, since a daily-scheduled automation has many runs over time) carrying `startedAt`, `extractionCompletedAt`, `completedAt`, `leadsExtracted`, `emailsSent`, `leadSource`, and foreign keys to the `SearchJob`/`EmailCampaign` it drove — distinct from the automation's own configuration record.

## What this doc deliberately does not do

- Does not design the agent's actual model/tool-calling architecture (flagged above as needing its own pass).
- Does not re-litigate Addendum 2 §4's rotation/test-send/checkpoint-monitoring design — that's considered settled, this doc only flags the one place ("always" test-send) where this request's wording may tighten it.
- Does not produce a Prisma schema or API route list — that's the next pass, once dependency steps 1-2 above are actually confirmed done.

## Immediate next step

Re-verify today's extraction fixes against a real job (the same kind of large `minResults` run that surfaced the original bugs), then run through README's outstanding mailbox/campaign end-to-end checklist. Only after both come back clean should this doc turn into a real `TASK_09_CAMPAIGN_AUTOMATION_AND_AGENT_IMPLEMENTATION.md` with an actual schema and route list, following the same discipline every other TASK doc in this repo has used (verify the real current code/behavior before writing the spec, not before).

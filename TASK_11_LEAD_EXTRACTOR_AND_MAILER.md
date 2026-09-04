# Cline Task 11 — Lead Extractor (Search Templates) + Mailer (Subject Rotation)

**Repo**: `/Users/mikeolab/spaceworker`. **Scope**: app code + a small worker-contract decision (see below).

**Design reference**: a Claude Design canvas covers `LeadExtractor.dc.html` (template picker + multi-item search) and `MailerApp.dc.html` (sender + subject rotation). Ask the user for the current canvas link if you don't have it.

Split out from a combined task so it can be picked up independently of `TASK_10_OS_DESKTOP_AND_BROWSER.md` — the two don't share files and can run in parallel with a different person on each. This one is bigger and touches more business logic; read `PLAN.md` Addendum 5 and Addendum 6 in full before starting, they have the confirmed reasoning already worked out — don't re-derive it.

## Lead Extractor — real workflow, not the generic form it has today

Current `app/dashboard/extract/page.tsx` (from Michael's Task 3 PR) is a single fixed form: one query box, engine (DDG/Google), lane (quick/deep), max results. Per the confirmed real product shape (`PLAN.md` Addendum 5), this needs to become:

1. **A template picker**: "Lead Search" (the existing form, relabeled), "HR / Recruiting" (new fields: job titles list, location, experience level), "Plain Search" (one freeform box). Match the design canvas's `LeadExtractor.dc.html` artboard for the visual pattern (a segmented picker at top, conditional rendering of each template's fields in React).
2. **"Find" becomes a multi-item list**, not a single string — a user adds "plumber", then "carpenter", etc., as separate chips, and the job searches across all of them. This is a real change to `SearchJob.params`'s shape (currently likely a flat query string) — check the actual current `POST /api/jobs` request body shape in `app/api/jobs/route.ts` before changing it, and decide whether `params.query` becomes `params.queries: string[]` or a similar shape; keep the worker-side contract in mind (`worker/automation.py`'s `search_phase()` currently expects a single `query` string — this task may need a corresponding small worker change to loop over multiple queries, or the multi-query fan-out could happen at the dispatcher level, queuing one `SearchJob` per term). **Decide and note which approach you took** — this is a real architectural fork, not a trivial UI change.
3. **HR and Plain Search templates need their own automation**, per Addendum 5 — they are explicitly **not** the same DDG/Google lead-extraction engine with relabeled fields. Building the actual HR/Plain automation backends is likely too large for this task alone — if so, ship the UI for all three templates, wire "Lead Search" fully end-to-end (it's the one with a real backend today), and make the other two templates' submit action clearly say "coming soon" rather than silently doing nothing or (worse) running the wrong engine against HR/Plain input. Flag back explicitly if you think the HR backend is small enough to include here — don't guess silently either way.
4. Add a `SearchJob.template` field (`"lead" | "hr" | "plain"`) so this is trackable/extensible from the start, matching Addendum 5's note that this field needs to exist before Addendum 4's campaign-automation work assumes a single-template shape.

## Mailer — sender rotation already exists, subject rotation doesn't

Current `EmailCampaign` (Task 4) has a single `subject`/`bodyHtml` pair. Per `PLAN.md` Addendum 6 (and the original Addendum 2 §4/§5 research it confirms), this needs:

1. **A `CampaignVariant` model** (or similarly named) — a campaign has 2+ subject/body variants, rotating evenly across the send, the same way sender-mailbox rotation already works for `EmailQueueItem`. Addendum 2 §5 has a draft schema sketch (`CampaignVariant: id, campaignId, subject, bodyHtml`) — use it as a starting point, adjust as needed once you're in the real schema.
2. **UI**: match the design canvas's `MailerApp.dc.html` artboard — a "Subject lines (rotates evenly)" section with add/remove chips, mirroring the existing "Sending from (rotates evenly)" mailbox-chip pattern already built for Task 4's multi-mailbox selection.
3. **The send/drain logic** (`app/api/internal/mail-queue-drain/route.ts` or wherever the actual send loop lives) needs to pick a variant per recipient the same way it currently picks a mailbox — round-robin or random, matching whatever rotation strategy the existing sender-rotation code already uses, for consistency.

## Explicitly not this task

- Campaign-template automation (Addendum 4) — still blocked on Task 9 (mailbox/campaign E2E verification) being done first, per the plan's own stated sequencing. Don't start building the "mass ads" template flow here.
- Spintax, open-rate-driven A/B — explicitly deferred in Addendum 2's priority tiers, not in scope.
- The desktop/dock shell and Browser app — that's `TASK_10_OS_DESKTOP_AND_BROWSER.md`, a separate task.

## Verification

1. Create a Lead Search with 2+ "Find" terms, confirm the job actually searches for all of them (check the real leads that come back reference multiple different terms, not just the first one).
2. Confirm HR and Plain Search templates render their own distinct fields and either work end-to-end or clearly say "coming soon" — no silent no-ops.
3. Create a campaign with 2+ subject lines and 2+ senders, run a real small send, confirm both subject and sender actually rotate across the recipients (check the sent messages/logs, don't just trust the UI state).

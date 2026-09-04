# Cline Task 11 — Lead Extractor Search Templates

**Repo**: `/Users/mikeolab/spaceworker`. **Scope**: app code + a small worker-contract decision.

**Design reference**: a Claude Design canvas covers `LeadExtractor.dc.html` (template picker + multi-item search). Ask the user for the current canvas link if you don't have it.

Independent of `TASK_10_OS_DESKTOP_AND_BROWSER.md` and `TASK_12_MAILER_REWRITE.md` — no shared files, can run in parallel with a different person on each. Read `PLAN.md` Addendum 5 in full before starting — it has the confirmed reasoning already worked out, don't re-derive it.

## Real workflow, not the generic form it has today

Current `app/dashboard/extract/page.tsx` (from Michael's Task 3 PR) is a single fixed form: one query box, engine (DDG/Google), lane (quick/deep), max results. Per the confirmed real product shape (`PLAN.md` Addendum 5), this needs to become:

1. **A template picker**: "Lead Search" (the existing form, relabeled), "HR / Recruiting" (new fields: job titles list, location, experience level), "Plain Search" (one freeform box). Match the design canvas's `LeadExtractor.dc.html` artboard for the visual pattern (a segmented picker at top, conditional rendering of each template's fields in React).
2. **"Find" becomes a multi-item list**, not a single string — a user adds "plumber", then "carpenter", etc., as separate chips, and the job searches across all of them. This is a real change to `SearchJob.params`'s shape (currently likely a flat query string) — check the actual current `POST /api/jobs` request body shape in `app/api/jobs/route.ts` before changing it, and decide whether `params.query` becomes `params.queries: string[]` or a similar shape; keep the worker-side contract in mind (`worker/automation.py`'s `search_phase()` currently expects a single `query` string — this task may need a corresponding small worker change to loop over multiple queries, or the multi-query fan-out could happen at the dispatcher level, queuing one `SearchJob` per term). **Decide and note which approach you took** — this is a real architectural fork, not a trivial UI change.
3. **HR and Plain Search templates need their own automation**, per Addendum 5 — they are explicitly **not** the same DDG/Google lead-extraction engine with relabeled fields. Building the actual HR/Plain automation backends is likely too large for this task alone — if so, ship the UI for all three templates, wire "Lead Search" fully end-to-end (it's the one with a real backend today), and make the other two templates' submit action clearly say "coming soon" rather than silently doing nothing or (worse) running the wrong engine against HR/Plain input. Flag back explicitly if you think the HR backend is small enough to include here — don't guess silently either way.
4. Add a `SearchJob.template` field (`"lead" | "hr" | "plain"`) so this is trackable/extensible from the start, matching Addendum 5's note that this field needs to exist before Addendum 4's campaign-automation work assumes a single-template shape.

## Explicitly not this task

- Mailer rewrite (CSV recipients, sender/subject rotation, test-send-confirm) — that's `TASK_12_MAILER_REWRITE.md`, a separate task.
- Campaign-template automation (Addendum 4) — still blocked on Task 9 (mailbox/campaign E2E verification) being done first, per the plan's own stated sequencing.
- The desktop/dock shell and Browser app — that's `TASK_10_OS_DESKTOP_AND_BROWSER.md`.

## Verification

1. Create a Lead Search with 2+ "Find" terms, confirm the job actually searches for all of them (check the real leads that come back reference multiple different terms, not just the first one).
2. Confirm HR and Plain Search templates render their own distinct fields and either work end-to-end or clearly say "coming soon" — no silent no-ops.

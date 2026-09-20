# Task 54 — Domain filter on lead export

**Status: ready to build. Owner-requested 2026-09-21.**

## What's requested

A user finishes a run (or is looking at any existing `SearchJob`'s leads) and wants to keep only the leads whose email/website matches specific domains they pick — e.g. a run mixed `gmail.com`, `yahoo.com`, and a dozen real company domains, and the user only wants the company ones (or only wants a handful of specific ones) for this export.

Owner's exact framing: "add a domain filter to the exporting, like maybe a user wants a certain domain from the leads generated, he can select the domains he wants, and verify, and that replaces the leads, or maybe create a new run session to avoid loossing the others."

## Open product decision — do NOT guess, confirm with the owner before building

The owner floated two different outcomes for the SAME filter action and didn't pick one:

1. **Replace in place** — the filter narrows the CURRENT `SearchJob`'s leads (destructive: the excluded leads are gone from that job, presumably `deleteMany` on the non-matching `Lead` rows, or an update marking them excluded).
2. **Fork into a new run session** — the filter creates a NEW `SearchJob` (copy) containing only the matching leads, leaving the original job's full lead set untouched.

These have very different implementations and very different risk profiles (#1 is destructive and needs a real confirm step; #2 is non-destructive but adds a job-picker/naming step and duplicates rows). Ask the owner which one (or both, as two distinct buttons — e.g. "Filter this run" vs "Save as new run") before writing code. Given the "to avoid loosing the others" phrasing, the owner is already leaning toward wanting the NON-destructive option available at minimum, possibly as the default.

## Where this plugs in

- **Web**: `app/dashboard/extract/page.tsx` — the export buttons already live at the job-detail panel (`Export CSV` / `Emails only`, ~line 1407, pointing at `GET /api/jobs/[id]/export.csv`). A domain-filter step is a natural third control here: pick domains (probably a multi-select populated from the DISTINCT domains actually present in that job's leads, not a freeform guess) → "Verify" (show a live count: "N of M leads match") → then either export directly with the filter applied, or commit to option 1/2 above.
- **EXE**: `app/dashboard/extract/local-extract.tsx` has its own parallel leads table + result-mode selector (`namesEmails`/`emailsOnly`/`full`) per run, built earlier this session (2026-09-20) — same filter control needs to exist there too, operating on the EXE's local JSONL-backed leads (`app/api/exe/extract/storage.ts`), not Postgres.
- **Export route**: `app/api/jobs/[id]/export.csv/route.ts` currently takes only `?emailsOnly=1`. Extend it to accept `?domains=a.com,b.com` (or a POST body if the domain list could get long) and filter `leads` by `website`/`email` domain membership before building the CSV — this is the filter's actual enforcement point regardless of which product decision (1 vs 2) gets picked for the "verify and commit" UI step above.
- Extracting "the domain" from a lead: reuse whatever the codebase already uses for this (`extractRootDomain`, referenced this session in `local-engine/src/filters/webmail-platforms.ts` and the advanced-search code) rather than writing a second, possibly-inconsistent domain-parsing implementation.

## Suggested shape (not final — depends on the open decision above)

1. Add a "Filter by domain" control near the export buttons: fetch/derive the distinct set of domains present in the job's leads (small, bounded list per job — safe to compute in the same request as the job detail load, or a small dedicated endpoint).
2. Multi-select checkboxes (or chips, matching the Advanced Search domain-filter chip UI already built this session) for which domains to KEEP.
3. A "Verify" step shows the resulting count before committing to anything irreversible.
4. Depending on the owner's answer to the open decision:
   - Non-destructive: a "Save as new run" action creates a new `SearchJob` (same `userId`, a query label like `"<original query> (filtered)"`, `status: "done"`, `workerJobId: null` — same modeling `app/api/advanced-search/verify/route.ts` already uses for a "results already exist, nothing to run" job) plus `Lead.createMany` for just the matching rows.
   - Destructive: a confirm-gated action that deletes the non-matching `Lead` rows from the existing job — must use the app's existing confirm-dialog pattern (`useConfirm()`, already used elsewhere in this codebase, e.g. admin-panel.tsx's delete actions), never a silent action.
   - Or just ship the filter as an EXPORT-time-only parameter (no DB mutation at all — the simplest, lowest-risk version): the domain filter only affects what's IN the downloaded CSV, the underlying job/leads are never touched either way. This sidesteps the whole "replace vs new session" question entirely and may be all the owner actually needs — worth proposing back to them as the fast, safe default before building either of the DB-mutating options.

## Verification expected

- Export a job's CSV with a domain filter applied — confirm only matching-domain leads appear, header intact, RFC 4180 quoting still correct (reuses `lib/csv.ts`, unchanged).
- If a DB-mutating option ships: confirm ownership scoping (`userId` match) is preserved exactly like every other job/lead route in this file, and that the destructive path is genuinely gated behind a real confirm dialog, not a bare button.
- Test in both web and EXE builds — this session's EXE work (Advanced Search, Buy tab, password sign-in) all needed a fresh `gh workflow run "Build EXE"` + reinstall cycle before the new UI was actually testable on Windows; budget for that same cycle here (see `HOW_WE_MOVE_FAST.md` in the repo root for the exact commands).

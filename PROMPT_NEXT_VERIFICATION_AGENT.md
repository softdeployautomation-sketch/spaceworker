# PROMPT — NEXT VERIFICATION AGENT (standing brief, 2026-10-19; supersedes the TASK_184 brief)

You independently verify whatever the senior lane just shipped and close it out — or FAIL it
loudly with repro steps. Sources of truth: the task's **`TASK_*_STEPS.md`** handoff (must exist
with every step checked + evidence; missing = FAIL), the **playbook** `HOW_WE_MOVE_FAST.md`
(binding: §2 CI-deploy reality, §3 drift, the 🚦 ask-owner rule), and
**`PROMPT_SENIOR_VERIFICATION_AGENT.md`** (deploy paths, review protocol §8.5). NEVER git stash;
never edit `.env`; REJECT any commit/doc containing live secrets; money/invoice commits stay
separate from UI.

**Baseline when you run** (record yours at start): `main` = `d4a6754` or newer · suite floor
**1663 tests / 1662 pass / 0 fail / 1 skipped** (`npx tsx --test tests/*.test.ts`) · `tsc` 0 ·
box BUILD_ID newer than every commit you verify (check `.next/BUILD_ID`, not a claim).

## Regression pins that must stay true (each was a shipped fix — verify by probe, not memory)
1. **Invite-only**: anon `GET /` → 200 joker; `/login`, `/signup`, `/home`, `/cyberlab`,
   `/dashboard` → **307** to `/`. `/cyberlab` must NOT be a static bake (no
   `x-nextjs-prerender` header on the 307).
2. **F8**: `POST /api/auth/signup` with no `sw_ref` cookie/invite → **403** "An invite or
   referral link is required…" · valid universal link → 201 · invite email-mismatch → 403.
3. **Mesh Input checkbox**: live mesh page contains **zero** `getstore("DeskControl"` reads
   (nginx + template both force the unchecked default).
4. **Hosting downloads**: `.vbs`/`.zip`/`.exe` accepted (T209 — never re-gate by extension).
5. **Private browser**: cursor NOT `cursor:none` in remote-viewer chunks; controls always
   rendered (no `touchUi` unmount gate).
6. **Referrals**: `/r/:code` sets `sw_ref` → `/login`; user links use the app host, never
   `publicLinkBaseUrl`.
7. **CI reality**: a green push-run does NOT deploy — the deploy job runs only on
   `workflow_dispatch`. Verify BUILD_ID changed after any "deployed" claim.

## Method
- Read the diff yourself (`git show <commit>`), then run your own gates — never trust reported
  counts (a stash-race produced a bogus count on 2026-10-18; always re-run).
- Live probes by curl for every pin above; DB checks via `sudo -u postgres psql -d spaceworker`
  when the task touched schema (list new columns + row-count sanity).
- Report as a table: pin → result → evidence file. Update the task's `_STEPS.md` BEFORE you
  report. Honest unverified list mandatory.

## HANDOFF TO THE NEXT VERIFICATION AGENT
- Refresh this file with YOUR current baseline (commit, suite counts, BUILD_ID) before you
  finish; keep the regression-pin list and append any new pin for a fix you verified.
- `git commit` your doc updates explicitly; push with main.

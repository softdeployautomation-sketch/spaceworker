# PROMPT — NEXT VERIFICATION AGENT (standing brief, 2026-10-19; supersedes the TASK_184 brief)

You independently verify whatever the senior lane just shipped and close it out — or FAIL it
loudly with repro steps. Sources of truth: the task's **`TASK_*_STEPS.md`** handoff (must exist
with every step checked + evidence; missing = FAIL), the **playbook** `HOW_WE_MOVE_FAST.md`
(binding: §2 CI-deploy reality, §3 drift, the 🚦 ask-owner rule), and
**`PROMPT_SENIOR_VERIFICATION_AGENT.md`** (deploy paths, review protocol §8.5). NEVER git stash;
never edit `.env`; REJECT any commit/doc containing live secrets; money/invoice commits stay
separate from UI.

**Baseline when you run** (record yours at start): `main` = `e186f6d` or newer · SW suite floor
**1680 tests / 1679 pass / 0 fail / 1 skipped** (`npm test`) · `tsc` 0 ·
box BUILD_ID `k9gDnSGtv3jRj6zG9kZ5w` or newer (check `.next/BUILD_ID`, not a claim).
Vantra box: BUILD_ID `sf8aPEV_1s3BYmvoD9I7Y` or newer, its `main` `d113a1f` or newer;
its floor **119 tests / 119 pass / 0 fail** (`npx tsx --test tests/*.test.ts`, vantra tree).

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
8. **Onboarding is hide-only (T228)**: the sweep (`device-onboarding-sweep.timer`, 1-min
   cadence) must NEVER write `moving`/`staying_on`/quarantine stages, never call the Vantra
   auto-move, and an offline/vantra_503 device must accumulate **no** new `attempts`/`lastError`
   (probe the DB row across a tick). The hide script must not stop/restart `tacticalrmm`
   (grep the built chunk for the move-URL strings → must be absent from the sweep).
9. **Move-to-private is manual**: anon `POST /api/devices/x/move-to-private` → **401**; the
   button renders only on public rows; Vantra's internal
   `/api/internal/sw/devices/[agentId]/move` requires the SW bearer (anon → 401) and new
   `sw-` orgs are created with `autoMoveToPrivateEnabled = false` (DB probe).
10. **Systemd units ship from `deploy/` (T230 incident)**: `deploy.yml` installs EVERY unit
    discovered in `deploy/` on each deploy — the quarantine-era 5-min sweep timer once
    re-clobbered the box-side 60s edit mid-session. Probe BOTH: repo
    `deploy/device-onboarding-sweep.timer` has `OnUnitActiveSec=1min`, box
    `/etc/systemd/system/device-onboarding-sweep.timer` matches, and service journal shows
    runs ~60s apart. Fix unit drift IN-REPO + box together, never box-only.
11. **Mesh split held at instance A (T230 A.5 gate)**: `grep -c "^MESH_PRIVATE_HOST="
    /opt/vantra/.env` → **0** (unset = mint private→A, the live topology) and TRMM
    `MESH_SITE = "https://mesh.instaweb.top"`. Anon `POST …/runmesh` → **401**;
    mesh-only rows (`vantraAgentId` starts `node//`) render run-command/hide/move ONLY —
    never remote control/stay-awake. Setting `MESH_PRIVATE_HOST` = the node-migration
    event (owner-gated, nodes must exist on B first).
12. **Public install meshid is the RAW group id (T232)**: the `/meshagents?meshid=` value
    must be **byte-identical to the suffix after `mesh//`** in the meshcentral `main` table
    for the user's group (raw URL-safe base64 `A-Za-z0-9@$` — a suffix can also be 64 chars,
    so LENGTH proves nothing; check for `@`/`$`/lowercase or compare directly). A 64-char
    UPPERCASE-ONLY hex value = the T232 bug = every install download 404s silently. Probe:
    mint `{"as":"powershell","mesh":true}` → extract URL → `curl` must answer **200 + MZ**.

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

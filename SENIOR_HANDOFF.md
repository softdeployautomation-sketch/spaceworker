# SENIOR HANDOFF — SpaceWorker

**Owner:** Mike (`mikeolab`). **This file is the single source of truth for "what is the
state of SpaceWorker and what happens next."** If anything below disagrees with another
document, this one wins, and the other document gets fixed in the same commit.

---

## 0. How to use this file (read this first — it is binding)

**If you are the engineer taking over:** read sections 1–5 once to understand the system,
then section 6 for live state, then section 7 for what to do next. Do the work. Then
**update this file before you finish** — §10 tells you exactly what to update. The whole
point is that the next engineer can be handed the *same prompt* you were handed and be
useful immediately.

**Rules of this document:**

1. **It is append-and-revise, never rewrite.** §6 (Current state) and §7 (Queue) get
   revised in place. §9 (Log) is append-only — never edit or reorder an entry.
2. **Only write here what you verified.** Every claim in §6 must be something you saw
   with a command in this session. Unverified → say unverified.
3. **Do not branch this doc.** Other task docs (`TASK_*.md`) hold the *deep* detail for
   one piece of work. This file holds the *state* and *what's next*, and links out.
4. **Every claim needs a `file:line`, a command, or raw output.** "Should work" is not a
   status.
5. **If you change the deploy pipeline, the branch layout, or a shared convention, update
   §2–§5 immediately.** Those sections are what stop the next engineer repeating a
   mistake that already cost hours.

---

## 1. What SpaceWorker is

A hosted SaaS on one VPS (`164.68.105.96`, `/opt/spaceworker`) that does three things,
plus a desktop product line:

| Pillar | What it does | Lives in |
|---|---|---|
| **Outreach** | Lead extraction → validation → campaigns over the user's own SMTP mailboxes | `app/dashboard/extract`, `app/dashboard/campaigns`, `app/dashboard/mailboxes`, `worker/` (Python), `lib/mail-queue-drain` |
| **Device fleet** | RMM-style device management: remote console, screen monitoring, browser clones | `app/dashboard/devices`, `app/console/[deviceId]`, `browser-capture/`, `browser-server/` |
| **Agent** | AI assistant with platform context, metered per user | `app/api/agent`, `app/api/assistant`, `lib/agent.ts` |

**Two satellite systems it depends on:**

- **Vantra** (MeshCentral-derived RMM) — separate repo AND separate server. SpaceWorker
  talks to it over HTTP with a shared bearer (`VANTRA_INTERNAL_TOKEN`) via
  `lib/vantra-link.ts`; `VANTRA_URL` resolves to `127.0.0.1:3300` on the VPS. Device
  online/offline/idle telemetry comes from here. **Never assume SpaceWorker owns device
  truth** — for online/idle it is a pass-through.
- **Windows EXE / Linux builds** — Tauri desktop product line, built by
  `.github/workflows/build-exe.yml`. Versioned and licensed separately.

**Stack:** Next.js 16.2.9 (App Router, Turbopack) · React 19.2.4 · Prisma 6 ·
PostgreSQL 18 (VPS) · systemd timers for all background work · Playwright/Chromium for
captures and clones.

## 2. Where things run

Everything is one VPS. There is no staging environment — **production is the only
deployed environment**, which is why §5's traps matter.

**Long-running services:**

| Unit | Role |
|---|---|
| `spaceworker.service` | The Next.js app (the product) |
| `spaceworker-browser.service` | Interactive browser subsystem (clones/live sessions) |
| `screenshot-capture.service` | Headless Chromium that takes device screen captures |
| `extraction-worker.service` | Python FastAPI worker, bound to `127.0.0.1:8001` |
| `exit-node-us1/us2.service` | ProtonVPN WireGuard exit proxies for sending IP diversity |

**Timers (each drives a paired `.service`):** `dispatcher` (10s, extraction queue) ·
`mail-queue-drain` (60s, campaign sending) · `screenshot-sweep` (60s) ·
`screen-notify-sweep` (5min, monitoring alerts) · `payment-verify` (5min) ·
`automations-sweep` · `digest-sweep` · `governor-sweep` · `clone-sweep` ·
`device-onboarding-sweep` · `device-status-sweep`.

**Units are declared in `deploy/`.** The deploy discovers and installs them from there —
so **adding a unit to `deploy/` is all it takes** to ship it. (That was not always true;
the pipeline used to hardcode a list and silently skipped new units — see §5 trap 9.)
`deploy/nginx-spaceworker.conf` is the reverse proxy config (`spaceworker.top`).

**Env vars:** live in `/opt/spaceworker/.env` (never print values, never edit remotely
except by explicit instruction). Names are listed in the VPS block in §6.

## 3. Repo, branch and worktree layout — get this wrong and you lose hours

**This is one repository with two long-lived branches, and they are checked out as two
separate directories.** It is the single biggest source of expensive mistakes.

```
/Users/mikeolab/spaceworker      branch: main                <- THE LIVE APP
/Users/mikeolab/sw-selfhost      branch: self-hosted-build   <- a git WORKTREE of the same repo
/Users/mikeolab/vantra           SEPARATE repo (RMM/MeshCentral fork)
```

| | `main` | `self-hosted-build` |
|---|---|---|
| Meaning | The deployed product | The upcoming Windows-EXE + Linux product line (licence system) |
| Checked out at | `/Users/mikeolab/spaceworker` | `/Users/mikeolab/sw-selfhost` |
| Deploys to production? | **Yes** | No |
| Its own task docs | `TASK_150`–`TASK_154` | `TASK_145_SELF_HOSTED_LICENSE_{SENIOR,JUNIOR}_TRACK.md` |

**Three hard rules that follow from this:**

1. **A push to `self-hosted-build` must always be an explicit refspec:**
   `git push origin self-hosted-build:self-hosted-build`. A bare `git push` from that
   worktree was once configured to track `main`, which would have pushed the whole
   unreleased product line at production. Before every push from the worktree, run
   `git config --get branch.self-hosted-build.merge` and confirm it reads
   `refs/heads/self-hosted-build`.
2. **`/Users/mikeolab/sw-selfhost/.env` is a SYMLINK to the live app's `.env`.** Editing
   `.env` from the worktree silently edits production's config, and it is gitignored, so
   `git status` shows nothing. **Never edit `.env` from either tree.**
3. **The worktree's `node_modules` must be a real directory, never a symlink into
   `spaceworker/`.** A symlink lets `prisma generate` in the worktree overwrite the LIVE
   app's generated Prisma client, breaking `main`'s typecheck. It also trips a Turbopack
   panic (`next.config.ts` pins `turbopack.root = __dirname`). Verify with
   `ls -ld /Users/mikeolab/sw-selfhost/node_modules` — if it starts with `l`, fix it:
   `rm -f node_modules && cp -Rc /Users/mikeolab/spaceworker/node_modules ./node_modules`.

**Remotes:** `origin` = `github.com/softdeployautomation-sketch/spaceworker.git` — this is
the real one, and the one GitHub Actions reads. `michael-fork` is a **dead URL**
(`Repository not found`); ignore it, never push to it.

**Commit identity:** use the repo's existing one so history stays uniform:
`git -c user.name='MikeOlab' -c user.email='mikeolab@MacBook-Pro.local' commit …`

## 4. Rules of engagement

**Scope and staging**

- Work in the tree that matches the work. Live-app fixes → `/Users/mikeolab/spaceworker`
  on `main`. The self-hosted product line → `/Users/mikeolab/sw-selfhost`.
- **Stage only your own files, by explicit path.** Never `git add -A`, never `git add .`.
  There are frequently other agents' uncommitted changes in these trees; committing them
  is how you break someone else's work — and once nearly broke `main` by shipping a
  tracked file whose untracked dependency was left behind (§5 trap 8).
- If another agent's uncommitted change blocks you, **stop and report** — do not work on
  top of it.

**Schema and data**

- Schema changes must be **additive and nullable-safe**, and ship as a migration in
  `prisma/migrations/`. Never edit or rename a migration the live DB has already applied
  (it is recorded by name *and* checksum).
- Never run `prisma migrate` / `db push` against a shared or live database. Use a scratch
  DB; confirm the target first with `grep '^DATABASE_URL' .env`; drop it when done.
- **Never delete rows to make a count look right.** Mark, do not destroy — lead and queue
  rows are referenced by campaigns and exports.

**Background jobs**

- `countCapturing` / the `deviceScreenshots` slot in `lib/resource-governor.ts` is the
  **single admission authority**. Never add a parallel counter.
- Never bypass the AI metering in `lib/agent.ts`.
- A launch-time or runtime **licence** check must fail open (an offline customer must not
  be locked out). A check about **observed state** (device idle/online) must NOT fail open
  — absent evidence is not evidence of activity. Different domains, opposite defaults;
  get the direction right.

**Reading the codebase**

- `src-tauri/target/` is **gitignored build output containing stale copies of app
  source**. A repo-wide `grep` matches files that look authoritative and are not. Only
  `app/`, `lib/`, `components/`, `prisma/`, `tests/`, `browser-capture/`, `worker/`,
  `deploy/`, `scripts/` are real.
- `browser-capture/` must **never import from `lib/`** — several `lib/` modules import
  `"server-only"`, which throws in a plain Node process (that directory runs on the VPS
  as its own service).

**Evidence**

- Raw output only: rows, HTTP status + body, counts, `systemctl` output, DOM text,
  screenshots. Before **and** after. No "works as expected", no invented numbers.
- **Create the failing condition first.** If you did not watch it fail, you cannot claim
  a fix.
- A check that cannot fail is not evidence. Show the guard firing.
- Label simulations as **SIMULATION**. Never write "verified live" for something you
  simulated — that is the one failure mode that poisons every later decision.
- State explicitly what you could **not** verify. An honest gap is fine.



## 5. Known traps — each one already cost someone hours

Do not treat these as advice. Each was hit, diagnosed, and paid for. If you find a new
one, add it here in the same session you find it.

**1. PostgreSQL error codes differ between the VPS and this workstation — a check can pass
locally and be dead code in production.** The VPS runs **PostgreSQL 18**, which raises
SQLSTATE **23001** for an `ON DELETE RESTRICT` FK violation. Prisma does **not** map 23001
to a P-code, so it arrives as `PrismaClientUnknownRequestError` with no `.code`. This
workstation's **PG 16** raises 23503, which *is* mapped to **P2003**. So a route guarded
with `err.code === "P2003"` **never fires in production** — verified live: a mailbox delete
returned a bare **HTTP 500** on the VPS while every local test passed. **Never branch on a
single Prisma P-code for a constraint you care about.** Detect by shape
(`lib/prisma-fk-error.ts` is the precedent) or match the SQLSTATE too.

**2. `skipDuplicates` does NOT dedupe rows whose `sourceUrl` is NULL.** SQL treats every
NULL as distinct, so the unique constraint cannot collapse them. Documented in
`app/api/leads/upload/route.ts:91-100`. Any dedupe must compare values explicitly, not
lean on the index.

**3. Tests are never run by CI.** `package.json` has ~25 `test:*` scripts and **no
workflow runs any of them**. `deploy.yml` runs `npx tsc --noEmit` and `npm run build`;
`build-exe.yml` runs `npm ci`, `prisma generate`, `tauri-action`. So **a broken test suite
will typecheck, build and ship**. Run the relevant `test:*` scripts yourself; treat a green
CI run as "it compiles", nothing more.

**4. `src-tauri/target/` contains stale copies of app source.** A repo-wide grep for a
symbol returns hits in files that look live and are not (one probe returned 4 hits where
only 1 was real). Restrict greps to the real directories listed in §4.

**5. A tracked file can import an untracked one, and only *this* tree builds.** `main` was
found in a state where `lib/deliverability.ts` (tracked) imported `lib/test-merge-vars.ts`
(**untracked**). `git status` looked like normal WIP; CI and every other checkout would
have failed to build. **When you see a modified tracked file, check whether its new
imports resolve in `git show HEAD:`.** Commit the file and its new dependencies together,
or not at all.

**6. `prisma generate` in the worktree overwrites the LIVE app's client** — see §3 rule 3.
Symptom: `main`'s `npx tsc --noEmit` starts failing with missing model fields that exist
in the schema.

**7. `next build` fails locally unless `CI=1`.** `lib/env.ts` guards against placeholder
secrets and throws on `SESSION_SECRET` / `RESEND_API_KEY` when they look like dev stubs.
That is by design. **Do not "fix" it by putting real secrets in `.env`** — run
`CI=1 npx next build`.

**8. `next start` cannot boot from this workstation's `.env`** for the same reason. Pass
throwaway overrides on the command line only. Never edit `.env`.

**9. The deploy used to hardcode its systemd unit list and silently ship dead features.**
`deploy.yml` named four units literally and its verification ended in `|| true`, so M5's
`screen-notify-sweep.timer` was deployed with **no timer invoking it** and nothing
reported the gap (fixed in `06a5eeb` — units are now discovered from `deploy/` and the
check exits non-zero on a miss). **Lesson that outlives the fix: a verification step that
cannot fail is not a verification step.**

**10. GitHub's Actions UI can hide a commit.** When a run's title falls back to the
workflow name (`Build & Deploy`), the commit does not appear under its subject in the run
list — an agent reasonably concluded a commit was missing when it was on `origin/main` all
along. **Confirm with `git merge-base --is-ancestor <sha> origin/main`, never by scanning
the UI.**

**11. The local `spaceworker` dev database is roughly 74 migrations behind** and cannot
even render `/dashboard` (`Mailbox.sendRegion`, `User.premiumExpiresAt` missing). Do not
conclude from that that the app is broken. Build a scratch DB from `schema.prisma` with
`prisma db push --skip-generate` for any UI or query verification.

**12. Device online/idle truth lives in Vantra, not here.** SpaceWorker is a pass-through
(`lib/vantra-link.ts` → `127.0.0.1:3300`). Diagnosing a device-status problem entirely in
this repo will miss it — and the mesh read can time out (15s socket ceiling) under load,
which is a real failure mode.

**13. There are two remotes and one is dead.** See §3.

**14. §6 can be wrong about the current HEAD, and §6.5 can be stale.** Found 2026-10-01:
§6.1 named HEAD as `77f60f7` when `main` was actually `aa533cd` — `77f60f7` is `aa533cd`'s
*ancestor*, i.e. the doc recorded a commit that had already been superseded and effectively
named its own parent. §6.5 recorded the self-hosted worktree as **DIRTY** @ `163c1a1` with
`setup-wizard.tsx` in flight; it was actually **clean** @ `f6b6f78` (that agent had finished
T10). Both claims were plausible and both were wrong. **Do not act on §6 — checking out a SHA,
avoiding a "dirty" worktree, assuming the deploy matches HEAD — without re-deriving it:
`git rev-parse HEAD`, `git status --porcelain`, and the live `BUILD_ID`/run id.** §6 is a claim
to verify, not a fact to trust (§10 item 1).

**15. A deploy's restart window makes a 5-minute systemd oneshot report `failed` — a false
alarm.** Several `deploy/` oneshots (`device-onboarding-sweep`, `automations-sweep`, …) run
every 5 min and `curl` the app on `localhost:3500`. If a tick lands in the deploy's
`stop → extract → migrate → start` window, `curl` exits **7 (connection refused)** and the unit
shows **failed** in `systemctl --failed` / `systemctl status`. Observed 2026-10-01 (the N1+N2
deploy): `device-onboarding-sweep.service` failed **once** at 15:25:39 (journal: every prior
tick `{"ok":true,...}`; `Main PID ... status=7/NOTRUNNING`), then **self-healed** at the next
tick 15:30:40 (`status=0/SUCCESS`) and `--failed` returned empty. **Do not read a post-deploy
oneshot failure as your change breaking production** — check the journal timestamp against the
deploy window and re-check after the next tick. Only a unit still failing after a clean tick is
a real defect.

**16. A plan's `§SCHEMA` section is a *draft*, not the database.** `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`
§SCHEMA lists `LabScenario` / `LabRange` / `LabEpisode` / `LabFinding` / `DetectionPack` /
`LabConsent` and an `AgentPendingAction` kind `"lab-action"` in a list headed *"reserved seams,
shared by EVERYTHING device-side"* — which reads as "these exist, consume them". Measured
2026-10-01: `grep '^model Lab' prisma/schema.prisma` returns **nothing**, and only
`"browser-clone"` exists as an `AgentPendingAction` kind. The *device* seams in the same list
(`DeviceJob`, `DeviceAudit`, `AgentActionAudit`, `UserEntitlement`, the panic switch in
`app/api/devices/panic/route.ts`, `lib/resource-governor.ts`) **are** real — so a reader cannot
tell the built ones from the aspirational ones by reading the plan. **Before a task doc says
"reuse X", grep for X.** Same class of error as trap 14 (a document describing a system that
has moved on), one level deeper.

## 6. Current state — revise this block every session

**Last verified: 2026-10-01 (later session — the **screen-capture failure-message fix** was deployed and verified live; **§6.1 was stale again (trap 14)** and is corrected below. This session also added two scoping docs (Tasks 155/156); **no app code changed**.)**

### 6.1 Live app — `main`

| | |
|---|---|
| Branch / HEAD | `main` @ the current tip (run `git log --oneline -1`). The last **code** commits are **`e342578`** (TASK_154 N2) and `a64c702` (N1); **everything above `e342578` is documentation-only** and changes no behaviour. *(An earlier pass recorded HEAD as `77f60f7` — an ancestor of `aa533cd`; the doc named its own parent. Corrected 2026-10-01, §12.)* |
| Sync | in sync with `origin/main`; working tree **clean** |
| Deployed to production | **Live build is `iyIlFSwZhjQ_1Rap4MFWC`, `BUILD_ID` mtime `2026-10-01 16:19:43 CEST` — deployed from `main` @ `3d484af` (the screen-capture failure-message fix, `61f6a9e` + `3d484af`). TASK_154 N1+N2 shipped in the previous build `4-aARmhO-lJKtaX2Lx-9y` and are still present.** Verified live (not assumed): the improved capture-failure copy is in the shipped chunks (`grep -rl "capture service" /opt/spaceworker/.next/static` → 2 chunks), and §12 of the earlier entry's N1/N2 evidence still holds (that build also returned the top-level `idle:{state,asOf}` object and shipped the string `"activity unknown"`). |
| Deploy run | **`36875156299`** (`workflow_dispatch` @ `3d484af`, `conclusion=success`) — the deploy that shipped the capture-failure fix. *One earlier dispatch the same hour **failed**: `36873911731`, “Process completed with exit code 255” — a transient SSH failure to the VPS; the re-dispatch succeeded. A failed dispatch is not necessarily a broken build.* |
| CI on current HEAD | push run for `3d484af` and the docs-only commits above it: `Build & typecheck` = **success**, `Deploy to production (manual only)` = **skipped** (the deploy job is `workflow_dispatch`-gated; a push only runs build/typecheck) |
| Migrations applied | **No pending migrations in this deploy** — `git diff --name-only 06a5eeb HEAD -- prisma/` = **0** (N1/N2 are pure code). `_prisma_migrations` unchanged; `ScreenshotRotationCursor` still exists. |

### 6.2 What the deploy contained (verified live, not assumed)

*Describes the **deployed** build `iyIlFSwZhjQ_1Rap4MFWC` (`main` @ `3d484af`), which is the
previous build `4-aARmhO-lJKtaX2Lx-9y` (N1+N2) **plus the screen-capture failure-message fix**.*

- **Screen-capture failure messages (this deploy)** — `61f6a9e` + `3d484af`. Every capture
  failure reason is reduced to **one plain sentence, never a raw dump**; the Connect control is
  never clickable while disabled; `browser-capture/capture.ts` classifies failures
  (`tests/screen-capture-failure.test.ts` added, `tests/screen-timeline.test.ts` extended).
  Deploy also gained a remote step (+11 lines in `deploy.yml`). **Verified live:** the copy is in
  the shipped chunks and the build mtime is `2026-10-01 16:19:43 CEST`.

- **TASK_154 N1+N2 (this deploy)** — device idle provenance + the client idle latch. Server
  (N1): `/api/devices` carries a top-level `idle:{asOf,state}` object alongside the unchanged
  `onlineWindowMs` and per-row `idleSeconds`. Client (N2): both device surfaces route their
  status chip through ONE helper (`lib/device-idle.ts`) so a `null` idle no longer blanks the
  chip to a bare status word — it shows the last known good reading (latched) or, cold+unknown,
  the explicit `activity unknown`. Verified live — raw before/after in §12.
- **TASK_152 M1–M7** — device screen monitoring: its own console **Monitoring tab**
  (confirmed rendered; Summary now shows only a pointer), per-frame summaries + scrollable
  timeline, configurable cadence, user triggers + Telegram/digest, capture scheduler
  (concurrency/fairness/rotation), and monitor summaries feeding agent context.
- **TASK_153 S1/S2** — deploy now discovers every systemd unit from `deploy/`;
  `screen-notify-sweep.timer` is installed, enabled and armed. Capture no longer ticks the
  mesh Input toggle (observation never enables input).
- **TASK_150 T1–T5** — extractor domain filter + cross-session duplicate leads; campaign
  manual-test boundary framing, mailbox removal from a live send, multiple test recipients.
- **Mailbox delete fix** — deletes cleanly when nothing was delivered; asks once
  (`?force=1`) when send history would be lost.

### 6.3 Production health (checked this session)

`systemctl --failed` → **empty** (after the transient below cleared). Running:
`spaceworker`, `spaceworker-browser`, `extraction-worker` all **active** (plus `screenshot-capture`,
`exit-node-us1`, `exit-node-us2`). Timers armed: `dispatcher`, `mail-queue-drain`,
`screenshot-sweep`, `screen-notify-sweep`, `payment-verify`, `automations-sweep`,
`device-onboarding-sweep`.

**Post-deploy caveat (proved this session):** right after this deploy, `systemctl --failed`
showed **`device-onboarding-sweep.service` failed** — its 5-minute tick had collided with the
deploy's stop/extract window and `curl` exited **7 (connection refused)**. The journal showed
every earlier tick `{"ok":true,...}`; the *next* tick (15:30:40) exited `status=0/SUCCESS` and
`--failed` returned empty. **A post-deploy oneshot failure is a false alarm unless it survives
the next clean tick** — see §5 trap 15.

### 6.4 Known-unverified (do not claim these work)

- **TASK_154 N1+N2 ARE now deployed and verified live** (build `4-aARmhO-lJKtaX2Lx-9y`, deploy
  `36867996177`). Raw before/after in §12. **Honest gap:** the specific `null → "activity
  unknown"` branch was **not** observed *rendered* live after the deploy — at capture time the
  mesh read for every device I could reach succeeded (`WilkSF9` idle = `215`s), so the `null`
  path simply did not occur. That branch is proven by the N2 session's stubbed-body browser
  render harness (**SIMULATION**, labelled in §12) and by `tests/device-idle-chip.test.ts`
  (10/10) and the live bundle grep — **not** by a live screenshot. Do not over-claim it.
- **M3 summarisation has never been exercised against a live frame.** The summariser is
  proven present in the compiled bundle and the timeline UI renders, but the device's
  `screenshotMonitoringEnabled` is `false` (**re-verified this session: all 8 rows of
  `Device` are `false`**) and nobody flipped consent to test it. **Mike will test this
  himself.**
- `main`'s local dev DB cannot render `/dashboard` (§5 trap 11), so UI verification must
  use a scratch DB.
- `notifyAdmin` Telegram text changes are verified by inspection only (needs admin
  Telegram config to fire at runtime).

### 6.5 Self-hosted product line — `self-hosted-build`

| | |
|---|---|
| Branch / HEAD | `self-hosted-build` @ **`f6b6f78`** (TASK_145 T10 — wizard UI lifetime vs countdown) |
| Sync | in sync with `origin/self-hosted-build` |
| Working tree | **CLEAN** (re-verified 2026-10-01: `git status --porcelain` empty) |
| Progress | T1–T10, T16, T17 **CLOSED**; T11–T15 remain |
| Next task | **T11** (the live kill — highest value), per the `▶ NEXT TASK` pointer |

*(Corrected 2026-10-01: the previous pass recorded `163c1a1`, **DIRTY** with
`setup-wizard.tsx` in flight from a T10 agent. That agent finished — T10 is committed and
pushed as `f6b6f78` and the tree is clean. There is **no** in-flight work in the worktree
now; it is safe to start T11.)* The authoritative work order is the `▶ NEXT TASK` pointer
near the top of `TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md`; that pointer, not any
banner, decides what runs next.

**Two carry-over obligations for this branch:**
- **`W18` — a migration timestamp collision.** `20261020000000_add_exe_license_revocation`
  (branch) vs `20261020000000_admin_device_commands` (main, already applied to the live
  DB). Prisma applies pending migrations lexicographically, so on merge the branch's
  migration would sort before an already-applied one. **Renumber it before this branch
  ever merges** — it is only safe while it has never touched the live DB (scratch
  `spaceworker_t145` only).
- **Merge disposition differs per file.** `admin-panel.tsx` needs a **union** (both sides
  have real work; main is ~1354 lines ahead — resolving "by side" would delete the live
  remote-viewer feature). `components/mailboxes-panel.tsx` and friends need **main's
  version outright** (the branch is ~575 lines behind there). Never apply one rule to both.

## 7. Queue — what runs next, in order

**Live app (`main`)** — strictly sequential where files overlap:

| # | Task | Doc | Notes |
|---|---|---|---|
| ~~1~~ | ✅ ~~**TASK_154 N1** — server: idle readings carry provenance~~ **DONE + DEPLOYED** (`a64c702`) | `TASK_154_...md` §3 N1 | `lib/vantra-link.ts` + `app/api/devices/route.ts`; `tests/vantra-idle-provenance.test.ts` (**8/8**). Live in `4-aARmhO-...`. |
| ~~2~~ | ✅ ~~**TASK_154 N2** — client: latch idle, delete the "bare status" fallback~~ **DONE + DEPLOYED 2026-10-01** (`e342578`) | same §3 N2 | ONE shared helper `idleChipLabel` in `lib/device-idle.ts`; both surfaces + all 3 console sites wired; `tests/device-idle-chip.test.ts` (**10/10**). Live in `4-aARmhO-...`. See §12. |
| ~~3~~ | ✅ ~~**DEPLOY N1 + N2 together**~~ **DONE 2026-10-01** — run `36867996177`, build `4-aARmhO-lJKtaX2Lx-9y`; verified live per §8/§12 | — | Closed TASK_154's owner report. |
| 1 | **TASK_154 N3** — key idle by agent id, not hostname | same §3 N3 | Optional follow-up, cross-repo. Only worth doing if the hostname-keying bites in practice. |
| 2 | **TASK_150 T6** — confirm/fix changing the test email mid-send | `TASK_150_...md` §3 T6 | Last item of TASK_150 |

**N2 outcome (what shipped, so the next reader is not re-deriving it).** N2 consumes only the
**always-on** top-level `idle: { state, asOf }` + `onlineWindowMs`; it does **not** request
`?idle=provenance`, so N1's per-row opt-in object is still unused by the app (available if N3
needs per-row provenance). The latch is a **module-global `Map`** in `lib/device-idle.ts`, keyed
`id:` else `name:`, **not** reset on unmount — it self-bounds via the server's `onlineWindowMs`
and the 60 s active boundary, so a stale idle cannot freeze forever. It clears only on a
positively-active reading (< 60 s, matching `formatIdle`).

**TASK_152 M8 (device task/control — the deferred "final version")** is deliberately NOT
scoped yet. It needs its own safety work; the observability half (M1–M7) had to land first.
Do not fold M8 into any of the above.

**Owner-requested design work (scoping delivered 2026-10-01 — docs exist, nothing built):**

| # | Task | Doc | Notes |
|---|---|---|---|
| D1 | **Task 155 — Workers & Pages** (hosting tab: pages, redirects, files, converters; Cloudflare as engine, our `dl.*` as the free tier) | `PLAN_TASK_155_WORKERS_AND_PAGES.md` | Owner: *"free first."* Three engines; token model = platform (capped) / BYO / managed pool. **Start with its T0 spikes then P1 (files on our own metal) → P2 (redirects) → P3 (Pages).** Has 5 owner questions in §13. |
| D2 | **Task 156 — Cyber Lab, real-world** (offensive + defensive tooling, "not simulation", abuse sentinel) | `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` | **Depends on 155 P1/P2** (owner: *"the workers need to be ready so the lab has enough tools"*). Adds the tooling matrix, the abuse sentinel, the `Lab*` schema deltas and phasing C0–C6. Governing doc for *what* is built; `TASK_98_...md` remains the build spec + Michael's MT-2/MT-3 artefacts. Has 5 owner questions in §10. |

*Neither is in the code queue yet — both are waiting on the owner's answers (D1 §13, D2 §10).
Do not start them ahead of the live-app items above.*

**Self-hosted line:** T10 → T11 (the live kill — highest value) → T12 → T13 → T14 → T15,
per `TASK_145_...JUNIOR_TRACK.md`.

**Rule:** if a task's files overlap another's, they are sequential, not parallel. Overlaps
are called out in each task doc.


## 8. How to verify — the standard the owner actually wants

Every task doc ends with an Evidence list. **Meet it, and meet the rules in §4.** Short form:

1. **Read the task doc's "verified state" section first.** It exists so you do not
   re-diagnose something already diagnosed. If you disagree with it, say so and show why —
   do not silently work around it.
2. **Reproduce the failure before you touch anything.** Raw output of it failing.
3. **Make the change.**
4. **Show it passing** — same command, raw output.
5. **Prove nothing else broke.** Minimum: `npx tsc --noEmit` (exit 0),
   `CI=1 npx next build` (succeeds), and the `test:*` scripts related to what you touched
   (**CI will not run them** — §5 trap 3).
6. **Report honestly.** List what you could NOT verify. That list is expected.

**Local verification setup (this workstation):**

```bash
cd /Users/mikeolab/spaceworker
grep '^DATABASE_URL' .env                     # confirm target BEFORE any DB write
createdb sw_mycheck                           # scratch DB (§5 trap 11)
DATABASE_URL='postgresql://mikeolab@127.0.0.1:5432/sw_mycheck' npx prisma db push --skip-generate
CI=1 npx next build
npx tsc --noEmit
npm run test:<relevant>                       # CI does not run these
dropdb sw_mycheck                             # clean up
```

**VPS (read-only):** `ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96`, app at
`/opt/spaceworker`:

```bash
cat /opt/spaceworker/.next/BUILD_ID            # what build is actually live
systemctl list-timers --all | grep -i spaceworker
systemctl --failed
sudo -u postgres psql -d spaceworker -c 'SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 5;'
```

**Caution learned the hard way:** `components/` and `lib/` are **not shipped** to the VPS —
the compiled app lives in `.next`. To check whether a source change is live, grep the
**built chunks**, not the source files there (the VPS source tree is stale by design, so a
grep hit in `/opt/spaceworker/components/` proves nothing — and a miss is not a failure).

## 9. How to deploy

**Pushing to `main` does NOT deploy.** `deploy.yml` has `push: branches: [main]` but the
deploy job is gated:

```
on: push / workflow_dispatch
  build:   name: Build & typecheck        # runs on every push
  deploy:  name: Deploy to production (manual only)
           if: github.event_name == 'workflow_dispatch'   # SKIPPED on push
```

**To deploy:**

```bash
cd /Users/mikeolab/spaceworker
gh workflow run deploy.yml --ref main
gh run list --workflow=deploy.yml --limit 3        # find the run id
gh run view <run_id> --json status,conclusion,headSha
```

**What the deploy job does, in order** — know this before triggering it; there is no
staging environment and no rollback command:

1. `npm ci`, `prisma generate`, `npm run build`
2. `tar czf` → `.next node_modules package.json package-lock.json prisma browser-server
   worker deploy browser-capture` (**`components/` and `lib/` are deliberately NOT in the
   tar** — the compiled app is in `.next`; do not "fix" this)
3. `scp` to the VPS
4. `systemctl stop spaceworker spaceworker-browser extraction-worker`
5. extract over `/opt/spaceworker`
6. `sudo -u trmm npx prisma migrate deploy` — **a failing migration aborts under `set -e`
   and can leave services stopped**
7. start the services back; assert `is-active`
8. install **every** systemd unit discovered from `deploy/`, then assert each

**Before triggering:** read your own diff for pending migrations, confirm they are
additive, and accept that a bad migration is a production incident with no undo. If one
fails, **stop and report — do not improvise a repair against production.**

**After deploying, verify — do not assume success means the feature works:**
`BUILD_ID` mtime is new · the new migrations are in `_prisma_migrations` ·
`systemctl --failed` is empty · any new timer is in `systemctl list-timers` · **and the
owner-visible behaviour actually changed** — screenshot the real page. A green deploy that
changed nothing the user can see is the exact failure that produced TASK_153.

**Caveat on `systemctl --failed`:** immediately after a deploy it can show a 5-minute oneshot
(`device-onboarding-sweep`, …) as `failed` because its tick hit the restart window (curl exit 7).
That is a **false alarm** — re-check after the next tick before calling it a regression (§5 trap 15).


## 10. Update protocol — do this before you finish, or the handoff dies

> **This was skipped once and it cost the next reader a full re-derivation.** The 2026-10-01 N2
> session shipped correct, CI-green work and then left **this file and `TASK_154_...md` untouched** —
> so §6 named a stale HEAD and §7 still said "NEXT" for an already-done task (trap 14). **Finishing
> the code is not finishing the task. If you did work, you owe these four edits in the same session,
> before you stop.** Code-complete + doc-stale == a broken handoff.

**In the same session as the work:**

1. **§6 Current state** — update the `Last verified:` date, HEAD SHAs, sync status,
   deployed build, and the "known-unverified" list. Remove items that are now verified.
   **Only state what you actually saw.**
2. **§7 Queue** — strike what you completed, promote what is next, add anything newly
   discovered (with its own TASK doc if it is more than a one-liner).
3. **§5 Known traps** — add any new trap you hit, with the evidence that proved it. This
   section is why the next engineer does not re-pay for your lesson.
4. **§12 Log** — append one entry (never edit an existing one):

```markdown
### YYYY-MM-DD — <one-line summary>
- **Did:** what you actually did (files + line ranges, commit SHA)
- **Verified:** the raw checks you ran and their results
- **NOT verified:** what you could not confirm, and why
- **State left behind:** branch/HEAD, tree clean or dirty, anything in flight
- **Next:** the one thing the next engineer should do first
```

5. **The task doc** — mark the item done in its own file, and have it point here rather
   than duplicating state.

**If you were interrupted:** say so explicitly in the log and say exactly what is
half-done. A half-done change with no note is worse than no change.

## 11. Where the deep detail lives

| Document | What it covers |
|---|---|
| `HOW_WE_MOVE_FAST.md` | Deploy/verification playbook, with the incident history behind each rule |
| `PIPELINE_CONSOLE_BROWSER_CLONE.md` | The console / browser-clone subsystem in depth |
| `PLAN.md` | Original product plan and architecture |
| `TASK_127_DEVICE_SCREENSHOT_DAILY_SUMMARY.md` | Screen monitoring phase 1 + the deferred phase 3 (device tasks) |
| `TASK_150`–`TASK_154` | The current live-app workstreams (see §7) |
| `TASK_145_*_TRACK.md` (in the worktree) | The self-hosted licence workstream, two-track format |
| `PROMPTS_SENIOR_ENGINEERS.md` | **The assignment pack** — PROMPT L (onboard the lead), PROMPT E (per-engineer task template) and PROMPT V (the lead's independent verification). Use it to hand work out; it encodes §4/§5/§8/§9/§10 as copy-paste operations. |
| `PLAN_TASK_155_WORKERS_AND_PAGES.md` | **Scoping, not built** — the Workers & Pages hosting tab (free-first). Owner Qs in §13. |
| `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` | **Scoping, not built** — the real-world Cyber Lab (tooling matrix + abuse sentinel). Depends on 155 P1/P2. Owner Qs in §10. |
| `HANDOFF.md` (root) | **STALE** (Sep 2026, PR merge notes). Historical only — do not follow. |
| `app/AGENTS.md`, `app/CLAUDE.md` | Repo-local agent conventions |

## 12. Log

### 2026-10-01 — Handoff established; TASK_152 deployed; TASK_153 recovery; TASK_154 scoped
- **Did:** verified TASK_152 M1–M7 are all committed and on `origin/main` (M6 = `f1d3aa0`,
  confirmed present despite not appearing in the GitHub UI — §5 trap 10). Diagnosed why
  production showed no change (deploy is `workflow_dispatch` only; last real deploy was
  2026-09-30, all TASK_152 commits are 2026-10-01). Found M1 had **never been
  implemented** — `browser-capture/` had exactly one commit in its history. Wrote
  `TASK_153` (deploy pipeline + M1 recovery) and drove S2 → S1 → S3. Verified the deploy
  live. Scoped `TASK_154` (device idle stability, N1–N3) after Mike reported the idle chip
  vanishing while a machine was untouched.
- **Verified:** deploy run `36845942402` `conclusion=success`; all pending migrations
  applied; `ScreenshotRotationCursor` exists; `screen-notify-sweep.timer` enabled+armed;
  `systemctl --failed` empty; Monitoring tab rendered in a real browser with Summary
  reduced to a pointer; TASK_150 T1–T5 and the mailbox fix present in the compiled build.
  Live Vantra idle endpoint healthy (`HTTP 200`, 0.199s, `{"I":104}`).
- **NOT verified:** M3 summarisation against a live frame (consent flag left off
  deliberately — Mike will test); Telegram `notifyAdmin` text changes at runtime.
- **State left behind:** `main` @ `77f60f7`, clean, in sync, deployed.
  `self-hosted-build` @ `163c1a1`, **dirty** (`app/setup/setup-wizard.tsx` — another agent
  mid-T10; hands off).
- **Next:** TASK_154 N1 (server: idle provenance + org-keyed TTL cache), then N2.

### 2026-10-01 — §6 re-verified (2 corrections); TASK_154 N1 implemented, proven, pushed (not deployed)
- **Did:** (a) **Verified §6 against reality, not copied.** All §6.1–§6.4 health claims held
  (§6.3 `systemctl --failed` empty, 6 units running, 6 timers armed; deploy `36845942402`
  success; `BUILD_ID` `MLKWXpSxzHtvt8KoE_F3h`; **5** migrations at the deploy; `ScreenshotRotationCursor`
  exists; all 8 `Device.screenshotMonitoringEnabled = false`). **Two corrections:** §6.1 named
  HEAD `77f60f7` when `main` was `aa533cd` (doc named its own ancestor), and §6.5 called the
  worktree DIRTY @ `163c1a1` when it was clean @ `f6b6f78`. Both fixed in place (§6.1, §6.5) and
  recorded as **new trap 14**.
  (b) **TASK_154 N1.** `lib/vantra-link.ts` (`+118`, one new block at `:717-834`): `BulkIdleReading`,
  an **org-keyed** TTL cache (`DEVICE_IDLE_CACHE_TTL_MS`, default **25 s** ≥ the 20 s client poll),
  **stale-serving** on a mesh failure, a **rate-limited** failure warning (60 s/org), and
  `fetchUserIdleReading()` that never throws. `app/api/devices/route.ts` (`:10`, `:20-89`): consumes it,
  emits top-level `idle: { asOf, state }`, keeps `idleSeconds` byte-identical, and adds an
  **opt-in** per-row `idle` object via `?idle=provenance`. `package.json:34` `test:idle`.
  New `tests/vantra-idle-provenance.test.ts` (8 tests). Commit **`a64c702`**, pushed `aa533cd..a64c702`.
- **Verified (raw):** **reproduce-first** — `npm run test:idle` was RED `# pass 0 / # fail 8`,
  test 2 failing `null !== 104` ("the reading must survive the hiccup instead of blanking to
  null"); after the fix `# pass 8 / # fail 0`. `npx tsc --noEmit` → `TSC_EXIT=0`;
  `CI=1 npx next build` → `✓ Compiled successfully in 23.7s`, `BUILD_EXIT=0`. Full sweep: **all 23
  `test:*` suites pass, 0 fail** (test:vantra 58, test:idle 8, test:devices 6, test:monitorctx 13, …).
  **HTTP evidence** (throwaway harness `/tmp/n1-http-evidence.ts`, **NOT committed**): healthy →
  `HTTP 200` `"idle":{"asOf":"2026-10-01T11:44:31.255Z","state":"fresh"}` with `I` `idleSeconds:104`;
  next poll, mesh throws → `HTTP 200`, reading **retained** (state `stale`), log
  `[device-idle] bulk idle read failed for org org-demo: mesh_timeout (serving last good map)`;
  a third poll within the TTL returned the reading **without a second mesh call**. CI on the push:
  run **`36857561751`** → `Build & typecheck` **success**, `Deploy to production (manual only)` **skipped**.
- **NOT verified:** **N1 live — it is not deployed**, and I deliberately did not deploy it (additive,
  no owner-visible change alone; deploy is a manual gate). No browser/DOM check of N1 for the same
  reason. The mesh timeout is a **SIMULATION** (a thrown `fetch` error), not an observed live 15 s
  socket timeout. Trap 1 (PG18 vs PG16) not exercised — N1 adds no Prisma error-code branch.
- **State left behind:** `main` @ the session tip — **`a64c702`** (N1 code) + **`d55ef2e`**
  (handoff update, docs-only) — clean, in sync with `origin/main`, CI green; the
  **deployed build is unchanged** (`06a5eeb`). `self-hosted-build` @ **`f6b6f78`**, clean, in sync
  (read-only this session — no work done there).
- **Next:** **TASK_154 N2** (client) — consume N1's provenance (see the §7 shape note); then deploy
  **N1 + N2 together** and screenshot the device page per §8.

### 2026-10-01 — TASK_154 N2 shipped (client latch); N1+N2 still NOT deployed; handoff was NOT updated by the N2 session (this pass fixed that)
- **Did (N2 code — authored by the N2 session, verified and recorded here by the senior pass):**
  deleted the bare-status fallback on **both** surfaces and routed every chip through ONE shared
  client-safe helper. `lib/device-idle.ts` **+180** (new block `:20-198`): `idleChipLabel()` (the
  latch + age-out), `statusWord()`, `relTime()`/`relTimeAt()`, `idleReadProvenanceFrom()`,
  `IDLE_ACTIVE_MAX_SECONDS = 60`, `IdleChipDevice`/`IdleReadProvenance` types, and the module-level
  latch `Map`. `components/device-list.tsx` (`:22`, `:202`, `:625-642`): `statusIdleLabel` now calls
  the helper; old `if (d.idleSeconds === null) return statusWord(d.status)` **gone**.
  `components/device-console.tsx` (`:36-40`, `:462`, `:568`, `:1398`, `:1700`): local `relTime`/
  `statusWord` copies deleted; **all three** print sites (agent context, header chip, Summary "User
  activity") wired. `package.json:35` `test:idlechip`; new `tests/device-idle-chip.test.ts` (10 tests).
  **Commit `e342578`**, pushed `bb2394f..e342578`. No schema change, no migration; `lib/devices.ts`
  (`deviceStatus()`/`DEVICE_ONLINE_WINDOW_MS`), the 20 s poll cadence, `.env`, `browser-capture/`,
  `src-tauri/` untouched.
- **Verified (raw, by the senior pass — independent re-run, not carried forward):**
  `git rev-parse HEAD` = `e342578` = `origin/main`, `git status --porcelain` empty; commit stat = the
  5 files above (392+/44−). **Reproduce-first** via the N2 session's render harness
  (`/tmp/n2-render-evidence.mjs`, real `DeviceList`/`DeviceConsole` in real Chromium/Playwright,
  `/api/devices` bodies stubbed — **SIMULATION**, throwaway `app/__n2probe` pages since removed):
  BEFORE flicker = `["online · idle 1 min"], ["online"], ["online · idle 1 min"]`; AFTER = all three
  `["online · idle 1 min"]`; age-bound BEFORE froze at `online · idle 12 min`, AFTER → `offline · last
  seen 11 min ago` (R3 owns it); `clear` and `offline` identical before/after. `npx tsc --noEmit` →
  `EXIT=0`; **full sweep: all 24 `test:*` suites pass, 0 fail** (test:idlechip 10, test:idle 8,
  test:devices 6, test:vantra 58, …). CI push run **`36865754289`** → `Build & typecheck` **success**,
  `Deploy to production (manual only)` **skipped**.
- **NOT verified:** **nothing is deployed** — the owner-visible fix is **not live**; the production
  build still predates N1+N2. The mesh hiccup is a **SIMULATION** (a stubbed `/api/devices` body / a
  thrown fetch), not an observed live 15 s socket timeout. Cold+unknown is proven at the helper level
  (`tests/device-idle-chip.test.ts:61-66`), **not** rendered in the browser. The render harness does
  not embed a git SHA, so "before = N2 reverted" rests on the harness run, not an artifact tag.
- **PROCESS FINDING:** the N2 session **did not perform §10** — it left `SENIOR_HANDOFF.md` (§6/§7/§12)
  and `TASK_154_...md` un-updated, so the handoff was stale on arrival (trap 14). This senior pass
  re-verified the work independently and wrote the updates. §10 now carries an explicit reminder.
- **State left behind:** `main` @ **`f55ddd9`** (this docs catch-up) / **`e342578`** (N2 code),
  clean, in sync with `origin/main`, CI green; the **deployed build is unchanged** (`06a5eeb`).
  `self-hosted-build` @ `f6b6f78`, clean (untouched).
- **Next:** **DEPLOY N1 + N2 together** (manual `workflow_dispatch`), then screenshot `/devices` and a
  device console (§8) — that is what closes TASK_154 for Mike. Then N3 (optional).


### 2026-10-01 — TASK_154 N1+N2 DEPLOYED to production and verified live (raw before/after); new trap 15 (post-deploy oneshot false-failure)
- **Did:** triggered the manual deploy that ships N1+N2 — `gh workflow run deploy.yml --ref main` → run **`36867996177`** (`workflow_dispatch`, sha `9f5d0d4`). **No code changed this pass** (N1 `a64c702`, N2 `e342578` were already committed); this session *deployed and verified* them. New in this file: **§5 trap 15**, refreshed **§6.1/6.2/6.3/6.4**, **§7** queue, **§9** caveat, this log.
- **Verified (raw):**
  - **Reproduce-first / BEFORE** (pre-deploy build `MLKWXpSxzHtvt8KoE_F3h`): live `GET /api/devices` for real user `myrate619@gmail.com` (read-only 1 h session token minted **on the VPS** from `SESSION_SECRET`, which never left the host) → top-level keys **`onlineWindowMs,devices` — NO `idle` key**; device `WilkSF9` online, **`idleSeconds=null`**; `Sc` offline. Real-Chromium full-page screenshots of `/dashboard/devices` + the console → `WilkSF9` chip = bare **`online`** (`/tmp/n2-live-BEFORE/{list,console}.png`).
  - **Deploy:** run `36867996177` → `Build & typecheck` **success**, `Deploy to production (manual only)` **success**. Live `BUILD_ID` = **`4-aARmhO-lJKtaX2Lx-9y`**, mtime **`2026-10-01 15:23:32 CEST`**.
  - **AFTER (live):** `GET /api/devices` top-level keys now **`onlineWindowMs,idle,devices`**, `idle` = **`{"asOf":"2026-10-01T13:27:05Z","state":"fresh"}`** → **N1 live**. Same DOM capture → `WilkSF9` chip = **`online · idle 3 min`** on BOTH list and console header (before: `online`); `Sc` still `offline · last seen 1 d ago`. `/tmp/n2-live-AFTER/{list,console}.png`. **N2 live** proven by bundle grep: `grep -rl "activity unknown" /opt/spaceworker/.next/static` → **3 chunks**.
  - **Health:** `systemctl --failed` → **empty** (after the transient, see below); `spaceworker`/`spaceworker-browser`/`extraction-worker` **active**; **no pending migrations** (`git diff --name-only 06a5eeb HEAD -- prisma/` = **0**).
  - **Regression:** full local `test:*` sweep **0 failed / 430 tests**; `npx tsc --noEmit` **EXIT=0**.
  - **Tooling note:** Playwright 1.63 expects `chromium-1243`, which **cannot be downloaded on this mac12 workstation** (`Playwright does not support chromium on mac12`); verification used the cached `chromium-1208` **"Google Chrome for Testing"** binary via an explicit `executablePath`. The screenshots are a **real browser on the real site**, not the sim harness.
- **NOT verified:** the specific **`null → "activity unknown"`** render was **not** re-observed *live after* the deploy — the mesh read succeeded for every device I could reach (`WilkSF9` idle=215 s, 12 polls), so the `null` path did not occur. That branch rests on the N2 session's **SIMULATION** harness (stubbed `/api/devices` bodies, labeled in the entry above) + `tests/device-idle-chip.test.ts` — **not** a live screenshot. All live actions were **read-only**; the minted token was **deleted** from the VPS. The `device-onboarding-sweep` failure is the deploy-collision (trap 15), not shown to be a standing defect.
- **PROCESS FINDING:** `systemctl --failed` **is not empty right after a deploy** — a 5-min oneshot that collides with the restart window shows `failed` (curl exit 7) and self-heals on the next tick. This cost real diagnosis time and is now **§5 trap 15** + a **§9** caveat.
- **State left behind:** deployed build `4-aARmhO-lJKtaX2Lx-9y` (deploy run `36867996177`, sha `9f5d0d4`); this docs commit advances `main` past `9f5d0d4` (documentation-only). Tree **clean**, in sync with `origin/main`, CI green. `self-hosted-build` @ `f6b6f78`, clean (untouched).
- **Next:** TASK_154 **N3** (key idle by agent id) **only if** hostname-keying bites in practice; otherwise **TASK_150 T6** (the last TASK_150 item, `TASK_150_...md` §3).


### 2026-10-01 — two scoping docs (Tasks 155/156) + the assignment pack; §6.1 corrected again (trap 14); new trap 16

- **Did:** (a) Wrote `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` (new, 328 lines, 11 sections — the real-world Cyber Lab scoping the owner asked for: capability matrix, **abuse sentinel**, `Lab*` schema deltas, phasing C0–C6, and open questions). (b) Wrote `PROMPTS_SENIOR_ENGINEERS.md` (new, 397 lines — PROMPT L for the incoming lead, PROMPT E per-engineer template, PROMPT V the lead's independent verification, plus instantiated headers for `TASK_154 N3`, `TASK_150 T6`, `Task 155`, `Task 156`, and the self-hosted `T11`–`T15`). (c) Handoff §5 (+trap 16), §6 (corrected), §7 (+design work), §11 (+3 rows). **No application code changed in this pass.**
- **Verified:** `main` @ `3d484af` == `origin/main`; **live build `iyIlFSwZhjQ_1Rap4MFWC`, mtime `2026-10-01 16:19:43 CEST`**, `systemctl --failed` **empty**; the capture-failure copy is in the shipped chunks. §6.1 still named the **previous** build (`4-aARmhO-…` / `9f5d0d4`) — **stale again (trap 14)** — corrected to the current build + deploy run `36875156299` (and the failed dispatch `36873911731`, exit 255 = transient SSH).
- **New trap (16):** a plan's `§SCHEMA` list is a **draft**, not the database. Measured: `grep '^model Lab' prisma/schema.prisma` → **nothing**; only `"browser-clone"` exists as an `AgentPendingAction` kind — while the *device* seams in the same list **are** real, so a reader cannot tell built from aspirational. Also measured: the prod VPS has **only `tcpdump`** from a 13-tool security list.
- **NOT verified:** nothing runtime in this pass (docs only). `PLAN_TASK_155` was written in a prior compacted pass and was **not** re-audited line-by-line here — its §4/§5 claims about engines and the `dl.*` service were read but not re-measured this pass. The Cyber Lab has **no** code, no schema, and no host — every `Lab*` item is unbuilt.
- **State left behind:** `main` @ docs commit (above `3d484af`, documentation-only); tree clean, in sync. `self-hosted-build` @ `f6b6f78`, clean (untouched — `git status --porcelain` empty).
- **Next:** `main` — **TASK_154 N3 only if hostname-keying bites** (must be shown first), else **TASK_150 T6**. Self-hosted — **T11** (the live kill), highest value. Design work (155/156) waits on the owner's answers; do not start either ahead of the live-app items.
- **Owner note:** confirmed the screen-capture fix reads correctly — *"device is offline and would clear itself as soon as it comes on"*.

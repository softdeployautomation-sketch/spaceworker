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

## 6. Current state — revise this block every session

**Last verified: 2026-10-01 (senior pass, session with Mike).**

### 6.1 Live app — `main`

| | |
|---|---|
| Branch / HEAD | `main` @ **`77f60f7`** ("TASK_154: scope the device status chip fix") |
| Sync | in sync with `origin/main`; working tree **clean** |
| Deployed to production | **YES** — build `MLKWXpSxzHtvt8KoE_F3h`, `BUILD_ID` mtime `2026-10-01 11:58 CEST` |
| Deploy run | `36845942402` (`workflow_dispatch`, `conclusion=success`) |
| Migrations applied | all pending applied (8 in that deploy); `ScreenshotRotationCursor` exists |

### 6.2 What the deploy contained (verified live, not assumed)

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

`systemctl --failed` → **empty**. Running: `spaceworker`, `spaceworker-browser`,
`screenshot-capture`, `extraction-worker`, `exit-node-us1`, `exit-node-us2`. Timers armed:
`dispatcher`, `mail-queue-drain`, `screenshot-sweep`, `screen-notify-sweep`,
`payment-verify`, `automations-sweep`.

### 6.4 Known-unverified (do not claim these work)

- **M3 summarisation has never been exercised against a live frame.** The summariser is
  proven present in the compiled bundle and the timeline UI renders, but the device's
  `screenshotMonitoringEnabled` is `false` and nobody flipped consent to test it. **Mike
  will test this himself.**
- `main`'s local dev DB cannot render `/dashboard` (§5 trap 11), so UI verification must
  use a scratch DB.
- `notifyAdmin` Telegram text changes are verified by inspection only (needs admin
  Telegram config to fire at runtime).

### 6.5 Self-hosted product line — `self-hosted-build`

| | |
|---|---|
| Branch / HEAD | `self-hosted-build` @ **`163c1a1`** (TASK_145 pass 15) |
| Sync | in sync with `origin/self-hosted-build` |
| Working tree | **DIRTY** — `app/setup/setup-wizard.tsx` modified (a T10 agent mid-work) |
| Progress | T1–T9, T16, T17 **CLOSED**; T10–T15 remain |
| Next task | **T10** (wizard UI consumes the `lifetime` flag) → **T11** is the highest-value edit |

**Do not start T10 if that file is still dirty from another agent — it is theirs to finish
and log.** The authoritative work order is the `▶ NEXT TASK` pointer near the top of
`TASK_145_SELF_HOSTED_LICENSE_JUNIOR_TRACK.md`; that pointer, not any banner, decides what
runs next.

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
| 1 | **TASK_154 N1** — server: idle readings carry provenance; mesh hiccup cannot blank them | `TASK_154_...md` §3 N1 | Isolated to `lib/vantra-link.ts`, `app/api/devices/route.ts` |
| 2 | **TASK_154 N2** — client: latch idle, delete the "bare status" fallback | same §3 N2 | **After N1** (consumes its shape) |
| 3 | **TASK_154 N3** — key idle by agent id, not hostname | same §3 N3 | Optional follow-up, cross-repo |
| 4 | **TASK_150 T6** — confirm/fix changing the test email mid-send | `TASK_150_...md` §3 T6 | Last item of TASK_150 |

**TASK_152 M8 (device task/control — the deferred "final version")** is deliberately NOT
scoped yet. It needs its own safety work; the observability half (M1–M7) had to land first.
Do not fold M8 into any of the above.

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


## 10. Update protocol — do this before you finish, or the handoff dies

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


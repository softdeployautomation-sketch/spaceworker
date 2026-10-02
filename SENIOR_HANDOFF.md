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

**16. A plan's `§SCHEMA` section is a *draft*, not the database.**
`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`§SCHEMA lists `LabScenario` / `LabRange` / `LabEpisode` / `LabFinding` / `DetectionPack` /
`LabConsent` and an `AgentPendingAction` kind `"lab-action"` in a list headed *"reserved seams,
shared by EVERYTHING device-side"* — which reads as "these exist, consume them". Measured
2026-10-01: `grep '^model Lab' prisma/schema.prisma` returns **nothing**, and only
`"browser-clone"` exists as an `AgentPendingAction` kind. The *device* seams in the same list
(`DeviceJob`, `DeviceAudit`, `AgentActionAudit`, `UserEntitlement`, the panic switch in
`app/api/devices/panic/route.ts`, `lib/resource-governor.ts`) **are** real — so a reader cannot
tell the built ones from the aspirational ones by reading the plan. **Before a task doc says
"reuse X", grep for X.** Same class of error as trap 14 (a document describing a system that
has moved on), one level deeper.

**17. A conditional task (“only if X demonstrably bites”) must be closed with LIVE evidence
— and “bites” means the live fleet, not a constructed example.** TASK_154 §3 N3 (“key idle
by agent id, not hostname”) is gated on *“only if hostname-keying demonstrably bites”* and is
explicitly *“not required for the owner’s fix… only if the owner wants it.”* The idle map is
keyed by the **mutable `Device.name` (= TRMM hostname)**, so a collision would silently let one
machine render another’s activity — a real, latent correctness hazard. Measured against the
**live** fleet 2026-10-01: **0** duplicate `(client_id, hostname)` in TRMM, **0** duplicate
non-removed `Device.name` per user, and **distinct, fully-resolving** idle keys across all 6 SW
orgs — i.e. it does **not** bite. A *forced* collision (**SIMULATION**) does reproduce the
failure (`online · active now` on a machine idle 900 s), which is why N3 is **filed, not dead**.
The lesson: forcing the failure proves the *mechanism*, not the *risk*. Do not spend a
cross-repo change (N3 needs the **Vantra** repo) on a hazard the live data says is absent —
log the negative evidence, leave the follow-up, and move on. Evidence in §12.

**18. An *account-scoped* Cloudflare API token verifies as `active` yet exposes no account —
you must be handed the Account ID out-of-band.** For Task 155's T0 spikes the owner supplied a
throwaway Cloudflare token. `GET /user/tokens/verify` returns
`{"id":"dbe2bd...","status":"active"}`, `success:true` — so every "is the token valid?" check
passes — **but** `GET /user` → `9109 Unauthorized`, `GET /memberships` → `10000 Authentication
error`, and `GET /accounts` → `result: []`, `total_count: 0`. This is not a broken token: it is
the **preferred** R14 shape (account-scoped, not user-scoped), and an account-scoped token simply
**does not enumerate its own account**. Account-scoped endpoints need an explicit
`/accounts/{account_id}/…` path segment, so **without the Account ID every Pages/Workers call
fails** even though the token works. Measured live 2026-10-01 once the owner supplied the Account
ID (`4c822d3b5378019cef1e1b79a3bf0492`): `/accounts/{id}/pages/projects` → **200** and
`/accounts/{id}/workers/scripts` → **200** (scope works), while `/accounts/{id}/r2/buckets` →
**403** (no R2 scope — and R2 needs billing anyway, R13). **Two more bites found the same pass:**
(a) `?per_page=50` on `/pages/projects` fails with `8000024 Invalid list options` — the max is
lower, use `per_page=10` and paginate; (b) **`GET /accounts/{id}` (the account object itself)
returned `success:false`/`name:null`** even though its *sub-resources* answer 200 — a token can
read a resource without being able to read the resource's *container*. Lesson: for an
account-scoped credential, **demand the Account ID with the token**, and **probe each scope with
the call you actually intend to make** before believing the token "works".

**19. Cloudflare Pages Direct Upload: the manifest hash is `blake3(base64(bytes)+extension)`
truncated to 32 hex chars — and an oversize asset returns a raw `500`, not a `4xx`.** Task 155's
T0 spike needed Direct Upload **without** wrangler, so the protocol was read from wrangler's source
and **executed against the live throwaway account** 2026-10-01. The parts that will bite:
(a) the per-file key is **`blake3(base64(fileBytes) + extensionWithoutDot)` → hex → first 32 chars**
— **not** a hash of the raw bytes, and **not** MD5 (the widely-copied blog uses MD5 and is wrong);
get this wrong and every deployment 500s with no useful message. (b) the flow is
`upload-token` → `check-missing` → `assets/upload` → `upsert-hashes` → `deployments`, and only the
**`deployments` POST uses the API token** while the three `assets/*` calls use the short-lived
**JWT**. (c) the `deployments` body is **multipart** with `manifest` (`{"/path":hash}`) + `branch`;
a hand-rolled boundary that is even slightly off returns a bare **500**. (d) **`MAX_ASSET_SIZE =
25 MiB` and oversize is a `500` "Worker threw exception", not a clean `413`** — measured:
`24 MiB → 200`, `25 MiB → 200`, **`26 MiB → 500`**. So **pre-validate on our side and never
forward >25 MiB**. (e) the deployment is **not** a *build* (R4): Direct Upload does not consume the
500-builds/month quota. Local gotcha: the **macOS `curl` is LibreSSL 3.3.6 and fails the TLS
handshake to `*.pages.dev`** — use Node's `fetch` (or a modern curl) to verify the served bytes.

**20. Task 155 P1's local hosting engine writes INSIDE the repo by default, and its download
accounting is fire-and-forget.** *(Hit 2026-10-01 building P1.)* Four bites, all cheap once known:
(a) `hostingStorageRoot()` = `HOSTING_STORAGE_DIR ?? path.join(process.cwd(), ".hosting-storage")`
(`lib/hosting/providers.ts:84`). **`.hosting-storage` is NOT in `.gitignore`** — proved:
`git check-ignore -v .hosting-storage` → *not ignored*. A dev who runs the app locally without the
env var (or an e2e that forgets it) puts **real uploaded bytes inside the working tree**; the VPS
deploy must set `HOSTING_STORAGE_DIR` **outside the deploy dir** — done on the P2 deploy:
`/opt/spaceworker-hosting` (owned `trmm:trmm`, mode 750), so no deploy tar can ever touch user
bytes. Never `git add .`/`-A`
(rule 4) — check `git status` for `.hosting-storage/` before every commit.
(b) `recordServe()` (`app/hf/[token]/route.ts`) is **fire-and-forget**: the GET returns before the
counter is written, so a test that asserts `downloadCount` immediately after the response fails
**intermittently**. Poll (the T155 e2e harness polls for 2.5 s). Same for the monthly bandwidth row.
(c) **Turbopack now prints a SECOND “overly broad file pattern … matches N files in [project]/”
warning**, traced `./lib/hosting/providers.ts` → `./app/api/hosting/status/route.ts` — because
`path.join(hostingStorageRoot(), safeSegment(token))` is a dynamic path under the project root.
It is the same class as the pre-existing one traced through `lib/clone-engine-dist.ts`. `next build`
still exits **0** (2 warnings, 0 errors) — **do not “fix” it by inlining a path or by moving the
storage root**, and do not mistake it for a failure.
(d) The admin hosting rows and the customer file list render only **after** their `fetch` resolves.
Asserting the DOM immediately after clicking the tab (or right after an upload) reports **false
FAILs** — wait for one known row text first.
**21. The `dl.instaweb.top` vhost had NO `/hf/` location, and `hostingPublicBase()` silently falls
back to the MAIN app host.** *(Hit 2026-10-01 on the Task 155 P2 deploy.)* `lib/hosting/providers.ts:77`
is `process.env.HOSTING_PUBLIC_BASE_URL || process.env.APP_BASE_URL || ""`, and `APP_BASE_URL` is
`https://spaceworker.top`. So if you deploy hosting **without** setting `HOSTING_PUBLIC_BASE_URL`, every
minted file URL points at the app host — which (a) violates plan §15 ("never serve user bytes from the
main spaceworker.top host") and (b) 404s, because only the `dl.*` vhost gets `/hf/`. Worse, the failure
is **silent on `dl.*`**: that vhost's catch-all is `location / { return 404; }`, so a missing proxy and a
missing token look identical. Proved the proxy is live by the **body, not the status**:
`curl -sS https://dl.instaweb.top/hf/deadbeef` → nginx plain `404` before, app
`{"error":"Not found.","code":"not_found"}` (content-type `application/json`) after. Fix applied:
`HOSTING_PUBLIC_BASE_URL=https://dl.instaweb.top` in `/opt/spaceworker/.env` **and** `location /hf/ {
proxy_pass http://127.0.0.1:3500; … }` in `/etc/nginx/sites-available/dl.instaweb.top.conf` (app port is
**3500**, from `spaceworker.service`; the generator behind `/d/` + `/e/` is **4000** — do not confuse them).

**22. `7z l` prints an archive-HEADER block that is NOT an entry — a naive parser reads
`Path = <archive>.zip` and rejects EVERY real archive as a nested zip.** *(Hit + fixed
2026-10-02 on Task 155 P3.)* `lib/hosting/extract.ts` lists a `.zip` with `7z l -slt` and parses the
`----------`-delimited records. The **first** block, printed *before* the first `----------`, is the
**archive** header (`Path = site.zip`, `Type = zip`, `Physical Size = …`) — not a member. A parser that
starts collecting `Path =` the moment it sees one therefore recorded the *archive itself* as entry #1,
so the "no nested archives" guard saw a `.zip` inside the zip and **refused every genuine archive**.
The unit test that only fed a hand-written listing (no header block) passed, which is exactly why it
survived. Fixed: skip everything up to the first `----------` line before collecting members
(`extract.ts` `parseSevenZipListing`). **Lesson: drive a REAL `7z` binary in the test** — the new
`tests/hosting-pages.test.ts` shells out to `7z` to build an actual archive, which is what caught it.
Same family as trap 16: a hand-typed fixture is a draft, not the tool's real output.

## 6. Current state — revise this block every session

**Last verified: 2026-10-02 (Task 155 **P3 DEPLOYED + MIGRATED + VERIFIED LIVE** — `main` @ `bb6ff6c`, deployed build `LjgrTG69r2eiN-w07Hj-i` (`BUILD_ID` mtime `2026-10-02 06:56:12 CEST`), deploy run **36966548887** (`workflow_dispatch`, in-window `prisma migrate deploy` reported *"Database schema is up to date!"*, migration `20261029000000_task155_p3_pages_sites` recorded `finished_at 2026-10-02 06:58:17 CEST`). P3 makes the **folder/zip → PREVIEW → PUBLISH** flow real and the engine **per-site**: LOCAL (free) serves the extracted tree from our metal at `/pv/<token>/` (preview, noindex, TTL) and `/hs/<token>/` (live, immutable); CLOUDFLARE (premium) runs the four-call Direct-Upload deploy against a per-item credential (user BYO account, else platform). Every new cap is an admin-editable `AdminSetting` (premiumMaxProjects / MaxFilesPerProject / MaxBandwidthGbPerMonth / DeploymentsPerDay / PreviewTtlHours / MaxZipMb / MaxZipEntries / MaxHeavyJobsPerUser / PublishedRevisionsKept); the heavy extract is serialised behind the §16.6 job lock; a dead token fails **closed** (§16.4). **ADDITIVE** migration: 9 `AdminSetting` columns + 2 NULLABLE `HostingCredential` columns + 3 new empty tables (`HostingSite`/`HostingRevision`/`HostingJob`) — no row rewritten. Proven: `npx tsc --noEmit` → **0**, `CI=1 npx next build` → **exit 0** (all P3 routes in the manifest + the P3 UI strings present in the shipped client chunk), `npm run test:hosting` → **39/39** incl. the new `tests/hosting-pages.test.ts` that builds a **real `7z` archive** and drives the real extract/serve path (which caught a real parser bug — trap 22). Live this session: `https://spaceworker.top/` → **200**, `/dashboard/hosting` → **307** (auth), `/api/hosting/sites` → **401** (auth-gated, route exists), `/pv/<bad>` and `/hs/<bad>` → **404** (new public handlers exist, no 500); `systemctl --failed` → **empty**; all three services **active**.**

**⚠ The one thing NOT true yet:** no user has clicked *Upload a zip → preview → publish* on production. The live proof above is **reads** (routes exist, auth enforced, public handlers return 404 not 500); the **write** path (create site → zip → preview 200 → publish → live 200) was proven on the scratch DB + real `7z`/`next start`, **not** on prod, and the **premium/Cloudflare** leg was proven against the **throwaway** account only. That is the first thing to do by hand (see §6.4).

*(Previous, P2 — kept for the record:)* **Last verified: 2026-10-01 (Task 155 **P2 DEPLOYED + MIGRATED + VERIFIED LIVE, master switch FLIPPED ON** — `main` @ `435d419`, deployed build `9RVryDnQoHNZL4NL-Zdy6` (`BUILD_ID` mtime `2026-10-02 00:15:49 CEST`), deploy run **36933764632** (`workflow_dispatch`, in-window `prisma migrate deploy` reported *"Database schema is up to date!"*). The **Hosting tab is now live and public** at `https://spaceworker.top/dashboard/hosting`, serving files from `https://dl.instaweb.top/hf/<token>` (new nginx `location /hf/` → `127.0.0.1:3500`; `HOSTING_PUBLIC_BASE_URL=https://dl.instaweb.top`, bytes on disk at `/opt/spaceworker-hosting`, outside the deploy tar). `AdminSetting.hostingEnabled=true`. P2 added user-owned short links (`/r/<slug|token>`, reusing the Task 30 `LinkRedirect` with two NULLABLE columns so campaign links are untouched), a BYO-credential store (`HostingCredential`, AES-256-GCM via `lib/mailbox-crypto.ts`, list returns a 4-char hint only, one default per provider) and the Cyber Lab nav/card/panel + admin RAM dials (still dark, `cyberlabEnabled=false`). Proven: `npx tsc --noEmit` → **0**, `CI=1 npx next build` → **exit 0** (all 15 new routes in the manifest + **shipped in the VPS client chunks**), **all 26 `test:*` suites pass** (`test:hosting` now **39/39**), and a **live authenticated** hit of production `/api/hosting/status` → **HTTP 200** (`enabled:true`, `entitled:true` reason `premium`, `publicBase https://dl.instaweb.top`, caps `storageQuotaMb 10240 / maxFileSizeMb 512 / maxLinks 50`) plus SSR-proved nav + dashboard cards for **Hosting** and **Cyber Lab**. Earlier this day: Task 155 **P1** built+proven+pushed (`a131835`); T0 spikes passed (26 MiB → 500); owner answered §13, supplied the throwaway Cloudflare account/token, ruled **all caps are admin-editable** (§14) and **user files served from the instaweb public family** (§15). TASK_150 closed (T6 waived).)**

### 6.1 Live app — `main`

| | |
|---|---|
| Branch / HEAD | `main` @ **`bb6ff6c`** (TASK_155 P3). The last code commits before it: `435d419` (P2) and `a131835` (P1). Run `git log --oneline -1` to re-check — §6 can lag (trap 14). |
| Sync | in sync with `origin/main` (`282ee9a..bb6ff6c` pushed); working tree **clean** |
| Deployed to production | **`LjgrTG69r2eiN-w07Hj-i`**, `BUILD_ID` mtime **`2026-10-02 06:56:12 CEST`**, from `main` @ **`bb6ff6c`** — includes **P1 + P2 + P3** (hosting files engine, user-owned links, BYO credential store, **Pages engine: folder/zip → preview → publish, per-site engine picker, account chooser**). Verified live this session: `https://spaceworker.top/` → **200**, `/dashboard/hosting` → **307** (auth), `/api/hosting/sites` → **401** (auth-gated route exists), `/pv/<bad>` and `/hs/<bad>` → **404** (new public P3 handlers exist, no 500). |
| Deploy run | **`36966548887`** (`workflow_dispatch` @ `bb6ff6c`). |
| CI on current HEAD | push run for `bb6ff6c`: `Build & typecheck` green; `Deploy to production (manual only)` = skipped (workflow_dispatch-gated). |
| Migrations applied | **`20261028000000_task155_p1_hosting_files`**, **`20261028000001_task155_p2_links_credentials_caps`** AND **`20261029000000_task155_p3_pages_sites`** are **applied to production** — the P3 deploy's in-window `prisma migrate deploy` reported *"Database schema is up to date!"* and the P3 migration is recorded (`finished_at 2026-10-02 06:58:17 CEST`). Production now has `HostedAsset`, `HostingUsageMonthly`, `HostingCredential`, **`HostingSite`, `HostingRevision`, `HostingJob`** and the extended `AdminSetting.hosting*` columns. `AdminSetting.hostingEnabled = true`. |

### 6.2 What the deploy contained (verified live, not assumed)

**The current deployed build is `LjgrTG69r2eiN-w07Hj-i` (`main` @ `bb6ff6c`) — it adds Task 155
**P3** on top of everything below (the Pages engine: folder/zip → preview → publish, the per-site
engine picker + account chooser, `/pv/` + `/hs/` public handlers).** The bullets in this sub-section
describe the *earlier* build `iyIlFSwZhjQ_1Rap4MFWC` (`3d484af`) and remain accurate for what is
still live from that deploy:

*Describes the build `iyIlFSwZhjQ_1Rap4MFWC` (`main` @ `3d484af`), which was the
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

`systemctl --failed` → **empty** (re-checked 2026-10-02 after the P3 deploy). Running:
`spaceworker`, `spaceworker-browser`, `extraction-worker` all **active** (plus `screenshot-capture`,
`exit-node-us1`, `exit-node-us2`). Timers armed: `dispatcher`, `mail-queue-drain`,
`screenshot-sweep`, `screen-notify-sweep`, `payment-verify`, `automations-sweep`,
`device-onboarding-sweep`.

**Post-deploy caveat (proved 2026-10-01, still applies):** right after a deploy, `systemctl --failed`
can show **`device-onboarding-sweep.service` failed** — its 5-minute tick collided with the
deploy's stop/extract window and `curl` exited **7 (connection refused)**. The journal showed
every earlier tick `{"ok":true,...}`; the *next* tick (15:30:40) exited `status=0/SUCCESS` and
`--failed` returned empty. **A post-deploy oneshot failure is a false alarm unless it survives
the next clean tick** — see §5 trap 15. (On the 2026-10-02 P3 deploy `--failed` was empty
immediately, so the transient did not recur.)

### 6.4 Known-unverified (do not claim these work)

- **TASK_155 P3 (Pages engine) — what is live vs what is only proven locally.** *Stated plainly so no
  later reader mistakes a local proof for a production fact:*
  - **LIVE and proven this session:** the code is deployed (`LjgrTG69r2eiN-w07Hj-i` @ `bb6ff6c`), the
    `20261029000000_task155_p3_pages_sites` migration is **applied to production** (3 new tables exist),
    `/dashboard/hosting` exists (307 → /login), the write routes exist and are auth-gated
    (`/api/hosting/sites` → **401**), and the **new public P3 handlers are live and not 500** —
    `GET /pv/<bad>` and `/hs/<bad>` → **404** via the app (a missing route would be a 404 too but the
    handlers are present in the built manifest — see §8's "grep the built chunks" rule).
  - **NOT verified — the production *write* path.** No user has run *create site → zip → preview 200 →
    publish → live 200* on production. That flow (and the ZIP parse/`7z` extract/quota logic) was proven
    on the scratch DB + `next start` with the real `7z` binary (`tests/hosting-pages.test.ts`), **not**
    on the VPS. **First manual check for the lead:** create one site, upload a small zip, open the
    preview URL, press Publish, fetch the live URL from the public internet.
  - **Premium/Cloudflare leg is proven against the THROWAWAY account only.** The four-call Pages
    Direct-Upload deploy ran against `CLOUDFLARE_ACCOUNT_ID_DEV`/`CLOUDFLARE_API_TOKEN_DEV`; no real
    customer BYO token has driven a deploy. The **platform** credential is the throwaway account
    (`lib/hosting/cloudflare.ts`), and a dead/manifest-mismatched token fails **closed** (§16.4) rather
    than falling back to LOCAL — proven by tests, not by a live customer run.
  - **`external` storage engine is still REGISTERED BUT NOT IMPLEMENTED** (only `local` and `cloudflare`
    are implemented). Selecting `external` throws the typed `HostingProviderNotReadyError`.
  - **Cyber Lab** is **dark** (`cyberlabEnabled=false`): nav item + dashboard card + panel + admin RAM
    dials exist, but no lab capability runs. Task 156 C2+ is not started.

- **TASK_155 P1/P2 (hosting) — legacy local proofs (still valid for those features).** The P1/P2 *write*
  path (file upload → `/hf/<token>` 200 → rename → delete) and the local links/credentials proofs were
  run on the scratch DB + `next start :3999` (`spaceworker_t155`), **not** on prod; the `dl.*`
  `location /hf/` proxy **is** proven live by the body of `GET https://dl.instaweb.top/hf/deadbeef`
  (`application/json` app 404, not nginx's plain 404).

- **TASK_154 N3 was EVALUATED, not built (2026-10-01).** Its gate — *“only if
  hostname-keying demonstrably bites”* — was tested against the **LIVE** fleet and **FAILS**.
  Raw evidence in §12: TRMM `(client_id, hostname)` duplicates = **0**; SW non-removed
  `Device.name` duplicates per user = **0**; and across all **6** live SW orgs the Vantra
  `/idle` map keys are **distinct** and **every** SW device name resolves to its mesh key
  (`I`→104, `WilkSF9`→0, `Sc`→0, `CSFD-CHECKOUT`→15). The mechanism is real but **latent**:
  a *forced* collision collapses two agents onto one key and makes the idle machine read
  `online · active now` (**SIMULATION**, §12). N3 therefore stays a **correctly-filed
  follow-up (cross-repo, needs a Vantra change), NOT a defect** — do not “fix” it
  speculatively across two repos. See §5 trap 17.

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
| ~~1~~ | ✅ ~~**TASK_154 N3** — key idle by agent id, not hostname~~ **EVALUATED 2026-10-01 — gate FAILS, does not bite; no code written** | `TASK_154_...md` §3 N3 | Live evidence in §12; trap 17. Cross-repo (needs a **Vantra** change). Left as a latent, correctly-filed follow-up — **not** a defect. |
| ~~1~~ | ✅ ~~**TASK_150 T6** — confirm/fix changing the test email mid-send~~ **WAIVED by the owner 2026-10-01** — *"we can add another test email during send, that's enough for now; I tested that."* **NOT queued** | `TASK_150_...md` §3 T6 | Closes TASK_150 (T1–T5 done). Do not re-open unless the owner reports it again. |
| ~~4~~ | ✅ ~~**TASK_155 P1** — hosting FILES engine (`/hf/<token>`, admin-capped)~~ **DONE + PUSHED 2026-10-01 (`a131835`) + DEPLOYED 2026-10-02 (live in `435d419`)** | `PLAN_TASK_155_...md` §9 P1 | Code + one additive migration (applied to production) + `tests/hosting-files.test.ts`. The `dl.*` nginx `location /hf/` was added on the P2 deploy. |
| ~~5~~ | ✅ ~~**TASK_155 P2** — user-owned redirects + BYO credential store + Cyber Lab scaffolding~~ **DONE + DEPLOYED + LIVE 2026-10-02 (`435d419`, run `36933764632`)** | `PLAN_TASK_155_...md` §9 P2 | `hostingEnabled` flipped **on**; Hosting tab public; Cyber Lab dark. Next build is **P3** (see the owner-requested table below). |
| ~~7~~ | ✅ ~~**TASK_155 P3** — Pages engine (folder/zip → preview → publish) + per-site engine picker + account chooser~~ **DONE + DEPLOYED + LIVE 2026-10-02 (`bb6ff6c`, run `36966548887`)** | `PLAN_TASK_155_...md` §16/§9 P3 | Additive migration applied; `test:hosting` **39/39**. Next build is **D2 / Task 156 C0→C1** (see the owner-requested table below). |


| | ~~6~~ | ✅ ~~**TASK_155 P3** — Pages engine + folder→preview→publish + the engine switch + the account chooser~~ **DONE + DEPLOYED + LIVE 2026-10-02 (`bb6ff6c`, run `36966548887`, build `LjgrTG69r2eiN-w07Hj-i`)** | `PLAN_TASK_155_...md` §16/§9 P3 | `cloudflare` engine implemented (raw REST Direct Upload, fail-closed §16.4); zip → `7z` extract → **preview** (`/pv/<token>/`) → **publish** (`/hs/<token>/`); per-site engine picker + §16.4 account chooser; premium has its own `hostingPremium*` cap family (§16.3); job lock + metrics recorded for the later governor (§16.6). 9 new `AdminSetting` columns + 2 NULLABLE `HostingCredential` cols + `HostingSite`/`HostingRevision`/`HostingJob` in one **additive** migration (applied to production). `tests/hosting-pages.test.ts` + `test:hosting` **39/39**. |

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

**Owner-requested design work (Task 155 **P1 + P2 + P3 are DEPLOYED and LIVE**, `bb6ff6c`; **D2/Task 156 C0→C1 is the next build**):**

| # | Task | Doc | Notes |
|---|---|---|---|
| ~~1~~ | ✅ ~~**D1 — Task 155 P1** (files engine on our own metal)~~ **DONE + PROVEN + PUSHED + DEPLOYED 2026-10-02 (`a131835`, live in `435d419`)** | `PLAN_TASK_155_WORKERS_AND_PAGES.md` §9 P1 | `/hf/<token>` upload/list/rename/delete behind the new `hosting` entitlement; rename rewrites only `dispositionFilename`/`mime` so **sha256 is provably unchanged**; every cap is an admin-editable `AdminSetting` (live change, no redeploy — proven in a real browser); engine registry `local` implemented / `cloudflare`+`external` registered. `tests/hosting-files.test.ts` (**26/26**), E2E **36/36**, browser **23/23**. Migration applied to production. |
| ~~2~~ | ✅ ~~**D1 — Task 155 P2** (user-owned redirects, BYO credential store, Cyber Lab scaffolding)~~ **DONE + DEPLOYED + LIVE 2026-10-02 (`435d419`)** | same doc §9 P2 | `/r/<slug\|token>` user-owned links (two NULLABLE `LinkRedirect` columns — campaign links untouched); `HostingCredential` (AES-256-GCM, 4-char hint only, one default per provider); Cyber Lab nav/card/panel (`cyberlabEnabled=false`) + admin RAM dials. `test:hosting` **39/39**, all 26 suites green, live prod `/api/hosting/status` → 200 `enabled:true`. `hostingEnabled` flipped **on**. |
| ~~3~~ | ✅ ~~**D1 — Task 155 P3** (Pages engine + folder→preview→publish + the engine switch + the account chooser)~~ **DONE + DEPLOYED + LIVE 2026-10-02 (`bb6ff6c`, run `36966548887`)** | same doc **§16 BINDS it** + §8/§9 P3/§14 | `cloudflare` engine implemented (raw REST Direct Upload); **zip → extract (`7z`) → preview → publish**; **per-site engine picker** ("Our server" vs "Premium"); the §16.4 **account chooser** (platform + BYO, verify-on-save); premium's **own** cap family (§16.3); job lock + metrics recorded for the later governor (§16.6). `tests/hosting-pages.test.ts` added (real `7z`); `test:hosting` **39/39**. New trap 22. |
| **1** | **D2 — Task 156 "Cyber Lab, real-world"** — **NEXT, start now at C0 → C1 ONLY** | `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` **§12 (owner addendum 2026-10-02, BINDING)** | **Depends on 155 P1/P2/P3 (ALL DONE + LIVE).** C0 = AUP + LabConsent text (screen + repo doc; nothing runs before it exists). C1 = one **additive** schema migration + the `cyberlab` gate (key already in `ENTITLEMENT_KEYS`) + staff badge + admin `Lab*` limits + `LabToolCatalog` rows (§12.1) + the read-only Research admin page. **C2+ is NOT this run.** Reuse 155 §14's cap mechanism; reuse the existing panic switch / `AgentActionAudit` / `UserEntitlement`; **never the prod VPS**; **do not edit `lib/resource-governor.ts`**. See `PROMPT_NEXT_AGENT.md`. |

*D1's P1, P2 **and** P3 are **deployed and live** (`bb6ff6c`, build `LjgrTG69r2eiN-w07Hj-i`); the
`dl.*` `location /hf/` proxy is live and proven, `hostingEnabled=true`, and the Pages flow serves from
`/pv/` + `/hs/`. **D2 / Task 156 C0→C1 is the next live-app item** (its own doc §12). **Converters are
OFF (§16.5)** — do not install `sharp`/`ffmpeg`/`libreoffice`; rename-with-unchanged-bytes is the whole
file story for now. **`lib/resource-governor.ts` is out of scope** — the governor task comes later
(155 §16.6).*

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

### 2026-10-01 — TASK_154 N3 gate EVALUATED against the LIVE fleet: does NOT bite → no code written; new trap 17; N3 struck, TASK_150 T6 promoted

- **Did:** discharged TASK_154 §3 N3 (*“key idle by agent id, not hostname”*) — a task whose own doc
  gates it (*“only if hostname-keying demonstrably bites”*, *“not required for the owner’s fix… only
  if the owner wants it”*, *“cross-repo”*). Tested the gate with raw evidence instead of implementing
  it; on a **negative** result I wrote **no application code** (a real fix needs the **Vantra** repo,
  out of this task’s one-repo scope) and instead recorded the finding. New **§5 trap 17**, **§6.4**
  bullet, **§7** (strike N3, promote **TASK_150 T6**), this entry; TASK_154 doc **Status** + §3 N3
  marked evaluated. Throwaway repro harness created, run, and **removed** (not committed).
- **Reproduce (SIMULATION — hand-built org/mesh, NOT live):** drove the **REAL**
  `app/api/devices/route.ts` + the **REAL** `idleChipLabel` (house require-hook, real code, stubbed
  deps) with two distinct devices sharing one hostname vs. distinct hostnames. Raw:
  ```
  COLLISION  dev-A idleSeconds= 5 chip= "online · active now" (truth: idle 900s)
  COLLISION  dev-B idleSeconds= 5 chip= "online · active now" (truth: idle 5s)
  COLLISION  both rows share one idleSeconds? true
  CONTROL    dev-A idleSeconds= 900 chip= "online · idle 15 min"
  CONTROL    dev-B idleSeconds= 5   chip= "online · active now"
  ```
  → the **mechanism is real**: a same-hostname collision collapses two agents onto one map key, so
  the idle machine reads `online · active now` (the exact TASK_154 R2 lie). Distinct hostnames are
  correct. **This is what the bug WOULD do — not what the live fleet does.**
- **Verified — the gate itself, against LIVE data (read-only; raw):**
  - **TRMM `(client_id, hostname)` duplicates → 0.** `SELECT c.id, a.hostname, count(*) FROM
    agents_agent a JOIN clients_site s ON s.id=a.site_id JOIN clients_client c ON c.id=s.client_id
    GROUP BY 1,2 HAVING count(*)>1` → **0 rows**. Per-client hostnames: `8/I`, `43/{Sc,WilkSF9}`,
    `44/I`, `47/CSFD-CHECKOUT` — **no client has two machines of the same name.**
  - **SW `Device.name` duplicates per user (non-removed) → 0**; **empty names → 0**.
  - **Vantra `/api/internal/sw/devices/idle` for ALL 6 live SW orgs** (Bearer token read on the VPS,
    never printed): `cmucs1rq5…`→`{}`, `cmue394ot…`→`{"WilkSF9":0,"Sc":0}`, `cmufkhca6…`→`{"I":104}`,
    `cmulntqlg…`→`{}`, `cmuncir0v…`→`{}`, `cmuncovco…`→`{"CSFD-CHECKOUT":15}` — **every key distinct
    and every SW device name resolves to its mesh key** (`I`→104, `WilkSF9`→0, `Sc`→0,
    `CSFD-CHECKOUT`→15). HTTP 200, ~0.10–0.15 s each.
  - **Conclusion:** hostname-keying does **not** demonstrably bite on the live fleet → the gate
    **fails** → N3 is a latent, correctly-filed follow-up, not a defect.
- **Regression / tree health (no code changed, so before == after):** `npx tsc --noEmit` **EXIT=0**;
  `CI=1 npx next build` **EXIT=0** (BEFORE it briefly reported the known stale-`.next/types`
  `Cannot find module './routes.js'` artifact — cleared once the build regenerated `.next/types`);
  **full sweep: 25/25 `test:*` suites, 0 fail** (incl. `test:idle`, `test:idlechip`, `test:devices`,
  `test:vantra`).
- **NOT verified (expected):** no code change → nothing new to verify at runtime; nothing was
  **deployed** (deploy is a separate manual gate and there is no code to ship). The collision is a
  **SIMULATION** — the live fleet was checked and is collision-free, so the failure was **never
  observed in production**. The **Vantra-side agent-id keying was not built** (out of this task’s
  scope). Cross-user leak was reasoned (idle is per-org, so a hostname cannot cross users) but not
  separately exercised.
- **State left behind:** `main` @ this docs commit; tree clean, in sync with `origin/main`; CI on the
  current HEAD `4f0e96c` **success** (run `36878242413`, deploy job skipped). **Deployed build
  unchanged** — `iyIlFSwZhjQ_1Rap4MFWC`, mtime `2026-10-01 16:19:43 CEST`; `systemctl --failed`
  **empty** (0 loaded units). `self-hosted-build` @ `f6b6f78`, clean (untouched).
- **Next:** `main` — **TASK_150 T6** (confirm/fix changing the test email mid-send), the last item of
  TASK_150. Self-hosted — **T11** (the live kill). Design work (155/156) waits on the owner’s answers.


### 2026-10-01 — TASK_150 CLOSED (owner waived T6); D1/Task 155 promoted to NEXT — still gated on §13
- **Did:** (a) Owner **waived TASK_150 T6** (*"we can add another test email during send,
  that's enough for now; I tested that."*) → `TASK_150_...md` header + §3 T6 marked **CLOSED /
  T6 not needed** (T1–T5 already done: `35ce6bf`, `fb83115`, `a49c660`, `57e11ce`, `3f9bb18`).
  (b) Handoff **§7** struck T6 and promoted **D1 / Task 155** to **NEXT**, keeping it gated on
  the owner's **§13** answers + the **T0 spikes**. (c) `PROMPTS_SENIOR_ENGINEERS.md` T6 block
  marked **WAIVED** and the two "next item" lines corrected. (d) Scoped D1 against the real
  tree (see Verified). **No application code changed.**
- **Verified:** `git rev-parse --short HEAD` = `335c951`; `git status --porcelain` **clean**
  before the edits. Tree facts for D1: `lib/entitlements.ts:12` `ENTITLEMENT_KEYS` =
  `[extractor, mailer, assistant, devices, cyberlab]` (**no `hosting`**);
  `components/dashboard-nav.tsx:36` `NAV_ITEMS` + `:52` `BUILD_ALLOWED_HREFS` (single-source
  nav confirmed); `/r/[token]` + `LinkRedirect` (`prisma/schema.prisma:1155`) live;
  `lib/link-cloak.ts` + `lib/mailbox-crypto.ts` exist; deps — `sharp` **ABSENT**,
  `wrangler` **ABSENT**, `xlsx ^0.18.5` present, `pdfjs-dist ^5.6.205` present; last migration
  `20261027000000_task152_m6_capture_scheduler`.
- **NOT verified:** nothing behavioural — this is a docs + scoping pass. The two T0 spikes
  (Cloudflare Direct-Upload Direct REST + the 25 MiB rejection, and R4/R15/custom-domain) were
  **not** run — they need a real Cloudflare account/token (owner's).
- **State left behind:** `main` @ this docs commit; tree clean, in sync with `origin/main`.
  **Deployed build unchanged** — `iyIlFSwZhjQ_1Rap4MFWC`, mtime `2026-10-01 16:19:43 CEST`.
  `self-hosted-build` untouched (`f6b6f78`).
- **Next:** owner answers **`PLAN_TASK_155_WORKERS_AND_PAGES.md` §13** (5 Qs) + supplies a
  Cloudflare account/token for **T0**; then D1 starts at **T0 → P1 (files on our own metal)**.


### 2026-10-01 — Task 155 §13 answered + throwaway Cloudflare account supplied; T0 prerequisites PROVEN LIVE; D1 UNGATED
- **Did:** (a) Owner answered `PLAN_TASK_155_...md` **§13** and supplied a **throwaway Cloudflare
  account token** (kept in the gitignored `spaceworker/.env` as `CLOUDFLARE_API_TOKEN_DEV` +
  `CLOUDFLARE_ACCOUNT_ID_DEV`; the tracked `.env.example` gained **blank** `CLOUDFLARE_API_TOKEN`
  / `CLOUDFLARE_ACCOUNT_ID` + a security note). (b) Ran the **T0 prerequisite probes live** (see
  Verified). (c) Recorded the owner's binding decisions in the plan **§13.1–13.3**, refreshed the
  plan header + §2/§12 status, added handoff **trap 18**, updated **§6** last-verified and
  **§7** (D1 now **UNGATED**, start at T0), and rewrote the `PROMPTS_SENIOR_ENGINEERS.md` D1
  block to match (start-now, free-first, T0-first, security rules, cap-in-every-mode).
  **No application code changed.**
- **Verified (raw Cloudflare API, live, 2026-10-01):**
  `GET /user/tokens/verify` → `{"id":"dbe2bd7375e2fdfd03b478a440ae0aae","status":"active"}`
  (`success:true`). `GET /user` → `9109 Unauthorized`; `GET /memberships` → `10000 Authentication
  error`; `GET /accounts` → `result: []` (`total_count: 0`) ⇒ the token is **account-scoped** and
  does **not** enumerate its own account. Owner then supplied **Account ID
  `4c822d3b5378019cef1e1b79a3bf0492`** (+ subdomain `channelchannel4747.workers.dev`). With it:
  `GET /accounts/{id}/pages/projects` → **200**, `success:true`, **`total_count: 6`** — projects
  `fileshare`, `filesharing`, `securefilesharing`, `new`, `cfdirect`, `cfredirect` (all
  `*.pages.dev`); `GET /accounts/{id}/workers/scripts` → **200**, `result: []`;
  `GET /accounts/{id}/r2/buckets` → **403** (no R2 scope). Gotchas: `?per_page=50` on
  `/pages/projects` → `8000024 Invalid list options` (use `per_page=10`); `GET /accounts/{id}`
  (the object itself) → `success:false`, yet sub-resources answer 200.
- **NOT verified:** the actual **T0 spikes** — a real **Direct-Upload deploy over raw REST**, the
  **25 MiB rejection** (upload 26 MiB → fail), **R4** (Direct Upload vs the 500-builds/month
  quota), **R15** (Workers free limits), and the **custom-domain** endpoint — **not yet run**;
  only the token/scope/account prerequisites are proven. Nothing user-visible was built.
  **SIMULATION: none** — every claim above is a live API response.
- **State left behind:** `main` @ this docs commit; tree clean, in sync with `origin/main`.
  **Deployed build unchanged** — `iyIlFSwZhjQ_1Rap4MFWC`, mtime `2026-10-01 16:19:43 CEST`.
  `self-hosted-build` untouched (`f6b6f78`). The throwaway token is live in the local `.env`
  only; **revoke it once T0 is done**.
- **Next:** **D1 / Task 155 — run the T0 spikes** (§9) against the account above, then **P1**
  (files on our own metal). Converters (155 §13 Q4) still open — do not install heavy binaries.

### 2026-10-01 — Task 155 T0 spikes PASSED (raw evidence); owner ruled caps are admin-editable; D1 ready for P1
- **Did:** (a) Ran the **T0 spikes** against the throwaway Cloudflare account — **S0-a** (docs +
  probe: R1/R3/R5/R7 + **R4 resolved**) and **S0-b** (**Direct Upload over raw REST**, end-to-end).
  (b) Recorded the full protocol + raw evidence in `PLAN_TASK_155_...md` **§9**, set the header to
  **T0 DONE**, and added **§14 "Admin-editable caps"** from the owner's 2026-10-01 instruction
  (*"You can decide the limit … add to the admin where those limits can be easily changed, and also
  all caps for the workers and cyberlab"*) with chosen defaults. (c) Added handoff **trap 19**;
  refreshed **§6** last-verified and **§7** (D1 now **T0 PASSED — START P1**). (d) Updated the
  `PROMPTS_SENIOR_ENGINEERS.md` D1 block (T0 done, caps-in-admin). **No application code changed.**
- **Verified (raw, live, 2026-10-01):** created project `sw-t0-spike`; manifest hash =
  `blake3(base64(bytes)+ext)`→hex→32 chars (blake3 validated vs the `abc` vector
  `6437b3ac…9d85`); `upload-token` → `check-missing` → `assets/upload`
  (`{"successful_key_count":3,"unsuccessful_keys":[]}`) → `upsert-hashes` →
  `deployments` (multipart `manifest`+`branch`) → `latest_stage.status:"success"`. Served proof
  via **Node fetch**: `https://sw-t0-spike.pages.dev/` → **200 text/html** with the exact uploaded
  HTML; `/hello.txt` → **200 text/plain** with the exact bytes. **25 MiB cap witnessed:**
  `24 MiB → 200`, `25 MiB → 200`, **`26 MiB → 500`** (`Worker threw exception`). **R4 RESOLVED:**
  Direct Upload is **not** a build. Project **deleted** (account back to 6).
- **NOT verified:** the **custom-domain endpoint** was identified
  (`POST …/pages/projects/{p}/domains`) but **not executed** (premium-only; §13); **R15** Workers
  free requests/day not cleanly captured (deferred to P5). Nothing user-visible was built.
  **SIMULATION: none** — every result above is a live API response.
- **State left behind:** `main` @ this docs commit; tree clean, in sync with `origin/main`.
  **Deployed build unchanged** — `iyIlFSwZhjQ_1Rap4MFWC`, mtime `2026-10-01 16:19:43 CEST`.
  `self-hosted-build` untouched (`f6b6f78`). Throwaway token still in the local `.env` only.
- **Next:** **D1 / Task 155 — P1** (files on our own metal, dark behind `hosting`, caps per §14).
  Converters (155 §13 Q4) still open — do not install heavy binaries.

### 2026-10-01 — TASK_155 P1 BUILT + PROVEN + PUSHED (`a131835`); NOT deployed; TASK_150 T6 recorded as NOT NEEDED
- **Did:** Built **Task 155 P1** — the hosting **FILES** engine on our own metal: upload / list /
  rename / delete, served publicly at **`/hf/<token>`**, behind the **new `hosting` entitlement**,
  **dark** (`hostingEnabled=false` by default). Every cap is an **additive `AdminSetting` column**
  (10 of them) enforced **server-side**, editable in the admin **Infrastructure → “Hosting limits
  (Workers & Pages)”** panel, so a limit change is **live without a redeploy**; the storage engine
  is a **registry** (`local` implemented; `cloudflare` / `external` registered, `implemented:false`)
  picked from the same panel, so a file can live on our metal **or** a third party. One **additive**
  migration (`20261028000000_task155_p1_hosting_files`) — 10 defaulted columns + 2 empty tables, zero
  row rewrites. Added `tests/hosting-files.test.ts` + `npm run test:hosting`.
  **Also (same session, doc-only):** marked **TASK_150 T6 “test email mid-send” NOT NEEDED** in
  `TASK_150_LIVE_CAMPAIGN_AND_EXTRACTOR_FIXES.md` per the owner — *“we can add another test email
  during send, that's enough for now, I tested that”* — so T6 will not be picked up by anyone.
- **Verified (raw, this session, all local — NOT production):**
  - `npx tsc --noEmit` → **exit 0**.
  - `CI=1 npx next build` → **exit 0**, `✓ Compiled successfully in 53s`; the build manifest lists
    `ƒ /api/admin/hosting`, `ƒ /api/hosting/status`, `ƒ /api/hosting/files`,
    `ƒ /api/hosting/files/[id]`, `ƒ /dashboard/hosting`, `ƒ /hf/[token]`. (2 *warnings*, 0 errors —
    one of them new, see trap 20c.)
  - `npm run test:hosting` → **26/26 pass, 0 fail**.
  - **E2E against a real Postgres scratch DB + a real `next start` (port 3999)** — `36/36`:
    unauthenticated `/api/hosting/status` **401**; entitled **200** with `providers=[local,
    cloudflare,external]` and `publicBase=https://dl.instaweb.top`; a real EXE upload → **201** with
    the **real sha256**; `GET /hf/<token>` → **200** with **byte-identical** bytes; **the rename
    anchor**: `PATCH` rename → the `Content-Disposition` filename changes to
    `Totally Different Name.exe` while `sha256` and the served bytes are **identical**;
    `.php` → **400 `blocked_extension`**; EXE without ack → **400 `gated_ack_required`**; another
    user's file → **404**; `PATCH /api/admin/hosting` without the admin cookie → **403**;
    `freeMaxFileSizeMb=7` → **200** and **immediately live** in `/api/hosting/status` (`got=7`,
    *no restart*); `pagesMaxAssetMb=999` → **400** (hard 25 MiB ceiling); `freeMaxFiles=0` → **400**;
    unknown field → **400**; and the **quota-breach anchor**: a 2 MB upload under a **1 MB** admin cap
    → **400 `quota_file_size`** with the human message *“Files are limited to 1 MB each.”* —
    **never a 500**; delete → **200** then `/hf` **404**.
  - **Headed-browser proof (real Chromium, real DOM, screenshots in `/tmp/t155-ui/`)** — `23/23`:
    the Hosting tab renders and lists the uploaded file with its **server-computed sha256 prefix** and
    download count; the **rename in the UI** changed the displayed filename while the list still showed
    the **same sha256** (`9e7c0020df82…`); a browser navigation to `/hf/<token>` → **200** with
    **byte-identical** bytes and the **renamed** filename in `Content-Disposition`; then admin login
    (real passcode) → **Infrastructure** shows the **Hosting limits** panel with all four cap rows,
    the **live counters** (`7 file(s) · 0.00 GB stored · 7 user(s)`) and the **storage-engine picker**;
    clicking **Set** on *Max file size* = **9** was read back **from the customer's own session**
    (`/api/hosting/status` → `maxFileSizeMb=9`) **and** from `AdminSetting.hostingFreeMaxFileSizeMb=9`
    → **an admin cap change is live with no redeploy**. No uncaught page errors.
  - **Nothing else broke:** every `test:*` suite re-run → **0 failures** across all 26 suites
    (engine 79, vantra 58, domains 37, screenshots 36, governor 26, hosting 26, screennotify 16,
    message 15, summaries 15, …).
- **NOT verified (expected, not a weakness):** P1 is **not deployed**, so **nothing about it is
  live**. `GET https://dl.instaweb.top/hf/<token>` has **never been attempted** — and **will 404
  until the `dl.*`/instaweb vhost on the VPS gets a `location /hf/` proxy** (that nginx config is
  **on the VPS, not in this repo**; `deploy/nginx-spaceworker.conf` only declares
  `server_name spaceworker.top` → `127.0.0.1:3500`). `prisma migrate deploy` against production is
  **unrun**. The `cloudflare` / `external` engines are **registered but not implemented** (a typed
  `HostingProviderNotReadyError`, not a silent failure). **SIMULATION: none** — every line above is
  real HTTP / a real browser / a real DB; the only thing simulated is *nothing at all*.
- **State left behind:** `main` @ **`a131835`**, pushed to `origin/main`, **working tree clean**.
  **Deployed build unchanged** — still `iyIlFSwZhjQ_1Rap4MFWC`, mtime `2026-10-01 16:19:43 CEST`
  (`3d484af`). `self-hosted-build` untouched. The scratch DB `spaceworker_t155` + its test users/assets
  still exist locally (harmless, isolated); the ad-hoc harnesses were removed from the repo tree and
  kept only in `/tmp` (`/tmp/t155_e2e.final.mjs`, `/tmp/t155_ui.final.mjs`).
- **Next:** **P2 (redirects, user-owned)** — promote the live `/r/<token>` + `LinkRedirect` to
  user-owned links + custom slugs + hit counts **without changing `/r/`'s current behaviour**. The
  lead must first decide the **P1 deploy + migration** and the **`dl.*` nginx `location /hf/`**.
  Converters (155 §13 Q4) still open — do not install heavy binaries.
### 2026-10-02 — TASK_155 P2 BUILT + DEPLOYED + VERIFIED LIVE; master switch FLIPPED ON; new trap 21

- **Did:** built and shipped **P2** of Task 155 — (a) **user-owned short links** on the existing
  Task 30 `LinkRedirect` row (two **NULLABLE** columns added, so every campaign/`/r/<token>` link
  keeps its exact behaviour); (b) the **BYO Cloudflare credential store** `HostingCredential`
  (account id + token at rest AES-256-GCM via `lib/mailbox-crypto.ts`; the list API returns a
  **4-char hint only**; exactly one `isDefault` per provider); (c) the **Cyber Lab** nav item +
  dashboard card + a dark panel + the **admin RAM dials** (`cyberlabEnabled=false`); (d) the new
  **`hosting` entitlement** live end-to-end. Then **dispatched `deploy.yml`** (run `36933764632`),
  which applied the migrations in-window and set the box up, **added the nginx `location /hf/`
  proxy** on the `dl.instaweb.top` vhost over SSH, set `HOSTING_PUBLIC_BASE_URL` +
  `HOSTING_STORAGE_DIR=/opt/spaceworker-hosting` in `/opt/spaceworker/.env`, and **flipped
  `AdminSetting.hostingEnabled = true`**.
- **Verified:** `npx tsc --noEmit` → **0**; `CI=1 npx next build` → **exit 0** (all 15 new routes in
  the manifest **and** present in the shipped VPS client chunks); **all 26 `test:*` suites pass**
  (`test:hosting` now **39/39**); a **live authenticated** production `GET /api/hosting/status` →
  **HTTP 200** (`enabled:true`, `entitled:true` reason `premium`, `publicBase
  https://dl.instaweb.top`, caps `storageQuotaMb 10240 / maxFileSizeMb 512 / maxLinks 50`);
  SSR-proved **Hosting** + **Cyber Lab** nav & dashboard cards; `systemctl --failed` empty;
  `dl.instaweb.top/hf/<dead-token>` → **app-level JSON 404** (proves the nginx proxy is live — nginx's
  own catch-all is a plain 404).
- **NOT verified:** the production **write** path (upload → `/hf` 200 → rename → delete) — proven
  only on the local scratch DB (`spaceworker_t155`) + `next start :3999` (E2E **36/36**, browser
  **23/23**), never by hand on prod. `cloudflare`/`external` storage engines still registered-but-not-
  implemented. No real premium/BYO upload. **SIMULATION: none.**
- **State left behind:** `main` @ **`435d419`** (P2), pushed to `origin/main`; deployed build
  **`9RVryDnQoHNZL4NL-Zdy6`** (mtime `2026-10-02 00:15:49 CEST`); `hostingEnabled=true`; both hosting
  migrations applied to production; bytes at `/opt/spaceworker-hosting` (owned `trmm:trmm`, 750);
  `self-hosted-build` untouched.
- **Next:** **Task 155 P3** — the Pages engine (implement the `cloudflare` provider), folder/zip →
  extract (`7z`) → **preview** → **publish**, the per-item engine picker, and the §16.4 account
  chooser. **Converters are OFF** (owner 2026-10-02, §16.5). **`lib/resource-governor.ts` is out of
  scope** — the governor task comes after P3 (§16.6). See `PROMPT_NEXT_AGENT.md`.



### 2026-10-02 — TASK_155 P3 BUILT + DEPLOYED + VERIFIED LIVE (Pages engine: folder/zip → preview → publish); new trap 22; D2/Task 156 promoted to NEXT

- **Did:** Task 155 **P3** — the Cloudflare **Pages engine** + the **folder/zip → PREVIEW → PUBLISH**
  flow + the **per-site engine picker** + the **§16.4 account chooser**, per plan §16 (binding) / §9 P3 /
  §8 / §14 / §15. New/changed: `lib/hosting/{cloudflare,extract,serve,sites}.ts`, `lib/hosting/rules.ts`,
  `lib/hosting/credentials.ts`, `lib/hosting/providers.ts`, `app/api/hosting/sites/**` (create/list/get
  + revisions + publish), `app/api/hosting/credentials/[id]/verify/route.ts`,
  `app/api/hosting/status/route.ts`, `app/pv/[token]/[[...path]]/route.ts` (**preview**, noindex, TTL),
  `app/hs/[token]/[[...path]]/route.ts` (**live**, immutable), `components/hosting-panel.tsx`
  (engine picker + zip upload + preview/publish + account chooser), `app/api/admin/hosting/route.ts` +
  `app/admin/(protected)/admin-panel.tsx` (the new `hostingPremium*`/`hostingMaxZip*` dials),
  `prisma/schema.prisma` (9 `AdminSetting` cols + 2 NULLABLE `HostingCredential` cols +
  `HostingSite`/`HostingRevision`/`HostingJob`), migration
  `20261029000000_task155_p3_pages_sites`, `tests/hosting-pages.test.ts`, `package.json`
  (`test:pages`). **Additive only** — no existing column/row touched. Commits **`bb6ff6c`** (25 files,
  +3448/−13), pushed `282ee9a..bb6ff6c`; deploy run **`36966548887`** (`gh workflow run deploy.yml
  --ref main`).
- **Verified (raw):** `npx prisma validate` OK · `npx prisma generate` OK · `npx tsc --noEmit` → **0** ·
  `CI=1 npx next build` → **exit 0** (P3 routes in the manifest; P3 UI strings present in the shipped
  client chunk) · `npm run test:hosting` → **39/39** and the new `npm run test:pages` (real `7z`
  archive; caught trap 22) green. **Deploy:** both jobs `completed/success`; on the VPS
  `cat /opt/spaceworker/.next/BUILD_ID` → **`LjgrTG69r2eiN-w07Hj-i`** (mtime `2026-10-02 06:56:12 CEST`);
  `prisma migrate status` → *"Database schema is up to date!"*; `_prisma_migrations` shows
  `20261029000000_task155_p3_pages_sites` `finished_at 2026-10-02 06:58:17 CEST`; `pg_tables` shows
  `HostingSite`/`HostingRevision`/`HostingJob`/`HostingCredential`/`HostingUsageMonthly`;
  `systemctl --failed` → **empty**; `systemctl is-active spaceworker spaceworker-browser
  extraction-worker` → **active/active/active**. **Live behaviour (`spaceworker.top`):** `/` → **200**,
  `/dashboard/hosting` → **307**, `/api/hosting/sites` → **401** (auth-gated route exists),
  `/pv/<bad>` and `/hs/<bad>` → **404** (new public handlers exist, no 500).
- **NOT verified:** the production **write** path — no user has run *create site → zip → preview 200 →
  publish → live 200* on prod (proven on the scratch DB + real `7z`/`next start` only); the
  **premium/Cloudflare** leg ran against the **throwaway** account (`CLOUDFLARE_*_DEV`) only, no real
  BYO token; `external` storage engine still registered-not-implemented. **SIMULATION: none.**
- **State left behind:** `main` @ **`bb6ff6c`**, pushed to `origin/main`; deployed build
  **`LjgrTG69r2eiN-w07Hj-i`**; `hostingEnabled=true`; P1+P2+P3 migrations all applied to production;
  bytes at `/opt/spaceworker-hosting`; `self-hosted-build` untouched.
- **Next:** **D2 / Task 156 "Cyber Lab, real-world" — C0 (AUP/consent) → C1 (schema + gate + staff
  badge + admin `Lab*` limits + `LabToolCatalog` + read-only Research admin page) ONLY.** Build spec
  `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` **§12 (owner addendum 2026-10-02, BINDING)**. C2+ is a
  separate assignment. See `PROMPT_NEXT_AGENT.md`.

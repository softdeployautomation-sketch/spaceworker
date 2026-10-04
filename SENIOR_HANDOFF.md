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
**23. A FRESH database cannot replay the migration history in order — ≥5 migrations are
out-of-order, so `prisma migrate deploy` (or `db push` replay) fails on a brand-new DB.**
*(Hit 2026-10-02 on Task 155 P4.)* Applying the whole `prisma/migrations/` dir to an empty DB dies on
`20260914150000_add_license_claim_token` because it references the **`ExeLicense`** table that a
*later* timestamped migration creates (same for `20260921000000_device_tools_v2` → **`Device`**).
**The live DB is NOT affected** — its `_prisma_migrations` history is already recorded, so production
deploys succeed; only **new** DBs (scratch/local/CI) hit it. Workaround used: apply up to the break,
`npx prisma migrate resolve --applied <name>`, continue — **never edit another task's migration** to
"fix" it (that rewrites history). This is filed as a hygiene task in §7; do not re-diagnose it from
scratch.

**24. Cloudflare R2 IS NOT PART OF THE HOSTING PLAN — files stay LOCAL. Do not "finish" the R2 work.**
*(Recorded 2026-10-03 when a cancelled R2 implementation was reverted.)* The owner's binding answer
is **"files stay local instaweb; only sites and links get the cloudflare option; links are workers
on custom hosts; a link can just point at our own `/hf/<token>` url, so no bucket is needed."** So:
**Sites** = Pages (done), **Links** = Workers (the only remaining build, **P6c**), **Files** =
local only, one engine, no dial. Consequently there is **no R2 subscription, no bucket, no S3
access keys, no SigV4 client and no presigned-URL path** anywhere. A partial R2 implementation
(`lib/hosting/r2.ts`, `lib/hosting/storage-credentials.ts`, `HostedAsset.credentialId`, sixteen
`storage*` columns, migration `20261032000000_task155_p6bc_r2_workers`) existed uncommitted and was
**reverted — never deployed**. **Do not apply that migration, do not resurrect those files, and do
not add an engine column to `HostedAsset`.** If a doc or test still references R2, that reference
is stale: fix the reference, not the design. The general trap: *"files need a CDN, therefore object
storage"* — a hosted file already has a stable public `/hf/<token>` URL, which is a perfectly good
redirect **target**, so a link can be accelerated at the edge while the bytes stay on our disk.

**25. A green push run does NOT mean the code deployed. `deploy.yml`'s deploy job is
`workflow_dispatch`-gated — pushes only build.**
*(Recorded 2026-10-03, and it produced a false "deployed and verified" claim.)*
`.github/workflows/deploy.yml` triggers on `push: [main]` **and** `workflow_dispatch`, but the
deploy job carries `if: github.event_name == 'workflow_dispatch'`. So a push run goes **green**
with `Build & typecheck: success` and `Deploy to production: skipped`, and `gh run watch` exits
**0**. Proof it did not land: `systemctl show spaceworker -p ActiveEnterTimestamp` still pointed at
the *previous* deploy while `/opt/spaceworker/.next/BUILD_ID` was unchanged. **A push is a lint/type
gate, not a release.** To actually ship:

```
git push origin main
gh workflow run deploy.yml --ref main        # then watch THAT run id
gh run watch <run-id> --exit-status
gh run view <run-id> --json jobs -q '.jobs[] | "\(.name): \(.conclusion)"'   # BOTH must be success
```

Always confirm the box actually moved: `systemctl show spaceworker -p ActiveEnterTimestamp` and
`cat /opt/spaceworker/.next/BUILD_ID`. §10 says "only state what you actually saw" — a green
`gh run watch` on a push run is **not** evidence of a deploy, and this is the second-order trap:
the run id from `gh run list` is the **push** run unless you explicitly `gh workflow run`.

**26. A link row's `workerName`/`routePattern` are only set if THAT row's own publish
succeeded — never use them as the teardown key.**
*(Recorded 2026-10-03 on Task 155 P6c; this orphaned a live route in production.)*
The Worker route is keyed by **user + custom host**, not by any individual link, so the route a
row *records* is shared with all of its siblings. But `workerName`/`routePattern` are only written
when that row's publish reaches the end — a link created while the token lacked `DNS:Edit` fails
at the DNS step and records **NULL for both**. Deleting that row therefore passed
`routePattern=null` into teardown, which skipped route deletion entirely: the script was deleted,
the route survived, and Cloudflare served **500 on the customer's live domain** indefinitely. This
was not hypothetical — a real route (`go.instaweb.top/*` → `sw-027970396cd46c94fd3b39e958bbd5c5`)
was stranded that way and had to be swept manually. The irony: the failed row is the one most
likely to be deleted **last**, which is exactly the delete that triggers teardown. Fix:
`mapIdentityFor(userId, customHost)` in `lib/hosting/links-engine.ts` recomputes the identity
(it is a pure function of those two inputs); recorded values are a fallback only. **Generalise: any
teardown keyed on a per-row column is wrong when that column is nullable and the resource is
shared — derive shared-resource identity from its real inputs.**

## 6. Current state — revise this block every session

**Last verified: 2026-10-02 (Task 155 **P4** + Task 156 **C1** DEPLOYED + MIGRATED + VERIFIED LIVE — `main` @ `cab860a`, deployed build **`BWRMBHG8mkpIrzUPTQ8-t`** (`BUILD_ID` mtime `2026-10-02 12:33:13 CEST`), deploy run **36995895931** (`workflow_dispatch`, **success**, 5m16s). Two migrations applied **in-window** and recorded in `_prisma_migrations`: `20261030000000_task156_c1_lab_schema` and `20261030120000_task155_p4_premium_links` (both `finished_at 2026-10-02 12:35:49 CEST`) — **NULLABLE / additive, no row rewritten**. **P4** = the Hosting page is now a **Sites | Links | Files** tabbed surface (counts shown as badges; the P1 status strip is unchanged and stays the "what am I allowed" contract), the **premium link cap** is a new `AdminSetting.hostingPremiumMaxLinks` (default **500**, free keeps `hostingFreeMaxLinks` **50**) resolved through the SAME `resolveHostingCaps` mechanism as the free dial, the **Cloudflare account token moved to `dashboard/settings`** (new *Hosting accounts* card — same `/api/hosting/credentials/*` routes, token never echoed), and **zip → preview → publish** is surfaced as the *"test before production"* step. **Task 156 C0+C1** = the Cyber Lab is **PREMIUM-gated** (`cyberlab` entitlement — owner **A14**: there is **NO staff badge and NO staff gate** anywhere in SpaceWorker; a grep finds none, so do not add one), ten additive `Lab*` models + `AdminSetting.cyberlab*` dials, `lib/lab/**` (gate/consent/tools/catalog-seed/research), `LabToolCatalog` seeded with **16 rows** and a `staleAfter` date that hides a stale row, the **AUP/consent** recorded server-side (hashed) before anything runs, and the **read-only Research** admin page (feeds only — never an attack). **C0** = `TASK_156_CYBER_LAB_AUP.md` + the consent screen (`components/cyberlab-aup.tsx`). Proven this session: `npx prisma validate` OK · `npx tsc --noEmit` → **0** · `CI=1 npx next build` → **exit 0** · `npm run test:hosting` → **40/40**, `test:pages` → **19/19**, `test:lab` → **10/10** · **eslint at HEAD parity on every touched file** (the only errors are the pre-existing `react-hooks/set-state-in-effect` warnings in `admin-panel.tsx` / `hosting-panel.tsx`, which are present at HEAD too). Live: `BUILD_ID` + mtime above; the P4 UI string **`Hosting accounts`** is present in the **shipped client chunk** (`/opt/spaceworker/.next/static/chunks/3yoy8celt_47q.js`); both new migrations are in `_prisma_migrations`. **⚠ NOT verified live:** the P3/P4 **write** path — no real user has clicked *upload → preview → publish* on production (see §6.4); and the **email/password login** on prod was not re-confirmed this session. **⚠ NEW environment finding (not a regression, not yet fixed):** a **fresh** database cannot replay migration history in order — at least **5 migrations are out-of-order** (e.g. `20260914150000_add_license_claim_token` references the `ExeLicense` table that a *later* timestamped migration creates; `20260921000000_device_tools_v2` references `Device`). The **live DB is unaffected** (its history is already recorded, so deploys are safe); only **brand-new DBs** hit it. Worked around on scratch with `prisma migrate resolve --applied`; **the other tasks' migrations were NOT edited.** This deserves its own cleanup task (see §7).
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

### ★★ OWNER-DIRECTED SEQUENCE (2026-10-03) — this supersedes the table below for what comes first

The owner set this order explicitly: **domains → wallet → support tickets → marketing → then back to
Cyber Lab completion (Task 156).** Do not start Cyber Lab until marketing is done, even though
`PLAN_TASK_156` is fully scoped and is otherwise the "next" item in the older table.

| # | Workstream | Doc | State |
|---|---|---|---|
| **1** | **Domains** — hosting Domains section (BYO + platform), zone-create probe, pending-zone → nameservers → poll `active`, fallback to a prefilled ticket | `PLAN_TASK_157_PLATFORM_DOMAINS.md` §4 Phases 4–5 + `PLAN_TASK_155…` §18 | **Phase 4a SHIPPED + LIVE 2026-10-04** (`2805bb2`, migration `20261105000000_task157_user_domains` applied, deploy run `37192624610`). User self-service domains (list/add/delete/verify-one), admin list/add-on-behalf/delete, server-side ownership gating on link create/update, hosting Domains UI, DB CHECK constraints. Live-verified 28/28 route assertions + zero migration drift. ⚠️ **The `Zone:Edit` probe came back NEGATIVE (2026-10-03) — see §7.3**; automatic zone creation is still **not available**, so onboarding works for zones already in the account. Remaining: 4b ticket fallback, 4c, Phase 5 restructure, admin Domains UI, `credentialId` enforcement, site-publication wiring. |
| **2** | **Wallet / balance-first billing** — top up, spend on premium **and on EXE licenses**, admin grant, immutable ledger | **`PLAN_TASK_158_WALLET_BALANCE.md`** (new this session) | **Designed, not started.** 6 phases W1–W6 |
| **3** | **Support tickets** — user/admin, threaded, zone metadata only, **never a Cloudflare token** | `PLAN_TASK_157…` §4 Phase 6 | **Scoped, not started.** No `SupportTicket` model exists yet |
| **4** | **Marketing** for the new tools (hosting domains, wallet, tickets) | **needs its own doc** | **Not started.** No doc yet — write one before coding |
| **5** | **Cyber Lab C2+ completion** | `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` | Deferred by the owner until #4 lands |

**Sequencing note:** #1 and #2 both touch the admin panel and `prisma/schema.prisma`, so they are
**sequential, not parallel** (this file's standing rule). #2's migration (W1) must also be the
**first** thing that exercises the `ExeLicense.paymentId` nullable change, since that is the one
schema edit with a live blast radius.

### 7.1 Wallet / balance-first billing — what the owner actually asked for

> "now i want the payment flow for spaceworker not to be mandatory for subscription, i want users
> to be able to add balance to there account first, then they can decide to make use of that
> balance for subscription or other things."

Plus, this session:

> "users can top there wallet to purchase the exe licenses so our web app becomes a place they can
> come to fix and replace there license as well… so it's still the same"

**So the model inverts.** Today every payment *is* one product (`Payment.product`, granted by
`lib/license-service.ts` `handleApprovedPayment`). Under this plan the **wallet is the product of
the payment** and everything else is bought *from* it — premium terms **and** EXE licenses. Full
design, schema, API contracts, 18 acceptance tests and 6 open questions:
**`PLAN_TASK_158_WALLET_BALANCE.md`.**

**Two findings that will bite whoever builds it:**
- **`ExeLicense.paymentId` is `@unique` and REQUIRED** (`prisma/schema.prisma`). A wallet
  purchase has no payment row, so EXE-from-wallet costs a migration: `paymentId` becomes
  nullable, a nullable `walletEntryId` is added, and a CHECK constraint enforces "exactly one
  of the two". Plan decision **D9**.
- **`issueExeLicense()` (`lib/license-service.ts:130`) hardcodes `paymentId`** and its
  idempotency check is `findUnique({ where: { paymentId } })`. That is the **double-mint guard** —
  one debit must yield exactly one key. Do not let the wallet path bypass it.

**Reuse target is Vantra, which already works this way in production** — copy its guarded-update
shape (credit `:70-86`, debit `:116-123` of
`vantra/app/api/admin/payments/[paymentId]/confirm/route.ts`) and its "on-chain confirmation is
not payment" discipline (`vantra/app/api/billing/manual/submit/route.ts:35-42`). SpaceWorker
already has the three receiving addresses on `AdminSetting` (`btcWallet` / `usdtWallet` /
`usdtErc20Wallet`), so **no new payment infrastructure is needed** — this is a ledger plus a
spend path. SpaceWorker improves on Vantra in one place: an **append-only `WalletLedgerEntry`**
with a per-row `balanceAfterCents`, which Vantra lacks (it mutates `walletBalanceCents` directly,
so "where did my $20 go?" is unanswerable from the DB).

**Do NOT** widen `Payment.amountUsd` from `Float` to cents — it has a wide blast radius and zero
user benefit. New wallet maths uses **integer cents only** (decision **D3**).

### 7.2 ⚠️ ZONE-CREATE PERMISSION PROBE — **RAN LIVE, ANSWER: NO** (2026-10-03)

This was the open question blocking the domains wizard (`TRIAGE_2026-10-03_HOSTING.md`
§3.3, previously "UNVERIFIED — do not assume"). **It is now settled, and the answer is
negative.** Full raw evidence: **`TRIAGE_2026-10-03_HOSTING.md` §3.5.**

**Result: all 3 platform accounts, all 5 configured tokens → `403`:**
```
Requires permission "com.cloudflare.api.account.zone.create" to create zones for the selected account
```
| Account | CF acct | Token | Zones readable | `POST /zones` |
|---|---|---|---|---|
| Primary cf | `4c822d3b…` | Pages | 0 | **403** |
| New Prod | `9bc97c44…` | Pages | 0 | **403** |
| New Prod | `9bc97c44…` | Workers/DNS | **3** | **403** |
| hosting Premium Links | `43b24dc0…` | Pages | 0 | **403** |
| hosting Premium Links | `43b24dc0…` | Workers/DNS | 0 | **403** |

**How it was proven without risking a real domain:** the probe issued
`POST /zones` with a **deliberately invalid** domain name. Cloudflare checks the
**account permission before validating the domain**, so the request returned `403` on
permission and could not have claimed anything. This required **no** throwaway domain on
a domain the owner controls — the risk the triage doc was worried about never arose.
Reusable rule: **a probe whose input is invalid-by-construction answers a permission
question at zero risk.** It is only ambiguous when the answer is *positive* (then you
need a real domain to confirm).

**⇒ What this changes for the domains wizard:**
- **Brand-new domains cannot be auto-onboarded today.** The wizard must not ship a
  "create zone" step that is guaranteed to 403.
- **Existing active zones work with zero setup** — `instaweb.top`, `mainaccess.top`,
  `broks.beauty` (the last is the owner's and is **reserved — must stay denylisted**).
  This is the day-to-day path and it needs **no** `zone.create` permission.
- **Fallback = the support-ticket flow** for a brand-new domain. That makes **tickets
  (owner item #3) a dependency of domains (item #1)**, not a parallel workstream.
- **To unblock auto-creation**, the owner grants **Zone → Zone → Edit** scoped to the
  **account** on a token, then this probe is re-run. Note a token scoped to specific
  zone *resources* still cannot create new zones — it must be account-wide.

**Two side-findings (also worth acting on):**
1. **A third platform account exists** — `hosting Premium Links` (`43b24dc0…`), from
   the per-purpose pinning. It has **zero zones**, so it can serve `workers.dev` links
   only, never a custom domain. **Never pin a *domain* purpose to it.**
2. **`broks.beauty` is still readable by the `New Prod` Workers/DNS token** — the §2.2
   governance hole is **unremediated**. The reserved-host denylist remains required; do
   not treat zone-create being blocked as any mitigation for it.

**Cleanup done:** probe script, runner and the temp env file (which held
`DATABASE_URL` + `MAILBOX_ENCRYPTION_KEY`) were removed from the VPS. No zones created,
no DB writes, no token value ever printed, `spaceworker.service` still `active`.

### 7.3 Support tickets — scope

None exist (searched `app/`, `lib/`, `components/`). User + admin, threaded replies,
`open→resolved`, persistent left-nav **Support** entry, and a **hard lint rule forbidding any
Cloudflare token in a ticket body**. May carry zone metadata (name / status / nameservers /
account id). ⚠️ **Per §7.2 this is now a DEPENDENCY of the domains work, not a parallel item:**
a brand-new domain cannot be auto-created, so the ticket is the fallback path.

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
| ~~1~~ | ✅ ~~**D2 — Task 156 "Cyber Lab, real-world" C0 + C1**~~ **DONE + DEPLOYED + LIVE 2026-10-02 (`5485fdc`, run `36995895931`, build `BWRMBHG8mkpIrzUPTQ8-t`)** | `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` §12 (BINDING) | **C0** = `TASK_156_CYBER_LAB_AUP.md` + the consent screen (`components/cyberlab-aup.tsx`), recorded server-side (hashed) — nothing runs before acceptance. **C1** = additive `Lab*` schema (10 models) + the `cyberlab` **PREMIUM** gate (**NO staff badge — owner A14**; there is NO staff helper anywhere in the repo) + `AdminSetting.cyberlab*` dials + `LabToolCatalog` (**16 rows**, `staleAfter` hides a stale row) + the **read-only** Research admin page (feeds only, never an attack). `test:lab` **10/10**. |
| **2** | **D2 — Task 156 C2 → C6** (the lab actually *does* something) — **SEPARATE ASSIGNMENT, not this run** | same doc §12 + §7 (C0–C6) | Gated on the **owner + a lawyer**; **NON-production host ONLY — NEVER the prod VPS**; reuse 155 §14's cap mechanism, the existing panic switch / `AgentActionAudit` / `UserEntitlement`; **do not edit `lib/resource-governor.ts`**. Do not start it without those gates. |
| ~~4~~ | ✅ ~~**Task 155 P4** — tabbed Hosting UI + premium link cap + Cloudflare token in Settings + preview framed as "test before production"~~ **DONE + DEPLOYED + LIVE 2026-10-02 (`d79eee6`, run `36995895931`)** | same doc §17 | Sites \| Links \| Files tabs with count badges (P1 status strip unchanged); `AdminSetting.hostingPremiumMaxLinks` (**500**) resolved through the SAME `resolveHostingCaps` swap as the free dial (**50**); *Hosting accounts* card moved to `dashboard/settings` (token never echoed); links open/edit/delete + files visibility toggle surfaced. `test:hosting` **40/40**. The §19.10 **copy pass** (CF-silent hosting screen, "Premium" labels) is also built. |
| **3** | **Task 155 P6a — the THREE-option engine model** (Free = ours · **Premium = OUR Cloudflare, zero setup** · BYO = yours) | same doc **§19 BINDS it** | Answers the owner's *"no more premium links unless the user adds their cloudflare"*. NEW additive `HostingPlatformAccount` table + the **platform branch** in `resolveDeployCredential` (its comment already promises it, the code does not do it) + a **premium gate** on `engine=cloudflare, credentialId=NULL` + the three-option picker/badges + the **admin rotation** surface (multiple accounts, priority order — answers §19.9 Q4/Q5) + the `hostingPlatformCfEnabled` kill-switch dial. |
| **4** | **Task 155 P5a — Domains tab** (user adds a domain; we automate DNS + TLS) | same doc **§18** | New additive `HostingDomain` model + TXT/CNAME verification (`lib/sending-domains.ts` already does live `node:dns` TXT proof) + binding. **§18.9 Q2 ANSWERED on the box this session** (certbot **1.21.0**, nginx **1.30.4**, app `User=trmm`, `/etc/sudoers.d/trmm` = **`NOPASSWD:ALL`**, and **NO default vhost** → the catch-all is a NEW file). Recommendation: **Path A first (CF edge, `provider=platform` default per §19.10 rule 5)**, then Path B (our metal). It needs a healthy `HostingPlatformAccount` → **do P6a first**. |
| **5** | **Task 155 P6d — upload inputs: file / folder / zip** | same doc **§20 BINDS it** | The owner's *"not only zip option should be available for site upload"*. **BINDING recommendation = client-side normalization to the ONE existing zip pipeline** (§20.2) so all of `analyseArchive`'s guards stay in one tested place; optional loose-file server path (§20.4); **NO migration** (§20.5). Independent of P6a/P5a, but **sequence it against P6a (they touch the same panel)**. Closes the §6.4 write-path gap when verified live. |
| **5b** | **Task 155 P6c — LINKS on Cloudflare Workers (the ONLY remaining §19 item)** | same doc **§19.12.3 BINDS it** | The owner's revised decision closed the files question: **files stay LOCAL (instaweb), only SITES + LINKS get Free/Premium/Yours.** So this is a **Worker that 302s on the user's custom host** — **NOT Pages, NOT R2**. Schema = seven `LinkRedirect` columns (`engine` default `'local'`, `credentialId`, `workerName`, `routePattern`, `customHost`, `deployStatus`, `deployError`) + one index. **One script per USER** (`sw-<hash>`, a `MAP` of token→target), verified-zone check BEFORE any route call, route-then-script deletion order, and **`/r/<token>` local fallback must keep working even when the Worker is live**. **⚠️ P6b (files→R2) is CANCELLED — its uncommitted code was reverted 2026-10-03 and migration `20261032000000_task155_p6bc_r2_workers` is deleted. Do NOT recreate R2 and do NOT apply it.** **STATUS 2026-10-03: BUILT, DEPLOYED and LIVE-VERIFIED — `main` @ `24c55b2`, deploy run `37121991416` (`workflow_dispatch`), `BUILD_ID GYb1KlxCj5lZBJNfNWBUs`.** The owner added DNS edit to the platform token, and the full create→edit→delete lifecycle was verified **through the deployed HTTP API** on the real custom host: create → `302`, edit → `302` with the new `Location`, delete → **no route and no script left in Cloudflare**, host then `522`, `/r/<token>` `404`. Two real bugs were found and fixed live along the way: routes are **zone-scoped** (`/zones/{zoneId}/workers/routes`, not the account-scoped URL), and deleting a link whose **own publish failed** orphaned the route (fixed in `24c55b2`; `workerName`/`routePattern` are NULL on such a row, so teardown now derives the identity from user+host — see §5 trap 26). **Remaining: BYO ("Yours") credential flow still needs a real browser test, and domain onboarding for a brand-new domain is NOT implemented** (existing Cloudflare zones work; adding a new domain needs a registrar nameserver change, and platform-managed domains without one would need Cloudflare for SaaS/custom hostnames — a separate paid/product decision). |
| **6** | **Hygiene — fresh-DB migration replay is broken (≥5 out-of-order migrations)** | **needs its own task doc** | Live DB + deploys are **unaffected**; only brand-new DBs (scratch/CI/local) hit it — see **trap 23**. Fix = reorder/repair **or** a documented `migrate resolve` cheat-sheet. **Do NOT silently edit another task's migration.** |

*D2 / Task 156 **C0 + C1 are now deployed and live**, and **Task 155 P4 is live** (`d79eee6` +
`5485fdc`, run `36995895931`, build `BWRMBHG8mkpIrzUPTQ8-t`). The next live-app items are **P6a
(§19 — the three-option engine)**, then **P5a (§18 — Domains)**, then **P6d (§20 — upload inputs)**;
each is scoped and grounded but **gated on the owner's answers to its own "open questions" section**
(§19.9, §18.9, §20.9) **and on the exact `git`/`gh` checks in §9 — do not deploy without them.** The
P3/P4 hosting **write** path is still unproven on prod (§6.4) — close it as part of whichever hosting
item ships first. **Converters are OFF (§16.5)** — do not install `sharp`/`ffmpeg`/`libreoffice`.
**`lib/resource-governor.ts` is out of scope** (155 §16.6).*

**Self-hosted line:** T10 → T11 (the live kill — highest value) → T12 → T13 → T14 → T15,
per `TASK_145_...JUNIOR_TRACK.md`.

**Rule:** if a task's files overlap another's, they are sequential, not parallel. Overlaps
are called out in each task doc.


## 8. How to verify — the standard the owner actually wants

### 8.0 MONEY-ADJACENT WORK — the full gate (binding; no exceptions)

`tsc` passing proves code **compiles**, not that it **works**. This repo's own history says so
out loud: *"Typechecking proves the code compiles, not that it works. For anything security- or
money-adjacent, write a disposable Node script that exercises the real deployed HTTP routes with
real (throwaway, self-cleaning) data"* (`HOW_WE_MOVE_FAST.md` §4).

**The owner was explicit: scope every possible test so we don't ship broken product.** For the
wallet (`PLAN_TASK_158`) and any billing/licensing change, every one of these is required. "It
typechecks" is not an acceptable report.

**A — Local, before it can be considered finished**

| # | Gate | Command |
|---|---|---|
| A1 | Types | `npx tsc --noEmit -p .` → exit 0 |
| A2 | Build | `CI=1 npx next build` → succeeds |
| A3 | New tests | the new `npm run test:wallet` / `test:wallet-exe` → all pass, **raw output** |
| A4 | Blast-radius tests | `npm run test:hosting` (39/39 today) + the **licensing** tests — CI will **not** run these (trap 3) |
| A5 | Lint | `npm run lint` |
| A6 | Fresh-DB migration replay | the migration applies to an empty scratch DB — and against a clone of production's `_prisma_migrations` (**trap 23**; fresh-DB replay is *already* broken by ≥5 out-of-order migrations, so prove YOUR migration adds no new breakage and say so) |

**B — Live on the VPS, against the real deployed routes** (`HOW_WE_MOVE_FAST.md` §4; run from
`/opt/spaceworker`, app on `http://localhost:3500`)

| # | Gate | How |
|---|---|---|
| B1 | Real HTTP, not the handler | `fetch("http://localhost:3500/api/...")` against the deployed app |
| B2 | Disposable data | real `_e2e-<name>-test-${Date.now()}@spaceworker.test` rows via the real Prisma models |
| B3 | Assert **DB state, not just the HTTP body** | read `User.balanceCents` / `WalletLedgerEntry` / `ExeLicense` back out of Postgres — the response saying `{"ok":true}` proves nothing |
| B4 | **Concurrency** | fire two simultaneous spends of the full balance → exactly one wins, the other 402. **This is the single most important money test**; a race here is a silent overdraft |
| B5 | **Double-mint** | one debit ⇒ exactly ONE `ExeLicense`; replay the `idempotencyKey` and assert no second key |
| B6 | Admin gating | mint a session via `createAdminSessionToken()` from `lib/admin-auth.ts` — **never** pull a plaintext `ADMIN_TOKEN` into a script or transcript |
| B7 | Full lifecycle | top-up → admin approves → balance credited → spend → entitlement granted, end to end, with a DB read after each hop |
| B8 | **Cleanup** | delete every row you created (watch FK order — `PaymentVerificationAttempt` blocks a `Payment` delete) and delete the script + `stub-server-only.cjs` from the VPS. **Never leave test data in production.** |
| B9 | Unambiguous outcome | one `RESULT: PASS` / `RESULT: FAIL` line, `process.exit(0/1)` |

**C — After `migrate deploy` (every time, no exceptions)**

The **§6b drift check** — `migrate deploy` exiting 0 does **not** prove the DB matches the
datamodel:
```bash
cd /opt/spaceworker
sudo -u trmm env HOME=/home/trmm npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel  prisma/schema.prisma --script
```
In sync ⇒ **exactly** `-- This is an empty migration.` Anything else is real drift. **Critical for
the wallet:** the new `WalletLedgerEntry` has a **nullable-unique `idempotencyKey`** and a
**CHECK constraint on `ExeLicense`** — both are objects hand-written SQL gets subtly wrong, and
both are exactly what the diff will surface. **Do NOT add `ON DELETE CASCADE`** to the new FKs —
trap 23's lesson is that a cascade on an audit-bearing FK silently destroys exactly the rows you
kept the ledger to preserve.

**D — Report honestly.** The list of what you could NOT verify is expected. Label anything
simulated as **"SIMULATION"**. A claimed-but-unverified money path is worse than an unfinished one.

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
| **`PLAN_TASK_157_PLATFORM_DOMAINS.md`** | **Scoping, partly live** — platform domains, premium hostnames, hosting restructure, support tickets. §4 Phase 1 + 3b are **shipped and live**; Phases 4–6 (domains wizard, restructure, tickets) are **not started**. |
| **`PLAN_TASK_158_WALLET_BALANCE.md`** | **Designed, not built** — the balance-first wallet. Top up, then spend on premium **and EXE licenses**; admin grants; an append-only ledger Vantra doesn't have. 6 phases W1–W6, 18 acceptance tests, 6 open questions. **See §7.1 and the money gate §8.0.** |
| `HANDOFF.md` (root) | **STALE** (Sep 2026, PR merge notes). Historical only — do not follow. |
| `app/AGENTS.md`, `app/CLAUDE.md` | Repo-local agent conventions |

## 12. Log

### 2026-10-03 — ZONE-CREATE PROBE RAN: **NO**, tokens lack `zone.create` (answers §6.4 / triage §3.3)

**Read-only investigation. Zero production writes.** `main` still `32a280a`; nothing deployed.

**Answered the open question** that was blocking the domains wizard: *can the platform
tokens create a Cloudflare zone?* **No.** All **3 accounts / 5 tokens** returned
```
403  Requires permission "com.cloudflare.api.account.zone.create" to create zones for the selected account
```
Raw evidence: **`TRIAGE_2026-10-03_HOSTING.md` §3.5**; handoff **§7.2**.

**The probe was safe by construction — worth reusing.** Rather than create a real zone
on a domain the owner controls (the risk the triage doc flagged), the probe issued
`POST /zones` with a **deliberately invalid domain name**. Cloudflare evaluates the
**account permission before validating the domain**, so it returned `403` on permission and
**could not have claimed anything**. Generalizable lesson, added to §5's method: *a probe
whose input is invalid-by-construction answers a permission question at zero risk* — it is
only ambiguous when the answer is **positive**, because then you still need a real domain
to confirm.

**How it ran:** on the VPS, decrypting the real tokens with the production helper
(`lib/mailbox-crypto.ts` `decryptSecretOrThrow`) over the actual `HostingPlatformAccount`
rows. **No token value was ever printed** — labels, ids, hints and statuses only. Needed
`scripts/stub-server-only.cjs` (§4) and both `DATABASE_URL` + `MAILBOX_ENCRYPTION_KEY`
injected server-side via `grep` (never printed). Two live errors, both fixed: the model
field is `label` not `name`, and **`.env` is not `source`-able** (a value contains spaces)
so keys must be extracted individually.

**Two side-findings:**
1. **A third platform account now exists** — `hosting Premium Links` (`43b24dc0…`), from
   per-purpose pinning. **Zero zones** ⇒ it can serve `workers.dev` links only, never a
   custom domain. **Never pin a domain purpose to it.**
2. **`broks.beauty` is still readable by the `New Prod` Workers/DNS token** — the §2.2
   governance hole is **unremediated**. Blocking zone-create mitigates **nothing** there.

**Consequence — this reshapes the owner sequence.** Brand-new domains cannot be auto-created,
so the domains wizard must **not** ship a create-zone step. But **existing active zones**
(`instaweb.top`, `mainaccess.top`) work with **zero setup** — that is the day-to-day path and
needs no permission. The fallback for a genuinely new domain is **the ticket flow**, which makes
**tickets a dependency of domains** (§7.3), not a sibling. To restore auto-creation the owner
grants **Zone → Zone → Edit** on the **account** (not on specific zone resources) and this probe
is re-run.

**Cleanup verified:** probe script, runner and temp env file removed from the VPS; no zones
created; no DB rows written; `spaceworker.service` `active`.

### 2026-10-03 — Wallet / balance-first billing SCOPED (`PLAN_TASK_158`); owner set the build order; money-adjacent test gate added to §8

**Docs only — no code, no schema, no deploy.** `main` unchanged at `32a280a`.

**Owner's request:** *"now i want the payment flow for spaceworker not to be mandatory for
subscription, i want users to be able to add balance to there account first, then they can decide to
make use of that balance for subscription or other things."* Follow-up this session: *"users can top
there wallet to purchase the exe licenses so our web app becomes a place they can come to fix and
replace there license as well… so it's still the same."*

**Owner-set build order (binding, §7):** **domains → wallet → support tickets → marketing →
back to Cyber Lab C2+.** Marketing has **no doc yet** — one must be written before that code starts.

**New:** `PLAN_TASK_158_WALLET_BALANCE.md` — full wallet design. **`PLAN_TASK_157_PLATFORM_DOMAINS.md`**
confirmed as the domains/tickets doc.

**The model inverts.** Today a `Payment` row *is* one product and approval grants exactly that
(`handleApprovedPayment`, `lib/license-service.ts:33`). Under the plan the **wallet is the product of
the payment**, and premium terms + EXE licenses are bought *from* it.

**Verified by reading the code (not assumed):**
- Vantra already does balance-first **in production** — credit `confirm/route.ts:70-86` and debit
  `:116-123` are both **guarded `updateMany`** calls whose `count === 0` is the race signal
  (no read-then-write). `billing/manual/submit/route.ts:35-42` proves on-chain confirmation is
  **not** payment — even a confirmed tx only reaches `pending_review`.
- SpaceWorker has **no** `balanceCents`, **no** ledger, and `Payment.amountUsd` is **`Float`**.
- SpaceWorker already has `AdminSetting.btcWallet` / `usdtWallet` / `usdtErc20Wallet` + the
  `/api/billing/*` routes, so **no new payment infrastructure is needed** — this is a ledger + spend path.

**Two findings that change the cost of the work:**
1. **`ExeLicense.paymentId` is `@unique` and REQUIRED.** EXE-from-wallet therefore needs a
   migration (`paymentId` nullable + `walletEntryId` + a CHECK enforcing exactly one) — decision **D9**.
   A synthetic zero-value `Payment` row was rejected: it fakes money that never moved.
2. **`issueExeLicense()` (`lib/license-service.ts:130`) hardcodes `paymentId`**, and its
   `findUnique({ where: { paymentId } })` check is the **double-mint guard**. The wallet path must not
   bypass it — one debit must yield exactly one key.

**Where we beat the reference:** Vantra mutates `walletBalanceCents` directly, so "where did my $20
go?" is unanswerable from the DB. The plan adds an **append-only `WalletLedgerEntry`** with a
per-row `balanceAfterCents` and a nullable-unique `idempotencyKey`.

**Deliberately NOT done:** widening `Payment.amountUsd` from `Float` to cents (decision **D3** — wide
blast radius, zero user benefit; new wallet maths is integer cents only).

**New trap-adjacent risk recorded for the builder:** the new nullable-unique index + the
`ExeLicense` CHECK constraint are exactly the objects hand-written migration SQL gets subtly wrong,
so §6b's drift check is now **mandatory** after the W1 migration, and the new FKs must **not** use
`ON DELETE CASCADE` (trap 23's lesson).

### 2026-10-03 — Task 155 P6c: fix orphaned Worker route on delete; P6c now LIVE-VERIFIED end-to-end
- **Did:** fixed the last live P6c bug — deleting a link whose own publish had failed left its
  shared Cloudflare route behind (500s forever). `mapIdentityFor(userId, customHost)` in
  `lib/hosting/links-engine.ts` derives the route identity; `removeLinkFromWorkerMap` in
  `lib/hosting/links.ts` now prefers recorded values and falls back to that. Same commit turned
  DNS `403`s into an actionable "add DNS:Edit/DNS:Read" message instead of a bare auth error.
  Commit **`24c55b2`**; swept the orphaned production route `go.instaweb.top/*` →
  `sw-027970396cd46c94fd3b39e958bbd5c5`. Also fixed the **platform Cloudflare account ID**, which
  was missing its final `b`, and corrected route calls to the zone-scoped endpoint.
- **Verified:** `npx tsc --noEmit` 0; `npm run test:hosting` **136/136** (was 135 — added a
  regression test that walks the real sequence and **fails against the old behaviour**);
  `npm run test:pages` **26/26**; focused ESLint exit 0; `CI=1 npm run build` exit 0. Live, through
  the **deployed HTTP API** (`POST/PATCH/DELETE /api/hosting/links`) on the real custom host:
  create → `302`, edit → `302` with `Location: https://example.org/deployed-two`, delete → **0 rows,
  0 routes in Cloudflare**, host `522`, `/r/<token>` `404`. Production **clean**: no `sw*` rows.
- **NOT verified:** the **BYO ("Yours") credential flow has never been exercised in a real browser**
  — it is unit-tested only. **Domain onboarding for a brand-new domain is not implemented**: existing
  Cloudflare zones work, but `POST /zones` for a new domain needs a registrar nameserver change, and
  platform-managed domains without one would need Cloudflare for SaaS/custom hostnames (a paid,
  separate product decision — not started). The owner-facing Monk reply is still outstanding.
- **State left behind:** `main` @ **`24c55b2`**, in sync with `origin/main`, tree **clean**,
  `BUILD_ID GYb1KlxCj5lZBJNfNWBUs` (service restarted 14:14:39 CEST). All `tmp-*.ts` diagnostics
  deleted; the port-15432 tunnel is down and `/tmp/.swprod.env` (mode 600) has been securely
  removed. The `go.instaweb.top` **DNS record is intentionally kept** — future Worker links need it.
- **Next:** decide the domain-onboarding approach (registrar-nameserver vs Cloudflare for SaaS),
  then browser-test the BYO credential flow. See §5 traps **25** (a green push run does not deploy)
  and **26** (never key a shared-resource teardown on a nullable per-row column).

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
- **Next:** **D2 / Task 156 "Cyber Lab, real-world" — C0 (AUP/consent) → C1 (schema + PREMIUM `cyberlab`
  gate (NO staff badge - owner A14 / PLAN_156 §12.9) + admin `Lab*` limits + `LabToolCatalog` +
  read-only Research admin page) ONLY.** Build spec
  `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` **§12 (owner addendum 2026-10-02, BINDING)**. C2+ is a
  separate assignment. See `PROMPT_NEXT_AGENT.md`.

### 2026-10-02 — owner A14: Cyber Lab gated by PREMIUM, not a staff badge (docs only, no code)

- **Did:** recorded the owner's access ruling — *"we dont have staff gate in spaceworker yet, so just
  build it premium gated … we only had it in vantra. lets not make this a blocker"* — as **PLAN_156
  §12.9 (BINDING)** and propagated it into the C1 scope everywhere it appeared:
  `PROMPT_NEXT_AGENT.md` (new ask **A14**, the `TASK:`/`DEPLOY?` lines, the C1 scope block, the
  non-negotiable list, the acceptance line, the commit message), `PLAN_TASK_156…` (§2 cell, §5 matrix
  note, §6 field note, §7 C1 row, §10 Q2 → RESOLVED, §11, §12 intro "Seven→Eight rulings", §12.8), and
  this handoff's §7/§12 next-task text. Also **fixed a broken code fence** in `PROMPT_NEXT_AGENT.md`
  (the TASK BLOCK's closing fence had swallowed the `## OWNER'S ASKS` heading; an orphan fragment sat
  after A13) — fences now pair cleanly (20/61, 65/121, 212/223, 252/261).
- **Verified:** `grep -c '^```' PROMPT_NEXT_AGENT.md` → even and paired; `cyberlab` present in
  `lib/entitlements.ts` `ENTITLEMENT_KEYS` (the gate key already exists); no staff helper in `lib/*.ts`
  (only `admin`-named surfaces), confirming §12.9's premise.
- **NOT verified:** nothing runtime — this is a **docs/scope change**, no code paths touched.
  **SIMULATION: none.**
- **State left behind:** `main` @ `78252a6` (+ this docs commit); deployed build unchanged
  (`LjgrTG69r2eiN-w07Hj-i`). No deploy needed.
- **Next:** unchanged — D2 / Task 156 **C0 → C1**, now with the **PREMIUM `cyberlab` gate** instead of
  a staff badge.
### 2026-10-02 — Task 156 C0+C1 built; Task 155 P4 built + DEPLOYED + VERIFIED LIVE; §18/§19/§20 scoped; trap 23

- **Did:**
  - **Task 156 D2 / C0+C1** — commit **`5485fdc`** (local): `TASK_156_CYBER_LAB_AUP.md` + the consent
    screen `components/cyberlab-aup.tsx` (recorded server-side via `LabConsent`, hashed) = **C0**; ten
    additive `Lab*` models + `AdminSetting.cyberlab*` dials (migration
    `20261030000000_task156_c1_lab_schema`), `lib/lab/{aup,consent,gate,tools,catalog-seed,research}.ts`,
    the **PREMIUM** `cyberlab` gate (**no staff badge — owner A14**), `LabToolCatalog` seeded **16 rows**
    with `staleAfter` hiding, read-only Research admin page, and `tests/lab-gate.test.ts` = **C1**.
  - **Task 155 P4** — commit **`d79eee6`**: Sites \| Links \| Files tabs with count badges;
    `AdminSetting.hostingPremiumMaxLinks` (500) via the SAME `resolveHostingCaps` swap as the free dial
    (50) (migration `20261030120000_task155_p4_premium_links`); the *Hosting accounts* card moved to
    `dashboard/settings`; links open/edit/delete + files visibility toggle surfaced; preview framed as
    the "test before production" step; the **§19.10 copy pass** (CF-silent hosting screen, "Premium"
    labels) in `components/hosting-panel.tsx`.
  - **Scope (docs only, no code):** PLAN_155 **§18 (P5 Domains — grounded spec, §18.9 Q2 ANSWERED on
    the box)**, **§19 (P6 — the three-option engine model, §19.9 Q4/Q5 answered by the owner, §19.10
    binding UI rules)**, **§20 (P6d — upload inputs: file/folder/zip, client-normalized to the ONE zip
    pipeline)**; this handoff's §6 + §7 queue + **trap 23**; a full rewrite of `PROMPT_NEXT_AGENT.md`
    (the whole pending queue + the access pack).
- **Verified:** `npx prisma validate` OK · `npx tsc --noEmit` → **0** · `CI=1 npx next build` →
  **exit 0** · `npm run test:hosting` → **40/40**, `test:pages` → **19/19**, `test:lab` → **10/10** ·
  eslint **HEAD parity** on all touched files · both migrations applied to a scratch DB and to prod.
  **Live:** `BUILD_ID` = `BWRMBHG8mkpIrzUPTQ8-t` (mtime `2026-10-02 12:33:13 CEST`); deploy run
  `36995895931` **success**; both new migrations in `_prisma_migrations` (`finished_at
  2026-10-02 12:35:49 CEST`); the P4 UI string `Hosting accounts` present in the shipped client chunk
  (`/opt/spaceworker/.next/static/chunks/3yoy8celt_47q.js`). On the box: certbot **1.21.0**, nginx
  **1.30.4**, 13 vhosts, 8 certbot lineages, app `User=trmm`, `/etc/sudoers.d/trmm` = `NOPASSWD:ALL`,
  **no default vhost**.
- **NOT verified:** the P3/P4 hosting **write** path on prod (no real upload→preview→publish click yet);
  prod email/password login not re-confirmed; the premium/Cloudflare leg still only proven against a
  throwaway account. **SIMULATION: none** — nothing offensive was run.
- **State left behind:** `main` @ `cab860a` **synced with `origin/main`**; tree **clean**; prod build
  `BWRMBHG8mkpIrzUPTQ8-t`.
---

## 2026-10-03 — LIVE TRIAGE: Pages 404, broks.beauty, domain onboarding, account rotation

Full evidence + exact commands: **`TRIAGE_2026-10-03_HOSTING.md`** (read it before touching any
of this work). HEAD `71ca4d7`, tree clean. Read-only investigation except one tunnel.

- **THE PAGES "SSL ERROR" WAS A MIS-DIAGNOSIS — the real bug was already fixed.** The preview
  `c01095fa.testsite-735.pages.dev` returns **404**, not a TLS failure: `curl` shows
  `ssl_verify_result=0`, and the cert (`CN=test2-bli.pages.dev`, SAN `*.test2-bli.pages.dev`,
  notBefore `Oct 3 11:33`) predates the deploy. The deployment's manifest is
  `{"/inn/.DS_Store":…, "/inn/index.html":…}` — **no `/index.html` at the root**, because the
  owner zipped a *folder*, so the wrapper directory shipped verbatim. Proof: `/inn/` → **200**,
  `/` → 404, same deployment. Commit `0452397` ("unwrap the zipped folder", `singleRootPrefix()`
  at `lib/hosting/extract.ts:133`, wired at `lib/hosting/sites.ts:445`) fixed exactly this — and
  it landed at `2026-10-03 00:59`, **38 minutes AFTER** the failing `00:21` deploy. `0452397` is
  an ancestor of the deployed `24c55b2`, so **production already has the fix**; the `test2` site
  uploaded at `12:29` serves `/` → 200. **Ask the owner to re-upload the zip.** No code needed.
- **`broks.beauty` — the one live link is the owner's own and works**: `mylink` →
  `go.broks.beauty` → 302 → `/r/REyVckus…` → 302 → `dl.instaweb.top/hf/…`. The deployed Worker
  MAP keys are that link's **token + slug** (by design, `links-engine.ts:131-134`), not stale.
  **THE REAL RISK**: the platform token in account `9bc97c44…` can read/write all four zones —
  `broks.beauty` (the owner's **private device domain**), `instaweb.top`, `mainaccess.top`,
  `spaceworker.top` — so **any premium user could point a custom host at the private domain and
  succeed.** Fix in three layers: (a) narrow the token's Zone Resources to the three platform
  zones (dashboard, 2 min); (b) server-side **reserved-host denylist** on link create/edit,
  config-driven, own error code; (c) zone allowlist in the Worker publish path. Delete
  `cmusdejvt0013kpiz8fd9awns` to remove `go.broks.beauty` now (P6c teardown is fail-closed).
- **DOMAIN ONBOARDING: yes, one `POST /zones` + ONE unavoidable manual step.** The zone is
  created `pending` and returns 2 nameservers; the user pastes them at their registrar (no API
  can do this — it is not a product limitation), then we poll until `active`. **Cloudflare for
  SaaS is NOT required** — it would only be needed to avoid transferring nameservers, and it is
  a separate, likely paid product. ⚠️ **UNVERIFIED: whether our tokens can even create zones** —
  that is an account-level `Zone:Edit` permission our Pages/Workers tokens likely lack. Probe it
  with a throwaway domain **the owner controls**; never against `broks.beauty` or a domain we
  don't own. Also: adding to the *platform* account means **we control that domain's DNS** —
  owner must choose the trust posture (recommend BYO by default).
- **"2 of 2 accounts usable" = healthy ROWS, not capacity or round-robin.**
  `platform-accounts-panel.tsx:103` counts `status==="active" && !verifyError`; rotation takes
  the **first** healthy row by ascending `priority` (verified on use), and Worker publishing
  additionally skips rows with no Workers token. **It currently hides a split-brain**: account A
  ("Primary cf") has the **Pages** token + both Pages projects but **no Workers token and no
  zones**; account B ("New Prod") has the **Workers/DNS** token + all four zones but **no Pages
  token**. So sites go to A and links go to B, while the panel reads healthy. Fix = report
  health **per capability** (`Pages 1/1 · Workers 1/1`). ⚠️ **UNVERIFIED: re-ordering priority
  is believed to affect FUTURE deployments only and does NOT migrate existing projects/links —
  confirm before shipping any "current account" selector.**
- **Tickets: none exist** (searched `app/`, `lib/`, `components/`). Scoped in the triage §5 —
  attach zone metadata (name/status/name_servers/account), threaded replies, `open→resolved`,
  and **never store Cloudflare tokens on a ticket**.
- **Verified live:** Worker route inventory across all four zones; the deployed script body; both
  Pages projects' manifests, stages and URLs; TLS/cert on both hosts; the redirect chain; the
  DB link row; git history of the fix. **No production writes.**
- **Cleanup done:** removed `/tmp/.swprod.env`, `/tmp/.accts.txt`, `/tmp/.cfprobe.mjs`,
  `/tmp/.cfpages.mjs`, `/tmp/.cfdeploy.mjs`, `/tmp/.cfscript.mjs`, `/tmp/.cftestsite.mjs`,
  `/tmp/.cfassets.mjs`, `/tmp/.cfdep.mjs`; killed the `15432` → prod Postgres SSH tunnel.
- **Next:** (1) tell the owner to re-upload the zip; (2) narrow the CF token's zones;
  (3) implement the reserved-host denylist + tests; (4) verify zone-create permission;
  (5) then the domain wizard; (6) then per-capability health; (7) then tickets.

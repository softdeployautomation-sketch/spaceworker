# How we move fast on this repo — deploy & verification playbook

**Written 2026-09-21** after a long session that shipped and live-verified a large batch of licensing/payment/security work (Tasks 45–49 + the store/pricing/trial features). This captures the exact mechanics that made verification fast and safe, so fixing Tasks 49–54 doesn't require rediscovering any of it. Read this before touching deploy, migrations, or EXE builds on this repo.

## 0. Access — read this first

- **VPS** (164.68.105.96 — runs both `spaceworker.service` and the sibling `vantra.service`): `ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96`. That key file already exists on this machine — reference it by path, never copy/print its contents into a script, log, or committed file.
- **Windows VM** (for EXE install/testing only — not needed for a pure backend/web task): `ssh -i ~/.ssh/tacticalrmm_vps myrat@192.168.0.104`. Same key. The VM's IP can change on restart — if that address stops responding, ask rather than guessing a new one.
- **GitHub**: this machine's `git` and `gh` are already authenticated (both `git push origin main` and `gh workflow run` / `gh run download` work directly, no separate login step). Push directly from a normal commit — don't invent a different auth method.
- **The VPS has NO git repository at all** — `/opt/spaceworker` (and `/opt/vantra`) are plain rsync'd file copies, not `git clone`s. `git status`/`git log`/`git rev-parse` etc. will always fail there with "not a git repository" — that's expected, not a sign anything is broken. Verify a deploy landed correctly by checking file contents/timestamps directly (`grep`, `cat -n`, `ls -la`) or by running the app itself (`systemctl status`, `curl`, an E2E script per §4) — never by trying `git log` on the server. All real git history lives only in the local checkout this repo is cloned from, and on GitHub after a push.

## 1. The repo root vs. `app/` trap (bit us twice — don't repeat it)

On the VPS, `/opt/spaceworker/` is the **repo root** — `app/`, `components/`, `lib/`, `prisma/` all live directly under it. `/opt/spaceworker/app/` is the Next.js **router directory** (`app/api/...`, `app/dashboard/...`), NOT a second copy of the repo.

- **rsync destination**: always `root@164.68.105.96:/opt/spaceworker/` (trailing slash, repo root) with an explicit `--files-from` list of repo-relative paths (e.g. `app/api/exe-license/auto-bind/route.ts`, `lib/products.ts`). Never a bare directory sync, never a relative `..` in the remote target — a `..`-containing remote path once resolved to the wrong directory and overwrote the real landing page mid-session. If a path needs `..`, stop and rewrite it as an absolute path instead.
- **Commands that need the repo root** (prisma migrate/generate): run from `/opt/spaceworker`. (Not `git` — see §0, there's no git repo on the VPS at all.)
- **Commands that need the Next app dir** (`npm run build`, `npm run dev`): run from **`/opt/spaceworker`** — the repo root IS the Next project root (that's where `package.json`, `next.config.ts` and `.next/` live, and `spaceworker.service` runs `next start` with `WorkingDirectory=/opt/spaceworker`). `/opt/spaceworker/app/` is the **router directory only** and has no `package.json`; running `npm run build` inside it fails. (Corrected 2026-09-23 after the stale "run from `/opt/spaceworker/app`" line below wasted a deploy attempt. Same shape in Vantra: build from `/opt/vantra`, its repo root.)
- Confirm you're in the right one before running anything destructive: `pwd` first if unsure.

## 1a. `proxy.ts` (Next.js 16 middleware) — a second, nastier file-location trap

Task 56 lost most of a session to this. Next.js 16 renamed `middleware.ts` to `proxy.ts`, and the real one **must live at the repo root** (`/opt/spaceworker/proxy.ts` locally, sibling to `next.config.ts`/`package.json`), never inside `app/`. Next.js gives **zero warning or error** if you put one at `app/proxy.ts` by mistake — it's just silently never executed, forever, with no signal anything is wrong.

- **`middleware-manifest.json` is not trustworthy verification in this Next.js version (16.2.9 + Turbopack).** It can read `"middleware": {}` (empty) even when the real, correctly-placed `proxy.ts` genuinely IS executing — confirmed directly: its pre-existing session-gate logic was provably running (redirects firing correctly) while the manifest still showed empty. **Never conclude "middleware isn't running" from this file alone.**
- **The only reliable way to confirm `proxy.ts` is actually executing**: an observable side effect from code you know is inside it — an existing redirect/header, or a temporary `console.log(...)` read back via `journalctl -u spaceworker.service --since '1 minute ago'` after hitting the route with `curl`. Delete the debug log once confirmed; don't leave it in.
- `proxy.ts` runs in an **isolated bundle** — Next's own docs literally say "Proxy is meant to be invoked separately of your render code ... you should not attempt relying on shared modules or globals." A module-scope cache (or any other in-memory state) imported into `proxy.ts` is a **separate instance** from the one the rest of the app (API routes, etc.) touches — writes/invalidations from elsewhere in the app will NOT reach it. Design anything proxy.ts reads to tolerate that (a short TTL that naturally self-refreshes is fine; relying on an explicit cross-module invalidation call to reach proxy is not).
- When gating by path prefix in `proxy.ts`, remember `/admin/**` (pages) and `/api/admin/**` (routes) are **different prefixes** — excluding only one from a broad gate (e.g. a maintenance-mode check) can lock the admin out of the very endpoint needed to turn the gate back off. This happened live on 2026-09-20 and needed a hand DB restore to recover. Always check both when the intent is "admin bypasses this."

## 2. Deploy sequence (web changes, no schema change)

**2026-09-28 — use `scripts/deploy-vps.sh`, not the raw rsync below, whenever
possible.** It wraps everything this section (and §2a, §3) does by hand —
maintenance-page coverage for the whole restart window (nginx serves
`static/maintenance.html` while `.next` rebuilds, only clears it once the app
answers 200), automatic `.next.prev` rollback if a build fails, `.env`
snapshotting, protected-path safety, and `prisma generate` run before `next
build` (a stale client used to fail typecheck AFTER `.next` was already wiped).
A whole session's worth of manual rsync+build+restart deploys on 2026-09-28
never engaged the maintenance page even once, because this script existed and
wasn't used — see its own header comment for the full incident history.

**Deploy the DIRECTORY TREES, not a `--files-from` list** (2026-09-28 — see the
incident right below; the list recipe that used to live here was a silent
file-dropper):

```bash
# Sync each tree wholesale. -r is explicit because --files-from does NOT imply
# it, and a DIRECTORY entry in a files-from list recurses unreliably (proven
# below). Repeat per directory; each of these is a complete, order-independent
# sync of that tree.
for d in app lib components tests prisma; do
  rsync -azr --exclude='.env' -e "ssh -i ~/.ssh/tacticalrmm_vps" \
    "$d/" "root@164.68.105.96:/opt/spaceworker/$d/"
done
ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96 \
  'chown -R trmm:trmm /opt/spaceworker'
```

Then the script for the build half only — it syncs the two root files, which
have no entry in the list above, and does `prisma generate` → maintenance ON →
`next build` → restart → verify:

```bash
printf 'package.json\nHOW_WE_MOVE_FAST.md\n' > /tmp/deploy-root.txt
scripts/deploy-vps.sh /tmp/deploy-root.txt
```

Why split it this way: `scripts/deploy-vps.sh` requires a files-from list, but
`--files-from` is the very mechanism that dropped files in the incident below.
Passing it only root-level files (which can't recurse, so can't be dropped) and
letting rsync handle the trees directly gets the script's maintenance page,
rollback and verify without its one unreliable input. **Whatever you do, §2a is
not optional** — it is what caught this, and it is the only step that can.

Schema change: `prisma migrate deploy` + the §6b drift check first (§3), THEN
this (the script runs `prisma generate` for you, right before the build). It
does NOT run `migrate deploy`.

**2026-09-28 incident — a "full tree" files-from list shipped 6 files short.**
The recipe above used to say to list `app/`, `lib/`, `components/` as directory
entries and that this was equivalent to a bare `rsync -av` ("--files-from
supports directory entries (recurses)"). It is not. With that list, rsync
transferred only **two levels** under `app/` — `app/dashboard/`, `app/api/` and
friends landed as empty directories and every file inside them was skipped, so
six changed files of a ten-file fix were silently left behind:

```
app/api/mailboxes/test-connection/route.ts     8798 -> 4259 bytes (old version)
app/api/mailboxes/[id]/test/route.ts
app/api/campaigns/[id]/{test-send,test-recipient,run-diagnostics}/route.ts
app/dashboard/campaigns/[id]/page.tsx
```

The run looked perfect: `sent 90557 bytes`, explicit `-r` passed, exit 0,
`systemctl is-active` = active, `curl` = 200, maintenance off, `.next` rebuilt.
Nothing short of §2a could see it — the app was serving an old API route against
a new UI, which is precisely the "hard-to-diagnose production bug" §2a describes.
`lib/` and `components/` were fine only because their changed files sit one
level deep. **Sibling of the two traps already in §7; the fix is to stop
deploying source trees through `--files-from` at all.** Also note the dry-run
that would have caught it: `rsync -avzn -i` shows `app/api/` enumerated as a
directory with no files under it.

The raw manual sequence below is kept for `--no-build`/`--verify-only`-style
one-offs, or when `scripts/deploy-vps.sh` itself needs debugging — not as the
everyday path anymore.

```bash
# from your local checkout, after committing:
cat > /tmp/deploy-files.txt <<'EOF'
app/api/exe-license/auto-bind/route.ts
lib/products.ts
# ...one repo-relative path per line
EOF
rsync -avz -e "ssh -i ~/.ssh/tacticalrmm_vps" --files-from=/tmp/deploy-files.txt --exclude='.env' ./ root@164.68.105.96:/opt/spaceworker/

ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96 \
  "cd /opt/spaceworker && sudo -u trmm npm run build 2>&1 | tail -20 \
   && systemctl restart spaceworker.service && sleep 3 \
   && systemctl is-active spaceworker.service \
   && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3500/"
```

(**Fixed 2026-09-25** — this snippet itself still said `cd /opt/spaceworker/app`, the exact stale path §1 above already says wasted a deploy attempt once; §1 was corrected but this example never was. Build from `/opt/spaceworker`, the repo root — that's where `package.json` lives.)

**`--exclude='.env'` is MANDATORY on every rsync to the VPS - both repos.** (Added 2026-09-22 after a deploy clobbered the server-only `/opt/spaceworker/.env` and `/opt/vantra/.env`, wiping `ADMIN_TOKEN`/`DATABASE_URL` and taking both admin panels down; the old SpaceWorker passcode was unrecoverable and had to be reset.) Server `.env` files are hand-maintained there and don't exist in the local checkout - a bare directory sync or a `--files-from` that accidentally includes `.env` destroys them. Need env changes on the VPS? Use a targeted `ssh` sed/append, never rsync. Snapshot first: `cp /opt/<app>/.env /root/<app>.env.bak-<task>-$(date +%Y%m%d%H%M%S)`.


Build runs as the `trmm` user (matches the deployed process's file ownership), not root. Always tail the build output and check `is-active` + a real `curl` status code before considering a deploy done — a build failure mid-restart once left the service stuck in `activating`/`000` for a few minutes; the fix was just running the build again correctly, but don't skip the check.

## 2a. Full-tree parity check — run this whenever you're not 100% sure the VPS is caught up

**2026-09-28 incident**: the `--files-from` pattern in §2 depends entirely on the deployer remembering every file a change touched. Over enough deploys, this silently drifts — one session found **42 files on the VPS with different content than `main`, plus 27 files that didn't exist on the VPS at all**, including a whole feature (the device-onboarding quarantine pipeline) that had simply never shipped. `prisma/schema.prisma` matched exactly the whole time, so this was pure application-code drift, not a data-risk situation — but it silently caused a real, hard-to-diagnose production bug (a template picker returning fields the deployed API route never selected) that took a long, painful debugging session to trace back to "the file just isn't the one in git."

**Checking one file matches what you intended to deploy is not the same as checking the app is caught up.** Before declaring any deploy done — and especially after a period where you're not sure every past deploy was complete — run a full-tree checksum comparison, not just a diff of the files you touched:

```bash
# From a clean checkout/worktree of origin/main:
find app lib components -type f \( -name '*.ts' -o -name '*.tsx' \) -exec md5 -r {} \; > /tmp/local.txt   # macOS: md5 -r; Linux: md5sum
md5 -r next.config.ts proxy.ts >> /tmp/local.txt
awk '{print $2, $1}' /tmp/local.txt | sort > /tmp/local-norm.txt

ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96 \
  "cd /opt/spaceworker && find app lib components -type f \( -name '*.ts' -o -name '*.tsx' \) -exec md5sum {} \; ; md5sum next.config.ts proxy.ts" \
  > /tmp/remote.txt
awk '{print $2, $1}' /tmp/remote.txt | sed 's|^/opt/spaceworker/||' | sort > /tmp/remote-norm.txt

python3 -c "
local = dict(l.split() for l in open('/tmp/local-norm.txt'))
remote = dict(l.split() for l in open('/tmp/remote-norm.txt'))
missing = [f for f in local if f not in remote]
stale = [f for f in local if f in remote and local[f] != remote[f]]
print('missing on prod:', len(missing), missing)
print('stale on prod:', len(stale), stale)
"
```

Fix anything it finds by rsyncing the real directories over (`app/`, `lib/`, `components/` wholesale, not a hand-picked file list), rebuild, restart, then re-run the same check and confirm zero `missing`/`stale` before moving on. This is cheap (a few seconds) — run it any time you're about to tell the user a deploy is done, not just when something's already gone wrong.

## 3. Schema changes (Prisma migration)

No local Postgres in this dev environment — `npx prisma migrate dev` won't work locally. Instead:

1. Edit `prisma/schema.prisma` locally.
2. **Write the migration SQL by hand** in `prisma/migrations/<timestamp>_<name>/migration.sql`, matching the exact style of any existing migration in that folder (plain `ALTER TABLE`/`CREATE TABLE` statements, a short comment at the top explaining why).
3. `npx prisma generate` locally (no DB connection needed — just regenerates TS types from the schema file) so `tsc --noEmit` passes against the new fields before you ever touch the VPS.
4. `npx tsc --noEmit -p .` locally — must be clean before deploying.
5. Deploy the changed app files **plus** `prisma/schema.prisma` **plus** the new `prisma/migrations/.../migration.sql` file via the same rsync pattern above.
6. On the VPS, from `/opt/spaceworker` (repo root, not `app/`):
   ```bash
   sudo -u trmm npx prisma migrate deploy   # applies the new migration to the live DB
   sudo -u trmm npx prisma generate         # regenerates the client the running app will import
   ```
7. **Then** `cd /opt/spaceworker/app && sudo -u trmm npm run build && systemctl restart spaceworker.service` — building against a stale-generated client is the one mistake that actually broke the service mid-session (`Property 'exeTrialSession' does not exist on type 'PrismaClient'`) until `prisma generate` was rerun. Migrate → generate → build → restart, in that order, every time.

**How to validate a new migration before trusting it (`scripts/deploy-vps.sh` only runs `prisma generate` — it does NOT run `migrate deploy`, so the VPS will not pick your migration up by itself):**

Do **not** try to replay the history onto an empty database. `prisma migrate deploy` on an
empty DB fails at `20260914150000_add_license_claim_token` with `relation "ExeLicense"
does not exist` — pre-existing migrations assume tables created outside the chain. That is
unrelated to your change and tells you nothing about it.

Production's real situation is "apply the new migration on top of N already-applied ones",
so clone exactly that: dump production's **schema** plus the `_prisma_migrations`
**rows** into a scratch DB, then run `migrate deploy` against the scratch DB and assert your
object exists. `/tmp/validate-migration-139.sh` (TASK_139) is a worked example, and it is
what caught that the migration had simply never been synced to the server (`69 migrations
found … No pending migrations to apply` — i.e. the file wasn't there yet, not that the SQL
was wrong).

## 4. Real E2E verification against the live server (not just `tsc`)

Typechecking proves the code compiles, not that it works. For anything security- or money-adjacent, write a disposable Node script that exercises the real deployed HTTP routes with real (throwaway, self-cleaning) data, run it ON the VPS against `http://localhost:3500`.

**The `server-only` problem**: most `lib/*.ts` files start with `import "server-only"`, which throws when imported outside Next's own build pipeline — including a plain `tsx` script. Fix with a one-time require-hook stub (write once, reuse, delete when done):

```js
// scripts/stub-server-only.cjs
const Module = require("module");
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return orig.apply(this, arguments);
};
```

Then: `sudo -u trmm npx tsx --require ./scripts/stub-server-only.cjs scripts/your-e2e-test.ts` (run from `/opt/spaceworker`, the repo root — `tsx` resolves `../lib/...` imports from `scripts/`).

**Pattern for the test script itself** (used for every verification this session — bind/transfer, password sign-in, payment-status, pricing, trial visibility, the Task 49 fix):
1. Create disposable test rows directly via the real Prisma models (`db.user.create`, `db.payment.create`, `db.exeLicense.create`, etc.) — a real `_e2e-<name>-test-${Date.now()}@spaceworker.test` email so it's never confused with a real customer.
2. Hit the actual deployed route(s) with real `fetch()` calls against `http://localhost:3500/api/...` — not calling the handler function directly, the actual HTTP layer.
3. Assert against both the HTTP response AND a follow-up DB read (e.g. "did `boundMachineId` actually change in Postgres, not just in the JSON response").
4. **Always clean up** every row you created (watch for FK constraints — e.g. `PaymentVerificationAttempt` rows block a `Payment` delete until removed first) and delete the test script + the stub file from the VPS when done. Never leave test data in the production DB or test scripts sitting in `scripts/`.
5. Print a single `RESULT: PASS`/`RESULT: FAIL` line gated on every assertion, `process.exit(0/1)` accordingly — makes the run's outcome unambiguous at a glance.

**Testing an admin-gated route** without touching the real `ADMIN_TOKEN` secret: mint a valid session JWT directly using the already-deployed code (`createAdminSessionToken()` from `lib/admin-auth.ts`, which only needs `SESSION_SECRET`, not the admin passcode), then send it as the `Cookie` header:
```ts
const adminToken = await createAdminSessionToken();
const res = await fetch("http://localhost:3500/api/admin/exe-trials", {
  headers: { Cookie: `spaceworker_admin_session=${adminToken}` },
});
```
This proves the real admin-gated code path works without ever pulling a plaintext secret into a script or chat transcript.

**Never pull real secrets into a script or terminal output.** When one file's config needs copying into another env file (e.g. reusing Vantra's Telegram bot token for SpaceWorker), do it entirely server-side with `grep ... >> targetfile`, which never prints the value — confirm success by counting matched lines, not by displaying them.

## 5. EXE build + install cycle (Windows)

```bash
gh workflow run "Build EXE" -f variant=extractor -R softdeployautomation-sketch/spaceworker
# poll (in background, not a blocking sleep):
until [ "$(gh run view <RUN_ID> -R softdeployautomation-sketch/spaceworker --json status -q '.status')" = "completed" ]; do sleep 15; done
gh run download <RUN_ID> -R softdeployautomation-sketch/spaceworker
```

Takes ~8 minutes. Then transfer + install on the Windows VM over SSH:
```bash
ssh -i ~/.ssh/tacticalrmm_vps myrat@192.168.0.104 "powershell -Command \"Start-Process 'C:\Users\myrat\AppData\Local\SpaceWorker OS - Lead Extractor\uninstall.exe' -ArgumentList '/S' -Wait\""
scp -i ~/.ssh/tacticalrmm_vps "<local installer path>" "myrat@192.168.0.104:C:/Users/myrat/Downloads/setup.exe"
ssh -i ~/.ssh/tacticalrmm_vps myrat@192.168.0.104 "powershell -Command \"Start-Process 'C:\Users\myrat\Downloads\setup.exe' -ArgumentList '/S' -Wait\""
```

**Cannot launch the GUI over SSH** — `Start-Process` for the app itself dies within ~15–20 seconds because there's no interactive desktop session for it to attach to over an SSH-only connection. The install/uninstall steps above work fine (they're headless), but the actual app launch has to be done by a human sitting at the VM's own desktop. Say so plainly rather than claiming a GUI test happened when it didn't. (In practice, launching via `Start-Process` over SSH and then immediately `curl`ing `http://127.0.0.1:34413/...` from the *same* SSH session has worked reliably in this session for verifying SERVER-side behavior — the Node process does stay up long enough for that; it's the visible WINDOW that's unusable this way, not the local Next.js server.)

**CRITICAL — the installer does NOT refresh the bundled runtime on reinstall.** Found live 2026-09-21 after several rounds of confusing "the fix doesn't seem to have landed" results: `uninstall.exe` + a fresh `setup.exe` (even a hash-verified, byte-different-from-last-time one) only replaces `spaceworker-exe.exe` and `uninstall.exe` themselves — the bundled Next.js runtime under `%LOCALAPPDATA%\SpaceWorker OS - Lead Extractor\_up_\` is **left untouched if that folder already exists**, silently keeping whatever build was there before, no matter how many times you "reinstall." Confirmed directly: `_up_`'s own `LastWriteTime` stayed frozen across three full uninstall→transfer→install cycles in a row, while the launcher EXE's timestamp changed every time — an installed build can look successful (correct hash, correct launcher timestamp, app launches, server responds) while still serving old JS underneath.

**The fix, until the installer itself is corrected**: before every install used for real verification, explicitly delete the stale directory first:
```bash
ssh -i ~/.ssh/tacticalrmm_vps myrat@192.168.0.104 "powershell -Command \"Get-Process -Name 'spaceworker-exe','msedgewebview2','node' -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 3; Remove-Item 'C:\Users\myrat\AppData\Local\SpaceWorker OS - Lead Extractor\_up_' -Recurse -Force -ErrorAction SilentlyContinue\""
```
`msedgewebview2` helper processes can survive killing the main `spaceworker-exe` process and will hold a file lock that makes the `Remove-Item` fail silently-ish (`_up_` still `Test-Path`s `True` right after) — kill `msedgewebview2` and `node` explicitly too, not just the launcher, and verify with `Test-Path` before trusting the removal. A real fresh extraction install takes noticeably longer (multiple minutes, not the near-instant "success" a skipped-extraction reinstall gives) — that timing difference is itself a useful tell.

**Longer-term**: this should be fixed properly in the NSIS/Tauri bundling config so a normal reinstall (or better, a version-aware update) always replaces the runtime — worth its own task rather than remembering this manual step forever.

**Only the Extractor variant is wired into CI today** — the workflow's `variant` dropdown (`.github/workflows/build-exe.yml`) only offers `extractor`, and `BUILD_TARGET` now correctly tracks whichever variant is selected (fixed 2026-09-20 — it used to be hardcoded regardless of input). Adding Mailer/Combined/Automation as real buildable variants is its own task, not assumed done.

**Faster alternative for backend-only changes**: if what you're verifying is a `/api/exe/*` route's logic and not literally the Windows GUI, run the EXE's local runtime directly on your dev machine instead of a full build+install cycle:
```bash
SPACEWORKER_LOCAL_EXE=true BUILD_TARGET=extractor npm run dev -- -p 3400
```
Then hit `http://localhost:3400/api/exe/...` with real `curl`/`fetch` requests — exercises the exact same code the packaged EXE runs, in seconds instead of ~10+ minutes, without a Windows VM at all. Use the full build+install cycle only when the change is genuinely about the packaged installer or the native shell itself.

## 6. Gotchas learned live (append-only — read before building/deploying)

Added 2026-09-22 (Task 92):

- **Next.js forbids sibling dynamic slug name mismatches.** Two routes at the
  same dynamic level must use the SAME slug: `app/api/admin/users/[id]/...` +
  `app/api/admin/users/[userId]/...` compiled fine (`tsc` clean, `next build`
  succeeded) but **crashed the whole app at boot** with
  `You cannot use different slug names for the same dynamic path ('id' !== 'userId')`
  — landing returned 500 and journalctl spammed unhandled rejections. Before
  adding a nested dynamic route, `ls` the sibling directories and copy the
  existing slug name exactly (admin user routes use `[id]`).
- **Hand-written migration SQL: empty text-array default is
  `DEFAULT ARRAY[]::TEXT[]`** (or `'{}'`), never `ARRAY()::TEXT[]` — the
  latter is a Postgres syntax error that fails the whole migration mid-deploy
  (recover with `npx prisma migrate resolve --rolled-back <name>` after
  fixing the SQL). Also: quote EVERY camelCase column in manual psql
  verification (`"grantedAt"`, not `grantedAt` — unquoted folds to lowercase
  and errors).
- **`.next` ownership breaks the trmm build.** A build ever run as root on
  the VPS leaves root-owned files in `/opt/spaceworker/.next`; the next
  `sudo -u trmm npm run build` dies with `EACCES ... unlink` mid-build and the
  service can end up stuck `activating`. Fix: `chown -R trmm:trmm
  /opt/spaceworker/.next`, then rebuild. Always build as `trmm` (per §2) and
  check ownership first when an EACCES unlink appears.
  **Vantra is a DIFFERENT user — this cost a deploy on 2026-09-23.** `vantra.service`
  runs `User=vantra` and `/opt/vantra/.next` is `vantra:vantra`, so building it as
  `trmm` fails instantly with `EACCES: permission denied, open
  '/opt/vantra/.next/trace-build'`. Build Vantra as its own user:
  `cd /opt/vantra && sudo -u vantra npm run build`. Per-repo rule:
  **SpaceWorker → `trmm`, Vantra → `vantra`** — check with
  `systemctl cat <svc> | grep ^User=` before the first build of a session.
  **Rsynced files land as your local uid (502), not the service user.** After any
  rsync, `chown` the deployed files to `trmm:trmm` (that's what the sibling route
  dirs use, even inside Vantra) — `ls -la` a sibling first to confirm the local
  convention.
- (Also from Task 92) `systemctl status` prints the substituted
  `%INTERNAL_BEARER_TOKEN%` from unit files — don't paste raw status output
  into logs/screenshots when a token-bearing unit was involved.
- **2026-10 (console bug batch): a "partial route dir" rsync silently 404s as
  HTML.** Deploying only SOME sibling route dirs (e.g. `action/` +
  `queued-commands/` without `mesh-urls/`) leaves the missing ones returning
  Next.js's HTML 404 page — which callers then render verbatim in the UI
  (`<!DOCTYPE html>…` in a red error line). When rsyncing route directories
  under a shared dynamic segment, `ls` the LOCAL dir and deploy ALL siblings,
  or rsync the parent dir wholesale. (Related, same incident: `sw-agent-tenant`
  + the action route's local copy both read `client_id`/numeric `client`, but
  today's TRMM payload returns `client` as the client NAME string — resolve
  via the clients list; see lib/sw-agent-tenant.ts.)
- **TRMM's agent serializer is not stable field-shape — assert on live
  payloads, not memory.** `/agents/<id>/` currently returns `client` (string
  name) + `site` (numeric) and NO `client_id`/`client_name`. Any tenant/auth
  resolution built on assumed numeric fields fails silently → every guarded
  route 404s "Device not found" on healthy, correctly-installed agents.
- **2026-09-23 (MeshCentral iframe auth): SameSite=None needs the webserver.js
- **2026-09-23 (MeshCentral login-token auth — RESOLVED; the outage was `cause:"noauth"`).**
  Vantra's MeshCentral websocket login (`lib/meshcentral-api.ts::listMeshNodes`,
  and therefore the older `findMeshNodeIdByHostname` and the mesh view-only route)
  was being refused with `{"action":"close","cause":"noauth","msg":"noauth"}`. That exact
  message comes from `webserver.js` ≈L7399 — the branch where `PerformWSSessionAuth`
  returned `user == null` and no `x-meshauth: *` header was sent, i.e. the `?auth=`
  token was **not decrypted into a user**. It fails at the websocket auth layer
  *before* any application code runs, so it is never a bug in the caller and never a
  regression from whichever task you happen to be on. Don't chase it in app code.
  **Actual root cause (found + fixed 2026-09-23): the token's `u` must be the FULL
  MeshCentral userid (`user//name`), not a bare username.** The key half was already
  right: `webserver.js` ≈L9116 decrypts `?auth=` with
  `obj.parent.loginCookieEncryptionKey` (`decodeCookie(..., 60)`), and
  `MESH_LOGIN_KEY` in `/opt/vantra/.env` **does** byte-for-byte equal MeshCentral's
  `LoginCookieEncryptionKey` record `key` (160 hex / 80 bytes — verified). The
  rejection was one branch later, ≈L9127:
  `... && (obj.users[cookie.u]) && (cookie.u.split('/')[1] == domain.id)`, commented
  "Cookie of format { u: 'user//name', a: 3 }". `obj.users` is keyed by the **full
  userid** (`user//vantra-service___4` in the store), so sending the bare name
  `vantra-service___4` missed the lookup → `user == null` → `noauth`.
  Proof, same socket, only `u` changed: `u:"vantra-service___4"` → `noauth`;
  `u:"user//vantra-service___4"` → authenticated, 3 nodes returned.
  **Two-part fix:** (1) `/opt/vantra/.env` now has
  `MESH_LOGIN_USER=user//vantra-service___4` (snapshot:
  `/root/vantra.env.bak-t106fix-*`); (2) `makeLoginToken()` normalises a bare name to
  `user//<name>` (Vantra `8296f47`) so a bare value can't silently break mesh auth
  again. This also repaired the pre-existing **mesh view-only session** flow —
  **closed out 2026-09-23** by exercising Vantra's real functions against the live
  socket: `listMeshNodes()` with the deployed full userid → 3 nodes; with a BARE
  override → still 3 nodes (normalisation works); `findMeshNodeIdByHostname("Sc")`
  → `node//…`; `createViewOnlyShareLink()` → share URL; `GET <share url>` →
  **HTTP 200, 149135 bytes**. Lesson: a bare-vs-qualified identity string failed at
  the *transport* layer and every caller swallowed it (fail-soft by design) — probe
  the socket directly, don't read logs.
  Lesson for next time: a bare-vs-qualified identity string failed at the *transport*
  layer and every caller swallowed it — when mesh lookups go quietly empty, probe the
  socket directly instead of reading application logs.
  (For reference, this deployment has no `loginkey` field anywhere: config.json has
  `allowLoginToken:true` but no `loginkey`, and neither do its two `.bak` copies —
  don't go looking for one.)
  Symptom to recognise: idle/idletime enrichment (Task 106 C1) silently returns
  `{"ok":true,"idleByHostname":{}}` so every `idleSeconds` is `null`. Every caller is
  fail-soft by design, so this failure mode is **silent** — probe the socket, don't
  read logs for it.
  MeshCentral's live store here is **Postgres** (`settings.postgres` in config.json;
  DB `meshcentral`, doc table `main` with columns `doc,id,type,domain`) — the
  `meshcentral-data/meshcentral.db.json` file is stale and is NOT the live store.
  Still true and handy: per-node `idletime` is in **seconds**
  (`agents/meshcore.js`: `win-deskutils.idle.getSecondsAllSessions()`), sampled
  roughly every 5 minutes, and reflects the most recently active session on the box.

  patch RE-APPLIED after every MeshCentral update.** The `xid` cookie's
  SameSite comes from `settings.sessionsamesite` (config.json — now "none"),
  but its Secure flag is `secure: (obj.args.tlsoffload == null)` in
  `/meshcentral/node_modules/meshcentral/webserver.js` (~L7025). `tlsOffload`
  is set, so vanilla MC emits SameSite=None WITHOUT Secure → Chrome/Firefox
  reject the cookie and the cross-site iframe still fails with "Unable to
  perform authentication". Patch that line to `secure: true` (browser always
  talks HTTPS in front of the tlsOffload terminator, so Secure is correct).
  Verified via `curl -D-` on a minted control URL: `xid=…; samesite=none;
  secure; httponly`. Backups: `/root/config.json.bak-*`, `/root/webserver.js.bak-*`.

- **2026-09-23 (browser-clone review): "encrypted at rest" ≠ "usable on another
  machine". Verify the KEY SHIPS, not just the data.** Chrome cookie/password values
  are AES-encrypted with a key that lives (DPAPI-wrapped) in `<User Data>\Local State`;
  on current Chrome the values are `v20` **app-bound** (check: the value begins hex
  `763230`). Copying the raw `Cookies`/`Login Data` files to another PC therefore
  produces values that CANNOT be decrypted there → the "clone" restores a browser with
  no sessions. Any cross-machine secret move needs an explicit **re-protection** step
  (decrypt on source → re-encrypt for destination, or inject a fresh key + `Local State`
  into the destination profile). Passwords were re-protected in the engine; cookies were
  not — asymmetry like that is the thing to look for.
- **2026-09-23 (browser-clone review): ALWAYS verify a capture/backup by DECRYPTING it
  and listing entries — counts and "exit 0" lie.** The PS path reported success, wrote a
  390 KB archive, and contained 31 entries — and **zero** cookie files, because it looked
  for `Cookies` at the profile root while current Chrome keeps it at
  `<profile>\Network\Cookies` (and `Local State` at the **User Data root**, one level
  ABOVE the profile). Rule: after any capture, decrypt + enumerate and grep for the files
  that carry the feature's value (here: cookies). A green exit code is not evidence.
- **2026-09-23: device-side deliverable gates (add to every such task).** For PowerShell:
  `Parser::ParseFile` AST gate on the target Windows host (proves syntax without
  executing). For Go: `go build ./...` + `go test ./...` + `GOOS=windows GOARCH=amd64
  go build ./...` (and confirm `go.mod` needs no external deps for clean cross-compiles).
  Run these BEFORE functional tests so a syntax/compile failure can never masquerade as a
  logic bug. This review's gates found a blocking defect that a "looks fine" read would
  have missed.

- **2026-09-24 (TASK_109/B3): a deployed `lib/*.ts` module is verifiable live with
  no route of its own — and a transport/relay refusal is reproducible for free.**
  Recipe that produced 57/57 on the clone orchestrator (reusable for B4/B5/B6):
  (1) `tsc` + `eslint` + `npm run build` locally, deploy, then `md5` the file on the
  box — `md5` equality is the *only* proof the deployed code is the committed code;
  (2) `grep -rl` a distinctive string from the module under
  `/opt/spaceworker/.next/server` to prove it actually compiled into the bundle (an
  imported-by-nothing `lib/*.ts` is NOT in there — that is how B2's
  `clone-transport.ts` sat unbuilt until B3 imported it);
  (3) a disposable tsx harness (§4 stub) that creates a temp user/device rows, drives
  the real functions, and deletes everything in a `finally`, then re-checks residue
  counts back to zero (`CloneJob`/`RelayHealth`/`HostedBrowserSession` = 0);
  (4) **hit the real HTTP route** where one exists (mint a user session with
  `createSessionToken()` from `lib/auth.ts` and send
  `Cookie: spaceworker_session=<jwt>` — the user-session twin of the admin-token
  trick in §4) rather than only calling the function — this is what proved the panic
  leg through `POST /api/devices/panic` on the deployed build;
  (5) point a temp device at an **unknown `vantraAgentId`**: a real Vantra route
  answers 404 fast, which makes "fails closed before the next step" (e.g.
  `relay_unreachable`, zero capture jobs, no session row) testable on live data with
  no Windows device online.

Added 2026-09-27 (TASK_128 — the onboarding-quarantine window):

- **`react-hooks/purity` rejects `Date.now()` during render — a live countdown
  needs a tick, not an inline read.** Rendering `Date.now()` (or `new Date()`)
  in a component body fails lint with *"Cannot call `Date.now()` during render"*,
  because render must stay pure. The pattern that passes — and that the
  Devices strip, its row badge and the console's Onboarding card all use — is
  `const [nowMs, setNowMs] = useState(() => Date.now())` plus a
  `setInterval(() => setNowMs(Date.now()), 60_000)` in a `useEffect` (the lazy
  initialiser is fine; only the *render-time* call is impure). Keep it a
  **separate** interval from the 20 s data poll: the countdown text must move
  even when the list payload is unchanged.
- **A "failed" state that the UI filters out is a silent failure.** TASK_128's
  first build filtered non-terminal onboarding rows with
  `isOnboardingTerminal`, which made a `failed` row vanish from the strip, from
  the console card *and* from the row badge — so a device that never moved just
  reverted to a plain `Public` and looked like nothing had happened. When you
  add a terminal-failure status, grep every place that filters
  `released | failed` together and make sure `failed` still renders somewhere
  loud. Guard it with a test that asserts the failed *copy*, not just the status.
- **Check the migration timestamp against `origin/main`, not local `main`, BEFORE
  naming it.** TASK_128 was authored on a branch whose tip predated main's
  screenshot migrations. The new migration was first named `20261009000000` —
  sorting *before* an already-applied one — and the "fix" (`20261011000000`)
  then **collided with a migration that was already on `origin/main` and already
  applied on the VPS** (`20261011000000_task127_screenshot_wake_delay`, commit
  `139dd4e`), because the local `main` ref was **2 commits behind `origin/main`**.
  Nothing had been deployed, so a `git mv` was enough — but if it had been
  applied anywhere this needs `prisma migrate resolve`, not a rename, and a
  reused prefix is exactly how migration history diverges. Always:
  ```
  git fetch origin
  git ls-tree --name-only origin/main prisma/migrations/ | tail -3
  ```
  and pick a timestamp **strictly greater** than the newest one on
  `origin/main`. Never trust local `main` for this — it drifts.

Added 2026-09-27 (TASK_128 §15 — verifying a deploy actually took):

- **`/opt/<app>/lib/*.ts` on the VPS is NOT what runs — grepping it can hand you
  a confident WRONG answer.** Both deploy workflows ship a **prebuilt tarball**
  (`.next node_modules package.json package-lock.json prisma …`); they never ship
  `lib/`, `app/` or `components/`. But `/opt/vantra` still has a **stale `lib/`
  tree from an earlier source-based deploy** (its `lib/device-auto-move.ts` is
  dated Sep 22, five days before the build that is actually running). Verifying
  *"is `AUTO_MOVE_DELAY_MINUTES` live at 15?"* by grepping
  `/opt/vantra/lib/device-auto-move.ts` answers **20** — the value from a file
  that has been dead on disk since September, and it looked exactly like
  authoritative evidence. `/opt/spaceworker/lib/` does not exist at all, so there
  the same grep silently returns nothing. Either way the file is not evidence.
  The runtime is `next start`, i.e. the **build**, so verify against the build:
  ```bash
  stat -c '%y %n' /opt/<app>/.next/BUILD_ID      # is the build from THIS deploy?
  # server chunks ship .map files whose sourcesContent is the real compiled source
  F=$(grep -rl 'THE_CONSTANT' /opt/<app>/.next/server | grep '\.map$' | head -1)
  python3 -c "import json,sys; m=json.load(open(sys.argv[1])); \
    [print(l.strip()) for i,s in enumerate(m['sources']) if 'the-file' in s \
     for l in m['sourcesContent'][i].split(chr(10)) if 'THE_CONSTANT' in l]" "$F"
  ```
  That prints the source the running build was compiled from. Pair it with the
  `BUILD_ID` mtime (must be *after* your deploy) or you are reading a previous
  build. Cheaper still for behaviour: the routes themselves, since a mounted
  route answers 401/403 where a missing one answers 404 — and a **tenant-guarded
  destructive route can be tested safely by aiming it at a non-existent id**,
  where `404 "Device not found."` proves the action name is accepted *and* the
  guard fires before anything destructive, with `400 "Unknown action."` as the
  contrast for a name that is not wired at all.

- **2026-09-27 (TASK_128): `.next/static/chunks/` accumulates ORPHANS across
  deploys — a `grep` there is not proof either way.** Measured on the live box:
  **138** `.js` files under `static/chunks`, and the *old* expression
  (`"private"===e.tier?"Private":"Public"`) was still present in several of them
  while the *new* one was present in exactly one. Both were found, so a bare
  `grep -rl` of the chunk dir can neither confirm nor refute a UI change — the
  extract-the-tarball deploy never removes chunks from earlier builds, and
  `app-build-manifest.json` (the dev-time route→chunk map, §6 above) is **not
  emitted** in this production build (`find .next -name '*manifest*'` returns
  `build-manifest`, `app-path-routes-manifest`, etc. — no `app-build-manifest`).
  Order of preference instead: (1) `BUILD_ID` mtime *after* your deploy;
  (2) the **server** `.map` recipe above — server chunks are the authoritative
  compiled source; (3) grep the **repo** for the old expression and confirm it is
  gone: if the old literal exists nowhere in the source, no chunk on the box can
  be serving it; (4) if a chunk *is* known from a devtools network trace, anchor
  on the presence of the **unique new** minified expression, never on absence.

Added 2026-09-27 (owner: *"what exactly are this link errors you keep passing, and
why can't they be fixed"* — the answer was two unrelated things):

- **`npm run lint` here reports ~42,000 problems because bare `eslint` walks
  `src-tauri/target/`.** `package.json`'s `lint` script is a bare `eslint` with
  no path argument, and `eslint.config.mjs` only ignored the four
  `eslint-config-next` defaults (`.next`, `out`, `build`, `next-env.d.ts`) — not
  the Tauri build output. So a whole-repo run walks the release bundle,
  including a fully-bundled Next standalone `server.js` (one minified line,
  which is why the positions look like `1:5562`), and piles up
  **42,652 problems (3,481 errors / 39,171 warnings)** that nobody can act on.
  `src-tauri/target/` is already in `.gitignore:17`, so none of it is source.
  With `globalIgnores(["src-tauri/target/**"])` added, the same run over
  `app components lib tests` drops to **89 problems in 28 files** — all
  pre-existing and unrelated. **A linter that always screams is a linter nobody
  reads**, and that noise is exactly what hid the three real findings below. When
  a repo's lint output is in the thousands, suspect build output before suspecting
  the code: `npx eslint . -f json | …` grouped by file names the culprit in one go.
- **`react-hooks/set-state-in-effect` (eslint-plugin-react-hooks 7.1.1) flags a
  *direct call to any function that transitively contains `setState`*, without
  checking that any `setState` runs synchronously.** Proof, using this repo's own
  config — three cases in one scratch component: (A) an `async` loader whose only
  `setState` is *after* an `await`, called directly in the effect body →
  **flagged**; (B) a genuinely synchronous `setState` in the body → flagged (the
  real bug it is designed to catch); (C) the **identical** async loader reached via
  `setInterval` → **clean**. A and C differ only in whether the call is direct, so
  the trigger is structural, not runtime. Consequences: the idiomatic
  `useEffect(() => { void load(); }, [load])` pattern — where `load` awaits its
  fetch before touching state — is a **false positive**, and *disabling the rule
  globally would blind you to (B)*. Use a **narrow suppression at each site**
  (`// eslint-disable-next-line react-hooks/set-state-in-effect -- <why>`, or a
  scoped `/* eslint-disable */ … /* eslint-enable */` pair around just that
  effect) and say in the comment *why* every `setState` is behind an `await`, so
  the next reader can check the claim instead of trusting it. This is also how to
  tell a real finding from a false one: a **real** one has a synchronous
  `setState` on the path you can point at.

Added 2026-09-27 (TASK_128 §16 — a timer is not a failure detector):

- **Never make elapsed wall-clock time terminal for a device you can only observe
  intermittently.** TASK_128's onboarding clock starts when Vantra first *sees*
  the agent and keeps running whether or not the machine is reachable — so the
  elapsed value silently includes every hour the box spent **switched off**. A
  35-minute ceiling built on that number marked a perfectly healthy device
  `failed` on the first sweep after it came back, and because `failed` was
  terminal the red badge then *stuck* even after the move succeeded. If a
  "stuck" signal is needed, make it a **warning** (a separate display state
  carrying the elapsed time and the *reason*), and let the terminal state come
  only from genuine **attempt** counts — which is what Vantra's
  `device-auto-move.ts` already does (`attempts >= 6`, and it returns early
  without acting when the device is offline). The general rule: **time is
  evidence of waiting, attempts are evidence of failing.** Keep red for the
  second one only, so the colour stays trustworthy.
  Related, and the reason this was easy to miss: the two halves of the same
  feature had *different* failure semantics — Vantra (which performs the move)
  waits forever while offline; SpaceWorker (which only observes) was the one
  inventing a deadline.

Added 2026-09-28 (TASK_136 — a diagnostic must ask the same question the real code asks):

- **When you write a diagnostic that runs a protocol conversation by hand, it must
  speak the SAME conversation the real client speaks — same encryption, same
  auth, same command ORDER — or its verdicts are worthless.** TASK_136 added an
  envelope probe to prove a mailbox can actually send (`verify()` stops at EHLO,
  so it passed a relay that then refused every recipient). The first draft
  connected, skipped STARTTLS, skipped AUTH, and offered the envelope. A control
  run against `smtp.gmail.com:587` returned
  `530 5.7.0 Must issue a STARTTLS command first` — and the code reported
  **"this mailbox cannot send"**. That reply is *correct*: it is the server
  answering the question we actually asked (a plaintext one). Every normal 587
  provider would have been condemned, and no unit test caught it — **the shared
  fake server had the same blind spot as the code**, because both were written
  from the same wrong mental model. What caught it was pointing the probe at a
  **real, known-good server** and asserting it does NOT fail. So: for any
  protocol diagnostic, keep a live control against a real provider in your
  verification list, not just a fake. Two rules generalise:
  - **A "no" is only a verdict if your session was equivalent to a real one.**
    Record whether you actually encrypted and authenticated (`usedTls`,
    `authenticated`), and when the reply blames one of those things you didn't
    do, return *inconclusive* — never a failure. The component that owns that
    concern (here `nodemailer.verify()`, which owns credentials and TLS) is the
    only one allowed to answer it.
  - **A fake server built from your understanding of the protocol cannot falsify
    your understanding of the protocol.** It is necessary but not sufficient
    evidence.
- **`nodemailer.verify()` is a CONNECT + AUTH check, not a "can send" check.**
  It returns `true` for a server that accepts the connection, advertises nothing,
  and then answers `550 Not allowed` to every `RCPT TO` — including its own
  address. If a feature's promise is "this mailbox will deliver", `verify()`'s
  green tick is not that promise; offer a real envelope (`MAIL FROM` → `RCPT TO`
  → **`RSET`**, and never `DATA`, so nothing can be transmitted) and let the
  server's own reply decide.

Added 2026-09-28 (relay/DKIM bring-up — the fix that "worked" was a no-op twice):

- **On this VPS, `systemctl reload postfix` and `systemctl restart postfix` are
  NO-OPS — `/lib/systemd/system/postfix.service` is a stub** (`ExecStart=/bin/true`,
  `ExecReload=/bin/true`). It always reports `active`, so the command looks like it
  worked, while the real `master` keeps its OLD configuration in memory forever.
  Signing DKIM was wired into `main.cf` and never took effect; nothing logged an
  error. Use the **binary**: `postfix reload` (or `postfix start`). Verify by
  ELAPSED TIME on the master process, not by `is-active`:
  `ps -eo pid,etime,args | grep sbin/master`. If the etime is older than your
  config change, the change is not live. (OpenDKIM's own unit is a normal unit —
  `systemctl restart opendkim` does work.)
- **A milter socket that the smtpd user cannot open is SILENTLY IGNORED.** OpenDKIM
  bound its socket as `opendkim:opendkim`, but Postfix's smtpd runs as `postfix` —
  a non-owner with no write bit, so the connect failed. `milter_default_action =
  accept` (set so DKIM can never block mail — correct) then means the failure is
  invisible: mail flows, unsigned, and there is no error anywhere. Fix:
  `UserID opendkim:postfix` so OpenDKIM chgrps the socket to the group Postfix
  runs as. Probe it as that user before believing it.
- **Never accept a log line as proof that DKIM is signing.** `grep opendkim
  /var/log/mail.log` showed only start/stop banners for hours across two
  "successful" restarts. The only acceptable proof is the header on the delivered
  message **and** a cryptographic verification of it:
  `DKIM-Signature: ... d=<domain>; s=<selector>` present, then verify the signature
  against the public key (dkimpy with a stubbed `dnsfunc`, so the missing DNS
  record doesn't mask a real key mismatch). A signature that is present but
  unverifiable is WORSE than none, because it looks like the job is done.
- **Extracting a message from an mbox: do not use `awk NF`.** It deletes blank
  lines, which removes the header/body separator and corrupts the message — DKIM
  then fails with `Unexpected characters in RFC822 header`. And don't round-trip
  through a parsed Message object either (line endings and header folding change,
  breaking a `c=relaxed/simple` body hash). Slice the RAW BYTES at the last
  `^From ` separator and keep everything after that line untouched.
- **A mailbox host that is internal on purpose now has an explicit, operator-only
  door** (`SMTP_INTERNAL_RELAY_HOSTS`, see `lib/smtp-host-guard.ts` + TASK_137).
  It takes `host:PORT` pairs and the port is mandatory: a portless entry would
  re-open the whole-loopback port scan that Task 51 closed. If you touch that
  guard, `npm run test:mailguard` pins both halves (loopback stays blocked with
  no allowlist; only the exact host:PORT opens).
- **In a `require`-hook test stub, return methods at the TOP LEVEL — never nested
  under `default`.** `lib/sending-domains.ts` does `import dns from
  "node:dns/promises"`. esbuild's CJS interop sets the wrapper's `.default` to the
  WHOLE module object, so a stub shaped `{ default: { resolveTxt } }` leaves
  `dns.resolveTxt` **undefined** — and because `txtRecords()` wraps its lookup in
  `catch {}` (correctly: ENOTFOUND must read as "nothing published"), the resulting
  TypeError was swallowed and every lookup silently answered "no record". The suite
  ran green against a stub that never worked, until two assertions caught it. Both
  the `{ lookup }` stub in `tests/smtp-host-guard.test.ts` and the `{ resolveTxt }`
  stub in `tests/sending-domains.test.ts` are top-level for this reason. General
  rule: a stub whose failure mode is indistinguishable from a legitimate negative
  answer must be proven to WORK, not just to pass — mutate the code under test and
  confirm the assertion actually fails.
- **A merge/overwrite bug in shared relay tables is invisible without a test.**
  OpenDKIM's KeyTable/SigningTable at `/etc/opendkim/` are shared by EVERY tenant.
  Regenerating them from only the domain being added would silently stop DKIM
  signing for every other customer — no error, no log, mail just starts landing in
  spam. `upsertTableLine`/`removeTableLine` in `lib/sending-domains.ts` therefore
  take the EXISTING file contents and merge. `npm run test:domains` pins it: mutate
  `upsertTableLine` to overwrite (return only the new line) and the merge test fails.
- **An unsigned send is INVISIBLE: 250 accepted, no
  `DKIM-Signature`, spam-folder on arrival.** Proven live (TASK_140) — the same
  relay accepted two messages identically, one signed `d=…ca.lu`, one with **no
  signature header at all**, and both returned `250 2.0.0 Ok`. Every check the app
  had (server talks, server takes the envelope) passes in both cases. So the rule
  is: *"the server accepted it" is not "the mail will be delivered"* — always say
  whether it will be SIGNED. `evaluateSigningCoverage()` in `lib/sending-domains.ts`
  does that, and it keys on **`installedOnRelay`** (the key on disk is what signs),
  never on `status`: a domain whose DNS is not verified yet is still signed, and
  conflating the two sends users to redo work they already did.
- **A VM/RDP/desktop session cannot fix authentication — only DNS can.** DKIM is a
  DNS lookup keyed on the `d=` domain; SPF is a DNS IP list. The verifier never
  learns where the message was composed, and a session on the same host has the
  same egress IP, so nothing about the session changes either axis. If someone
  proposes "run it from a VM/RDP instead", this is the answer.
- **The per-customer DNS record can be eliminated by moving it to OUR domain.**
  You cannot authenticate a domain you do not control, but you do not have to use
  the customer's domain. `PLATFORM_SENDING_DOMAIN` (TASK_140) points at a domain we
  own and authenticate once; then **one** DNS edit serves **all** customers, which
  is exactly the shared-sending-domain model at Resend/SendGrid. Two routes exist
  here and both are already half-built: our own relay (add the relay IP to our SPF
  + publish our `sw._domainkey` key) and Resend (we already send from
  `spaceworker@instaweb.top` with `resend._domainkey.instaweb.top` published).
  **When editing that SPF, ADD the `ip4:` term — never replace the record**: the
  existing `include:` carries the platform's own signup/verification mail.
- **The relay's SigningTable is the ground truth for "will it be signed" — not our
  database.** They diverge in both directions and the live server has one today: a
  key installed out-of-band (a shell script) SIGNS mail while no `SendingDomain`
  row exists, so a DB-only check reports "UNSIGNED" for mail that is in fact
  signed — a false alarm on a working mailbox. A row can equally outlive its key on
  disk. OpenDKIM consults the file, so `parseSigningTableDomains()` reads it and the
  DB supplies only DNS state; when the file is unreadable the decision falls back to
  `installedOnRelay` (never to "everything unsigned"). Both directions are
  mutation-tested in `npm run test:domains`.
- **`deploy-vps.sh` used to skip the build and still report `EXIT=0`.** Under macOS
  bash **3.2**, `${DIR_ENTRIES[@]}` on an **empty** array is an unbound-variable
  abort (fixed only in bash 4.4) — and it is empty exactly when the file list has
  no directory entries, which is what §2 tells you to pass for the build half. So
  following the playbook on macOS aborted at the tree-sync step, before
  `prisma generate`/build/restart, while `is-active`/`curl`/maintenance all looked
  perfect — describing the PREVIOUS build. Fixed two ways: the expansion is now
  `${DIR_ENTRIES[@]+"${DIR_ENTRIES[@]}"}`, and an EXIT-trap check FAILS the run if
  it exits 0 without reaching the `DEPLOY_COMPLETE=1` marker. **Always confirm a
  deploy by comparing `.next/BUILD_ID`'s mtime against your source mtimes** — on
  the VPS the script runs under bash 5.1, which is why this only ever bit locally.
- **Launch the deploy with `nohup … > log 2>&1 </dev/null &` — the `</dev/null` is
  not optional.** Without it the local `ssh` client gets SIGSTOPped by terminal job
  control (seen twice: `ps -o stat` shows `TN`). The remote build then COMPLETES
  while the local script stays frozen — leaving the new build on disk, maintenance
  **ON**, and the service never restarted, i.e. users get the maintenance page. If
  that happens, finish it by hand: `systemctl restart spaceworker.service`, check
  `curl localhost:3500/` = 200, then `rm -f /var/www/sw-maintenance.on`.
- **A DNS check that "could not answer" must NEVER be rendered as "no record
  published".** These are different verdicts with opposite user actions: an absent
  record is a genuine DKIM failure the user must fix, while a resolver that
  SERVFAILed or timed out tells us nothing, and calling it "no key published"
  sends someone to re-publish a record that may already be correct and live. Only
  `ENOTFOUND`/`ENODATA` mean the name genuinely does not exist; everything else is
  `unknown`. The lookup is also raced against a timer (`resolveTxtBounded`), because
  it feeds a verdict on the Test-connection screen and a stalled resolver must not
  become a stalled test — and the raced-away promise's rejection is captured as a
  value, or an unhandled rejection could take the process down after the answer was
  already given. **Pin this at the DNS layer, not only at the decision layer** —
  `tests/sending-domains.test.ts` drives `lookupDkimState` through the require hook
  with a stub that can hang (`setHang`) and fail (`setDnsFailure`), and the timeout
  is an injectable parameter so the rule costs 50 ms of test time, not 2.5 s.
- **A require-hook condition that forgets the file extension matches NOTHING, and a
  stub that does not apply is indistinguishable from a stub that agrees with you.**
  Every module in this repo is required as `lib/<name>.ts`, so the parent filename
  ends in `.ts`; a check written as `from.endsWith("/lib/sending-domain-coverage")`
  is silently false, and the module under test then imports the REAL module. That
  is worse than a loud failure because three tests still passed — a real resolver
  answering NXDOMAIN for a nonexistent name produces the same `"missing"` verdict
  the stub would have. The broken hook was only revealed by assertions whose
  expected values exist **only in the table** (a chunked 2048-bit key, a
  non-default selector). **So: list stubbed consumers with their real extension,
  and make at least one assertion per stubbed module depend on data that cannot
  come from the real dependency.** Here that is `DNS_CONSUMERS` +
  `setTxt`/`setHang`/`setDnsFailure`.
- **DKIM has two halves and only one of them is ours.** The sending server
  *applies* the signature (that is us, and our relay does it); the RECEIVER
  *validates* it by fetching `<selector>._domainkey.<FromDomain>` from DNS and
  checking the maths against the published public key. So a sender can sign
  perfectly and still fail authentication — and **no sending software can publish
  that key, because it is not our domain**. Brevo, Resend, SendGrid and Gammadyne
  are all in the same position, which is why they all hand you the same "add these
  DNS records" screen. The only zero-DNS-work ways to be authenticated are (a) send
  as a domain the sender has already authenticated (a provider's shared domain) or
  (b) have the domain owner publish `sw._domainkey` once. Never present "signed" as
  "will authenticate": the coverage verdict must say whether the key is PUBLISHED
  and whether it is OURS.




## 6b. Post-migration drift check — run this after EVERY `migrate deploy`

`prisma migrate deploy` exiting 0 does **not** prove the live DB matches the datamodel.
Hand-written migration SQL (this repo's convention) can create a table, index or FK that
is *almost* what `schema.prisma` declares — and Prisma will happily keep applying
migrations while the two silently diverge.

**The check (run on the VPS, after `migrate deploy`):**

```bash
cd /opt/spaceworker
sudo -u trmm env HOME=/home/trmm npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel  prisma/schema.prisma \
  --script
```

`--from-schema-datasource` **introspects the live database**; `--to-schema-datamodel` is
the schema file. **In sync ⇒ the output is exactly `-- This is an empty migration.`**
Anything else is real drift — read it, don't dismiss it.

**When the drift involves an object you just added, filter before panicking:**

```bash
... --script > /tmp/drift.sql
grep -niE 'clonejob|relayhealth|clone' /tmp/drift.sql   # empty = YOUR change is clean
```

This is how B1 was cleared: 87 lines of drift existed, but **zero** referenced the clone
objects, so B1 was in sync and the drift was pre-existing (Task 92).

**Two traps this check caught (2026-09-23):**

1. **`DROP CONSTRAINT` + `ADD CONSTRAINT` on the *same name* ≠ "missing FK".** It means
   the constraint exists but differs in a property Prisma can't `ALTER` — in practice the
   **`ON DELETE` action**. Task 92's hand-written SQL used `ON DELETE CASCADE` where the
   datamodel declares `RESTRICT`, across the whole device layer. The diff looked like a
   re-add; the reality was a *delete-action mismatch* that silently destroys audit rows.
   **Always confirm with the catalog, not the diff prose:**
   ```sql
   SELECT conrelid::regclass AS tbl, conname,
          CASE confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
               WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
               WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
   FROM pg_constraint
   WHERE contype = 'f' AND connamespace = 'public'::regnamespace
   ORDER BY 1,2;
   ```
2. **A drifted FK also drifts its index name.** Postgres truncates identifiers to 63
   bytes, so a hand-written index can end up as `…relationType_k` while the datamodel
   declares `…relationTy_key`; Prisma reports that as `-- RenameIndex`.

**Don't skip the backup.** `migrate deploy` is usually additive, but a corrective
migration (like TASK_113) touches live constraints — `pg_dump` first, always.



## 7. General discipline

- Full-project `npx tsc --noEmit -p .` after every batch of edits, before deploying — catches JSX/type breakage immediately (caught a bad JSX restructure this way mid-session).
- Commit messages should state what a security/audit finding actually was and how it was verified fixed (see this repo's `TASK_49...md` + its matching commit for the pattern) — future-you (or Cline) reading `git log` should be able to tell a real fix from a claimed one.
- If a rsync/build/restart cycle looks like it broke the live service, check `systemctl status <service> --no-pager` immediately — don't assume; a stuck "activating" state with a `000` curl response means fix-forward now (usually: regenerate the Prisma client, rebuild, restart), not walk away.
- Never write JSX/TSX via shell heredocs (`cat > file <<'EOF'`): silent corruption (dropped function bodies, reordered blocks, stray tail lines) that still looks plausible on read — cost a full rewrite of both device components on TASK_95. Use the editor tool's create/insert/replace (chunked ~100-line calls, verify with a brace-depth one-liner + `npx tsc --noEmit` after each chunk).
- Never pass a MULTI-LINE commit message via `git commit -m "..."`: the embedded newlines leave the shell waiting on a quote (you get `cmdand quote>` and a hung terminal, and with `&&` chaining the push silently never runs). Write the message with the editor to `/tmp/<name>-msg.txt` and use `git commit -F /tmp/<name>-msg.txt`. Same class of trap as the heredoc rule above.

- **APP_BASE_URL must be the PUBLIC URL.** Device-side callbacks (PIN collect) bake `${APP_BASE_URL}/api/devices/pin-callback` into the on-device prompt — it was `http://localhost:3400`, so the device posted the PIN to itself and it silently vanished. Fixed to `https://spaceworker.top`. Also affects license-claim and campaign links. Verify: `grep ^APP_BASE_URL /opt/spaceworker/.env`.
- **rsync --files-from paths are relative to the SOURCE operand.** Using `/` as the source looks up `/lib/...` at filesystem root (code 23, nothing transferred — then a rebuild silently ships stale code). Always `cd <repo> && rsync ... . root@host:/opt/app/` with `.` as source.
- **`--files-from` does NOT imply `-r`, even with `-a`.** A DIRECTORY entry in the
  files-from list (e.g. `app/api/devices/`) deploys NOTHING and rsync still exits 0 —
  the run reports `sent 344 bytes` and looks finished. Always pass explicit `-r`
  (`rsync -azr`), and dry-run with `-n -i` first so the itemized file list is visible
  before the real run. Cost a deploy 2026-10: the new
  `app/api/devices/[deviceId]/maintenance/route.ts` silently never landed while two
  single-file entries in the same run transferred fine. (Sibling trap to the source-
  operand one above; both "the deploy looked fine and wasn't".)
- **`-r` on a DIRECTORY entry is necessary but NOT sufficient — it still
  under-recurses.** 2026-09-28: with `-azr` passed and `app/` listed as a
  directory entry, rsync descended only TWO levels under `app/`, so
  `app/api/` and `app/dashboard/` were created as empty directories and all six
  changed route/page files inside them never landed — `sent 90557 bytes`, exit 0,
  service active, 200 OK. **The standing rule is now: never deploy a source tree
  through `--files-from`. Sync trees with `rsync -azr "$d/" "host:$APP_DIR/$d/"`
  (§2) and reserve `--files-from` for flat root-level files.** Verify with the
  §2a parity check, which is the only thing that caught it. Why it under-recursed
  is not documented here on purpose — the rule doesn't depend on knowing.
- **`scripts/deploy-vps.sh` itself never actually implemented the rule above
  until 2026-09-28.** It kept lumping directory entries into one
  `--files-from` call the whole time — the very thing the note above says not
  to do. Caught live: deploying the extractor-routing feature, a brand-new
  `app/api/settings/extract-region/` route directory and a brand-new
  `prisma/migrations/2026.../` folder both landed as EMPTY directories (rsync
  exit 0, "sent N bytes", `prisma migrate deploy` even said "No pending
  migrations" because the migration file genuinely wasn't there). Fixed for
  real this time: the script now splits its file list — flat file entries
  still go through one `--files-from` rsync, but every entry ending in `/` is
  synced as its own tree via `rsync -azr "$d/" host:$APP_DIR/$d/`, matching
  the rule instead of just stating it. Confirmed via §2a parity check
  (341/341 files match) after redeploying with the fix.
- **2026-10 console lifecycle rules (owner's calls — keep them consistent).**
  • MANUAL tools execute DIRECTLY — Connect, Run now, PIN collect, maintenance
    overlay start/stop, queued commands. NO proposal rail for a user acting on their
    own device; the approval rail is for AGENT-initiated requests only. Anything manual
    that starts asking "Approve & run" again is a regression.
  • "Cancelled" means GONE from the UI. Queued commands: `listQueuedCommands` filters
    `status != cancelled` (the mirror row survives as audit only). PIN requests:
    `listPinRequests` PRUNES dead rows (cancelled / expired / pending-past-TTL /
    submitted-without-a-pin) and `deletePinRequest` hard-deletes (cancel of a waiting
    request = the row + its one-time token disappear, so a late PIN POST gets
    `invalid_token`; delete of a collected PIN = "free the UI").
  • A collected PIN is NEVER rendered in the clear: masked `••••` with an explicit
    per-row Show/Hide, plus a delete. Only requests that came back with a PIN are kept.
  • `/api/devices/[deviceId]/maintenance` exists precisely so manual start/stop skips
    the proposal flow; the agent path still goes through `/actions` +
    approval (lib/vantra-link.ts).
- **Maintenance-overlay input invariant (Vantra side).** The overlay is a purely visual
  layer: it must never touch cursor resources (`Hide-SystemCursor` broke technician
  control 3/3 live tests — deliberately dead code now) and must never take foreground
  keyboard focus (`WS_EX_NOACTIVATE`, applied pre-Show). Full story in
  `../vantra/TASK_23_MAINTENANCE_OVERLAY_CLICK_THROUGH.md` + its 2026-10 section.
- **Browser cookie DB location is platform/version dependent — enumerate BOTH.** Newer
  Chromium on Windows keeps cookies at `<profile>\Network\Cookies`; macOS and legacy
  Chromium keep them at `<profile>\Cookies`. Code that hardcodes one silently captures
  zero cookies (this cost a full review cycle on MT-1). Always copy/enumerate both,
  plus the `-journal`/`-wal`/`-shm` sidecars.
- **CDP: `Network.getAllCookies` is NOT a browser-level method.** On the browser
  WebSocket it fails `-32601 'wasn't found'`. The correct browser-level call is
  `Storage.getCookies` (and `Storage.setCookies` to write).
- **Browser-profile capture must run in the USER'S interactive session.** Chrome's
  app-bound (`v20`) cookie key is unwrapped via the elevation service; from a
  service/SSH (non-interactive) session that path is unavailable and cookies come
  back empty. Launch captures through the agent with `runAsUser: true`, never from
  a service context.
- **When the Windows VM is too flaky to test on, replicate the mechanism locally.**
  A CDP capture can be proven on macOS: minimal profile copy -> headless Chrome ->
  browser-level WS -> `Storage.getCookies`. Two traps: (a) `NODE_PATH` does NOT
  apply to ESM imports, so a harness importing `ws` must live inside a directory
  whose `node_modules` has it (run it from the repo root, then delete it); (b) verify
  by COUNTING what the capture returned, never by the script's exit code.
- **No `pwsh` on this Mac (and `brew install --cask powershell` needs interactive
  sudo), so the AST parse gate only runs on the VM.** Interim gate: a tokenizer that
  strips comments/strings/here-strings and checks bracket balance. Note the trap it
  taught us — PowerShell here-strings OPEN with `@'`/`@"` and CLOSE with `'@`/`"@`
  (reversed), so a naive matcher reports false positives on valid files.
- **A `.ps1` FILE is refused on a stock Windows box unless you pass `-ExecutionPolicy Bypass`.**
  `& C:\...\install-relay.ps1 -NewExe ...` dies with "running scripts is disabled
  on this system" (ExecutionPolicy=Restricted is the default) while the *same*
  logic passed as INLINE script text runs fine — that asymmetry is why every
  console tool that sends inline PowerShell (Run now, Hide/Reveal agent) worked
  while the file-based clone installers could never run. Measured on the Windows
  VM 2026-09-24 (TASK_114). Always invoke a script file as
  `& powershell -NoProfile -ExecutionPolicy Bypass -File <path> <args...>`
  (the parent's `$LASTEXITCODE` then carries the script's exit code).
- **A transient staging dir must outlive the installers that read from it.**
  `install-hosted.ps1` copies `-NewExe` into the install dir, so handing it its
  OWN destination fails hard ("Cannot overwrite the item ... with itself"), and
  deleting staging before the role install fails "path does not exist". Stage →
  quarantine → install FROM staging → clean up LAST, on success and failure.
  (Both states were hit live while wiring TASK_114.)
- **NEVER combine `--delete` with `--files-from` on a VPS sync — it is the single
  most destructive thing in this repo's deploy path.** With `--files-from`, every
  directory named in the list becomes authoritative, so ONE root-level entry
  (`package.json`, `next.config.ts`, …) makes `--delete` remove *every other root
  path* on the receiver. On 2026-09-24 that wiped, in a single deploy:
  `.env` (extractor stuck "queued", private browser unconfigured, US/Canada
  locations vanished — all silent, feature-by-feature), `.next/` (`next start`
  crash-looped 37× with "Could not find a production build" → **public site
  down**), and `static/` (nginx's `error_page 502 503 504 /maintenance.html`
  target gone, so users got raw nginx 502s instead of the maintenance page).
  `--exclude='.env'` alone does NOT save you, because it protects one path while
  `--delete` eats the rest. Use `scripts/deploy-vps.sh` instead: `--delete` is
  opt-in via `--prune`, server-only runtime paths are hard-excluded, `.env` in a
  list is refused outright, a `.env` snapshot is taken first, files are chowned
  to `trmm`, and a post-deploy assertion proves `.env`, `.next`,
  `node_modules` and `static/maintenance.html` all survived.
- **`--delete` also un-does hand-applied server state that has no repo source.**
  `static/maintenance.html` (installed from `deploy/maintenance.html`),
  `engine-dist/` (built by `scripts/engine-dist.mjs`), and `worker/venv/` all
  exist ONLY on the VPS. If nginx starts returning bare 502s during an outage,
  check that `static/maintenance.html` exists before hunting anything else.
- **A "Test connection" hang was two bugs stacked, and neither was in nodemailer.**
  Confirmed live 2026-09-28 against a real customer mailbox on a non-standard
  SMTP port (24610). (1) The Add/Edit mailbox form's Security `<select>`
  pre-filled the Port field on every change, so picking "STARTTLS (recommended)"
  silently rewrote a hand-typed `24610` to `587` — a port that host black-holes
  (SYN accepted, no banner, ever). (2) Nothing in this codebase ever set
  nodemailer's timeouts, so its defaults applied: `connectionTimeout` **2
  minutes**, `socketTimeout` **10 minutes**. The result was a "Testing…" button
  frozen for 120s and then one unhelpful line, `ETIMEDOUT Connection timeout`.
  Both are fixed (port guard in `components/mailboxes-panel.tsx`, explicit
  timeouts exported from `lib/mailer-send.ts`), and the same trap applies to a
  REAL send: a campaign pointed at a dead port used to stall the queue for 10
  minutes per attempt.
- **`transport.verify()` returning `true` does NOT mean your credentials were
  checked.** nodemailer skips `login()` entirely when the server advertises no
  AUTH mechanism (`if (perCallAuth && (connection.allowsAuth ||
  options.forceAuth))` in `node_modules/nodemailer/lib/smtp-transport/index.js`).
  A host that answers `220 ... Python SMTP` on port 25, advertises no AUTH, and
  accepts every message will therefore show a green "✓ Connection OK" for a
  completely wrong password — and then silently DROP everything it accepted.
  That is exactly what happened here: the campaign reported sends and delivered
  nothing, not even to spam. `lib/smtp-diagnostics.ts` now reads the server's own
  banner + EHLO capability list so this is visible BEFORE it costs a campaign,
  and the mailbox test surfaces it as an explicit warning. **Anything that
  claims "connection OK" must be shown the server's advertised AUTH list, not
  just a boolean.**
- **Order matters in the mailbox test: probe with raw sockets FIRST, then
  `verify()`.** `probeSmtpCapabilities` speaks SMTP directly and bails on its own
  8s budget, so a black-holed port fails fast instead of waiting out nodemailer.
  It is deliberately advisory-only (never the pass/fail verdict) because a probe
  that merely lacks information must not block a mailbox that sends fine.
- **Prisma `String[]` needs an explicit default in raw SQL.** The hand-written
  migration for a scalar list must be
  `ADD COLUMN "x" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]` — a bare `TEXT[]`
  default will fail on a non-empty table.
- **`read ECONNRESET` before the SMTP banner is a REFUSAL, not a network fault.**
  A recipient MX may accept the TCP connection and then reset it without ever
  greeting — Google and Yahoo both do this to residential/dynamic source IPs
  (Gammadyne's own docs call it the Policy Block List: "most IPs that are
  assigned dynamically or behind a residential gateway"). Measured here: from a
  residential line `gmail-smtp-in.l.google.com:25` connects then resets, while
  from our VPS the same host answers `220 mx.google.com ESMTP …` in ~300 ms.
  An ISP that blocks outbound port 25 can inject the same reset, and the two are
  not distinguishable from the client — but the conclusion is identical either
  way, so **never diagnose "the server is down" from a reset before the banner,
  and never promise direct-to-MX delivery from a customer's own connection.**
  This is also why a desktop bulk mailer can appear to work "because of an RDP":
  Direct Delivery needs a datacenter IP that recipient MX servers will talk to,
  and relay mode needs a working SMTP server — a desktop on a home line has
  neither.
- **An SMTP preset must always carry host + port + security TOGETHER, and the
  port is the source of truth.** The send path picks the handshake from the PORT
  (`lib/mailer-send.ts`: 465 ⇒ implicit TLS, anything else ⇒ STARTTLS), never
  from the label, so a preset that fills a host with the wrong port produces a
  connection the provider never answers — the user experiences it as the
  "Testing…" hang, and it looks like our bug. The table lives in
  `lib/smtp-provider-presets.ts` as pure data (not inside the component) so
  `tests/smtp-provider-presets.test.ts` can pin the coherence rule; mutation-check
  it by setting a 465 provider to 587 and watching the test fail.



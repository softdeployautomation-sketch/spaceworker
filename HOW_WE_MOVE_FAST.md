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

```bash
# from your local checkout, after committing:
cat > /tmp/deploy-files.txt <<'EOF'
app/api/exe-license/auto-bind/route.ts
lib/products.ts
# ...one repo-relative path per line
EOF
rsync -avz -e "ssh -i ~/.ssh/tacticalrmm_vps" --files-from=/tmp/deploy-files.txt --exclude='.env' ./ root@164.68.105.96:/opt/spaceworker/

ssh -i ~/.ssh/tacticalrmm_vps root@164.68.105.96 \
  "cd /opt/spaceworker/app && sudo -u trmm npm run build 2>&1 | tail -20 \
   && systemctl restart spaceworker.service && sleep 3 \
   && systemctl is-active spaceworker.service \
   && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3500/"
```

**`--exclude='.env'` is MANDATORY on every rsync to the VPS - both repos.** (Added 2026-09-22 after a deploy clobbered the server-only `/opt/spaceworker/.env` and `/opt/vantra/.env`, wiping `ADMIN_TOKEN`/`DATABASE_URL` and taking both admin panels down; the old SpaceWorker passcode was unrecoverable and had to be reset.) Server `.env` files are hand-maintained there and don't exist in the local checkout - a bare directory sync or a `--files-from` that accidentally includes `.env` destroys them. Need env changes on the VPS? Use a targeted `ssh` sed/append, never rsync. Snapshot first: `cp /opt/<app>/.env /root/<app>.env.bak-<task>-$(date +%Y%m%d%H%M%S)`.


Build runs as the `trmm` user (matches the deployed process's file ownership), not root. Always tail the build output and check `is-active` + a real `curl` status code before considering a deploy done — a build failure mid-restart once left the service stuck in `activating`/`000` for a few minutes; the fix was just running the build again correctly, but don't skip the check.

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

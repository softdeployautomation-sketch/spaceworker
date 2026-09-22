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
- **Commands that need the Next app dir** (`npm run build`, `npm run dev`): run from `/opt/spaceworker/app`.
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

## 6. General discipline

- Full-project `npx tsc --noEmit -p .` after every batch of edits, before deploying — catches JSX/type breakage immediately (caught a bad JSX restructure this way mid-session).
- Commit messages should state what a security/audit finding actually was and how it was verified fixed (see this repo's `TASK_49...md` + its matching commit for the pattern) — future-you (or Cline) reading `git log` should be able to tell a real fix from a claimed one.
- If a rsync/build/restart cycle looks like it broke the live service, check `systemctl status <service> --no-pager` immediately — don't assume; a stuck "activating" state with a `000` curl response means fix-forward now (usually: regenerate the Prisma client, rebuild, restart), not walk away.

# TASK_211 STEPS — MeshCentral connect must NOT auto-check "Input"

Task doc: `TASK_211_MESH_CONNECT_INPUT_AUTOCHECK.md` (scope, root cause, fix plan §3,
verification battery §5, non-goals §7).
Branch: `agent/task-211-mesh-input` (off local `main` = `5ef85a8`).

---

## BEFORE — 2026-10-15 (task agent)

### 1. Owner decisions (verbatim, from the task doc §1)

- "when you fixed the mobile view for the mesh central, you have made the connect button
  of mesh central auto add input … I want the connect button to connect and user decides
  to check the input."
- Acceptance: after Connect the session comes up **input OFF**; the "Input" checkbox is
  present/enabled; the user's own toggle persists via MeshCentral `putstore` — we only
  change the DEFAULT for a fresh browser.
- Mobile new-tab console (TASK_207 launcher card → `window.open(mesh.control)`) shows the
  same bug — same root cause, covered by the same fix.

### 2. Branch / base state (checked 2026-10-15)

- Working tree before branch switch: 0 tracked modifications (`git status --porcelain |
  grep -vc '^??'` → 0) — nothing to clobber; all pending files were untracked docs/scripts.
- `git fetch origin`: local `main` = `5ef85a8` is strictly AHEAD of `origin/main`
  (`a1704b4`); `origin/main..main` = 20, `main..origin/main` = 0 (ancestor, not diverged).
- Base chosen per task doc §6 ("Branch … off current `main`") → local `main` `5ef85a8`.
  Not `origin/main`: task doc is explicit, and this task adds only new files, so no
  divergence risk either way.
- Branch created: `git checkout -b agent/task-211-mesh-input main` → OK.
- Neighbouring in-flight work: TASK_209 committed at `7055cf3` on
  `agent/task-209-vbs-allow-restore`; TASK_210 (deploy tooling) has no tracked edits
  anywhere. **Shared-file clobber check (§3.1): N/A — this task creates only NEW files**
  (`scripts/t211-mesh-input-default.sh`, `scripts/t211-mesh-input-verify.sh`,
  this STEPS doc). No shared file (`lib/hosting/rules.ts`, `components/device-console.tsx`,
  `prisma/schema.prisma`, `scripts/deploy-vps.sh`, …) is touched, hence no per-branch
  diff needed; record: `git for-each-ref refs/heads` reviewed, no other branch owns
  `scripts/t211-*` (they did not exist before this session).

### 3. Repo-side findings (file-grounded, line numbers at time of write)

- `components/device-console.tsx:3843-3846` — mobile launcher card "Open remote
  console" → `window.open(mesh.control, "_blank", …)` (TASK_207 new-tab surface).
- `components/device-console.tsx:3858` — in-page `<iframe src={mesh.control}>`.
  Both surfaces load the SAME MeshCentral page on the SAME vhost → one wire-level
  rewrite fixes both (task doc §4).
- `lib/device-tools.ts:143` — `fetchMeshUrls(opts)`; `:180` calls Vantra
  `/api/internal/sw/devices/<id>/mesh-urls?scope=device`. Confirms the client only
  forwards `?scope=device` (hostname rewrite + scope) — **no input/view params are ever
  added client-side** (matches task doc §2; `grep -rn 'DeskControl' lib components` →
  zero hits, so the checkbox default is not ours to fix in app code).
- Root cause lives box-side only: `/meshcentral/node_modules/meshcentral/views/
  default.handlebars:1859` and `:9591` — `getstore('DeskControl', 1)` (default = 1 =
  checked); live page is `default-min.handlebars` because `minify: 1` → exactly 2 ×
  `getstore("DeskControl",1)` on the wire (pre-change ground truth of §5.1).

### 4. Fix approach locked (task doc §3 Option A — no deviation)

nginx `sub_filter` marked block on BOTH mesh vhosts
(`/etc/nginx/sites-enabled/mesh.spaceworker.top.conf` SSL server block + `/etc/nginx/
sites-enabled/meshcentral.conf`), server-level, after the `server_name` line of the
block that proxies to `http://127.0.0.1:4430/`:

- `sub_filter 'getstore("DeskControl",1)' 'getstore("DeskControl",0)';`
- `sub_filter_once off;` (both occurrences)
- `proxy_set_header Accept-Encoding "";` (sub_filter cannot match compressed bodies)
- `gzip on; gzip_comp_level 5;` (re-compress the 866 KB page)
- wrapped in `# >>> TASK_211` / `# <<< TASK_211` markers for grep-ability + revert.

Implementation notes (engineering, within the doc's intent — documented here because the
task agent cannot see the live confs and must not guess):

1. **nginx `proxy_set_header` inheritance trap.** `proxy_set_header` directives are
   inherited from `server` level to a `location` **only if that location defines NO
   `proxy_set_header` of its own**. MeshCentral vhosts typically set `Upgrade`/
   `Connection` inside `location /` — if so, the server-level `Accept-Encoding ""` would
   be silently dropped, the body would stay compressed, and `sub_filter` would match
   NOTHING while `nginx -t` still passes. The apply script therefore detects a
   location-level `proxy_set_header` in the block serving the page and additionally
   inserts `proxy_set_header Accept-Encoding "";` as the first line of that location
   (logged, deterministic anchor = the `location` line directly above the first
   `127.0.0.1:4430` `proxy_pass`). It contains NO `>>> TASK_211` marker, so the §5.3
   assertion `grep -c '>>> TASK_211' <conf>` stays exactly 1. The wire check (§5.2)
   remains the authoritative proof either way.
2. **Validate-then-edit-then-verify.** Both confs are validated (exist, contain a
   `127.0.0.1:4430` `proxy_pass`, an anchor `server_name` above it) BEFORE any edit;
   any deviation → loud `FAIL` + exit nonzero with NO change (task doc §6 STOP-and-report).
3. **Rollback:** backups `<conf>.bak-t211` taken before the first edit (skipped if they
   already exist — idempotent re-runs), `nginx -t` again after editing, on failure only
   the confs edited in THIS run are restored from their backups → exit nonzero.
   `systemctl reload nginx` (never restart) only after a clean post-edit `nginx -t`.
4. **App-untouched proof:** apply records `stat` mtime of `/opt/spaceworker/.next/
   BUILD_ID` (read-only) to `/var/tmp/t211-baseline-buildid`; the verify script compares
   it back (§5.4). Never writes under `/opt/*`.

### 5. Deliverables

- `scripts/t211-mesh-input-default.sh` — apply (idempotent, rollback-safe, guarded).
- `scripts/t211-mesh-input-verify.sh` — §5 battery, machine-readable
  `PASS|<id>|<detail>` / `FAIL|…` / `MANUAL|…` lines + final `RESULT|PASS` / `RESULT|FAIL`.
- Both scripts run in fixture mode (`T211_NGINX_DIR`, `T211_BUILD_ID`, `T211_BASELINE`,
  `T211_HOST_*`, `T211_BOX_IP` env overrides + `nginx`/`systemctl`/`curl` resolved via
  `PATH`) so the task agent can test the full logic locally WITHOUT any VPS access
  (PROMPT §1 hard boundary).

### 6. Gates started (results in AFTER)

- `npx tsc --noEmit` → log `/tmp/t211-tsc.log`
- `npx tsx --test tests/*.test.ts` → log `/tmp/t211-tests.log`
- eslint: no TS/JS file changed by this task (shell + markdown only) — noted, not run
  against unchanged files.

---

## AFTER — 2026-10-15 (task agent)

### 1. What changed (files)

- `scripts/t211-mesh-input-default.sh` — NEW (9 390 B, mode 755): validate-all-first,
  marked `sub_filter` block after the SSL `server_name` of each mesh vhost, location-level
  `Accept-Encoding ""` patch when needed (inheritance trap), backups, post-edit `nginx -t`,
  rollback, `systemctl reload nginx` only, `BUILD_ID` baseline record, `FAIL|…` lines +
  exit 1 on every guard, idempotent (`SKIP (idempotent)` on re-run).
- `scripts/t211-mesh-input-verify.sh` — NEW (7 392 B, mode 755): §5 battery
  (`pre` and `post` modes), machine-readable `PASS|<id>|<detail>` / `FAIL|…` / `MANUAL|…`
  + final `RESULT|PASS` / `RESULT|FAIL`, exit 0/1 accordingly.
- This STEPS doc (untracked per §3.2). **No shared/TS/schema file touched** → §3.1
  clobber diff: nothing new since BEFORE (this task creates only NEW files).

### 2. Gates (verbatim results)

- `npx tsc --noEmit` → **`tsc exit: 0`** (log `/tmp/t211-tsc3.log`) — repo-wide 0 errors.
  Gotcha: first runs failed with 15× `TS2339` (`cyberlabLiveEgressEnabled`,
  `LabTarget.sourceDeviceId` missing). Cause: **stale generated Prisma client**
  (`node_modules/.prisma/client`, generated before the deployed schema was reconciled) —
  NOT a code error. Fix: local `npx prisma generate` (allowed by §1), re-run → 0.
- `npx tsx --test tests/*.test.ts` → **exit 0**: `# tests 1490 / # pass 1489 / # fail 0 /
  # cancelled 0 / # skipped 1` (log `/tmp/t211-tests.log`). The single skip is the
  baseline DB-gated one (`ok 118 - DB: removing a mailbox mid-send … # SKIP`) — allowed
  by §3.4.
- eslint: N/A — task changed shell + markdown only (documented, not run on unchanged files).
- `bash -n` on both deliverable scripts → OK (before commit).

### 3. Local fixture tests (no VPS access — PROMPT §1 respected)

Harness: **`/tmp/t211box/run-tests.sh`** (throwaway, NOT committed; re-run with
`bash /tmp/t211box/run-tests.sh`, log `/tmp/t211box/results.log`). It provides fake
`nginx`/`systemctl`/`curl` on `$PATH` + fixture vhosts (customer with `:80`+SSL blocks and
location-level `proxy_set_header` lines; admin without) + fixture MeshCentral pages
(2× `getstore("DeskControl",1)` pre / 2× `,0` post) and drives BOTH scripts through their
env-overridable paths (`T211_NGINX_DIR`, `T211_BUILD_ID`, `T211_BASELINE`,
`T211_FAKE_WIRE`).

Result: **`RESULT|PASS|fixture-tests ok=50 bad=0`** (runner exit 0), scenarios:

- S1 apply on fresh fixtures: marker ×1 per conf, block directly after the SSL
  `server_name` (line 13+1; admin line 6+1), location patch inside `location /` only where
  location-level `proxy_set_header` exists (customer yes / admin no), backups byte-identical
  to originals, baseline recorded, reload called, **no restart ever**.
- S2 idempotent re-run: exit 0, `SKIP (idempotent)`, markers stay ×1, reload NOT repeated.
- S3 `verify post` on a correctly applied box → `RESULT|PASS` exit 0 incl. all 12 section
  PASS lines + `MANUAL|browser.connect_input_off` checklist.
- S4 `verify post` with the wire still on the old default → exit 1, `FAIL|wire.default1…`
  (2 × `,1` live), `FAIL|wire.default0…`, `RESULT|FAIL`.
- S5 `verify pre` on fresh fixtures → `RESULT|PASS` with `×2` — ground truth of the bug
  reproduced.
- S6 injected post-edit `nginx -t` failure → apply exit 1, `FAIL|postcheck.nginx_t`,
  BOTH confs restored byte-identical, reload never ran.
- S7 missing admin conf → apply exit 1, `FAIL|conf.missing`, customer conf NOT edited,
  no reload (validate-all-first proof).
- S8 `BUILD_ID` changed → `verify post` exit 1 with `FAIL|app.untouched`.

### 4. Bugs found while testing

- Product logic: none surfaced — the single FAIL in the first harness run was a harness
  assertion (grep `location /` also matched the word inside a fixture comment line);
  pattern tightened to `^[[:space:]]*location /` → 50/50. Script behaviour was correct
  even in that run (patch landed at `location /`+1 = line 30).
- Honest limit: the fixture `nginx` stub validates script *control flow*, not real nginx
  parsing — the authoritative `nginx -t` gate runs on the box (apply itself re-checks and
  rolls back on failure; the wire check of §5.2 is the final proof).
- Cosmetic: the inserted location-level line uses 4-space indent vs. the 8-space location
  body — valid nginx, ignores whitespace; noted instead of guessing box indentation.

---

## HANDOFF → VERIFICATION AGENT

**Identity**
- Repo: `spaceworker` (`/Users/mikeolab/spaceworker`) · branch: `agent/task-211-mesh-input`
  (off local `main` `5ef85a8`) · commit: **`bf8ec8b`** — *feat(mesh): TASK_211 — apply + verify
  scripts for Input-default uncheck (wire sub_filter)*. Exactly 2 files, 339 insertions,
  mode 755; `git status` clean of tracked task files (TASK/STEPS docs stay untracked per §3.2).

**Exact deploy file list** (import-closure check §3.1: N/A — no TS/JS, no imports, no
shared file touched, no other branch owns these paths)
1. `scripts/t211-mesh-input-default.sh` → VPS (e.g. `/usr/local/sbin/` or run from repo
   checkout — your call as deployer)
2. `scripts/t211-mesh-input-verify.sh` → VPS likewise
No app rebuild needed (box `.next` build untouched); no Vantra change.

**Migration / DB steps:** none. **Cross-repo deploy order:** none (spaceworker-only).

**On-box execution order (task doc §2 — VPS work is YOURS, task agent never touches it)**
1. Run apply (needs root/sudo): `bash scripts/t211-mesh-input-default.sh`
   - Expected: both confs patched (`OK` + block inserted), `systemctl reload nginx` called,
     exit 0. Re-run safe (prints `SKIP (idempotent)`).
   - Any `FAIL|…` line → exit 1 with confs untouched/rolled back; STOP and escalate
     (STOP-and-report rule), do not hand-patch around it.
2. Run verify: `bash scripts/t211-mesh-input-verify.sh post`
   - Expected final line: **`RESULT|PASS`** and exit 0.
3. Manual checklist (emitted by verify, task doc §5.6/§7): fresh browser tab →
   https://mesh.spaceworker.top/ → Connect → Control → **"Input" UNCHECKED**; checkbox
   enabled; toggle it ON, reload page, still ON (user's `putstore` persistence intact);
   repeat once on the mobile new-tab console (TASK_207 launcher) and in the desktop
   in-page iframe.

**Post-deploy verification checks (exact greps/curls)**
- `grep -c '>>> TASK_211' /etc/nginx/sites-enabled/mesh.spaceworker.top.conf` → `1`
  (same for `/etc/nginx/sites-enabled/meshcentral.conf`).
- `curl -sk https://mesh.spaceworker.top/ | grep -o 'getstore("DeskControl",[01]' | sort | uniq -c`
  → exactly `2 × getstore("DeskControl",0` and ZERO `,1` (same on `https://mesh.instaweb.top/`).
- `scripts/t211-mesh-input-verify.sh post` → `RESULT|PASS`, exit 0.
- `grep -c 'Accept-Encoding ""' <conf>` → ≥2 where location patch applied (inheritance trap).

**Risks + rollback**
- Risk: box conf may already carry `gzip`/`sub_filter` or a different vhost layout than the
  fixtures → apply's validate-all-first + post-edit `nginx -t` catches this and rolls back
  automatically (fixture-proven, S6/S7); wire check is the final authority (acceptance:
  task doc §5.2/§5.5 — a passing `nginx -t` alone does NOT mean the rewrite is live).
- Risk: gzip double-compression if the box already gzips at `http` level — nginx allows the
  directive override; if `nginx -t` objects, rollback happens automatically.
- Rollback (owner escape hatch, task doc §3/§5.3): restore `<conf>.bak-t211` (or delete the
  `# >>> TASK_211` … `# <<< TASK_211` block + the `# TASK_211 location-level` line), then
  `nginx -t && systemctl reload nginx`. App revert: none needed (nothing under `/opt/*`
  ever written; `BUILD_ID` only read — baseline at `/var/tmp/t211-baseline-buildid`).


